#!/usr/bin/env bash
# Thymus 的测试。源码 import dsh 的类型，必须在 dsh workspace 里跑——
# 所以临时拷进去、跑完撤走。两处来源：
#   packages/thymus/  插件包（要发布的那部分）
#   thymus/           仍留在实验场的部分（judge / trajectory / turn 及其 spec）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/packages/extensions/cordis-host-runner/tests"
REL="packages/extensions/cordis-host-runner/tests"

# 拷进去的 spec 一律加 thymus- 前缀，撤走时按前缀清，不用逐个列。
cleanup() { rm -rf "$DEST/thymus-src" "$DEST"/thymus-*.spec.ts; }
trap cleanup EXIT

mkdir -p "$DEST/thymus-src"
cp "$ROOT"/packages/thymus/src/*.ts "$DEST/thymus-src/"
cp "$ROOT"/thymus/src/*.ts "$DEST/thymus-src/"

specs=()
for f in "$ROOT"/packages/thymus/tests/*.spec.ts; do
  cp "$f" "$DEST/thymus-$(basename "$f")"
  specs+=("$REL/thymus-$(basename "$f")")
done
for f in "$ROOT"/thymus/thymus-*.spec.ts; do
  cp "$f" "$DEST/"
  specs+=("$REL/$(basename "$f")")
done

cd "$DSH"
CI=true corepack pnpm vitest run "${specs[@]}"
