#!/bin/zsh
# 134 — 马拉松第二模型臂启动器（model_table 的数据源）
#
# 用法:
#   ./scripts/second-model-arm.sh minimax    # 跑 MiniMax-M3 四区分基准
#   ./scripts/second-model-arm.sh deepseek   # 跑 deepseek-v4-pro 四区分基准
#
# 前置:
#   1. ~/.wudao/.credentials.yaml 有对应 provider 的 key
#   2. wudao-bench/ 目录有 τ²/GAIA/SWE/T-Bench 的 harness
#   3. wudao openai shim 跑在 :8790（wudao ui 或直接 server 启动）
#
# 四个区分面（跳过已饱和的 HumanEval/BFCL/polyglot——跑了白跑）:
#   GAIA validation（research 类）
#   SWE-bench Lite（bug-fix 类）
#   τ² telecom（conversation 类）
#   Terminal-Bench 2.1（terminal 类）
set -e

MODEL_KEY="${1:-minimax}"
CD="/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench"

case "$MODEL_KEY" in
  minimax)
    PROVIDER="minimax-code"; MODEL="MiniMax-M3"; TAG="minimax-m3" ;;
  deepseek)
    PROVIDER="deepseek"; MODEL="deepseek-v4-pro"; TAG="deepseek-v4pro" ;;
  *)
    echo "用法: $0 <minimax|deepseek>"; exit 2 ;;
esac

echo "=== 第二模型臂: $PROVIDER/$MODEL ==="
echo "产物目录后缀: $TAG"
echo ""
echo "手动启动各基准（每个是独立的长时任务——建议 tmux 分窗）:"
echo ""
echo "1) GAIA validation（research）:"
echo "   cd $CD && wudao --provider $PROVIDER --model $MODEL -p 'solve this GAIA task' ..."
echo ""
echo "2) SWE-bench Lite（bug-fix）:"
echo "   cd $CD && # 见 swe-pipeline 历史命令，换 --provider/--model"
echo ""
echo "3) τ² telecom（conversation）:"
echo "   cd $CD/tau2-bench && uv run tau2 run \\"
echo "     --domain telecom \\"
echo "     --agent-llm openai/$MODEL \\"
echo "     --user-llm openai/$MODEL \\"
echo "     --num-trials 1 \\"
echo "     --max-concurrency 3 \\"
echo "     --save-to telecom-$TAG-k1 \\"
echo "     --auto-resume"
echo ""
echo "4) Terminal-Bench 2.1（terminal）:"
echo "   cd $CD && # 见 tb21-driver.py 历史，换 provider/model"
echo ""
echo "完成后将结果 populate 进 model_table（packages/evals/src/model-table.ts）"
echo "routableCategories() 从 [] 变为非空——路由器数据面就绪。"
