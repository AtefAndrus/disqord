# 依存の取得は slim で行い、実行は distroless で行う。取得を別ステージに分けるのは、
# .npmrc や bun のキャッシュを実行イメージに残さず、node_modules だけを複製するため。
# 2 つの FROM の bun は同じ patch にする (CI の drift check が両方を mise.toml と比べる)
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS install
RUN mkdir -p /temp/prod /temp/data
# .npmrc も渡す。bun.lock は取得元を持たないので、これが無いと本番イメージのビルドだけが
# Takumi Guard を経由せず既定レジストリから取得することになる
COPY package.json bun.lock .npmrc /temp/prod/
# --ignore-scripts: prepare (lefthook install) は dev 用 hook 設定で、本番イメージでは不要かつ devDependency 不在で失敗する
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

# 実行イメージは bun と libc、CA 証明書、tzdata だけを持つ distroless にする。
# slim は bot が一度も呼ばない util-linux や apt などの Debian パッケージを 80 個含み (1.4.4-slim の dpkg-query -W)、
# その脆弱性が修正されないまま残るうえ、侵入された場合に sh や apt を足場として使われる。
# bot はプロセスを起動せず (src に child_process も Bun.spawn も無い)、bun:sqlite は
# SQLite を bun に同梱しているので、OS のパッケージを必要としない
FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS release
WORKDIR /app

# distroless の /etc/passwd に bun ユーザは無いので、slim の bun ユーザと同じ uid / gid を数値で指定する。
# 本番の StatefulSet も runAsUser: 1000 / fsGroup: 1000 で動き、既存の PVC のファイルもこの uid が持つ
COPY --from=install --chown=1000:1000 /temp/prod/node_modules node_modules
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 package.json CHANGELOG.md ./

# SQLite の置き場 (volume のマウント先)。シェルも mkdir も無いので、空のディレクトリを複製して作る
COPY --from=install --chown=1000:1000 /temp/data /app/data

ENV NODE_ENV=production

# Expose health check port
EXPOSE 3000

# シェルが無いので exec 形式で書く。シェル形式は /bin/sh -c を経由するため distroless では必ず失敗する
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Security: run as non-root user (distroless の既定は root)
USER 1000:1000

# distroless は ENTRYPOINT に bun を持ち、そのままでは CMD が bun の引数として渡る。
# slim と同じく CMD だけで起動コマンドが決まるよう ENTRYPOINT を空にする
ENTRYPOINT []
CMD ["bun", "run", "src/index.ts"]
