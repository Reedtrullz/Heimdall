# Heimdall 🛡️

A professional investment command center for THORChain bond providers and liquidity providers — monitor bonded RUNE exposure, rewards, risk metrics, LP provenance, and provider-safe alerts with institutional-grade precision.

> **Canonical project:** This repository (`Reedtrullz/Heimdall`, local path `/Users/reidar/Projectos/Heimdall`) is the canonical THORChain dashboard. Do not revive or implement new work in the older `THORNode Watcher` / BondTrack checkout; keep it archive-only for historical QA/audit artifacts.

![Next.js](https://img.shields.io/badge/Next.js-16.3.6-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![Tailwind](https://img.shields.io/badge/Tailwind-4.0-cyan)
![License](https://img.shields.io/badge/License-MIT-green)
![CI](https://github.com/Reedtrullz/Heimdall/actions/workflows/ci.yml/badge.svg)
![Deployment](https://img.shields.io/badge/Deployment-Cloudflare-blue)
![Health](https://img.shields.io/badge/Health-✅-green)

## Features

### 📊 Portfolio Overview
- Total bonded RUNE tracking with USD valuation
- Real-time RUNE price (USD)
- Weighted APY calculations with benchmark comparison
- Provider exposure scoring and ranked next actions
- Net earnings transparency (gross vs net after fees)

### ⛓️ Provider Exposure
- Active/Standby/Ready status monitoring
- Bond amount and rank tracking
- Slash points and jail status
- Churn-out risk assessment
- Node operator fee impact analysis
- Background browser push alerts for provider exposure transitions

### 💰 Rewards & Earnings
- P&L dashboard with initial bond tracking
- Fee impact breakdown (leakage analysis)
- Auto-compound projections
- RUNE price chart with multiple timeframes
- Yield benchmarking (User vs Network vs Top Nodes)

### ⚠️ Risk Monitoring
- Slash monitor with severity levels
- Network security metrics (TVL, bond-to-pool ratio)
- Unbond window tracker
- Churn-out risk indicators
- Provider exposure score with actionable insights

### 🔧 Transaction Tools
- BOND/UNBOND memo composer
- Transaction history from Midgard using `type=` filter
- Wallet connection (Ledger address review, Vultisig, Keplr, XDEFI)
- Watchlist management

### 🌊 LP Status Trust Rebuild
- USD-based LP portfolio hero (`Total LP Value`, `Net P/L`, `Positions`, `Last Activity`)
- Investor-facing LP cards and table rows with real asset symbols (`ATOM`, `DOGE`, `BCH`)
- Honest `current-only` fallback when historical entry pricing cannot be proven
- Pricing-confidence banner instead of fake `0.00%` LP performance metrics
- Truthful missing-address state on `/dashboard/lp`

## Tech Stack

- **Framework**: Next.js 16.3.6 (App Router, Turbopack); vinext on Cloudflare Workers
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4
- **Data Fetching**: SWR
- **Charts**: Recharts (with ResponsiveContainer fixes for clean rendering)
- **Testing**: Vitest source tests + Playwright E2E specs across desktop and focused mobile-critical projects
- **Icons**: lucide-react
- **Deployment**: Cloudflare Worker via GitHub Actions; Ansible/VPS rollback
- **Security**: Ansible Vault for sensitive variables

## Getting Started

```bash
# Use the project Node version
nvm use

# Install dependencies
npm ci

# Start development server
npm run dev

# Run unit tests
npm test

# Run production E2E tests; release verification should use CI=true to force a fresh server/build
CI=true npm run e2e

# Reuse an already-running local server only when explicitly requested
npm run e2e:reuse

# Run E2E tests with the default config (fresh production server unless PLAYWRIGHT_REUSE_SERVER=true)
npm run e2e

# Run E2E tests with UI
npm run e2e:ui

# Build for production
npm run build
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

Copy `.env.example` to `.env.local` when you need local overrides. Do not put
secrets in `NEXT_PUBLIC_*` variables; they are bundled into client-side code.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_THORNODE_API` | THORNode API endpoint | `https://gateway.liquify.com/chain/thorchain_api` |
| `NEXT_PUBLIC_MIDGARD_API` | Midgard API endpoint | `https://gateway.liquify.com/chain/thorchain_midgard` |
| `NEXT_PUBLIC_MIDGARD_FALLBACK` | Secondary Midgard fallback | `https://midgard.thorchain.network` |
| `NEXT_PUBLIC_THORCHAIN_RPC` | THORChain RPC | `https://gateway.liquify.com/chain/thorchain_rpc` |
| `NEXT_PUBLIC_TRACK_API` | THORChain tracker URL | `https://track.thorchain.org/` |
| `NEXT_PUBLIC_COINGECKO_API` | CoinGecko API base URL | `https://api.coingecko.com/api/v3` |
| `NEXT_PUBLIC_THORCHAIN_NETWORK` | THORChain network label baked into the client bundle | `mainnet` |
| `NEXT_PUBLIC_APP_URL` | Canonical app URL used by CORS/server diagnostics | `https://bond.thorchain.no` |
| `NEXT_PUBLIC_USE_MOCK_DATA` | Local/test-only mock data toggle | `false` |
| `COINAPI_KEY` | Optional server-side CoinAPI key; never expose as `NEXT_PUBLIC_*` | unset |
| `TRUST_PROXY_HEADERS` | Server-side rate limiting: trust a deployment proxy's overwritten `X-Real-IP` header | `false` locally; `true` in production deploy |
| `TRUST_X_FORWARDED_FOR` | Server-side rate limiting: also trust `X-Forwarded-For`; enable only when the full proxy chain sanitizes it | `false` |
| `TRUST_CLOUDFLARE_HEADERS` | Server-side rate limiting: trust `CF-Connecting-IP` when directly behind Cloudflare | `false` |
| `TRUST_VERCEL_PROXY_HEADERS` | Server-side rate limiting: trust Vercel forwarded IP headers outside the Vercel runtime | `false` |
| `VERSION` | Runtime app version; Ansible sets this to the immutable deployed image tag | `sha-<short>` |
| `HEIMDALL_DATA_DIR` | Durable server-side data directory for background notification subscriptions | `.heimdall-data` locally; `/data` in production |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | Public VAPID key returned by `/api/notifications/status` for browser push subscriptions | unset |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Server-only VAPID private key used to send browser push notifications | unset |
| `WEB_PUSH_CONTACT` | VAPID subject/contact for Web Push delivery | unset |
| `NOTIFICATION_POLL_INTERVAL_MS` | Background provider-alert monitor interval; values below 30s are clamped | `60000` |
| `HEIMDALL_NOTIFICATION_RUNNER_TOKEN` | Bearer token for the optional internal notification monitor trigger route | unset |
| `HEIMDALL_NOTIFICATION_MAX_SUBSCRIPTIONS` | Runtime-wide cap for stored browser push subscriptions | `1000` |
| `HEIMDALL_NOTIFICATION_MAX_SUBSCRIPTIONS_PER_ADDRESS` | Per-address cap for stored browser push subscriptions | `10` |

`NEXT_PUBLIC_*` variables are build-time public configuration: Docker/CI passes
them as `--build-arg` so browser JavaScript is baked deterministically. Runtime
Ansible or Compose entries with the same names are for server-side rendering and
diagnostics only; they do **not** rewrite an already-built client bundle.
For a throwaway local mock-data build, set `NEXT_PUBLIC_USE_MOCK_DATA=true`
before `npm run build` and use `thor1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5e949nr`
as the demo provider address.
Proxy trust variables only affect server-side best-effort rate-limit identity.
Leave forwarding headers untrusted unless the deployment proxy overwrites or
sanitizes them.
Background notifications are server-triggered browser push alerts. They require
VAPID keys and a durable `HEIMDALL_DATA_DIR`; without those, the notification
settings page stays read-only and the local open-tab alert fallback still works.
Subscription caps are enforced server-side because these routes are public.

## THORChain Data Conventions

Before changing API clients, live-data charts, RUNE/APY math, or LP valuation copy, read [docs/thorchain-data-conventions.md](docs/thorchain-data-conventions.md). It is shared with tcwiki and defines endpoint routing, `1e8` RUNE units, APY decimal-vs-percent boundaries, and `current-only` LP valuation provenance.

## Deployment

Heimdall deploys to Cloudflare Workers from the passing `master` CI workflow.
The VPS image and Ansible playbook are reserved for rollback.

The Cloudflare Free migration path, preview gates, CI flag, and VPS rollback
procedure are in [DEPLOYMENT.md](DEPLOYMENT.md#cloudflare-free-migration).

### Architecture
```
Developer Push → GitHub → CI (tests, builds, E2E)
                       ↓
                  Cloudflare Worker (heimdall)
                       ↓
                  bond.thorchain.no

Rollback: GHCR image → Ansible → VPS container → Caddy
```

### VPS Rollback Deploy
```bash
# 1. Ensure Ansible is installed (via Homebrew)
brew install ansible

# 2. Run deployment playbook
cd /Users/reidar/Projectos/Heimdall
IMAGE_TAG=sha-<exact-short-sha> ansible-playbook \
  -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```

By default the playbook deploys
`ghcr.io/reedtrullz/heimdall:sha-<local short sha>` and sets runtime `VERSION`
to the same immutable tag. Override with `IMAGE_TAG=sha-<exact-short-sha>` when
deploying a specific published image; the playbook rejects mutable deploy tags
such as `latest`.

`compose.production.yml` is only a manual/diagnostic path and also refuses to
default to a mutable image: run it through the validation wrapper with
`IMAGE_SHA=<exact-short-sha>` so the image and runtime `VERSION` both resolve to
`sha-$IMAGE_SHA`:

```bash
IMAGE_SHA=<exact-short-sha> scripts/compose-production.sh config
IMAGE_SHA=<exact-short-sha> scripts/compose-production.sh up -d
```

### Release checks
- **Liveness and readiness**: CI checks `/api/health` and `/api/ready` for the exact source SHA.
- **CPU**: Check Worker and Durable Object CPU in Cloudflare Observability after deployment.
- **Rollback**: The preserved GHCR image, Ansible playbook, and VPS data support an intentional rollback.
- **Notifications**: Open-tab alerts remain available. Background push is unconfigured and needs durable Cloudflare storage before enabling it.
See [DEPLOYMENT.md](DEPLOYMENT.md) for full details. The Inebotten
Discord bot is a separate project — see
[Reedtrullz/inebotten-discord](https://github.com/Reedtrullz/inebotten-discord)
(its `deploy/` directory contains its own playbook).

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── api/                # Server-side API proxy routes (bypass CORS)
│   ├── dashboard/          # Dashboard pages (portfolio, nodes, rewards, risk, transactions, lp)
│   ├── layout.tsx          # Root layout with ThemeProvider
│   └── page.tsx            # Landing page
├── components/
│   ├── dashboard/          # 18+ domain components (charts, tables, monitors)
│   ├── layout/             # sidebar, dashboard-shell, theme-toggle
│   ├── wallet/             # wallet-connect, transaction-review
│   ├── alerts/             # alert-toast
│   ├── shared/             # address-input, status-badge, export-button
│   └── ui/                 # shadcn-style primitives
└── lib/
    ├── api/                # THORNode + Midgard API clients
    ├── hooks/              # SWR data hooks
    ├── transactions/       # BOND/UNBOND signing
    ├── types/              # TypeScript interfaces
    └── utils/              # formatters, calculations, health scoring
```

## API CORS Workaround

External Midgard/THORNode APIs block browser requests due to CORS. The app uses server-side proxy routes:

- `/api/midgard/*` → proxies to `gateway.liquify.com/chain/thorchain_midgard` (falls back to `midgard.thorchain.network`)
- `/api/thorchain/*` → proxies to `gateway.liquify.com/chain/thorchain_api/thorchain`

All API calls from frontend go through these proxies, bypassing browser CORS restrictions.

> The legacy `gateway.liquify.com/chain/thorchain_mainnet` path returns HTTP 500 and is not a valid endpoint. Use `thorchain_api` and `thorchain_midgard`.

> The `/api/thorchain/*` proxy normalises a leading `thorchain/` segment in the request path before applying its allowlist (see `src/app/api/thorchain/[...path]/route.ts`). The frontend client adds that prefix, and `THORNODE_API_URL` already ends in `/thorchain` — don't remove the normalisation.

## Supported Wallets

- **Ledger Hardware Wallet** — THORChain address and balance review over WebHID after the device is unlocked, the THORChain app is open, and the address is confirmed on device; BOND/UNBOND broadcast remains disabled until Ledger THORChain `MsgDeposit` signing is hardware-verified
- **Vultisig Extension** — THORChain extension provider with BOND/UNBOND broadcast support
- **Keplr Wallet** — Cosmos-based wallet with THORChain support
- **XDEFI Wallet** — Cross-chain desktop wallet

## E2E Testing

We use Playwright for end-to-end testing. Tests are in the `e2e/` directory.

```bash
# Run all E2E tests
npm run e2e

# Run with UI mode (debugging)
npm run e2e:ui

# Run specific test file
npx playwright test e2e/portfolio.spec.ts

# View test report
npx playwright show-report
```

### E2E Best Practices (from CI fixes)
- Prefer semantic locators scoped to the named region, landmark, card, table, tab panel, or dialog under test
- Use `{ exact: true }` for page/title headings and compact repeated labels when partial matches could pass against duplicate UI
- Mock API endpoints in `test.beforeEach()` for predictable tests
- Check page headings with `getByRole('heading', { name: ... })` 
- Avoid fragile XPath locators; use semantic text/role locators
- Do not use broad `.first()`, `.nth()`, or `.last()` to silence duplicate matches; narrow the surface first
- Handle missing elements gracefully (e.g., charts with `minWidth={0} minHeight={0}`)
## CI / CD

The `master` branch uses a single GitHub Actions workflow at
`.github/workflows/ci.yml`:

- **test** — Vitest unit tests + coverage
- **build** — Next.js production build
- **e2e** — Playwright E2E tests
- **cloudflare-build** — vinext Worker build
- **deploy-cloudflare** — deploys the exact master SHA and verifies health/readiness when the repository flag is enabled
- **docker-build** — non-pushing Docker build verification for PR, staging, and other non-`master` refs
- **publish** — runs only on `push` to `master`, after the three above pass.
  Builds the canonical `Dockerfile` with Buildx and publishes the GHCR
  `sha-<short>` tag.

The workflow keeps GitHub and Docker JavaScript actions on Node 24-capable
majors (`actions/checkout@v6`, `actions/setup-node@v6`,
`actions/upload-artifact@v7`, `docker/setup-buildx-action@v4`,
`docker/build-push-action@v7`, `docker/login-action@v4`, and
`docker/metadata-action@v6`) so CI does not regress to Node.js 20 deprecation
warnings.

Deploy verification compares the master SHA with the `version` returned by
both live `/api/health` and `/api/ready`. For a VPS rollback, compare the
GHCR tag, Ansible's selected tag, the container image, and both versions.

There is no separate publish workflow and no cross-workflow `workflow_run`
trigger. See `CLAUDE.md` and `AGENTS.md` for the rationale.

## Live Verification Checklist

The deployed site at `https://bond.thorchain.no` is the source of truth for user-facing QA. Production fixes are considered deployed only after the exact image SHA is re-tested there, including matching `version` values from `/api/health` and `/api/ready`.

After deployment, verify:
- Dashboard routes keep rendering when optional THORName or upstream pool-history calls degrade.
- LP valuation clearly labels `current-only` or degraded pricing when historical data is unavailable.
- Notification prompts stay non-blocking; background browser push stays configured after restart/update, and notification settings immediately affect live open-tab alerts.
- Portfolio/node quick actions preserve the intended BOND or UNBOND transaction mode.
- Transaction preview shows wallet/network-confirmed fee copy, memo copy feedback, and clear UNBOND memo semantics.
- Rewards controls, tax export, changelog search, filters, and entry buttons all produce visible results.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm test` and `npm run e2e`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Submit a pull request

## License

MIT
