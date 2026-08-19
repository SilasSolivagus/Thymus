#!/usr/bin/env bash
# THYMUS SPIKE — 作用域阶梯探针。
# 需要给 dsh 打一个 23 行的补丁（probes/scope-fix.patch），跑完自动还原，
# vendor/deepseek-harness 始终停在 rc.7 的干净状态。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/packages/extensions/cordis-host-runner/tests"

cleanup() {
  rm -f "$DEST/thymus-probe-ladder.spec.ts"
  git -C "$DSH" checkout -- packages/extensions/cordis-host-runner/src/index.ts 2>/dev/null || true
}
trap cleanup EXIT

git -C "$DSH" apply "$ROOT/probes/scope-fix.patch"
cp "$ROOT/probes/thymus-probe-ladder.spec.ts" "$DEST/"
cd "$DSH"
CI=true corepack pnpm vitest run \
  packages/extensions/cordis-host-runner/tests/thymus-probe-ladder.spec.ts \
  packages/extensions/cordis-host-runner/tests/
