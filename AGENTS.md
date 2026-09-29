# AGENTS.md — Heimdall

This file is for autonomous coding agents (Claude Code, Codex, OpenCode, etc.).
Human-friendly intro is in `README.md`. Deep AI context is in `CLAUDE.md`.

## Canonical routing
- This checkout (`/Users/reidar/Projectos/Heimdall`, repo `Reedtrullz/Heimdall`) is the canonical THORChain dashboard.
- The older `THORNode Watcher` / BondTrack checkout is archive-only. Do not implement features, fixes, docs, CI, or deployments there unless explicitly recovering historical artifacts.
- Keep Heimdall branding. Do not rename the product back to BondTrack.

## Golden rules
1. **One CI workflow only.** Edit `.github/workflows/ci.yml`. Do not create
   a second workflow with `name: "CI/CD Pipeline"` or `name: "CI"`.
2. **One Dockerfile only.** Edit `Dockerfile`. Do not create `Dockerfile.v2`,
   `Dockerfile-simple`, etc. — they exist only as historical cache-bust hacks
   and are forbidden.
3. **Publish is a job, not a workflow.** It lives inside `ci.yml` as a job
   named `publish` with `needs: [test, build, e2e]`. Don't reintroduce a
   separate `publish.yml` triggered by `workflow_run`.
4. **Image base is `node:22-slim` (glibc).** Don't switch to Alpine — the
   musl variant of `lightningcss` is unreliable.
5. **Run as non-root in the runtime stage.** `USER node`.
6. **Standalone output.** `next.config.ts` sets `output: 'standalone'`; the
   Dockerfile copies `.next/standalone`, `.next/static`, `public`. Don't
   regress to a single-stage build that ships `node_modules` + source.
7. **Liquify upstream paths.** THORNode = `thorchain_api`, Midgard =
   `thorchain_midgard`. The legacy `thorchain_mainnet` path returns HTTP 500
   and is not a valid endpoint. These are baked into `ci.yml` build args.
8. **Proxy path normalisation.** The `/api/thorchain` proxy strips a leading
   `thorchain/` segment before its allowlist regex matches — the frontend
   calls `fetchThornode('/thorchain/nodes')` and `THORNODE_API_URL` already
   ends in `/thorchain`. Don't simplify it away.
9. **Deploy immutable image tags.** Ansible defaults to
   `ghcr.io/reedtrullz/heimdall:sha-<local short sha>` or an explicit
   `IMAGE_TAG`; runtime `VERSION` must match that immutable tag. Keep
   `force_source: yes` on docker_image pull tasks so the selected tag is
   verified in GHCR instead of trusting a cached local image. The manual
   `compose.production.yml` path requires `IMAGE_SHA=<short-sha>` and derives
   both image and runtime version as `sha-$IMAGE_SHA`; do not use `latest`.
10. **Use Node 24-capable GitHub/Docker Actions.** JavaScript actions in
    `.github/workflows/ci.yml` and `.github/workflows/opencode.yml` should stay
    on `actions/checkout@v6`, `actions/setup-node@v6`,
    `actions/upload-artifact@v7`, `docker/setup-buildx-action@v4`,
    `docker/build-push-action@v7`, `docker/login-action@v4`, and
    `docker/metadata-action@v6` so CI avoids Node.js 20 runtime deprecation
    warnings.

## Required commands before pushing
```bash
nvm use            # Node 22, per .nvmrc
npm ci
npm run lint -- --max-warnings=0
npm test
npm run build      # mirrors CI's "build" job
```

## Adding a dependency
1. `npm install <pkg>` (commits to `package-lock.json`).
2. If it ships native binaries, confirm the Linux/x64 optional package is in
   `package-lock.json` and installed by Linux `npm ci --include=optional`.

## App Router specifics
- Client components that use `useSearchParams`/`usePathname` must be wrapped
  in `<Suspense>` at the page boundary.
- API proxy routes export `dynamic = 'force-dynamic'`.
- Use `unstable_noStore()` or `revalidate = 0` to opt out of caching when
  responses are user-specific.

## Deployment
Passing `master` CI deploys the Cloudflare Worker when
`HEIMDALL_CLOUDFLARE_DEPLOY_ENABLED=1`. Verify its exact full SHA against
`/api/health` and `/api/ready` on the intended live domain. Check Worker CPU
and real browser flows before calling a cutover complete.

The Ansible path is reserved for an intentional VPS rollback. Don't deploy
from the VPS. Run from your machine:
```bash
ansible-playbook -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```
The CI publishes the image; Ansible just pulls and swaps containers.
Verify deploy identity by comparing the exact `sha-<short>` tag selected by
Ansible with `docker ps --format '{{.Image}}'` and the `version` returned by
both `/api/health` and `/api/ready`.
Do not claim a production deployment unless that exact-SHA verification was
performed against the intended target.

## API access model

Heimdall is a **public read-only** dashboard. There is no auth.

- All `/api/*` routes accept any client IP. The Caddy proxy and Next.js
  routes do not require a session, token, or API key.
- Address-bound data (`/api/address/[address]`, `/api/pools/[pool]`,
  `/api/tax-report`) is publicly queryable for any THORChain address. This
  is intentional: the dashboard's purpose is to surface on-chain facts.
- CoinAPI is the only third-party with a server-side secret
  (`COINAPI_KEY`). It is used only for historical RUNE price enrichment;
  absence of the key is a 503 from `/api/coinapi/rune-price`, not a
  user-facing failure.
