// ω99-116 (P1): 截图快问 — global hotkey ⌥⌘S → `screencapture -i` (the
// SYSTEM crosshair — zero self-built selection UI) → the png bytes ride
// the Tauri event bus into the composer's image rail as an M79b draft:
// 「按 ⌥⌘S 框一块屏幕，图落在输入框里，配一句话问出去。」
//
// This module is the Rust half, split the selection.rs way: a PURE
// decision layer (this file's tests — spawn/exit classification, the size
// gate, the wire payload codec) plus a thin runner (spawn screencapture,
// stat/read/delete the sessionless tmpfile, emit). The web half lives in
// packages/web/src/screenshot-ask.ts; the event name is pinned on BOTH
// sides (a drift reads as a review-time diff, never a runtime fixup).

/// The Tauri event broadcasting a fresh screenshot (Rust → main window).
/// Same literal as the web side's WUDAO_SCREENSHOT_EVENT — pinned by tests
/// on both sides.
pub const WUDAO_SCREENSHOT_EVENT: &str = "wudao-screenshot";

/// The default global hotkey (⌥⌘S — S for screenshot). Kept over the
/// brief's fallback ⌥⌘D after the conflict grep: ⌥⌘D is a SYSTEM-global
/// macOS toggle (show/hide Dock) and must never be shadowed, while ⌥⌘S
/// has no macOS system binding — only app-local Settings bindings (the
/// IntelliJ family), the same app-scope tradeoff ⌥⌘E already makes.
pub const SCREENSHOT_HOTKEY: &str = "Alt+Command+S";

/// Single-file gate — 20MiB, mirroring read_dropped_file's
/// MAX_DROP_FILE_BYTES (core's DEFAULT_MAX_REQUEST_IMAGE_BYTES spirit):
/// stops a giant capture from base64-ballooning through the event bus.
pub const MAX_SCREENSHOT_BYTES: u64 = 20 * 1024 * 1024;

/// The typed outcome of one capture attempt. Cancelled is a FIRST-CLASS
/// state, not an error: the user pressed Esc in the system crosshair, and
/// the web side must never hear about it (silent drop, zero drafts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenshotOutcome {
    /// screencapture exited non-zero — the native Esc cancel.
    Cancelled,
    /// spawn/stat/read/size failures — the honest face (eprintln, the 110
    /// posture): the shell lives on, THIS capture dies, the log says why.
    Failed(String),
    /// The png bytes, ready for the wire.
    Captured(Vec<u8>),
}

/// Stage 1 (pure): the spawn result + exit status → the outcome, or None
/// when the capture finished and the file stages should run. A non-zero
/// exit reads as Cancelled per the brief's ruling (Esc is `screencapture
/// -i`'s ordinary exit; the residual non-zero failure cases surface
/// downstream as a missing-file stat error — still the honest face).
pub fn spawn_stage(spawn: Result<bool, String>) -> Option<ScreenshotOutcome> {
    match spawn {
        Err(err) => Some(ScreenshotOutcome::Failed(format!("cannot spawn screencapture: {err}"))),
        Ok(false) => Some(ScreenshotOutcome::Cancelled),
        Ok(true) => None,
    }
}

/// Stage 2 (pure): the size gate. 0 bytes → the typed empty hint (a
/// screen-recording-denied capture writes nothing — that hint IS the
/// honest face for the 62 号债 TCC case); >20MiB → the typed oversize
/// error; else Ok. 恰等不拒。
pub fn size_gate(len: u64) -> Result<(), String> {
    if len == 0 {
        Err("截图为空——请检查屏幕录制权限（系统设置 → 隐私与安全性 → 屏幕录制）".to_string())
    } else if len > MAX_SCREENSHOT_BYTES {
        Err(format!("截图超过 20MiB 上限（{len} 字节）"))
    } else {
        Ok(())
    }
}

/// The event payload codec (serde_json-only, the selection_event_payload
/// discipline): exactly `{"data","mediaType"}` — data is RFC-4648 base64
/// (main.rs's codec — the one the JS side's atob expects), mediaType
/// pinned image/png (screencapture's default output format).
fn screenshot_event_payload(bytes: &[u8]) -> String {
    serde_json::json!({ "data": crate::base64_encode(bytes), "mediaType": "image/png" }).to_string()
}

/// The fail-open status line when the screenshot hotkey cannot register
/// (taken by another app / the plugin state never came up) — the 110
/// honest face: the shell lives on, 截图快问 alone stands down, the log
/// says why. Never a panic, never an exit.
pub fn hotkey_unavailable_note(err: &str) -> String {
    format!("wudao: screenshot hotkey unavailable ({err}): 截图快问停用（应用继续）")
}

