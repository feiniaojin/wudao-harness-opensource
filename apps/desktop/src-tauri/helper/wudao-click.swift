// wudao-click — ω99-212: the desktop click helper (a ~60-line Swift CGEvent
// tool; compiled by apps/desktop/scripts/tauri-build.mjs into
// sidecar-resources/wudao-click when `xcrun -f swiftc` is present — absent →
// WARN skip, the cli's computer.click then degrades to its structured
// guidance error, never a half-broken click).
//
// Usage (argv):
//   wudao-click <x> <y> [right] [double]   — click at POINT coordinates
//   wudao-click scroll <x> <y> <dx> <dy> [at] — wheel scroll (plain form posts
//                                            at the system cursor; `at` first moves it to (x, y))
//   wudao-click drag <x1> <y1> <x2> <y2> [right] — press at the start,
//                                            interpolate ~20 small moves,
//                                            release at the end (ω99-220)
//   wudao-click observe <maxNodes> <maxDepth> <maxTextBytes> [app]
//                                          — AX BFS of the app's front window
//                                            (frontmost app when [app] is
//                                            absent); prints the numbered
//                                            element table (ω99-247, dsh
//                                            observeSnapshot 范式):
//                                            WUDAO_OBSERVE app=<name>
//                                            WUDAO_WINDOW <title>
//                                            [eN] role "title" @cx,cy value=… lines
//                                            WUDAO_END nodes truncated sha256
//   wudao-click press <index> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app]
//                                          — AXPress element e<index>: re-
//                                            observes with the SAME budgets,
//                                            compares the tree hash against
//                                            <sha256> (stale → exit 6, NEVER
//                                            a blind press), then presses
//                                            (self, else descendants ≤4 deep
//                                            — only when the element
//                                            advertised AXPress; dsh 范式)
//   wudao-click settext <index> <text> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app]
//                                          — AXValue write of <text> into
//                                            e<index> (same stale guard)
//   wudao-click hit <x> <y>               — read-only element hit at the POINT
//                                            (drag-destination verification,
//                                            ω99-261): AXUIElementCopyElement
//                                            AtPosition on the system-wide
//                                            element, prints one identity line
//                                            WUDAO_HIT role|subrole|title|
//                                            label|enabled|focused (the
//                                            observeTree hashLine family minus
//                                            the index segment — structural
//                                            identity never carries a number);
//                                            ZERO CGEvent, zero capture. Miss
//                                            → exit 4 (「落点无元素」— hit
//                                            never creates events, so 4 is
//                                            unambiguous here). Pre-261
//                                            helpers without the subcommand
//                                            reject `hit …` in the click
//                                            fallback (coord(argv[0]) fails
//                                            on the non-numeric word) → exit
//                                            3, zero events — the cli treats
//                                            that as silent degrade.
// Exit codes: 0 ok · 2 accessibility not granted (AXIsProcessTrusted; the cli
// maps this to the 辅助功能 guide card) · 3 bad args · 4 event create/post
// failure (hit subcommand: point hit nothing) · 5 target unavailable (app not
// running / no window) · 6 stale
// observation (tree hash mismatch / element gone — re-observe) · 8 element
// not actionable (no AXPress / rejected AXValue). Coordinates are macOS
// POINTS (logical); on a retina screen a screen.capture image is ~2x pixels —
// callers halve before calling. The observe table's @cx,cy (center = AXPosition+AXSize/2, after the title / before value=) is the same global POINT space; omitted when position/size is unavailable.
import Foundation
import CoreGraphics
import ApplicationServices
import AppKit      // ω99-247: NSWorkspace app resolution (read-only — never activates)
import CryptoKit   // ω99-247: SHA256 tree identity (the stale guard's evidence)

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

// Fail-closed BEFORE any event: without 辅助功能 trust the system silently
// drops CGEvents — surface the typed refusal instead of a phantom success.
if !AXIsProcessTrusted() {
  print("WUDAO_AX_UNTRUSTED")
  fail("wudao-click: 辅助功能未授权（系统设置 → 隐私与安全性 → 辅助功能，勾选 wudao 所在应用）", 2)
}

let argv = Array(CommandLine.arguments.dropFirst())

