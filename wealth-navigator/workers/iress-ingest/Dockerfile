# Build context: wealth-navigator/ (repo app root)
FROM oven/bun:1.1 AS base
WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src
COPY workers/iress-ingest ./workers/iress-ingest

ENV NODE_ENV=production
WORKDIR /app
CMD ["bun", "workers/iress-ingest/src/main.ts"]
