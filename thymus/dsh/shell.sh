#!/usr/bin/env bash
# 最小 web 壳：真 dsh agent loop + 真 Thymus 网关，端口 3083。
# 源码要在 dsh workspace 里才解析得到 @deepseek-ai/*，所以照 demo/run.sh 的老办法拷进去再起。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/thymus-shell"
cleanup() { rm -rf "$DEST"; }
trap cleanup EXIT
set -a; . "$ROOT/.env.local"; set +a
mkdir -p "$DEST/src" "$DEST/campus" "$DEST/dsh"
cp "$ROOT"/packages/thymus/src/*.ts "$ROOT"/thymus/src/*.ts "$DEST/src/"
cp "$ROOT"/thymus/campus/*.ts "$DEST/campus/"
cp "$ROOT"/thymus/dsh/*.ts "$DEST/dsh/"
cd "$DSH"
export NODE_OPTIONS="${NODE_OPTIONS:-} --use-env-proxy"
exec corepack pnpm exec tsx "$DEST/dsh/web-shell.ts"
