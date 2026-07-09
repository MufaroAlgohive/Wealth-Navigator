# Build context: wealth-navigator/ (repo app root)
FROM oven/bun:1.1 AS base
WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src
COPY workers/broker-ingest ./workers/broker-ingest

ENV NODE_ENV=production
WORKDIR /app
CMD ["bun", "workers/broker-ingest/src/index.ts"]
