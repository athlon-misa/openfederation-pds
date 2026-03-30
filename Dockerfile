# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
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
FROM node:22-alpine
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
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/src/index.js"]
