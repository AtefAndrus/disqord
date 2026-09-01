FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS base
WORKDIR /app

# Install dependencies (cache optimization)
FROM base AS install
RUN mkdir -p /temp/prod
# .npmrc も渡す。bun.lock は取得元を持たないので、これが無いと本番イメージのビルドだけが
# Takumi Guard を経由せず既定レジストリから取得することになる
COPY package.json bun.lock .npmrc /temp/prod/
# --ignore-scripts: prepare (lefthook install) は dev 用 hook 設定で、本番イメージでは不要かつ devDependency 不在で失敗する
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

# Release image
FROM base AS release

# Copy with correct ownership for bun user
COPY --from=install --chown=bun:bun /temp/prod/node_modules node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun package.json .

# Create data directory for SQLite (volume mount target)
RUN mkdir -p /app/data && chown -R bun:bun /app/data

# Environment configuration
ENV NODE_ENV=production

# Expose health check port
EXPOSE 3000

# Health check using Bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Security: run as non-root user
USER bun

CMD ["bun", "run", "src/index.ts"]
