import { isIP } from 'node:net';
import { NextRequest } from 'next/server';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Single-process, best-effort limiter. In serverless/multi-process deployments each
// process keeps its own store, so this reduces accidental bursts but is not a
// durable abuse-prevention boundary. Prevent unbounded memory growth by capping
// the in-memory store at 10000 live entries.
export const RATE_LIMIT_MAX_ENTRIES = 10000;

function cleanupExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

export function __resetRateLimitStoreForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  rateLimitStore.clear();
}

export function __getRateLimitStoreSizeForTests(): number {
  if (process.env.NODE_ENV !== 'test') return 0;
  return rateLimitStore.size;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function firstValidIp(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  if (!first) return null;

  return isIP(first) === 0 ? null : first;
}

function shouldTrustVercelHeaders(): boolean {
  return Boolean(process.env.VERCEL) || envFlag('TRUST_VERCEL_PROXY_HEADERS');
}

function shouldTrustCloudflareHeaders(): boolean {
  return envFlag('TRUST_CLOUDFLARE_HEADERS');
}

function shouldTrustProxyHeaders(): boolean {
  return envFlag('TRUST_PROXY_HEADERS');
}

function shouldTrustForwardedForHeader(): boolean {
  return shouldTrustProxyHeaders() && envFlag('TRUST_X_FORWARDED_FOR');
}

export function getClientIp(request: NextRequest): string {
  if (shouldTrustVercelHeaders()) {
    const vercelIp = firstValidIp(request.headers.get('x-vercel-forwarded-for'));
    if (vercelIp) return vercelIp;
  }

  if (shouldTrustCloudflareHeaders()) {
    const cfIp = firstValidIp(request.headers.get('cf-connecting-ip'));
    if (cfIp) return cfIp;
  }

  if (shouldTrustProxyHeaders()) {
    // Heimdall's VPS Caddy config overwrites X-Real-IP with {remote_host}.
    const realIp = firstValidIp(request.headers.get('x-real-ip'));
    if (realIp) return realIp;

    // X-Forwarded-For is only safe when the whole proxy chain sanitizes it.
    if (shouldTrustForwardedForHeader()) {
      const forwardedFor = firstValidIp(request.headers.get('x-forwarded-for'));
      if (forwardedFor) return forwardedFor;
    }
  }

  return 'unknown';
}

export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  if (!entry || entry.resetAt < now) {
    if (!entry && rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
      cleanupExpiredEntries(now);

      // Enforce store size limit before adding new entries.
      if (rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: now + windowMs,
        };
      }
    }

    // First request or window expired
    const resetAt = now + windowMs;
    rateLimitStore.set(identifier, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetAt,
    };
  }

  if (entry.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  entry.count++;
  rateLimitStore.set(identifier, entry);
  return {
    allowed: true,
    remaining: maxRequests - entry.count,
    resetAt: entry.resetAt,
  };
}
