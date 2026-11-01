'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { mutate } from 'swr';
import { RefreshCw, Clock, Wifi } from 'lucide-react';
import { Sidebar, MobileMenuButton } from '@/components/layout/sidebar';
import { WalletConnect } from '@/components/wallet/wallet-connect';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/shared/breadcrumbs';
import { ApiHealthBanner } from '@/components/shared/api-health-banner';
import { useApiHealthContext } from '@/lib/hooks/use-api-health';
import type { ApiHealthState } from '@/lib/hooks/use-api-health';
import { useWalletBalance } from '@/lib/hooks/use-wallet-balance';
import { useWalletContext } from '@/lib/hooks/use-wallet';
import { ChurnCountdown } from '@/components/dashboard/churn-countdown';
import { formatRuneFromNumber } from '@/lib/utils/formatters';
import { getTHORNameReverseLookupNoRetry as getTHORNameReverseLookup } from '@/lib/api/midgard';
import { readThorNameReverseLookupCache, writeThorNameReverseLookupCache } from '@/lib/storage/keys';

const DASHBOARD_SWR_KEY_PREFIXES = new Set([
  'nodes',
  'earnings-history',
  'historical-earnings',
  'rune-price',
  'rune-price-history',
  'historical-rune-price',
  'network-constants',
  'network-metrics',
  'health',
  'current-block-height',
  'churn-countdown',
  'bond-details',
  'actions-bond-v2',
  'lp-current',
  'lp-historical',
  'transaction-history',
  'pools',
  'fee-revenue',
  'changelogs',
  'protocol-version',
  'wallet-balance',
  'yield-benchmarks',
  'thorname',
]);

