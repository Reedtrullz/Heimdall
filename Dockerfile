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
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

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

RUN npm install --no-save --no-package-lock --legacy-peer-deps \
  lightningcss-linux-x64-gnu@1.32.0 \
  @tailwindcss/oxide-linux-x64-gnu@4.3.1 \
  @img/sharp-linux-x64@0.35.4 \
  @img/sharp-libvips-linux-x64@1.3.3

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "server.js"]
