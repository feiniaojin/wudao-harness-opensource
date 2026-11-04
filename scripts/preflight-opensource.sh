#!/bin/bash
# 发版前本地预检——GitHub Actions 的本地镜像，跑绿了再推（CI 额度昂贵，
# 0.4.21 一天烧了五轮才绿，本脚是其教训的固化）。
#
# 用法: ./scripts/preflight-opensource.sh
#
# 做什么：
#   1. sync-opensource.sh push（清洗快照落到开源仓工作区）
#   2. 开源仓内离线安装 + 全量构建
#   3. 六包 + evals 全量测试（含内部树跑不到的清洗效应：清洗规则改写、
#      内部档案缺席 skipIf、工作区路径差异）
#   4. 汇总红绿；红则 exit 1 且**不**自动推送
#
# 与 CI 的残余差异（诚实披露，预检绿 ≠ CI 必绿）：
#   - OS：本地 macOS vs CI ubuntu（dash/bash、大小写敏感 FS、swiftc 缺席
#     自跳——历史三类平台红已分别在 0.4.21 gate 修掉）
#   - 已知负载竞速族在并行全量下仍偶发（solo 复跑即绿；CI 遇到同款）
set -e

INTERNAL=/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness
OS=/Users/qinyujie/xdev/github/wudao-harness-opensource
cd "$INTERNAL"

echo "=== ① 同步清洗快照到开源仓 ==="
echo y | ./scripts/sync-opensource.sh push | tail -2

echo "=== ② 开源仓离线安装 + 全量构建 ==="
cd "$OS"
pnpm install --frozen-lockfile --offline --ignore-scripts >/dev/null
pnpm build >/dev/null

echo "=== ③ 六包 + evals 全量（这是 CI 将要跑的同一棵树）==="
FAIL=0
for p in core providers server browser web slack evals; do
  printf "packages/%s: " "$p"
  if (cd "packages/$p" && npx vitest run 2>/tmp/preflight-$p.log | grep -E "^ +Tests " | tail -1); then :
  else echo "  ^ 红——日志 /tmp/preflight-$p.log"; FAIL=1; fi
done
printf "packages/cli: "
if (cd packages/cli && npx vitest run 2>/tmp/preflight-cli.log | grep -E "^ +Tests " | tail -1); then :
else echo "  ^ 红——日志 /tmp/preflight-cli.log（负载竞速族先 solo 复跑再判）"; FAIL=1; fi

if [ "$FAIL" != "0" ]; then echo "❌ 预检红——先修再推"; exit 1; fi
echo "✅ 预检绿——可以推送（git push origin main + 重打 tag）"