export function shouldRefreshDashboardSWRKey(key: unknown): boolean {
  const keyPrefix = Array.isArray(key) ? key[0] : key;
  return typeof keyPrefix === 'string' && DASHBOARD_SWR_KEY_PREFIXES.has(keyPrefix);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatSourceAge(source: 'Midgard' | 'THORNode', checkedAt: Date | null, now: number): string {
  return checkedAt ? `${source} ${formatElapsed(now - checkedAt.getTime())}` : `${source} pending`;
}

function getSourceStatusLabel(
  source: 'Midgard' | 'THORNode',
  status: ApiHealthState['midgard'],
  checkedAt: Date | null,
  now: number
): string {
  if (status === 'mock') {
    return `${source} demo data`;
  }

  if (status === 'healthy') {
    return formatSourceAge(source, checkedAt, now);
  }

  if (status === 'unknown') {
    return checkedAt ? `${source} unknown · last good ${formatElapsed(now - checkedAt.getTime())}` : `${source} pending`;
  }

  return checkedAt
    ? `${source} ${status} · last good ${formatElapsed(now - checkedAt.getTime())}`
    : `${source} ${status}`;
}

function getSourceFreshnessTone(
  midgard: ApiHealthState['midgard'],
  thornode: ApiHealthState['thornode'],
  lastChecked: Date | null
): 'healthy' | 'checking' | 'degraded' | 'down' | 'demo' {
  if (midgard === 'mock' || thornode === 'mock') {
    return 'demo';
  }

  if (midgard === 'down' || thornode === 'down') {
    return 'down';
  }

  if (midgard === 'degraded' || thornode === 'degraded') {
    return 'degraded';
  }

  if (midgard === 'unknown' || thornode === 'unknown') {
    return lastChecked ? 'degraded' : 'checking';
  }

  return 'healthy';
}

function getCompactFreshnessLabel(tone: ReturnType<typeof getSourceFreshnessTone>): string {
  if (tone === 'demo') {
    return 'Demo data';
  }

  if (tone === 'down') {
    return 'Sources down';
  }

  if (tone === 'degraded') {
    return 'Sources degraded';
  }

  if (tone === 'checking') {
    return 'Checking sources';
  }

  return 'Sources responding';
}

function getSourceIconClass(tone: ReturnType<typeof getSourceFreshnessTone>): string {
  if (tone === 'healthy') return 'text-cyan-500';
  if (tone === 'demo') return 'text-sky-500';
  if (tone === 'down') return 'text-red-500';
  if (tone === 'checking') return 'text-blue-500';
  return 'text-yellow-500';
}

export function getSourceFreshnessLabel(
  lastSuccessful: ApiHealthState['lastSuccessful'],
  lastChecked: Date | null,
  now: number | null,
  status: Pick<ApiHealthState, 'midgard' | 'thornode'> = {
    midgard: lastSuccessful.midgard ? 'healthy' : 'unknown',
    thornode: lastSuccessful.thornode ? 'healthy' : 'unknown',
  }
): string {
  if (now === null) {
    return lastChecked ? 'Source health degraded or unknown' : 'Checking source health';
  }

  return [
    getSourceStatusLabel('Midgard', status.midgard, lastSuccessful.midgard, now),
    getSourceStatusLabel('THORNode', status.thornode, lastSuccessful.thornode, now),
  ].join(' · ');
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

export function DashboardShell({
  children,
  requireAddress = true,
  alertReviewPanel,
  alertReviewTrigger,
  notificationNudge,
}: {
  children: React.ReactNode;
  requireAddress?: boolean;
  alertReviewPanel?: React.ReactNode;
  alertReviewTrigger?: React.ReactNode;
  notificationNudge?: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchParams = useSearchParams();
  const address = searchParams.get('address');
  const [thorName, setThorName] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const { midgard, thornode, lastChecked, lastSuccessful } = useApiHealthContext();
  const { address: walletAddress } = useWalletContext();
  const { balance, status: walletBalanceStatus } = useWalletBalance(walletAddress);

  const hasAddress = requireAddress ? !!address : true;

  const freshnessLabel = getSourceFreshnessLabel(lastSuccessful, lastChecked, now, { midgard, thornode });
  const sourceFreshnessTone = getSourceFreshnessTone(midgard, thornode, lastChecked);
  const sourceIconClass = getSourceIconClass(sourceFreshnessTone);

  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = useCallback(() => {
    // Revalidate only: passing a data argument (even undefined) would overwrite loaded cache.
    void mutate(shouldRefreshDashboardSWRKey);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!address) {
      setThorName(null);
      return;
    }

    let cancelled = false;

    const cachedThorName = readThorNameReverseLookupCache(address);

    if (cachedThorName) {
      setThorName(cachedThorName === '__none__' ? null : cachedThorName);
      return () => {
        cancelled = true;
      };
    }

    getTHORNameReverseLookup(address)
      .then((data) => {
        if (cancelled) {
          return;
        }

        const resolvedThorName = data.entry?.name ?? null;

        setThorName(resolvedThorName);

        writeThorNameReverseLookupCache(address, resolvedThorName ?? '__none__');
      })
      .catch(() => {
        if (!cancelled) {
          setThorName(null);
          writeThorNameReverseLookupCache(address, '__none__');
        }
      });
    return () => { cancelled = true; };
  }, [address]);

  if (!hasAddress) {
    return (
      <div className="flex min-h-screen">
        <Sidebar isOpen={sidebarOpen} onCloseAction={() => setSidebarOpen(false)} />
        <main className="flex-1 flex items-center justify-center p-4">
          <p className="text-zinc-500">No address provided. Go back to the home page.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
      <Sidebar isOpen={sidebarOpen} onCloseAction={() => setSidebarOpen(false)} />
      <main className="flex-1 p-3 sm:p-4 md:p-6 overflow-auto">
        <div className="flex flex-wrap items-start sm:items-center justify-between gap-2 sm:gap-3 mb-4 pb-3 border-b border-zinc-200/60 dark:border-zinc-800/60 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-xl rounded-lg px-3 sm:px-4 -mx-3 sm:-mx-4 -mt-3 sm:-mt-4 md:-mt-6 pt-3 sm:pt-4 md:pt-6 shadow-sm">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        <MobileMenuButton onClickAction={() => setSidebarOpen(true)} isOpen={sidebarOpen} />
            <div className="min-w-0">
              <Breadcrumbs />
              {address ? (
                <p className="text-[10px] sm:text-xs md:text-sm text-zinc-500 font-mono mt-0.5 truncate" title={address}>
                  {thorName || truncateAddress(address)}
                </p>
              ) : null}
              {walletAddress && walletBalanceStatus !== 'idle' ? (
                <span
                  data-testid="wallet-balance-status"
                  className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 block"
                  aria-live="polite"
                >
                  {walletBalanceStatus === 'loading' && 'Wallet balance checking'}
                  {walletBalanceStatus === 'unavailable' && 'Wallet balance unavailable'}
                  {walletBalanceStatus === 'available' && (
                    <>
                      Wallet balance: <span className="font-mono">{formatRuneFromNumber(balance ?? 0)}</span>
                    </>
                  )}
                </span>
              ) : null}
              {address ? (
                <span
                  data-testid="source-freshness-compact"
                  className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 xl:hidden"
                >
                  <Wifi className={`h-3 w-3 ${sourceIconClass}`} aria-hidden="true" />
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {getCompactFreshnessLabel(sourceFreshnessTone)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
            <span
              data-testid="source-freshness-full"
              className="hidden xl:flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/60 px-2.5 py-1.5 rounded-full"
            >
              <Wifi className={`h-3 w-3 ${sourceIconClass}`} aria-hidden="true" />
              <Clock className="h-3 w-3" aria-hidden="true" />
              <span className="font-medium">{freshnessLabel}</span>
            </span>
            <span data-testid="churn-header-action" className="hidden xl:inline-flex">
              <ChurnCountdown />
            </span>
            {alertReviewTrigger}
            {notificationNudge}
            <WalletConnect />
            <Button
              variant="glass"
              size="icon"
              onClick={handleRefresh}
              title="Refresh data"
              aria-label="Refresh dashboard data"
              className="bg-white/80 dark:bg-zinc-800/80"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <ApiHealthBanner midgard={midgard} thornode={thornode} />
        {alertReviewPanel ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
            <div className="min-w-0 lg:order-2">
              {alertReviewPanel}
            </div>
            <div className="min-w-0 lg:order-1">
              {children}
            </div>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
