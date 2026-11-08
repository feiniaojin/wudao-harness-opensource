// Report-85/86 review ω-3a follow-up (report 89 item 1) — the SERVER half of
// the web protocol test's vaulted-set pin. The web test (packages/web/tests/
// protocol.test.ts, "the vaulted-mutation set is pinned") classifies one
// representative of every ClientOp action against the CLIENT mirror
// (isRetryableMutation) with a compile-time exhaustiveness assertion; this
// test mirrors it against the SERVER mirror (isVaultedMutation) so neither
// half can drift when the op set grows. The server's mirror is untyped (the
// op arrives as parsed JSON over the wire — no ClientOp import), so its
// full-set tripwire is the same count pin the web test carries at runtime.
import { describe, expect, it } from "vitest";
import { isVaultedMutation } from "../src/index.js";

describe("ω-3a vaulted-mutation mirror (isVaultedMutation)", () => {
  it("classifies one representative of every ClientOp action — identical to the web retryable set", () => {
    // 23 unconditional mutations (vaulted server-side, replayed client-side).
    const mutations: Record<string, unknown>[] = [
      { op: "submit", text: "t" },
      { op: "interrupt" },
      { op: "setMode", mode: "auto" },
      { op: "answerPermission", allow: true },
      { op: "resume", id: "s" },
      { op: "rewind", target: "last" },
      { op: "edit", n: 1 },
      { op: "settingsSaveKey", provider: "glm", key: "k" },
      { op: "settingsSet", key: "ui.theme", value: "dark" },
      // Provider management §5: a provider write is a side effect that must
      // survive a mid-flap replay exactly once — vaulted like settingsSet.
      { op: "settingsSaveProvider", id: "my-gw", config: { baseUrl: "https://gw.example.com/v1" } },
      { op: "switchWorkspace", path: "/w" },
      { op: "panelRootSet", path: "/w" },
      { op: "agentRootSwitch", path: "/w" },
      { op: "attachmentSave", inputs: [] },
      { op: "pluginMarketAdd", source: "s" },
      { op: "pluginMarketUpdate", name: "n" },
      { op: "pluginMarketRemove", name: "n" },
      { op: "pluginInstall", name: "n", market: "m", scope: "user" },
      { op: "pluginUninstall", id: "i" },
      { op: "pluginEnable", id: "i" },
      { op: "pluginDisable", id: "i" },
      // persona-settings T5: persona writes are side effects — vaulted like
      // the other registry mutations (delete converges on replay).
      { op: "personaSave", definition: { id: "p", displayName: "P", source: { kind: "workspace-source", provenance: "x", pinnedVersion: "1" }, headers: {} } },
      { op: "personaDelete", id: "p" },
      // ω99-235: #8 — the pet lane's ops — mutations of the SECOND driver
      // session, vaulted exactly like their main-lane twins (the mirror's
      // full-set duty: without them the three new isVaultedMutation cases
      // would ride unpinned — the count alone cannot detect an addition).
      { op: "petSubmit", text: "t" },
      { op: "petInterrupt" },
      { op: "petAnswerPermission", allow: true },
      // M85-pet §2（Task 3）— 精灵工具栏四写面：newPetSession 归档落盘
      // （rename 副作用，mid-flap 重放双归档是真危害）；setModel/setEffort
      // 是 pet 车道自己的 driver 状态写（setMode 同族）；setWorkspace 镜像
      // agentRootSwitch（已 vault 的主车道孪生）。
      { op: "petNewSession" },
      { op: "petSetModel", provider: "glm", model: "m", effort: "high" },
      { op: "petSetEffort", effort: "high" },
      { op: "petSetWorkspace", path: "/w" },
      // ω99-260: #7 — the memory decision — a side effect (confirm flips a
      // line, del removes it), vaulted; ok/del converge on replay.
      { op: "memoryDecide", id: "m-a", action: "ok" },
      // ω99-264: #4（同形）— the memory rewrite — a side effect (update writes a
      // new ledger line, version+1), vaulted; the driver short-circuits a
      // content-equal replay so a mid-flap replay converges.
      { op: "memoryEdit", id: "m-a", content: "改后内容" },
      // ω99-314: the file-level time machine's restore — a working-face side
      // effect (overwrites a workspace file), vaulted so a mid-flap replay
      // never double-reverts.
      { op: "fileRevert", path: "a.ts", sha: "a".repeat(64) },
      // ω99-317 — 定时任务管理面两写：setEnabled 是状态写（settingsSet 同
      // 形——重放必须恰好一次）；runNow 重放会双跑（vault 保 exactly-once，
      // driver 的 busy/running 守卫再兜一层）。删除入读表（见下）。
      { op: "schedulesSetEnabled", id: "abcd0001", enabled: false },
      { op: "schedulesRunNow", id: "abcd0001" },
    ];
    // 16 reads (never vaulted — a cached read would serve stale data).
    const reads: Record<string, unknown>[] = [
      { op: "listSlashCommands" },
      { op: "sessions" },
      { op: "tree" },
      { op: "settingsStatus" },
      { op: "settingsTestConnection", provider: "glm" },
      // Provider management §5: delete converges (an absent row is the goal
      // state — replaying it changes nothing) and the /models probe is a read.
      { op: "settingsDeleteProvider", id: "my-gw" },
      { op: "settingsListModels", provider: "glm" },
      { op: "fileTree", path: "src" },
      { op: "fileRead", path: "src/a.ts" },
      { op: "agentRootStatus" },
      { op: "ctxInfo" },
      // ω99-213: a read — replay converges to the same payload; the client's
      // (sessionId, mark) memoization is the burn guard, not vaulting.
      { op: "recap", sessionId: "s", sinceMark: 0 },
      { op: "attachmentGet", ref: { kind: "image", attachmentId: "a", mediaType: "image/png", byteLength: 1 } },
      { op: "pluginList" },
      { op: "pluginMarketList" },
      // persona-settings T5: the persona reads.
      { op: "personaList" },
      { op: "personaGet", id: "p" },
      // ω99-258: #7 — branchLeaves 入读表（census 45→46 同形演进）。
      // The structured branch leaf table — a read (the panel's
      // snapshot; never vaulted, the old-server reject degrades the chip).
      { op: "branchLeaves" },
      // ω99-260（同 #7）: memoryList 入读表（census 46→48 同形演进——本弧双
      // op：读表 + 决定，各归其类）. The full memory ledger — a read (the
      // 待审卡/管理面's snapshot; never vaulted, old-server reject degrades
      // both faces).
      { op: "memoryList" },
      // ω99-271: #4 — petHistory 入读表（census 49 + 3 同形演进——第四 pet op
      // 是纯读：260 memoryList 前例，vaulting a read 会服务陈旧史）. The pet
      // lane's paired session history — never vaulted (mid-flap replay would
      // serve a stale transcript to the pet window; a fresh read is idempotent).
      { op: "petHistory" },
      // ω99-277: #12 — sessionSearch 入读表（census 50→51 同形演进——纯读：
      // 260 memoryList 前例，vaulting a read would serve stale hits）. The
      // session-picker's full-text search — a replay re-scans, never vaulted.
      { op: "sessionSearch", q: "关键词" },
      // ω99-279: #12 — sessionDelete 入读表（census 51→52 同形演进——删除
      // 收敛：absent 即 goal state，重放落 not-found 不再动盘——
      // settingsDeleteProvider 删除收敛先例，mutation 表零动；与 web 侧
      // 读表刻意一致）. The session-picker's trash delete — never vaulted.
      { op: "sessionDelete", id: "sess-x" },
      // ω99-283: #6 — 回收站两 op 入读表（census 52→54 lockstep——恢复
      // 收敛同 sessionDelete：重放落 target-exists/not-found 两向都不动
      // 盘；列表纯扫；与 web 侧读表刻意一致）. The picker's trash list +
      // restore — never vaulted.
      { op: "sessionTrashList" },
      { op: "sessionRestore", id: "sess-x" },
      // ω99-286: #7 — 断点续跑入读表（census 54→55 同形演进；与 web 侧
      // 读表刻意一致）：写语义同 submit 族，但 driver 的 busy/尾形门让
      // mid-flap 重放收敛 started:false（零双跑）——isVaultedMutation 零动。
      { op: "sessionContinue", id: "sess-x" },
      // ω99-313 — 定时任务与提醒读面入读表（census 55→56 同形演进；与
      // web 侧读表刻意一致）：纯读 store，重放即重扫，零副作用。
      { op: "schedulesList" },
      // ω99-317 — schedulesRemove 入读表（census 58→59 同形演进；与 web
      // 侧读表刻意一致）：删除收敛——absent 即 goal state，重放落
      // not-found 收敛回执不再动盘（sessionDelete/settingsDeleteProvider
      // 删除收敛先例）。
      { op: "schedulesRemove", id: "abcd0001" },
      // ω99-316 — /btw 侧问入读表（census 59→60 同形演进——后到者随
      // ω99-317 重编号；与 web 侧读表刻意一致）：detached loop 克隆投影
      // 作答，绝不写 session JSONL/store——重放=重新问一次，零副作用。
      { op: "sideQuestion", sessionId: "sess-x", text: "问" },
      // PB-2（探针基础设施弧）— 遥测三读面入读表（census 61→64 同形演进；与
      // web 侧读表刻意一致）：probeStream 是订阅声明、probeRecent/probeStats 是
      // 纯读——重放=重订阅/重扫，零副作用（vaulted 读反会服务陈旧面）。
      { op: "probeStream" },
      { op: "probeRecent", limit: 10 },
      { op: "probeStats" },
    ];
    for (const op of mutations) expect(isVaultedMutation(op), String(op.op)).toBe(true);
    for (const op of reads) expect(isVaultedMutation(op), String(op.op)).toBe(false);
    // Dual-form ops vault ONLY their mutating form (n / add present).
    expect(isVaultedMutation({ op: "switch", n: 2 })).toBe(true);
    expect(isVaultedMutation({ op: "switch" })).toBe(false);
    expect(isVaultedMutation({ op: "recentWorkspaces", add: "/w" })).toBe(true);
    expect(isVaultedMutation({ op: "recentWorkspaces" })).toBe(false);
    // Unknown actions stay UN-vaulted (fail toward executing the frame — old
    // clients' future ops keep today's behavior rather than 409-conflicting).
    expect(isVaultedMutation({ op: "zzFutureOp", x: 1 })).toBe(false);
    // 多 driver 弧 C：写面 op 的可选 sid（车道路由字段，加性——本镜像按 op
    // 名分类，不读 sid）——带 sid 的写与裸形同 vault；census 面额不变（61，
    // 本弧零新 op；与 web 侧读表刻意一致）。
    expect(isVaultedMutation({ op: "submit", text: "t", sid: "L1" })).toBe(true);
    expect(isVaultedMutation({ op: "interrupt", sid: "L1" })).toBe(true);
    expect(isVaultedMutation({ op: "resume", id: "s", sid: "L1" })).toBe(true);
    // The enumeration covers EVERY action the client can send — the same
    // 41-action set the web test pins (23 + 16 + 2 dual-form). A new ClientOp
    // action changes this count: classify it here AND in the web test's lists
    // (isRetryableMutation + isVaultedMutation + PROTOCOL.md's vaulted-ops
    // list). The two mirrors are intentionally IDENTICAL — the client replays
    // exactly what the server vaults; a divergence here (an op vaulted on one
    // side only) breaks mid-flap recovery on the mismatched side.
    // ω99-213: recap joined the reads above → 42.
    // ω99-235: the pet lane's three ops joined the mutations above → 42 + 3.
    // ω99-258: branchLeaves joined the reads above → 45 + 1.
    // ω99-260: memoryList (read) + memoryDecide (mutation) joined the lists
    // above → 46 + 2 (brief 预判 47 低估一枚——两枚新 action 各归其类).
    // ω99-264: memoryEdit (mutation) joined the mutations above → 48 + 1.
    // ω99-271: petHistory (read) joined the reads above → 49 + 1.
    // ω99-277: sessionSearch (read) joined the reads above → 50 + 1.
    // ω99-279: sessionDelete (read — converging delete, settingsDeleteProvider
    // precedent) joined the reads above → 51 + 1.
    // ω99-283（续，标记见上）: sessionTrashList + sessionRestore (reads — the
    // restore converges like its delete twin) joined the reads above → 52 + 2.
    // ω99-286（续，标记见上）: sessionContinue (read for census/vaulting —
    // the driver's busy/tail gates converge a mid-flap replay to started:false)
    // joined the reads above → 54 + 1.
    // ω99-313: schedulesList (read — the durable schedules' pure store scan)
    // joined the reads above → 55 + 1.
    // ω99-314: fileRevert (mutation — the time machine's restore writes a
    // workspace file) joined the mutations above → 56 + 1.
    // ω99-317: schedulesSetEnabled + schedulesRunNow (mutations — the
    // management face's state write and run-now double-run hazard) joined
    // the mutations above, and schedulesRemove (read — the converging
    // delete) joined the reads above → 57 + 3.
    const actions = new Set([...mutations, ...reads].map((o) => String(o.op)));
    actions.add("switch");
    actions.add("recentWorkspaces");
    // ω99-316: sideQuestion (read — the /btw detached side lane; a replay
    // just re-asks) joined the reads above → 60 + 1（后到者随 ω99-317 重编号）.
    // PB-2: probeStream + probeRecent + probeStats (reads — the probe
    // telemetry face; a replay re-subscribes/re-scans, never vaulted) joined
    // the reads above → 61 + 3.
    // M85-pet §2（Task 3）: 精灵工具栏四写面（petNewSession/petSetModel/
    // petSetEffort/petSetWorkspace — mutations of the SECOND driver session,
    // the ω99-235 family law）joined the mutations above → 64 + 4.
    expect(actions.size).toBe(68);
  });
});
