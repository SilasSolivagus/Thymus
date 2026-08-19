#!/usr/bin/env bash
# THYMUS SPIKE — 一次性探针运行器。
# 探针依赖 dsh 自己的测试脚手架（tests/helpers.ts、mock-adapter.ts），
# 必须在 dsh workspace 内运行；这里把它们临时拷进去、跑完再撤走，
# 保证 vendor/deepseek-harness 始终停在 rc.7 的干净状态。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/packages/extensions/cordis-host-runner/tests"

cleanup() { rm -f "$DEST"/thymus-probe*.spec.ts; }
trap cleanup EXIT

cp "$ROOT"/probes/thymus-probe*.spec.ts "$DEST/"
cd "$DSH"
CI=true corepack pnpm vitest run \
  packages/extensions/cordis-host-runner/tests/thymus-probe.spec.ts \
  packages/extensions/cordis-host-runner/tests/thymus-probe-loop.spec.ts \
  packages/extensions/cordis-host-runner/tests/thymus-probe-persist.spec.ts
