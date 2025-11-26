FROM oven/bun:1.3-slim AS base
WORKDIR /app

COPY package.json tsconfig.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY docs ./docs

CMD ["bun", "run", "src/index.ts"]