func click(_ x: Double, _ y: Double, right: Bool, double: Bool) -> Void {
  let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let btn: CGMouseButton = right ? .right : .left
  let point = CGPoint(x: x, y: y)
  guard
    let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: btn),
    let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: btn)
  else { fail("wudao-click: cannot create CGEvent", 4) }
  let taps: Int32 = double ? 2 : 1
  for _ in 0..<taps {
    down.post(tap: .cghidEventTap)
    usleep(80_000) // human-ish press→release gap
    up.post(tap: .cghidEventTap)
    if taps > 1 { usleep(120_000) } // double-click pair gap
  }
}

func scroll(_ dx: Int32, _ dy: Int32) -> Void {
  // wheel1 = vertical (positive = up), wheel2 = horizontal (positive = left).
  guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: -dx, wheel3: 0)
  else { fail("wudao-click: cannot create scroll CGEvent", 4) }
  ev.post(tap: .cghidEventTap)
}

// ω99-220: #1 — the drag subcommand. Press at the start, ~20 interpolated
// moves (~10ms apart — drop targets like Finder register on event RHYTHM, a
// single teleport is often ignored), a small settle pause, release at the
// end. While the button is down the moves are leftMouseDragged /
// rightMouseDragged (NOT mouseMoved — a plain move with a button held does
// not read as a drag by the system). Exit-code semantics unchanged: 0 ok,
// 3 bad args (via coord), 4 event create/post failure.
func drag(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, right: Bool) -> Void {
  let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let moveType: CGEventType = right ? .rightMouseDragged : .leftMouseDragged
  let btn: CGMouseButton = right ? .right : .left
  let start = CGPoint(x: x1, y: y1)
  let end = CGPoint(x: x2, y: y2)
  guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: start, mouseButton: btn)
  else { fail("wudao-click: cannot create CGEvent", 4) }
  down.post(tap: .cghidEventTap)
  usleep(80_000) // press settle before the move (same family as the click gap)
  let steps = 20
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: moveType, mouseCursorPosition: p, mouseButton: btn)
    else { fail("wudao-click: cannot create CGEvent", 4) }
    ev.post(tap: .cghidEventTap)
    usleep(10_000) // drag-rhythm gap between interpolated moves
  }
  usleep(40_000) // settle at the destination before release (drop registration)
  guard let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: end, mouseButton: btn)
  else { fail("wudao-click: cannot create CGEvent", 4) }
  up.post(tap: .cghidEventTap)
}

func coord(_ s: String) -> Double {
  guard let v = Double(s), v.isFinite, v >= 0 else { fail("wudao-click: bad coordinate \(s)", 3) }
  return v
}

func delta(_ s: String) -> Int32 {
  guard let v = Int32(s) else { fail("wudao-click: bad scroll delta \(s)", 3) }
  return v
}

// ω99-247: #5 — observe / press / settext（AX BFS 观察器 + ref 点选/直写）。
// 蓝本：dsh main.swift observeSnapshot（预算三钉 BFS、`[n] role "title" value=…`
// 行格式、AXFocusedUIElement 焦点标注、secure 处理、pressWithDescendantFallback）
// ——两处有意超越：① 编号 1 起且行首 [eN]（与 browser_snapshot 的 e-ref 同一
// 语法，一个心智模型两个域）；② secure 字段连占位都不给（dsh 给
// value="[secure]"，本弧 value 面整个缺席）。stale 守卫=dsh stateHash 范式：
// press/settext 同参重观察→比对树哈希→不符即拒（fail-closed 在任何 AX 动作
// 之前）；树哈希是「结构身份」（编号|角色|子角色|标题|标签|可用|焦点）——
// 值不进哈希：同窗输入文字不该作废其余编号（不然填表场景 ref 反而不如坐标）。

func positiveInt(_ s: String, _ what: String) -> Int {
  guard let v = Int(s), v > 0 else { fail("wudao-click: bad \(what) \(s)", 3) }
  return v
}

func resolveApp(_ name: String) -> NSRunningApplication? {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  let byBundle = apps.filter { $0.bundleIdentifier == name }
  if byBundle.count == 1 { return byBundle.first }
  let byName = apps.filter {
    ($0.localizedName ?? "").compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
  }
  return byName.count == 1 ? byName.first : nil
}

func frontmostApp() -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.isActive }
}

