# Heimdall Deployment Guide

## Cloudflare Free migration

`cloudflare.config.ts` builds a vinext Worker. Its public fetch handler forwards
dynamic requests to the `HeimdallDO` SQLite Durable Object so rendering uses the
Durable Object CPU allowance. The current VPS notification service has no VAPID
keys or subscriptions; background push remains unavailable on Cloudflare.
Open-tab alerts and preferences stay in the browser. Do not enable VAPID keys
without replacing the filesystem notification store and process timer with
durable storage and a scheduled runner.

Preview: `HEIMDALL_RELEASE_VERSION=preview-<sha> npm run deploy:vinext -- --preview`.
Check the real UI, `/api/health`, `/api/ready`, `/api/notifications/status`,
CoinAPI parity, and Cloudflare request CPU grouped by `executionModel`. The
stateless fetch handler must stay below the Workers Free 10 ms CPU limit; the
Durable Object has its own allowance. A 200 response alone is insufficient.

The single GitHub CI workflow builds both Next.js and vinext on PRs. After
`HEIMDALL_CLOUDFLARE_DEPLOY_ENABLED=1` is set for the repository, a passing
master push deploys the `heimdall` Worker and verifies both health versions
against `sha-<full commit>`. Its token is the repository secret
`HEIMDALL_CLOUDFLARE_API_TOKEN`; the account ID is a repository variable.
`COINAPI_KEY` is a Worker secret. Keep secret values out of builds and reports.

Before cutover, verify the exact master Worker on its workers.dev URL, CPU,
application flows, and rollback image. Attach `bond.thorchain.no` as a Worker
custom domain, confirm public DNS and live Worker version/readiness, then mark
`/etc/heimdall/cloudflare-primary` on the VPS. The Ansible playbook refuses a
normal VPS deployment after this marker exists. To restore the preserved VPS
image intentionally, set `HEIMDALL_VPS_ROLLBACK=1` when running the playbook and
restore the saved Caddy/DNS configuration.

Retire only the old `heimdall` container, its port 3001 Caddy vhost, and its
obsolete production image after live verification. Preserve `/opt/apps/heimdall/data`,
backups, the prior tagged image for rollback, and unrelated services.

## Architecture

```
Local push → GitHub → CI workflow (test, build, e2e, publish)
                              ↓
                   GHCR: ghcr.io/reedtrullz/heimdall:sha-<short>
                              ↓
                   ansible-playbook from local machine
                              ↓
                   VPS pulls image → swaps container → /api/ready gate
                              ↓
                   Caddy proxy (https://bond.thorchain.no)
```

The VPS is a *target*, never a *source*. Don't `git pull` on it; don't build
images on it. CI builds, GHCR stores, Ansible deploys.

## Prerequisites

### Local (control node)
- Ansible: `brew install ansible`
- SSH key at `~/.ssh/id_rsa_racknerd`
- `inventory/hosts.yml` forces that key with `IdentitiesOnly=yes` so the local SSH agent cannot offer other identities first
- Vault password at `~/.vault_pass.txt` (gitignored)

### VPS (managed node)
- Docker
- GHCR pull credentials (read:packages PAT) — `docker login ghcr.io` already done
- UFW + fail2ban (already configured)

## Deploy

```bash
cd /Users/reidar/Projectos/Heimdall
IMAGE_TAG=sha-<exact-short-sha> ansible-playbook \
  -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```

The playbook:
1. Records the currently-running image ID/digest/reference (for rollback)
2. Pulls `ghcr.io/reedtrullz/heimdall:sha-<local short sha>` by default, or `ghcr.io/reedtrullz/heimdall:$IMAGE_TAG` when `IMAGE_TAG` is set and matches `sha-[0-9a-f]{7,40}`
3. Stops + removes old container
4. Starts new container with env vars from playbook + vault (`vault_coinapi_key` is exposed to the container only as server-side `COINAPI_KEY`)
5. Polls `/api/ready` until THORNode and Midgard are reachable through runtime config
6. If promotion fails, rolls back to the previous image and waits on `/api/ready` again
7. Sets runtime `VERSION` to the immutable image tag deployed

### Override variables
```bash
ansible-playbook -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt \
  -e "thornode_api=https://custom-thornode.example.com"
```

Public `NEXT_PUBLIC_*` variables are baked into the Docker image at build time
by CI build args. Ansible runtime values with those names are retained for
server-side rendering/diagnostics and to document the contract, but they cannot
rewrite browser JavaScript in an already-built image. Server-only values such as
`THORNODE_API_URL`, `MIDGARD_API_URL`, `MIDGARD_FALLBACK_URL`,
`TRUST_PROXY_HEADERS`, `TRUST_X_FORWARDED_FOR`, and `COINAPI_KEY` are
runtime-only.