use tauri::{AppHandle, Emitter};

/// The hotkey press. The capture BLOCKS until the user finishes — or Esc's
/// — the system crosshair, deliberately UNBOUNDED: 用户想框多久框多久 (the
/// brief's no-timeout ruling; a timeout would abort a slow deliberate
/// selection). Running that on the main thread would freeze the event
/// loop, so the whole capture rides a detached thread (AppHandle is
/// Send+Sync and emit is thread-safe). Cancelled → no event, no log (the
/// user aborted — 打扰是错的). Failed → the honest eprintln. Captured →
/// the payload round-trips through the canonical serializer so the bytes
/// the listener parses are the bytes the tests pin (the pet-drop pattern).
pub fn handle_screenshot_hotkey(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || match capture_screenshot() {
        ScreenshotOutcome::Cancelled => {}
        ScreenshotOutcome::Failed(err) => {
            eprintln!("wudao: screenshot failed ({err}): 本次截图停用（应用继续）");
        }
        ScreenshotOutcome::Captured(bytes) => {
            let payload: serde_json::Value = serde_json::from_str(&screenshot_event_payload(&bytes))
                .unwrap_or_else(|_| serde_json::json!({ "data": "", "mediaType": "" }));
            let _ = app.emit(WUDAO_SCREENSHOT_EVENT, payload);
        }
    });
}

/// One capture: `screencapture -i <tmpdir png>` into a sessionless
/// tmpfile, then the post-exit stages. The tmpfile name carries the pid +
/// a process-local counter so a double-press (a second capture while the
/// first crosshair is still up) never collides.
fn capture_screenshot() -> ScreenshotOutcome {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir()
        .join(format!("wudao-screenshot-{}-{n}.png", std::process::id()));
    let spawn = std::process::Command::new("screencapture")
        .arg("-i")
        .arg(&path)
        .status()
        .map(|s| s.success())
        .map_err(|e| e.to_string());
    match spawn_stage(spawn) {
        Some(outcome) => outcome,
        None => finish_capture(&path),
    }
}

/// The post-exit stages, real I/O but deterministic — tested here with
/// real temp files: stat gate (empty/oversize → typed error) → read →
/// delete-ALWAYS. 读后立删（失败也删）is the privacy contract: the bytes
/// never linger anywhere; the only copy past this point is the UI draft
/// the web side mints from the event (submit 前零 attachmentSave).
pub fn finish_capture(path: &std::path::Path) -> ScreenshotOutcome {
    let len = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(e) => {
            let _ = std::fs::remove_file(path);
            return ScreenshotOutcome::Failed(format!("cannot stat {}: {e}", path.display()));
        }
    };
    if let Err(err) = size_gate(len) {
        let _ = std::fs::remove_file(path);
        return ScreenshotOutcome::Failed(err);
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let _ = std::fs::remove_file(path);
            ScreenshotOutcome::Captured(bytes)
        }
        Err(e) => {
            let _ = std::fs::remove_file(path);
            ScreenshotOutcome::Failed(format!("cannot read {}: {e}", path.display()))
        }
    }
}

//
// ω99-116 tests — the pure layer behind 截图快问 (brief RED 预期 A): the
// spawn/exit classification (Esc→Cancelled), the size gate (empty/oversize
// → typed errors), the payload codec (base64 roundtrip), finish_capture's
// 读后立删 contract, and the pinned literals. The screencapture spawn +
// hotkey registration + emit edges are desktop-manual items (62 号债 TCC)
// — deliberately NOT tested here.
//
#[cfg(test)]
mod screenshot_tests {
    use super::*;

    // ---- spawn_stage ------------------------------------------------------

    #[test]
    fn spawn_failure_is_a_typed_error() {
        // 非 macOS / 无 screencapture——诚实面，不是崩溃
        assert_eq!(
            spawn_stage(Err("No such file or directory (os error 2)".to_string())),
            Some(ScreenshotOutcome::Failed(
                "cannot spawn screencapture: No such file or directory (os error 2)".to_string()
            )),
        );
    }

    #[test]
    fn nonzero_exit_is_cancelled_not_an_error() {
        // Esc 在系统选区 UI 里 = screencapture -i 的普通退出路径——typed
        // Cancelled，web 侧永远听不到
        assert_eq!(spawn_stage(Ok(false)), Some(ScreenshotOutcome::Cancelled));
    }

    #[test]
    fn success_exit_proceeds_to_the_file_stages() {
        assert_eq!(spawn_stage(Ok(true)), None);
    }

    // ---- size_gate ----------------------------------------------------------