func axCopy(_ element: AXUIElement, _ attribute: CFString) -> Any? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute, &value)
  return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  if let s = axCopy(element, attribute) as? String, !s.isEmpty { return s }
  if let a = axCopy(element, attribute) as? NSAttributedString, !a.string.isEmpty { return a.string }
  return nil
}

func axBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
  (axCopy(element, attribute) as? NSNumber)?.boolValue
}

func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
  return (names as NSArray).compactMap { $0 as? String }
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  guard let values = axCopy(element, kAXChildrenAttribute as CFString) as? [AnyObject] else { return [] }
  return values.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
}

/* ω99-285: #1 — macosx12 swiftc 兼容修复：axCopy 返回 Any?，Any 喂
 * CFGetTypeID 不合法（要求 class 约束）。先经 CFTypeRef 条件降级（对 CF
 * 值恒真、非 class 得 nil），再做 typeID 校验——与 axChildren 的 [AnyObject]
 * 路线同一范式，语义零变（copy 成功且 typeID 匹配方返回）。 */
func chosenWindow(_ appElement: AXUIElement) -> AXUIElement? {
  if let v = axCopy(appElement, kAXFocusedWindowAttribute as CFString) as? CFTypeRef, CFGetTypeID(v) == AXUIElementGetTypeID() {
    return (v as! AXUIElement)
  }
  if let v = axCopy(appElement, kAXMainWindowAttribute as CFString) as? CFTypeRef, CFGetTypeID(v) == AXUIElementGetTypeID() {
    return (v as! AXUIElement)
  }
  return axChildren(appElement).first
}

func observeSanitize(_ value: String, max: Int = 120) -> String {
  let collapsed = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard collapsed.count > max else { return collapsed }
  return String(collapsed.prefix(max)) + "…"
}

func observeJsonString(_ value: String) -> String {
  let data = try? JSONSerialization.data(withJSONObject: [value])
  let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
  return String(encoded.dropFirst().dropLast())
}

struct ObservedElement {
  let index: Int        // 1-based: e<index> is THE ref (browser e-syntax parity)
  let element: AXUIElement
  let hashLine: String  // structure identity — values never enter (see header)
}

func observeTree(root: AXUIElement, maxNodes: Int, maxDepth: Int, maxTextBytes: Int)
  -> (lines: [String], elements: [ObservedElement], truncated: Bool) {
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var cursor = 0
  var seen = Set<CFHashCode>()
  var elements: [ObservedElement] = []
  var lines: [String] = []
  var textBytes = 0
  var truncated = false
  while cursor < queue.count {
    if elements.count >= maxNodes { truncated = true; break }
    let (element, depth) = queue[cursor]
    cursor += 1
    if !seen.insert(CFHash(element)).inserted { continue }
    let role = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    let titleValue = axString(element, kAXTitleAttribute as CFString)
    let labelValue = titleValue ?? axString(element, kAXDescriptionAttribute as CFString)
    // secure 纪律（241 同源、严于 dsh）：密码框等 secure 字段绝不输出 value
    // ——连占位都没有；角色本身已表意（AXSecureTextField）。
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    var valueValue: String? = nil
    if !secure {
      if let raw = axCopy(element, kAXValueAttribute as CFString) {
        if let s = raw as? String { valueValue = observeSanitize(s) }
        else if let n = raw as? NSNumber { valueValue = n.stringValue }
      }
    }
    let enabled = axBool(element, kAXEnabledAttribute as CFString)
    let focused = axBool(element, kAXFocusedAttribute as CFString)
    let index = elements.count + 1
    var line = String(repeating: "  ", count: min(depth, 20)) + "[e\(index)] \(role)"
    if let t = titleValue { line += " \(observeJsonString(observeSanitize(t)))" }
    else if let l = labelValue { line += " \(observeJsonString(observeSanitize(l)))" }
    line += observeCenterSpan(element) ?? ""; if let v = valueValue { line += " value=\(observeJsonString(v))" } // center span (title→value slot; nil=位置不可知省略)
    if enabled == false { line += " disabled" }
    if focused == true { line += " focused" }
    let lineBytes = line.utf8.count + (lines.isEmpty ? 0 : 1)
    if textBytes + lineBytes <= maxTextBytes { lines.append(line); textBytes += lineBytes }
    else { truncated = true }
    let hashLine = [String(index), role, subrole ?? "", titleValue ?? "", labelValue ?? "", String(enabled ?? true), String(focused ?? false)].joined(separator: "|")
    elements.append(ObservedElement(index: index, element: element, hashLine: hashLine))
    if depth >= maxDepth {
      if !axChildren(element).isEmpty { truncated = true }
      continue
    }
    for child in axChildren(element) { queue.append((child, depth + 1)) }
  }
  return (lines, elements, truncated)
}

