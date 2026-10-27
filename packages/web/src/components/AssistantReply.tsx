// AssistantReply — 助手回复的统一容器（spec 2026-08-26 §3.1 → 116 弧 B
// 去框化）：署名行（16px 小精灵头像 + 悟道）在卡外，正文入 .reply-card
// （平铺裸底——surface 底+边线的卡壳已退役，dsh「90% 面积无框」；框是工具
// 卡/回执卡的语言，不是正文的语言）。历史侧（HistoryItem 的 assistant 分支）
// 与直播侧（LiveArea 的 LiveAnswer）共用同一实现——直播与定稿同构，回合
// 落定时的切换零跳变。
// ω99-275: #3 — 署名徽标从「悟」字面换小精灵头像（用户令 09-10）：空挂点
// .sig-avatar，肤由 html[data-pet-skin] 的 CSS 规则给图（入口 stamp，与
// 主题/强调色同一 dataset 开关范式）。.sig-glyph 保留给 HistoryList 的
// 「注」徽标（styles.css 规则不退役）。
import React from "react";

export function AssistantReply({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="msg-a">
      <div className="msg-sig">
        <span className="sig-avatar" aria-hidden="true" />
        <span className="sig-name">悟道Harness</span>
      </div>
      <div className="reply-card">{children}</div>
    </div>
  );
}