    #[test]
    fn size_gate_passes_at_and_under_the_cap() {
        assert_eq!(size_gate(1), Ok(()));
        assert_eq!(size_gate(MAX_SCREENSHOT_BYTES), Ok(())); // 恰等不拒
    }

    #[test]
    fn size_gate_rejects_empty_and_oversize() {
        // TCC 屏幕录制被拒 → screencapture 写空文件——提示查权限
        let empty = size_gate(0).unwrap_err();
        assert!(empty.contains("屏幕录制"), "empty hint names the permission: {empty}");
        let big = size_gate(MAX_SCREENSHOT_BYTES + 1).unwrap_err();
        assert!(big.contains("20MiB"), "oversize names the cap: {big}");
    }

    // ---- payload codec ------------------------------------------------------

    /// The test-side mirror of the JS atob (RFC 4648, padded) — proving the
    /// bytes survive the wire codec without shipping a decode crate.
    fn b64_decode(s: &str) -> Vec<u8> {
        const A: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut n: u32 = 0;
        let mut bits: u32 = 0;
        for c in s.bytes() {
            if c == b'=' {
                break;
            }
            let v = A.iter().position(|a| *a == c).expect("valid alphabet") as u32;
            n = (n << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((n >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn payload_roundtrips_bytes_as_base64_png() {
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 250];
        let json = screenshot_event_payload(&bytes);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v.get("mediaType"), Some(&serde_json::json!("image/png")));
        let data = v.get("data").and_then(|d| d.as_str()).unwrap();
        assert_eq!(b64_decode(data), bytes);
        // 空字节也成一形载荷（finish_capture 已拦空文件；codec 自身不挑食）
        let empty = screenshot_event_payload(&[]);
        let v: serde_json::Value = serde_json::from_str(&empty).unwrap();
        assert_eq!(v.get("data"), Some(&serde_json::json!("")));
    }

    #[test]
    fn payload_is_exactly_two_keys() {
        let v: serde_json::Value =
            serde_json::from_str(&screenshot_event_payload(&[1, 2, 3])).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 2, "no extras ride the wire");
        assert!(obj.contains_key("data"));
        assert!(obj.contains_key("mediaType"));
    }

    // ---- finish_capture（真临时文件——读后立删契约）--------------------------

    #[test]
    fn finish_capture_reads_then_deletes_the_tmpfile() {
        let path = std::env::temp_dir()
            .join(format!("wudao-screenshot-test-ok-{}.png", std::process::id()));
        std::fs::write(&path, [1u8, 2, 3]).unwrap();
        assert_eq!(finish_capture(&path), ScreenshotOutcome::Captured(vec![1, 2, 3]));
        assert!(!path.exists(), "读后立删——sessionless");
    }

    #[test]
    fn finish_capture_oversize_errors_and_still_deletes() {
        let path = std::env::temp_dir()
            .join(format!("wudao-screenshot-test-big-{}.png", std::process::id()));
        std::fs::write(&path, vec![0u8; MAX_SCREENSHOT_BYTES as usize + 1]).unwrap();
        match finish_capture(&path) {
            ScreenshotOutcome::Failed(msg) => assert!(msg.contains("20MiB"), "{msg}"),
            other => panic!("oversize must Fail, got {other:?}"),
        }
        assert!(!path.exists(), "超限也删——字节不留任何位置");
    }

    #[test]
    fn finish_capture_missing_file_is_a_typed_error() {
        let path = std::env::temp_dir()
            .join(format!("wudao-screenshot-test-missing-{}.png", std::process::id()));
        let _ = std::fs::remove_file(&path); // 前置清场
        match finish_capture(&path) {
            ScreenshotOutcome::Failed(msg) => assert!(msg.contains("cannot stat"), "{msg}"),
            other => panic!("missing file must Fail, got {other:?}"),
        }
    }

    // ---- pinned literals ------------------------------------------------------

    #[test]
    fn event_name_and_hotkey_and_cap_are_pinned() {
        // 事件名与 web 侧 screenshot-ask.ts 的 WUDAO_SCREENSHOT_EVENT 同名钉死
        assert_eq!(WUDAO_SCREENSHOT_EVENT, "wudao-screenshot");
        assert_eq!(SCREENSHOT_HOTKEY, "Alt+Command+S");
        assert_eq!(MAX_SCREENSHOT_BYTES, 20 * 1024 * 1024);
    }

    #[test]
    fn hotkey_unavailable_note_is_the_fail_open_face() {
        // taken 热键绝不杀壳——B 层的注册失败诚实面（110 同款形态）
        assert_eq!(
            hotkey_unavailable_note("hotkey already registered"),
            "wudao: screenshot hotkey unavailable (hotkey already registered): 截图快问停用（应用继续）",
        );
    }
}
