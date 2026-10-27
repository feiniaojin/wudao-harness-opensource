// ω99-316 — /btw 侧问的 web 渲染面：旁路问答气泡 + 一键转正（超越点 1）。
//
// 回答渲染为**标记气泡**（「旁路问答」轻视觉区分，不占主对话的 run
// 结构——SideQaLane 是 composer 上方/对话流旁侧的独立 lane，绝不进
// messages 渲染管线，刷新/恢复会话后自然消失（旁路本就不持久化）。
// 「转入主线」= 把问答对格式化为一条消息走**现有 steering/send 通道**
// （零新协议：忙时进 steering 队列，闲时直接发送——App.onSubmit 复用）。
export interface SideQa {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly rounds: number;
}

/** The promote formatter: the Q/A pair becomes ONE plain message for the
 *  existing send lane. The label tells the main session WHERE this came
 *  from (a promoted side answer — context, not a command). */
export function formatSidePromoteMessage(qa: SideQa): string {
  return `（旁路问答转入主线）\n问：${qa.question}\n答：${qa.answer}`;
}

export function SideQaLane({ qas, onPromote }: {
  readonly qas: readonly SideQa[];
  readonly onPromote: (qa: SideQa) => void;
}): React.ReactNode {
  if (qas.length === 0) return null;
  return (
    <div className="sideqa-lane" data-sideqa-lane>
      {qas.map((qa) => (
        <div className="sideqa" data-sideqa key={qa.id}>
          <div className="sideqa-tag">旁路问答</div>
          <div className="sideqa-q">{qa.question}</div>
          <div className="sideqa-a">{qa.answer}</div>
          <div className="sideqa-foot">
            <span className="sideqa-rounds">{qa.rounds} 轮</span>
            <button
              type="button"
              className="sideqa-promote"
              onClick={() => {
                onPromote(qa);
              }}
            >
              转入主线
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
