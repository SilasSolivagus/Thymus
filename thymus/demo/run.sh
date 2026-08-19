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
git -C "$DSH" apply "$ROOT/probes/scope-fix.patch"
mkdir -p "$DSH/thymus-demo/src" "$DSH/thymus-demo/demo"
cp "$ROOT"/thymus/src/*.ts "$DSH/thymus-demo/src/"
cp "$ROOT"/thymus/demo/run.ts "$DSH/thymus-demo/demo/"
cd "$DSH"
CI=true corepack pnpm exec tsx thymus-demo/demo/run.ts
