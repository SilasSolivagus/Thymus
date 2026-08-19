#!/usr/bin/env bash
# Thymus 自己的测试。源码在 thymus/src/，但必须在 dsh workspace 里跑
# （它 import dsh 的类型），所以临时拷进去、跑完撤走。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/packages/extensions/cordis-host-runner/tests"

cleanup() { rm -rf "$DEST/thymus-src" "$DEST/thymus-trajectory.spec.ts" "$DEST/thymus-recording.spec.ts" "$DEST/thymus-judge.spec.ts"; }
trap cleanup EXIT

mkdir -p "$DEST/thymus-src"
cp "$ROOT"/thymus/src/*.ts "$DEST/thymus-src/"
cp "$ROOT/thymus/thymus-trajectory.spec.ts" "$ROOT/thymus/thymus-recording.spec.ts" "$ROOT/thymus/thymus-judge.spec.ts" "$DEST/"
cd "$DSH"
CI=true corepack pnpm vitest run packages/extensions/cordis-host-runner/tests/thymus-trajectory.spec.ts packages/extensions/cordis-host-runner/tests/thymus-recording.spec.ts packages/extensions/cordis-host-runner/tests/thymus-judge.spec.ts
