#!/usr/bin/env bash
# Thymus 实跑：接真 DeepSeek。需要 .env.local 里的 DEEPSEEK_API_KEY。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"

cleanup() {
  rm -rf "$DSH/thymus-demo"
  git -C "$DSH" checkout -- packages/extensions/cordis-host-runner/src/index.ts 2>/dev/null || true
}
trap cleanup EXIT

set -a; . "$ROOT/.env.local"; set +a
export THYMUS_STORE="$ROOT/thymus/trajectories"
export THYMUS_OUT="$ROOT/thymus/campus/submitted"
git -C "$DSH" apply "$ROOT/probes/scope-fix.patch"
mkdir -p "$DSH/thymus-demo/src" "$DSH/thymus-demo/demo"
cp "$ROOT"/thymus/src/*.ts "$DSH/thymus-demo/src/"
cp "$ROOT"/packages/thymus/src/*.ts "$DSH/thymus-demo/src/"
cp "$ROOT"/thymus/demo/*.ts "$DSH/thymus-demo/demo/"
mkdir -p "$DSH/thymus-demo/campus"
cp "$ROOT"/thymus/campus/*.ts "$DSH/thymus-demo/campus/" 2>/dev/null || true
# SPEC.md 也要拷：有脚本把它当输入喂给模型（author-spec）。
cp "$ROOT"/thymus/campus/*.md "$DSH/thymus-demo/campus/" 2>/dev/null || true
cd "$DSH"
# 这台机器要走代理（HTTP_PROXY）。curl 认这个变量，Node 的 fetch 默认不认，
# 不加这个开关就会直连超时，adapter 报 TRANSPORT——而插件侧的 catch 不触发
# （见 FINDINGS-15），失败会被读成「判定通过」。
export NODE_OPTIONS="${NODE_OPTIONS:-} --use-env-proxy"
CI=true corepack pnpm exec tsx "thymus-demo/${DEMODIR:-demo}/${DEMO:-run}.ts"
