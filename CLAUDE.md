# CLAUDE.md — Heimdall Project Context

> **AI agent reading this:** before any non-trivial change, run `pnpm test` and
> `pnpm run build` locally. CI is the source of truth — match it exactly.

## Project Overview
Heimdall is a professional investment command center for THORChain bond
providers. Live at https://bond.thorchain.no.

**Canonical status:** `Reedtrullz/Heimdall` at `/Users/reidar/Projectos/Heimdall` is the canonical THORChain dashboard. The older `THORNode Watcher` / BondTrack checkout is archive-only and should only be read for historical QA/audit artifacts.

## Tech Stack
- **Framework:** Next.js 16.2.7 (App Router, Turbopack, `output: 'standalone'`)
- **Language:** TypeScript 5
- **Styling:** Tailwind CSS v4 (lightningcss / @tailwindcss/oxide native deps)
- **Data:** SWR
- **Charts:** Recharts
- **Tests:** Vitest (unit) + Playwright (E2E)
- **Container:** Single multi-stage `Dockerfile` (Node 22 slim, standalone output)
- **Deploy:** Ansible → VPS, Docker, Caddy reverse proxy
- **Secrets:** Ansible Vault (`group_vars/vps/vault.yml`)

## Repo Layout (top-level)
```
.github/workflows/ci.yml      Single CI workflow (test, build, e2e, publish)
.github/workflows/opencode.yml OpenCode auto-PR helper (unrelated)
Dockerfile                    Canonical multi-stage build
.dockerignore                 Aggressive — only ships what runtime needs
compose.production.yml        VPS docker compose
ansible-playbook.yml          Heimdall deploy
inventory/, group_vars/       Ansible config + vault
src/                          Application code
e2e/                          Playwright specs
docs/                         Living docs
docs/archive/                 Historical audits, learnings (read-only)
```

## Development
```bash
nvm use                       # picks up .nvmrc (Node 22)
pnpm install --frozen-lockfile
pnpm run dev                   # http://localhost:3000
pnpm test                      # vitest run
pnpm run e2e                   # playwright (needs dev server)
pnpm run build                 # production build
```

## CI (single workflow: `.github/workflows/ci.yml`)
Triggers on push/PR to `master` or `staging`.

Jobs (run in parallel):
1. **test** — `pnpm install --frozen-lockfile`, `pnpm run lint -- --max-warnings=0`, `pnpm test`, `pnpm run test:coverage`
2. **build** — `pnpm run build` (verifies Next.js build outside Docker)
3. **e2e** — `pnpm run e2e` with Playwright

Then **docker-build** runs a non-pushing `Dockerfile` build for PR, staging,
and other non-`master` refs. **publish** runs only on `push` to `master`, after
all three pass:
- builds the canonical `Dockerfile`
- publishes GHCR tags, including immutable `sha-<short>` tags
- uses Buildx with GitHub Actions cache (`cache-from`/`cache-to: type=gha`)

Keep GitHub and Docker JavaScript actions on Node 24-capable majors:
`actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v7`,
`docker/setup-buildx-action@v4`, `docker/build-push-action@v7`,
`docker/login-action@v4`, and `docker/metadata-action@v6`. Do not downgrade
them to older Node 20-backed majors to silence a workflow issue; fetch the run
logs and fix the actual failure.

There is no separate "Publish" workflow and no cross-workflow `workflow_run`
trigger — that pattern caused two-named-workflow races in the past.

## Docker
Single `Dockerfile`, two stages:
1. `builder` — `pnpm install --frozen-lockfile` (npm includes optional dependencies by default), then exact-version installs of the
   linux/x64 native prebuilts Tailwind v4 / Turbopack / Vitest / Sharp need
   (`lightningcss-linux-x64-gnu@1.32.0`,
   `@tailwindcss/oxide-linux-x64-gnu@4.3.1`,
   `@rolldown/binding-linux-x64-gnu@1.0.3`,
   `@unrs/resolver-binding-linux-x64-gnu@1.12.2`,
   `@img/sharp-linux-x64@0.35.3`,
   `@img/sharp-libvips-linux-x64@1.3.2`). Build args include every declared
   public `NEXT_PUBLIC_*` value plus `VERSION`.
2. `runner` — copies only `.next/standalone`, `.next/static`, `public/`. Runs
   as non-root `node`. Includes an explicit-error `HEALTHCHECK` hitting
   `http://127.0.0.1:3000/api/health`.

Local build:
```bash
docker build -t heimdall .
docker run --rm -p 3000:3000 heimdall
```

## Deployment
```bash
IMAGE_TAG=sha-<exact-short-sha> ansible-playbook \
  -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```
Flow: local push → CI builds & publishes to GHCR → run Ansible from local →
VPS pulls image → swaps container → gates promotion on `/api/ready` → rolls back
on failure. Docker healthchecks still use `/api/health` for process liveness.
**Never `git pull` on the VPS.**

