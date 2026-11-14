# OpenFederation dashboard, production image (#405).
#
# Build context: this folder (web-interface/). One image serves any PDS: the
# address is read when the container starts, from PDS_URL (see
# src/lib/runtime-config.ts), so nothing install-specific is baked in.
#
#   docker build -t openfederation-dashboard web-interface
#   docker run -p 3000:3000 -e PDS_URL=https://pds.example.org openfederation-dashboard
#
# Railway does not use this file: it builds with Nixpacks (nixpacks.toml).

# Stage 1: dependencies and build
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone output: a self-contained server.js with only the files it needs.
ENV NEXT_OUTPUT=standalone
RUN rm -rf .next && NODE_ENV=production npm run build

# Stage 2: runtime
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# A small heap is plenty for the dashboard server; keeps 2 GB hosts comfortable.
ENV NODE_OPTIONS="--max-old-space-size=256"
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/runtime-config.js || exit 1
CMD ["node", "server.js"]
