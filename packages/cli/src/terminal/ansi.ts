// P2-12（96 队列 #12）终端转义序列剥除 — 红线 1：模型可见输出永不含
// ANSI/控制序列。纪律：ring 存原始字节，剥除只发生在出口（run 的捕获、
// read 的渲染），且永远在拼接后的完整文本上做——转义序列可能跨 onData
// chunk 分裂，逐块剥会漏掉跨块序列。
//
// 覆盖面（VT100/xterm 实际会发的）：
//   OSC   ESC ] … (BEL | ESC \)   — 标题/剪贴板等
//   CSI   ESC [ 参数 中间 终止字节 — 颜色/光标/擦除/私有模式（含 ?2004h 括号粘贴）
//   其它  ESC + 单字符            — 字符集选择 ESC(B、ESC)、键盘模式 ESC=/ESC>
//   C0    除 \n \t 外全部         — BEL/BS/CR/ETX/NUL…；\r 剥掉后 \r\n 自然成 \n
//   DEL   0x7f                    — 终端回显的删除标记
// 保留：可打印字符、UTF-8、\n、\t。
// 已知简化（诚实声明）：跨行重绘（prompt 重画依赖 CR/光标移回的覆盖语义）
// 不做回放式重演——CR/光标序列直接剥除，文本按序拼接。

/**
 * Strip ANSI escape sequences and control characters from terminal output.
 * Pure; never throws. Apply on the JOINED text (chunk boundaries split
 * sequences — see the module note).
 */
export function stripTerminalCodes(text: string): string {
  return text
    // OSC — terminated by BEL or ST (ESC \); tolerate an unterminated tail
    // (the capture window may have cut a title write mid-flight).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI — parameter bytes 0x30–0x3F, intermediate 0x20–0x2F, final 0x40–0x7E
    // (the class carries all three; the trailing [@-~] pins the final byte).
    .replace(/\x1b\[[0-9;:?<=>!"' /#]*[@-~]/g, "")
    // A CSI truncated at the capture edge (parameters, no final byte yet).
    .replace(/\x1b\[[0-9;:?<=>!"' /#]*$/, "")
    // Other escape sequences: ESC + optional intermediates (0x20–0x2F) + a
    // final byte (0x30–0x7E) — charset designations ESC ( B / ESC ) 0 have TWO
    // chars after ESC; single-char escapes (ESC = 0x3D, ESC >, ESC 7/8, ESC M)
    // have one. Note "=" and ">" sit BELOW 0x40 — the final range must start
    // at 0x30 or DEC keyboard modes leak through.
    .replace(/\x1b[ -/]+[0-~]/g, "")
    .replace(/\x1b[0-~]/g, "")
    // A lone trailing ESC (a sequence truncated at the capture edge).
    .replace(/\x1b$/, "")
    // C0 minus \t (0x09) and \n (0x0A); plus DEL. \r (0x0D) included — CRLF
    // collapses to LF.
    .replace(/[\x00-\x08\x0b\x0c\x0d-\x1f\x7f]/g, "");
}
