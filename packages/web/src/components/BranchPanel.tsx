// ω99-258: #3 — the web branch face's widgets (桌面「从这里岔开」与分支切换).
// M53 的分支代数早已存在（core 纯层 + driver 三方法 + server 三 op）；本弧接
// 上第一公里：ArmedBranchBanner（岔开已装填——原文已带回输入框、取消即解除）
// 与 BranchBar（转录头的分支 chip「第 N/M 条线」+ 叶表面板：forkPreview/条数/
// 当前标记/切到这里）。数据 = branchLeaves 读 op 快照（打开时取一次+切换后重
// 取，不做实时订阅——v1 诚实边界见弧报告）；老 server 缺场 → chip 整面隐藏
// （与 245 健康行/251 点名行同族的零噪音门），绝不白屏。SimpleMode/pet 车道
// 零渲染——这两个组件只挂 advanced/buddy 的共享 chatColumn。
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BranchLeaf, WudaoClient } from "../protocol.js";
import { Icon } from "./Icon.js";
import { IconCheck } from "./icons.js";
import { classifyNotice } from "../notice-variant.js";

/** The armed-/edit banner — the branch point is picked, the original text is
 *  back in the composer (editable); a plain submit forks from there, the
 *  mainline stays on the tree. 取消 voids the arm (edit op n:0) — on an old
 *  server that refuses, the caller keeps the banner up honestly. */
export function ArmedBranchBanner({ n, onCancel }: { readonly n: number; readonly onCancel: () => void }): React.JSX.Element {
  return (
    <div className="armed-branch" role="status">
      <span className="armed-text">{`将从第 ${n} 轮开分支（原消息已带入，可修改后发送）；发送即岔开，主线保留`}</span>
      <button type="button" className="wudao action" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

/** The transcript head's branch line: a chip naming the active line
 *  (`第 N/M 条线`) that opens the leaf panel below it. Rendering rules (the
 *  zero-noise gate): no data yet / fetch failed (old server) → nothing; a
 *  single-line session → nothing to switch → nothing until the panel is open.
 *  Panel rows carry forkPreview (the 60-char fork point — v1's human-readable
 *  identity; naming is a pooled arc), messageCount, the 当前 mark, and the
 *  non-current rows' 「切到这里」; the switch reply text renders inline (the
 *  busy refusal is honest feedback, not a silent no-op). */
export function BranchBar({ client, refreshTick }: { readonly client: WudaoClient; readonly refreshTick: number }): React.JSX.Element | null {
  const [leaves, setLeaves] = useState<readonly BranchLeaf[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switchNote, setSwitchNote] = useState<string | null>(null);

  const load = useCallback((): void => {
    void client.branchLeaves()
      .then((rows: readonly BranchLeaf[]) => { setLeaves(rows); })
      .catch(() => { setLeaves(null); }); // old server / socket gone — hide the face
  }, [client]);
  // mount + the App's refresh ticks (a fork landed / the history epoch reset).
  // The FIRST fetch defers one macrotask: the App's synchronous boot ops
  // (listSlashCommands first among them) own the wire's head — relays and
  // tests key on that order, and a child effect would fire first.
  const firstFetch = useRef(true);
  useEffect(() => {
    if (firstFetch.current) {
      firstFetch.current = false;
      const t = setTimeout(load, 0);
      return () => { clearTimeout(t); };
    }
    load();
  }, [load, refreshTick]);
  // fresh snapshot when the panel opens (v1: snapshot on open, no subscription).
  useEffect(() => { if (open) load(); }, [open, load]);

  const onSwitch = useCallback((leaf: BranchLeaf): void => {
    setSwitchNote(null);
    void client.switchBranch(leaf.n)
      .then((text: string) => { setSwitchNote(text); load(); }) // the swap already landed driver-side — refetch flips isCurrent
      .catch((e: unknown) => { setSwitchNote(`⚠️ 切换失败：${e instanceof Error ? e.message : String(e)}`); });
  }, [client, load]);

  if (leaves === null) return null;
  if (leaves.length < 2 && !open) return null;
  const current = leaves.find((l) => l.isCurrent) ?? null;
  return (
    <div className="branch-bar">
      <button type="button" className="branch-chip" aria-expanded={open} onClick={() => { setOpen((v) => !v); setSwitchNote(null); }}>
        {`⑂ ${current !== null ? `第 ${current.n}/${leaves.length} 条线` : `${leaves.length} 条线`}`}
      </button>
      {open ? (
        <div className="branch-panel">
          {leaves.map((l) => (
            <div key={l.leafKey} className={`branch-row${l.isCurrent ? " cur" : ""}`}>
              <span className="row-n">{`${l.n}.`}</span>
              <span className="row-main">{l.forkPreview !== "" ? `分叉自 “${l.forkPreview}”` : "从头开始"}</span>
              <span className="row-count">{`${l.messageCount} 条消息`}</span>
              {l.isCurrent ? (
                <span className="row-cur">当前</span>
              ) : (
                <button type="button" className="wudao action" onClick={() => onSwitch(l)}>
                  切到这里
                </button>
              )}
            </div>
          ))}
          {switchNote !== null ? (
            // P2 §6.4 通知变体制：面板 note 行同律——前缀渲染面剥离 + 变体色。
            (() => {
              const n = classifyNotice(switchNote);
              return (
                <div className="branch-note" data-variant={n.variant}>
                  {n.variant === "warn" ? <Icon name="triangle-alert" size={12} /> : n.variant === "ok" ? <IconCheck size={12} className="ic" /> : null}
                  {n.text}
                </div>
              );
            })()
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
