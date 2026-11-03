// 拆分运动（借鉴弧 δ 顺带件，file-size 棘轮「把压力推向拆分」）：
// settings-ops.ts 的纯失败分类器外提（逐字节搬家，行为零变化；
// settings-ops re-export 维持既有公共面）。类型留在 settings-ops（其公共
// 面不动）；type-only 往返在运行时零环（provider-registry-ops 同律）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import type { TestConnectionState } from "./settings-ops.js";

/** Pure failure classifier: HTTP status + sniffed body → one of the human
 *  states (spec §B: 401→Key 无效/超时→网络/模型名错). Body sniffing catches
 *  OpenAI-compatible endpoints that report a missing model as 400 ("Model
 *  Not Exist") instead of 404. A null status is the transport bucket —
 *  timeout (abort) and refused/DNS/unreachable all read as "the network
 *  path is broken" to a novice. */
export function classifyTestResponse(status: number | null, body: string): TestConnectionState {
  if (status === null) return "network";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  const lower = truncateSafe(body, 400).toLowerCase();
  if (status === 400 && lower.includes("model") && (lower.includes("not") || lower.includes("不存在"))) return "model";
  return "http";
}
