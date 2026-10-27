#!/bin/bash
# SWE-bench Lite 300 全量管线：补丁→评估→清理循环
# 每批 20 实例：agent 生成补丁 → Docker 只评估本批新补丁 → 清容器/镜像/repo
# 增量：Phase 1 跳过已有预测；Phase 2 用本批文件（避免 run_id 变化导致全量重评）
# 磁盘守卫：df -k（KB 单位），<5,000,000KB(=5GB) 触发 Docker 深度清理

set -u
cd /Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness
BENCH=/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench
REPORTS=$BENCH/swe-reports
mkdir -p $REPORTS
export BENCH_PROVIDER=glm-code
export BENCH_MODEL=glm-5.3

TOTAL=300
BATCH=20

for ((start=0; start<TOTAL; start+=BATCH)); do
  end=$((start+BATCH))
  [ $end -gt $TOTAL ] && end=$TOTAL

  echo "=== 批 $start-$end 开始于 $(date) ==="

  # Phase 1: agent 生成补丁（增量追加；本批写 swe-preds-batch.jsonl）
  python3 scripts/bench/swe-docker.py $start $BATCH >> $BENCH/chain.log 2>&1

  # Phase 1.5: 立即清 repo——预测提取后 repo 即无用；批140 教训：repo(6G)+
  # 评估镜像+日志三峰叠加时单并发也会 Errno 28（repo 原等到 Phase 3 才清）
  chmod -R u+w $BENCH/swe-docker-repos 2>/dev/null
  rm -rf $BENCH/swe-docker-repos

  # Phase 2: Docker 只评估本批新补丁（空文件则跳过）
  # 单并发教训（09-21 晚）：max_workers=2 时双镜像构建峰值（matplotlib
  # ~3-4GB×2）+评估日志可吃穿 12GB 余量 → Errno 28 批级折损（批120 损13题）。
  if [ -s $BENCH/swe-preds-batch.jsonl ]; then
    python3 -m swebench.harness.run_evaluation \
      --predictions_path $BENCH/swe-preds-batch.jsonl \
      --dataset_name SWE-bench/SWE-bench_Lite \
      --run_id swe-full-$start \
      --max_workers 1 \
      --timeout 900 \
      --report_dir $REPORTS >> $BENCH/chain.log 2>&1
  else
    echo "=== 批 $start-$end 无新补丁，跳过评估 ===" >> $BENCH/chain.log
  fi

  # Phase 3: 清理（容器+镜像+repo+构建缓存——build cache 是隐性磁盘 eater）
  docker rm $(docker ps -aq) 2>/dev/null
  docker rmi $(docker images -q 'swebench/sweb.eval*') --force 2>/dev/null
  docker builder prune -af 2>/dev/null
  rm -rf $BENCH/swe-docker-repos

  # 磁盘守卫（df -k → KB；10GB=10,000,000KB——批120教训：12GB 也会被双镜像
  # 峰值吃穿，阈值提到 10GB 提前深度清理）
  AVAIL=$(df -k / | tail -1 | awk '{print $4}')
  if [ "$AVAIL" -lt 10000000 ]; then
    echo "⚠️ 磁盘低（${AVAIL}KB）——深度清理" >> $BENCH/chain.log
    docker system prune -af 2>/dev/null
    docker builder prune -af 2>/dev/null
  fi

  echo "=== 批 $start-$end 完成于 $(date) ==="
done

# 终局聚合：汇总所有批报告（resolved/unresolved 集合并集去重）
python3 - <<'EOF' >> $BENCH/chain.log 2>&1
import glob, json
resolved, unresolved = set(), set()
def walk(d):
    if isinstance(d, dict):
        for k, v in d.items():
            if k in ("resolved", "resolved_ids") and isinstance(v, list):
                resolved.update(v)
            elif k in ("unresolved", "unresolved_ids") and isinstance(v, list):
                unresolved.update(v)
            else:
                walk(v)
for f in sorted(glob.glob('/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench/swe-reports/*.json')):
    walk(json.load(open(f)))
n = len(resolved | unresolved)
print(f'[SWE-bench Lite 300 全量终局] resolved {len(resolved)}/{n} = {len(resolved)/n*100:.1f}%' if n else '[SWE] 无报告')
EOF

echo "SWE-bench Lite 300 全量完成: $(date)"
