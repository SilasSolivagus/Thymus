#!/usr/bin/env bash
# 用 dsh 自己的加载器把 Thymus 当插件挂起来。
#
# 组一份**最小 profile**：`dsh.profile.bundles` 写空，所以不会拉 `dsh-base`——
# base 里的 typert-loader 要读各包的 `lib/typert.host.js` 生成产物，而这份 vendored
# checkout 没构建过。只列这条链真正需要的插件，从源码解析（tsx + tsconfig paths）。
#
# 源码要在 dsh workspace 里才解析得到 @deepseek-ai/*，所以照 demo/run.sh 的老办法拷进去。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="$ROOT/vendor/deepseek-harness"
DEST="$DSH/thymus-shell"
HOME_DIR="${THYMUS_DSH_HOME:-$DEST/.dsh}"
PORT="${THYMUS_PORT:-3083}"

cleanup() { rm -rf "$DEST"; }
trap cleanup EXIT

set -a; . "$ROOT/.env.local"; set +a
mkdir -p "$DEST/src" "$DEST/campus" "$DEST/dsh" "$HOME_DIR/profiles/thymus"
cp "$ROOT"/packages/thymus/src/*.ts "$ROOT"/thymus/src/*.ts "$DEST/src/"
cp "$ROOT"/thymus/campus/*.ts "$DEST/campus/"
cp "$ROOT"/thymus/dsh/*.ts "$DEST/dsh/"

cat > "$HOME_DIR/profiles/thymus/package.json" <<JSON
{
  "name": "dsh-profile-thymus",
  "private": true,
  "dsh": { "profile": { "bundles": [] } }
}
JSON

cat > "$HOME_DIR/profiles/thymus/cordis.patch.yml" <<YML
# 最小组合：够跑一个带工具的客服 agent，加上 Thymus 治理与观察界面。
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: llm
      name: '@deepseek-ai/dsh-llm'
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek'
    - id: session
      name: '@deepseek-ai/dsh-session'
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        persona: '你是校园网客服，负责回答学生关于账号、账单、网络的问题。你有四个工具：lookup_account（按学号+手机号核验身份）、query_bill（查账单）、create_ticket（建工单）、query_network（查学校网络状态）。'
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: agents
      name: '@deepseek-ai/dsh-agent'
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
    - id: thymus
      name: '$DEST/dsh/plugin.ts'
    - id: thymus-ui
      name: '$DEST/dsh/ui-plugin.ts'
      config:
        port: $PORT
YML

cd "$DSH"
export DSH_HOME="$HOME_DIR"
export NODE_OPTIONS="${NODE_OPTIONS:-} --use-env-proxy"
exec node --import tsx apps/cli/src/bin.ts --profile thymus
