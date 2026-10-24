# Stage 1: Build
FROM node:22-slim AS builder

ARG NEXT_PUBLIC_THORNODE_API
ARG NEXT_PUBLIC_MIDGARD_API
ARG NEXT_PUBLIC_THORCHAIN_RPC
ARG NEXT_PUBLIC_TRACK_API
ARG NEXT_PUBLIC_MIDGARD_FALLBACK
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_COINGECKO_API
ARG NEXT_PUBLIC_THORCHAIN_NETWORK
ARG NEXT_PUBLIC_USE_MOCK_DATA
ARG VERSION

ENV NEXT_PUBLIC_THORNODE_API=${NEXT_PUBLIC_THORNODE_API}
ENV NEXT_PUBLIC_MIDGARD_API=${NEXT_PUBLIC_MIDGARD_API}
ENV NEXT_PUBLIC_THORCHAIN_RPC=${NEXT_PUBLIC_THORCHAIN_RPC}
ENV NEXT_PUBLIC_TRACK_API=${NEXT_PUBLIC_TRACK_API}
ENV NEXT_PUBLIC_MIDGARD_FALLBACK=${NEXT_PUBLIC_MIDGARD_FALLBACK}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_COINGECKO_API=${NEXT_PUBLIC_COINGECKO_API}
ENV NEXT_PUBLIC_THORCHAIN_NETWORK=${NEXT_PUBLIC_THORCHAIN_NETWORK}
ENV NEXT_PUBLIC_USE_MOCK_DATA=${NEXT_PUBLIC_USE_MOCK_DATA}
ENV VERSION=${VERSION}

WORKDIR /app
# pnpm comes from Corepack at the exact version pinned by package.json "packageManager".
# pnpm installs the lockfile's optional platform packages by default (npm needed --include=optional).
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build \
  && mkdir -p .next/standalone/node_modules \
  && for pkg in \
       lightningcss-linux-x64-gnu \
       @tailwindcss/oxide-linux-x64-gnu \
       @img/sharp-linux-x64 \
       @img/sharp-libvips-linux-x64; do \
         src="$(find node_modules/.pnpm -type d -path "*/node_modules/${pkg}" | head -n 1)"; \
         if [ -n "${src}" ]; then \
           mkdir -p ".next/standalone/node_modules/$(dirname "${pkg}")"; \
           cp -R "${src}" ".next/standalone/node_modules/${pkg}"; \
         fi; \
       done

# Stage 2: Production runner
FROM node:22-slim AS runner
ARG VERSION
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV VERSION=${VERSION}

RUN id -u node >/dev/null 2>&1 || useradd -m node
RUN mkdir -p /data && chown node:node /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "server.js"]