// ω99-257: #2 — ref 寻址的位置面：AXPosition/AXSize 读取 + 元素中心段发射 +
// scroll 的 at 形（光标先行）。三件裁定：
//   1. 中心=AXPosition+AXSize/2（四舍五入整数）；AX 给全局屏幕坐标（主屏左
//      上原点的点空间，与 CGEvent 同空间）——观察行 @cx,cy 天然是屏幕点，
//      TS 侧绝不经 captureScale 二次换算（多屏负坐标原样输出）。
//   2. position/size 任一缺席 → @ 段整段省略（诚实缺席，绝不编造坐标）；
//      旧版 helper 二进制即此形——TS 解析层新旧两形并存，scroll/drag 的 ref
//      路径遇无位置 entry 给 typed 升级出路（两版本过渡零断崖）。
//   3. hashLine 一字不加：位置不进身份（结构与位置解耦）——纯移动（窗口
//      挪位）不作废任何编号（click/type 的 ref 路径字节级零变）；代价=
//      scroll/drag 拿到的位置可能过时，与坐标路径同级风险，弧报告记边界。
/* ω99-285（续，标记见上）— 同款两处：`as? AXValue` 对 CF 值是无检查的
 * 恒真降级（本 swiftc 定 error），换 typeID 校验后的受检访问——比原码
 * 更严：只有真 AXValue 才进 AXValueGetValue。 */
