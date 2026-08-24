#!/usr/bin/env bash
# 在真 dsh 的 web 界面里跑 Thymus。需要 .env.local 里的 DEEPSEEK_API_KEY。
#
# 源码要在 dsh workspace 里才解析得到 @deepseek-ai/* 依赖，所以照 demo/run.sh 的老办法
# 拷进去再起。端口 3082（避开 web-cordis 那个 demo 的 3081）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/thymus-web"

cleanup() { rm -rf "$DEST"; }
trap cleanup EXIT

set -a; . "$ROOT/.env.local"; set +a
mkdir -p "$DEST/src" "$DEST/campus" "$DEST/dsh"
cp "$ROOT"/packages/thymus/src/*.ts "$ROOT"/thymus/src/*.ts "$DEST/src/"
cp "$ROOT"/thymus/campus/*.ts "$DEST/campus/"
cp "$ROOT"/thymus/campus/*.md "$DEST/campus/" 2>/dev/null || true
cp "$ROOT"/thymus/dsh/plugin.ts "$DEST/dsh/"

cat > "$DEST/cordis.yml" <<YML
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082

- insert:
    - id: thymus
      name: '$DEST/dsh/plugin.ts'
YML

cd "$DSH"
export NODE_OPTIONS="${NODE_OPTIONS:-} --use-env-proxy"
exec node --import tsx apps/cli/src/bin.ts web --patch "$DEST/cordis.yml"