Ansible defaults to `ghcr.io/reedtrullz/heimdall:sha-<local short sha>` or an
explicit `IMAGE_TAG`. Runtime `VERSION` must equal that immutable deployed tag;
verify by comparing the exact SHA tag with `/api/health` and `/api/ready` after
a deploy. Do not use mutable `:latest` as the deploy identity.

## Environment Variables
`NEXT_PUBLIC_*` vars are baked into the browser bundle at Docker build time and
are passed as `build-args` by both Docker CI jobs. Runtime Ansible/Compose
entries with the same names are retained for server-side rendering and
diagnostics, but changing them cannot mutate already-built client JavaScript.
Runtime-only vars (`PORT`, `HOSTNAME`, `NODE_ENV`, `VERSION`) and server-only
secrets/proxy vars (`COINAPI_KEY`, `THORNODE_API_URL`, `MIDGARD_API_URL`,
`MIDGARD_FALLBACK_URL`, `TRUST_PROXY_HEADERS`, `TRUST_X_FORWARDED_FOR`) are set
in Ansible; `COINAPI_KEY` comes from the existing `vault_coinapi_key` without
reading or documenting the secret. The manual `compose.production.yml` fallback
requires `IMAGE_SHA=<exact-short-sha>` and should be run through
`scripts/compose-production.sh` so non-hex values are rejected before Compose
interpolation. See `.env.example` for local, non-secret documentation of public
and server-side variables. Production trusts the Caddy-overwritten `X-Real-IP`
for best-effort rate limiting; do not trust `X-Forwarded-For` unless the full
proxy chain sanitizes it.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_THORNODE_API` | THORNode API |
| `NEXT_PUBLIC_MIDGARD_API` | Midgard API |
| `NEXT_PUBLIC_THORCHAIN_RPC` | THORChain RPC |
| `NEXT_PUBLIC_TRACK_API` | THORChain tracker URL |
| `NEXT_PUBLIC_MIDGARD_FALLBACK` | Secondary Midgard fallback |
| `NEXT_PUBLIC_APP_URL` | App/CORS origin |
| `NEXT_PUBLIC_COINGECKO_API` | CoinGecko API |
| `NEXT_PUBLIC_THORCHAIN_NETWORK` | `mainnet` / `stagenet` |
| `NEXT_PUBLIC_USE_MOCK_DATA` | Local/test mock-data toggle |
| `COINAPI_KEY` | Server-side CoinAPI key from vault |
| `TRUST_PROXY_HEADERS` | Trust deployment proxy `X-Real-IP` for rate limiting |
| `TRUST_X_FORWARDED_FOR` | Also trust sanitized `X-Forwarded-For` chains |
| `VERSION` | Runtime image tag, set to the immutable deployed `sha-<short>` tag |

## Health Endpoints
`GET /api/health` → `{ "status": "healthy", "timestamp": "...", "version": "..." }`
`GET /api/ready` → `{ "status": "ready" | "degraded", "version": "...", "checks": { ... } }`

Version priority: `process.env.VERSION` → `"unknown"`.

## Conventions
- Pages using `useSearchParams` must be `'use client'` and wrapped in `<Suspense>`.
- API proxy routes: `export const dynamic = 'force-dynamic'`.
- Address persistence: unified `BONDTRACK_ADDRESS` localStorage key (legacy name; do not rename).
- Component-local storage keys are `heimdall-*`.
- Single-Node First UI; prefer contextual empty states over UI voids.

## Don't
- Don't add a second workflow named `CI/CD Pipeline`.
- Don't use `workflow_run:` triggers to chain build → publish — use `needs:` inside one workflow.
- Don't introduce `Dockerfile.v2`, `Dockerfile-simple`, etc. as cache-bust hacks. If Docker cache misbehaves, prefer `--no-cache` on the action or a fresh GHA cache key.
- Don't switch the base image to Alpine (musl breaks `lightningcss` and `@tailwindcss/oxide` prebuilts).
- Don't commit secrets, `dogfood-output/`, or scratch `.md` reports to root — use `docs/archive/`.
- Don't bake stale `gateway.liquify.com/chain/thorchain_mainnet` URLs as build args. The correct paths are `thorchain_api` (THORNode) and `thorchain_midgard` (Midgard) — they're already set in `ci.yml` and `ansible-playbook.yml`. The `_mainnet` path returns HTTP 500.
- Don't change the `/api/thorchain/[...path]` proxy's leading-segment normalisation. The frontend client calls `fetchThornode('/thorchain/nodes')` so the browser hits `/api/thorchain/thorchain/nodes`; the proxy strips the duplicate `thorchain/` segment before its allowlist (`/^nodes$/`, `/^network$/`, …) runs, and `THORNODE_API_URL` already ends in `/thorchain`. Removing that step makes every request 403 and the "THORNode API is temporarily unavailable" banner reappears.
- Don't drop `force_source: yes` from the docker_image task in `ansible-playbook.yml` — it verifies the selected immutable tag is pulled instead of trusting a cached local image.

## Historical reports
See `docs/archive/` for prior audits (LP, UI/UX, etc.) and `learnings.md`.
