# Stage 1: Build
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# The workspace manifests must be in place before `npm ci`, or the dependencies
# declared inside packages/* (e.g. @scure/bip39 for the pseudonym package, whose
# source the server compiles in) are never installed and the build fails.
COPY packages/openfederation-sdk/package.json packages/openfederation-sdk/
COPY packages/openfederation-react/package.json packages/openfederation-react/
COPY packages/openfederation-lexicon/package.json packages/openfederation-lexicon/
COPY packages/openfederation-pseudonym/package.json packages/openfederation-pseudonym/
RUN npm ci
COPY tsconfig.json tsconfig.production.json ./
COPY src/ ./src/
COPY cli/ ./cli/
COPY scripts/ ./scripts/
COPY packages/ ./packages/
RUN npm run build
# Prune dev dependencies for production image
RUN npm ci --omit=dev

# Stage 2: Runtime
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV UV_THREADPOOL_SIZE=8
RUN apk add --no-cache wget
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/scripts/ ./scripts/
COPY --from=builder /app/src/db/schema.sql ./src/db/schema.sql
COPY --from=builder /app/src/lexicon/ ./src/lexicon/
# Run as the unprivileged `node` user that ships with the base image. The blob
# directories are created and handed to it here, so a new named volume mounted
# on either path inherits that ownership. A volume created by an earlier,
# root-running image stays root-owned: chown it once before upgrading
# (docker run --rm -v <volume>:/data/blobs alpine chown -R 1000:1000 /data/blobs).
RUN mkdir -p /data/blobs /app/data/blobs && chown -R node:node /data /app/data
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/src/index.js"]