The production playbook sets `TRUST_PROXY_HEADERS=true` because the checked-in
`Caddyfile` overwrites `X-Real-IP` with `{remote_host}` before forwarding to
Next.js. Keep `TRUST_X_FORWARDED_FOR=false` unless every proxy in front of the
app sanitizes incoming `X-Forwarded-For`; otherwise clients can spoof their
rate-limit identity.

### Force a specific immutable tag
The playbook does not default to `:latest`. To deploy an exact published SHA tag:
```bash
IMAGE_TAG=sha-490cac0 ansible-playbook \
  -i inventory/hosts.yml ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```

Use the exact short SHA tag published by CI. The playbook rejects mutable deploy
tags such as `latest`.

`compose.production.yml` is a manual/diagnostic fallback, not the normal release
path. It requires `IMAGE_SHA=<exact-short-sha>` and derives both the image tag
and runtime `VERSION` as `sha-$IMAGE_SHA`; do not use it with mutable tags. Use
the wrapper so non-hex values fail before Compose interpolation:

```bash
IMAGE_SHA=490cac0 scripts/compose-production.sh config
IMAGE_SHA=490cac0 scripts/compose-production.sh up -d
```

## Verify

```bash
# Container status
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16 "docker ps --filter name=heimdall --format '{{.Status}} {{.Image}}'"

# Liveness endpoint
curl -s https://bond.thorchain.no/api/health | jq

# Readiness endpoint used by promotion/rollback gates
curl -s https://bond.thorchain.no/api/ready | jq

# Exact deployed image/version check; image tag and health/ready versions should match.
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16 "docker ps --filter name=heimdall --format '{{.Image}}'"
curl -s https://bond.thorchain.no/api/health | jq -r .version
curl -s https://bond.thorchain.no/api/ready | jq -r .version

# Homepage
curl -s -o /dev/null -w "%{http_code}\n" https://bond.thorchain.no
```

## Rollback

Automatic: the playbook captures the previous image ID/digest/reference before
swapping and restores it if the readiness check fails.

Manual:
```bash
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16
docker stop heimdall && docker rm heimdall
docker run -d --name heimdall --restart unless-stopped \
  -p 127.0.0.1:3001:3000 \
  -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 \
  ghcr.io/reedtrullz/heimdall:sha-<previous-short-sha>
```

## Inebotten (Discord bot, sibling project)

Inebotten is a separate project in its own repo:
[Reedtrullz/inebotten-discord](https://github.com/Reedtrullz/inebotten-discord).
Its deploy playbook lives in that repo at `deploy/`. From a checkout of
that repo:

```bash
ansible-playbook -i deploy/inventory/hosts.yml deploy/ansible-playbook.yml \
  --vault-password-file ~/.vault_pass.txt
```

The Inebotten playbook reuses the same VPS, the same `deploy` user, and
the same `~/.vault_pass.txt` password file as Heimdall, but its secrets
(OpenRouter API key) live in `inebotten-discord/deploy/group_vars/vps/vault.yml` —
not in Heimdall's vault.

## Secrets

Stored encrypted in `group_vars/vps/vault.yml`. Vault password lives at
`~/.vault_pass.txt` (gitignored). Edit with:
```bash
ansible-vault edit group_vars/vps/vault.yml
```

## Troubleshooting

**Container unhealthy:**
```bash
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16 "docker logs --tail 100 heimdall"
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16 "docker exec heimdall node -e \"require('http').get('http://127.0.0.1:3000/api/health', r => { process.exitCode = r.statusCode === 200 ? 0 : 1; r.resume(); }).on('error', () => process.exit(1))\""
```

**GHCR auth on VPS:**
```bash
ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes deploy@198.23.137.16
echo "$GHCR_PAT" | docker login ghcr.io -u Reedtrullz --password-stdin
```

**Ansible can't reach VPS:**
```bash
ansible -i inventory/hosts.yml vps -m ping
```

**CI fails on Docker step but local build works:**
- Ensure new dependencies' linux-x64 prebuilts are added with exact versions to
  `.github/actions/install-deps/action.yml` and both native install lines in
  `Dockerfile`.
- Don't switch to Alpine. See `CLAUDE.md` "Don't" section.

**Deploy reports "ok" but the live site still runs old code:**
- `community.docker.docker_image` with `source: pull` is idempotent by
  image *name*. The Heimdall playbook pins `force_source: yes` so the selected
  immutable tag is verified in GHCR instead of trusting a cached local image —
  keep it.

**"THORNode API is temporarily unavailable" banner appears:**
- The browser hits `/api/thorchain/thorchain/nodes` (the client prepends
  a `/thorchain` path). The proxy at
  `src/app/api/thorchain/[...path]/route.ts` strips a leading
  `thorchain/` segment before applying its allowlist regex. If you see
  HTTP 403 `Proxy path is not allowed`, that normalisation step regressed.
- The proxy's `THORNODE_API_URL` already ends in `/thorchain`. Don't
  duplicate the segment in env values.