func axPoint(_ element: AXUIElement) -> CGPoint? {
  guard let v = axCopy(element, kAXPositionAttribute as CFString) as? CFTypeRef, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ element: AXUIElement) -> CGSize? {
  guard let v = axCopy(element, kAXSizeAttribute as CFString) as? CFTypeRef, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

/** 元素中心段 ` @cx,cy`（nil = 位置不可知，观察行省略整段）。 */
func observeCenterSpan(_ element: AXUIElement) -> String? {
  guard let pos = axPoint(element), let size = axSize(element) else { return nil }
  let cx = Int((pos.x + size.width / 2).rounded())
  let cy = Int((pos.y + size.height / 2).rounded())
  return " @\(cx),\(cy)"
}

/** 光标先行（at 形滚轮的前半）：滚轮事件贴系统光标——「滚在那个元素中心」
 *  = 移动+滚轮两事件（cliclick 范式：move 到位再滚）。小停顿让系统把后续
 *  事件路由到新光标下的窗口。 */
func moveCursor(_ x: Double, _ y: Double) -> Void {
  let point = CGPoint(x: x, y: y)
  guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
  else { fail("wudao-click: cannot create CGEvent", 4) }
  ev.post(tap: .cghidEventTap)
  usleep(20_000)
}

func sha256Hex(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

struct ObservationRun {
  let appName: String
  let windowTitle: String
  let lines: [String]
  let elements: [ObservedElement]
  let truncated: Bool
  let nodes: Int
  let stateHash: String
}

// Resolve the target (named app — read-only, NEVER activates — or the
// frontmost app), BFS its chosen window. An empty tree is SUCCESS (nodes is
// reported honestly; the cli's blacklist owns the degrade policy); a missing
// app/window is exit 5 (target unavailable).
func runObserve(maxNodes: Int, maxDepth: Int, maxTextBytes: Int, appName: String?) -> ObservationRun {
  let app: NSRunningApplication
  if let name = appName {
    guard let found = resolveApp(name) else {
      fail("wudao-click: no running application matches \"\(name)\"", 5)
    }
    app = found
  } else {
    guard let front = frontmostApp() else { fail("wudao-click: no frontmost application", 5) }
    app = front
  }
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  guard let window = chosenWindow(appElement) else {
    fail("wudao-click: \(app.localizedName ?? "app") has no observable window", 5)
  }
  let tree = observeTree(root: window, maxNodes: maxNodes, maxDepth: maxDepth, maxTextBytes: maxTextBytes)
  let appNameOut = app.localizedName ?? app.bundleIdentifier ?? "unknown"
  let windowTitle = axString(window, kAXTitleAttribute as CFString).map { observeSanitize($0, max: 120) } ?? ""
  let state = [appNameOut, windowTitle, tree.elements.map { $0.hashLine }.joined(separator: "\n")].joined(separator: "\n")
  return ObservationRun(
    appName: appNameOut,
    windowTitle: windowTitle,
    lines: tree.lines,
    elements: tree.elements,
    truncated: tree.truncated,
    nodes: tree.elements.count,
    stateHash: sha256Hex(state))
}

// dsh pressWithDescendantFallback: only descend when the addressed element
// ADVERTISED AXPress (a plain group must not cascade-press random children).
func pressRecursive(_ element: AXUIElement, remainingDepth: Int, visited: inout Set<CFHashCode>) -> Bool {
  guard remainingDepth >= 0 else { return false }
  guard visited.insert(CFHash(element)).inserted else { return false }
  if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return true }
  if remainingDepth == 0 { return false }
  for child in axChildren(element) {
    if pressRecursive(child, remainingDepth: remainingDepth - 1, visited: &visited) { return true }
  }
  return false
}

func pressElement(_ element: AXUIElement) -> Bool {
  guard axActions(element).contains(kAXPressAction as String) else { return false }
  var visited = Set<CFHashCode>()
  return pressRecursive(element, remainingDepth: 4, visited: &visited)
}

// press/settext 的公共前半：同参重观察 + sha 比对 + 编号定位（stale 守卫，
// fail-closed 在任何 AX 动作之前）。
func staleGuardedRecord(index: Int, maxNodes: Int, maxDepth: Int, maxTextBytes: Int, expectedSha: String, appName: String?) -> ObservedElement {
  let run = runObserve(maxNodes: maxNodes, maxDepth: maxDepth, maxTextBytes: maxTextBytes, appName: appName)
  guard run.stateHash == expectedSha else {
    fail("wudao-click: stale observation — the window's element tree changed since screen.observe", 6)
  }
  guard let record = run.elements.first(where: { $0.index == index }) else {
    fail("wudao-click: element [e\(index)] is not in the current tree", 6)
  }
  return record
}

if argv.first == "observe" && (argv.count == 4 || argv.count == 5) {
  let maxNodes = positiveInt(argv[1], "maxNodes")
  let maxDepth = positiveInt(argv[2], "maxDepth")
  let maxTextBytes = positiveInt(argv[3], "maxTextBytes")
  let app = argv.count == 5 ? argv[4] : nil
  let run = runObserve(maxNodes: maxNodes, maxDepth: maxDepth, maxTextBytes: maxTextBytes, appName: app)
  print("WUDAO_OBSERVE app=\(run.appName)")
  print("WUDAO_WINDOW \(run.windowTitle)")
  for line in run.lines { print(line) }
  print("WUDAO_END nodes=\(run.nodes) truncated=\(run.truncated ? 1 : 0) sha256=\(run.stateHash)")
} else if argv.first == "press" && (argv.count == 6 || argv.count == 7) {
  // press <index> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app]
  let index = positiveInt(argv[1], "index")
  let maxNodes = positiveInt(argv[2], "maxNodes")
  let maxDepth = positiveInt(argv[3], "maxDepth")
  let maxTextBytes = positiveInt(argv[4], "maxTextBytes")
  let expectedSha = argv[5]
  let app = argv.count == 7 ? argv[6] : nil
  let record = staleGuardedRecord(index: index, maxNodes: maxNodes, maxDepth: maxDepth, maxTextBytes: maxTextBytes, expectedSha: expectedSha, appName: app)
  guard pressElement(record.element) else {
    fail("wudao-click: element [e\(index)] has no press action", 8)
  }
} else if argv.first == "settext" && (argv.count == 7 || argv.count == 8) {
  // settext <index> <text> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app]
  let index = positiveInt(argv[1], "index")
  let text = argv[2]
  let maxNodes = positiveInt(argv[3], "maxNodes")
  let maxDepth = positiveInt(argv[4], "maxDepth")
  let maxTextBytes = positiveInt(argv[5], "maxTextBytes")
  let expectedSha = argv[6]
  let app = argv.count == 8 ? argv[7] : nil
  let record = staleGuardedRecord(index: index, maxNodes: maxNodes, maxDepth: maxDepth, maxTextBytes: maxTextBytes, expectedSha: expectedSha, appName: app)
  guard AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, text as CFTypeRef) == .success else {
    fail("wudao-click: element [e\(index)] rejected the text assignment", 8)
  }
} else if argv.first == "scroll" && (argv.count == 5 || (argv.count == 6 && argv[5] == "at")) {
  // Plain form: x/y parsed and discarded (wheel posts at the system cursor —
  // v1.5 face, byte-identical). Trailing `at`: MOVE the cursor to (x, y)
  // first, then wheel — the ref-scroll face (element center; coords arrive as
  // raw screen POINTS from the observe table, never capture-scaled).
  if argv.count == 6 {
    moveCursor(coord(argv[1]), coord(argv[2]))
  } else {
    _ = coord(argv[1]); _ = coord(argv[2])
  }
  scroll(delta(argv[3]), delta(argv[4]))
} else if argv.first == "drag" && (argv.count == 5 || argv.count == 6) {
  // drag <x1> <y1> <x2> <y2> [right] — trailing right flag, same as click's.
  let right = argv.count == 6 && argv[5] == "right"
  if argv.count == 6 && argv[5] != "right" { fail("usage: wudao-click drag <x1> <y1> <x2> <y2> [right]", 3) }
  drag(coord(argv[1]), coord(argv[2]), coord(argv[3]), coord(argv[4]), right: right)
// ω99-261: #1 — hit <x> <y>: read-only element hit at the drop point (the
// verification half of drag's endRef path). One AXUIElementCopyElement
// AtPosition query on the system-wide element — zero CGEvent, zero capture
// (observe-family safety). Prints the six-segment identity line (hashLine
// minus the index segment); miss → exit 4, bad coords → exit 3 via coord()
// (which also means pre-261 helpers reject `hit …` in their click fallback
// with zero events — the cli degrades silently on that exit 3).
} else if argv.first == "hit" && argv.count == 3 {
  let x = coord(argv[1])
  let y = coord(argv[2])
  let systemWide = AXUIElementCreateSystemWide()
  var hitElement: AXUIElement?
  guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &hitElement) == .success, let el = hitElement else {
    fail("wudao-click: 落点无元素", 4)
  }
  let role = axString(el, kAXRoleAttribute as CFString) ?? "AXUnknown"
  let subrole = axString(el, kAXSubroleAttribute as CFString) ?? ""
  let titleValue = axString(el, kAXTitleAttribute as CFString) ?? ""
  let labelValue = titleValue != "" ? titleValue : (axString(el, kAXDescriptionAttribute as CFString) ?? "")
  let enabled = axBool(el, kAXEnabledAttribute as CFString) ?? true
  let focused = axBool(el, kAXFocusedAttribute as CFString) ?? false
  let hitTitle = observeSanitize(titleValue)
  let hitLabel = observeSanitize(labelValue)
  print("WUDAO_HIT \(role)|\(subrole)|\(hitTitle)|\(hitLabel)|\(enabled ? "true" : "false")|\(focused ? "true" : "false")")
} else if argv.first != "scroll" && argv.first != "drag" && argv.first != "observe" && argv.first != "press" && argv.first != "settext" && argv.first != "hit" && argv.count >= 2 && argv.count <= 4 {
  let x = coord(argv[0])
  let y = coord(argv[1])
  let right = argv.dropFirst(2).contains("right")
  let double = argv.dropFirst(2).contains("double")
  click(x, y, right: right, double: double)
} else {
  fail("usage: wudao-click <x> <y> [right] [double] | wudao-click scroll <x> <y> <dx> <dy> [at] | wudao-click drag <x1> <y1> <x2> <y2> [right] | wudao-click hit <x> <y> | wudao-click observe <maxNodes> <maxDepth> <maxTextBytes> [app] | wudao-click press <index> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app] | wudao-click settext <index> <text> <maxNodes> <maxDepth> <maxTextBytes> <sha256> [app]", 3)
}