- Rate limiting is best-effort and process-local. Client IP extraction must not
  trust spoofable forwarding headers by default. Production sets
  `TRUST_PROXY_HEADERS=true` only because Caddy overwrites `X-Real-IP` with
  `{remote_host}`; keep `TRUST_X_FORWARDED_FOR=false` unless every proxy in
  front of the app sanitizes incoming `X-Forwarded-For`.
- If a future feature requires per-user data (e.g. personalised watchlists
  across devices), add a separate auth layer (Auth.js or an external IdP)
  and document it here before shipping.

The Inebotten Discord bot is a sibling project with its own repo and
deploy story — see [Reedtrullz/inebotten-discord](https://github.com/Reedtrullz/inebotten-discord)
(`deploy/` directory). It does not belong here.

## Where things live
| Concern | Path |
|---|---|
| App code | `src/` |
| E2E specs | `e2e/` |
| Unit specs | colocated `*.test.ts(x)` |
| Test infra | `src/test/` (MSW, helpers, setup) |
| Workflows | `.github/workflows/ci.yml` |
| Container | `Dockerfile`, `.dockerignore`, `compose.production.yml` |
| Deploy | `ansible-playbook.yml`, `inventory/`, `group_vars/` |
| Docs (live) | `README.md`, `CLAUDE.md`, `AGENTS.md`, `DEPLOYMENT.md`, `docs/` |
| Docs (archive) | `docs/archive/` — read-only, prior audits |
| Data conventions | `docs/thorchain-data-conventions.md` |

## Project structure
```
Heimdall/
├── src/
│   ├── app/                    # Next.js App Router (16 pages + 13 API routes)
│   │   ├── api/                # Server-side proxies/checks: thorchain, midgard, coingecko, coinapi, health, ready, pools, address, tax-report, notifications
│   │   ├── dashboard/          # 11 areas + settings/notifications: portfolio, overview, nodes, rewards, risk, transactions, lp, simulator, explorer, changelogs, settings
│   │   └── learn/              # Educational content + dynamic [slug] articles
│   ├── components/
│   │   ├── dashboard/          # 37 domain widgets (charts, tables, monitors, tx tools)
│   │   ├── layout/             # Shell, sidebar, theme toggle, bifrost status
│   │   ├── shared/             # Reusable atoms: DashboardCard, StatusBadge, Skeleton, etc.
│   │   ├── ui/                 # shadcn/Radix primitives: Button, Card, Tabs, Tooltip, etc.
│   │   ├── wallet/             # Wallet connect + transaction preview
│   │   └── alerts/             # Alert toast
│   ├── lib/
│   │   ├── api/                # THORNode + Midgard + CoinAPI + CoinGecko clients
│   │   ├── hooks/              # 27 SWR data hooks
│   │   ├── transactions/       # BOND/UNBOND signing + memo helpers
│   │   ├── types/              # Domain types: node, lp, wallet
│   │   ├── utils/              # Formatters, calculations, health score, IL, tax export
│   │   ├── config.ts           # Endpoints + network constants
│   │   ├── utils.ts            # cn() class merge helper
│   │   └── mock-data.ts        # Dev/test mock data toggle
│   └── test/                   # MSW server + handlers + test utilities
├── e2e/                        # 20 Playwright specs
└── docs/                       # Living docs + archived audits
```

## High-centrality files
These files are imported most widely — changes here have outsized blast radius:

| File | Importers | Role |
|------|-----------|------|
| `src/lib/types/node.ts` | ~37 | `BondPosition`, `NodeRaw`, `extractBondPositions()` |
| `src/lib/utils/formatters.ts` | ~35 | `runeToNumber()`, `formatRuneAmount()`, `formatBasisPoints()` |
| `src/lib/api/midgard.ts` | ~30 | Midgard client + raw types (607 lines — largest API file) |
| `src/lib/api/thornode.ts` | ~25 | THORNode client + `NodeRaw`, `NetworkConstantsRaw` |
| `src/lib/utils.ts` | ~26 | `cn()` class merge utility |
| `src/lib/config.ts` | ~20 | `ENDPOINTS`, `NETWORK` constants |
| `src/lib/utils/calculations.ts` | ~18 | Bond/LP/network math |

## Data flow
```
Browser component/page
  → SWR hook (src/lib/hooks/*)
    → API client (src/lib/api/thornode.ts | midgard.ts)
      → fetchThornode() | fetchMidgard() (src/lib/api/client.ts)
        → /api/thorchain/* | /api/midgard/* (Next.js route handler)
          → upstream THORNode | Midgard API
```

## Subdirectory AGENTS.md
Each major directory has its own AGENTS.md with domain-specific conventions:
- `e2e/AGENTS.md` — Playwright patterns
- `src/app/AGENTS.md` — Routes + API proxy conventions
- `src/components/dashboard/AGENTS.md` — 40 dashboard widgets
- `src/components/layout/AGENTS.md` — Shell + navigation
- `src/components/shared/AGENTS.md` — Reusable atoms
- `src/components/ui/AGENTS.md` — shadcn/Radix primitives
- `src/lib/api/AGENTS.md` — API client layer + proxy rules
- `src/lib/hooks/AGENTS.md` — 27 SWR hooks
- `src/lib/transactions/AGENTS.md` — BOND/UNBOND signing
- `src/lib/utils/AGENTS.md` — Formatters + calculations
- `src/test/AGENTS.md` — Test infrastructure + MSW
