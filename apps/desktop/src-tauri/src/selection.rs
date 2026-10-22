// ω99-110 (P1): 划词助手 — global hotkey ⌥⌘E → AX selection read → the pet's
// intake card. 「任意 app 划词 → 按热键 → 宠物弹接单卡（选文摘录 + 翻译/
// 解释 chip + 提问框）→ 发出 → 结果流式回气泡」。This module is the Rust
// half: a PURE clamp/payload layer (fully tested — this file's tests), a thin
// macOS AX FFI block (hand-rolled, ZERO crates; signatures pinned in the
// brief, deliberately untested — see its note), and the hotkey handler that
// decides what to broadcast. The web half lives in packages/web/src/pet/
// selection.ts; the event names are pinned on BOTH sides (a drift reads as
// a review-time diff, never a runtime normalization).

/// The selection cap. AX hands over whatever the user selected; a whole-page
/// ⌘A must not balloon the event payload (and the pet card clips visually
/// anyway). 12000 chars ≈ a long document excerpt; beyond it the text
/// truncates with an explicit marker suffix and truncated=true.
pub const MAX_SELECTION_CHARS: usize = 12_000;

/// The Tauri event broadcasting a fresh selection (Rust → pet window). Same
/// literal as the web side's WUDAO_PET_SELECTION_EVENT — pinned by tests on
/// both sides.
pub const WUDAO_PET_SELECTION_EVENT: &str = "wudao-pet-selection";

/// The default global hotkey (tauri-plugin-global-shortcut parses this
/// string; ⌥⌘E — E for excerpt, nothing else claims it on macOS).
pub const SELECTION_HOTKEY: &str = "Alt+Command+E";

/// Normalize a raw AX selection for the wire: trim, CRLF→LF, strip control
/// characters other than \n and \t, and cap at MAX_SELECTION_CHARS with an
/// explicit truncation marker. Pure — the tested surface.
pub fn clamp_selection(raw: &str) -> (String, bool) {
    let normalized: String = raw
        .trim()
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    if normalized.chars().count() > MAX_SELECTION_CHARS {
        // 按字符截（CJK 安全），尾加显式标记——截断从不静默。
        let cut: String = normalized.chars().take(MAX_SELECTION_CHARS).collect();
        (format!("{cut}\n…（已截断）"), true)
    } else {
        (normalized, false)
    }
}

/// The event payload codec (serde_json-only — the pet-window.json/pet-skin.json
/// discipline, no serde derive): exactly `{"text","truncated","granted"}`.
fn selection_event_payload(text: &str, truncated: bool, granted: bool) -> String {
    serde_json::json!({ "text": text, "truncated": truncated, "granted": granted }).to_string()
}

/// The hotkey's whole decision as ONE pure function (brief §2「热键→payload
/// 组装纯段」): untrusted → the guide payload (`granted:false`, empty text —
/// the pet shows its permission-guide card); trusted → clamp whatever AX
/// returned (None = any step of the read chain failed = empty string, never
/// an error state). The handler emits the return value verbatim.
pub fn selection_dispatch_payload(granted: bool, raw: Option<&str>) -> String {
    if !granted {
        return selection_event_payload("", false, false);
    }
    let (text, truncated) = clamp_selection(raw.unwrap_or(""));
    selection_event_payload(&text, truncated, true)
}

//
// ω99-110: the macOS AX read — hand-rolled FFI, ZERO crates (brief §1's
// dependency ruling: the ONLY new crate is tauri-plugin-global-shortcut).
// The FFI layer is THIN BY DESIGN and carries NO tests (brief §2): the
// signatures are pinned verbatim below and the calls only run on a live
// desktop (doc 114 §ω99-110 manual items). Everything decidable is decided
// in the pure layer.
//
// LINKABILITY NOTE (0.3.46 release postmortem): the symbol set is chosen
// against what the ApplicationServices umbrella .tbd actually exports.
// The first attempt (AXUIElementCopySystemFocusedElement + the
// kAXSelectedTextAttribute extern static) linked under `cargo test` but
// NOT under the release build: those two symbols appear in NO SDK .tbd on
// the build machine, and the --test profile MASKS this — test builds
// replace main(), the tauri setup closure becomes unreachable, and the
// FFI call chain is dropped before codegen, so the test binary links
// clean. An FFI block reachable only from the app's real main is
// INVISIBLE to `cargo test`; the release build is the only honest gate.
//

#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager};

/// kCFStringEncodingUTF8 (the FFI set deliberately omits the symbol; the
/// literal is the pinned one from the brief).
#[cfg(target_os = "macos")]
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[cfg(target_os = "macos")]
// Every symbol below is confirmed present in the ApplicationServices
// umbrella .tbd on the build machine (see the LINKABILITY NOTE above).
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> *const c_void;
    fn AXUIElementCopyAttributeValue(el: *const c_void, attr: *const c_void, v: *mut *const c_void) -> i32;
}

/// The AX attribute names, hand-built as CFStrings. The real constants
/// (kAXFocusedUIElementAttribute / kAXSelectedTextAttribute) are extern
/// statics this machine's SDK .tbds do not export (the 0.3.46 link
/// failure), so the read chain builds them from their documented public
/// string values — CFStringCreateWithCString is a CoreFoundation symbol
/// and always links. NUL-terminated for the C entry point.
#[cfg(target_os = "macos")]
const K_AX_FOCUSED_UI_ELEMENT: &[u8] = b"AXFocusedUIElement\0";
#[cfg(target_os = "macos")]
const K_AX_SELECTED_TEXT: &[u8] = b"AXSelectedText\0";

#[cfg(target_os = "macos")]
unsafe fn cfstring_literal(lit: &[u8]) -> *const c_void {
    CFStringCreateWithCString(
        std::ptr::null(),
        lit.as_ptr() as *const c_char,
        K_CF_STRING_ENCODING_UTF8,
    )
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(alloc: *const c_void, c_str: *const c_char, encoding: u32) -> *const c_void;
    fn CFStringGetLength(s: *const c_void) -> isize;
    fn CFStringGetCString(s: *const c_void, buf: *mut c_char, len: isize, enc: u32) -> bool; // kCFStringEncodingUTF8 = 0x08000100
    fn CFRelease(cf: *const c_void);
}

/// The read chain: trusted? → the system-wide element → its focused
/// element (AXFocusedUIElement — the documented equivalent of the
/// unavailable AXUIElementCopySystemFocusedElement convenience call) →
/// copy that element's AXSelectedText value → it is a CFString (the
/// attribute's API contract returns a string or nothing — the pinned FFI
/// set has no CFGetTypeID to re-check, and the contract is the type
/// guarantee) → UTF-8 into a 4*len+1 buffer. Any step failing / a
/// non-string value = None → dispatch reads it as the EMPTY selection
/// (the pet's「没划到文字」state — never an error surface, never a panic).
/// CFRelease(NULL) is a crash, so every release is null-guarded.
#[cfg(target_os = "macos")]
fn ax_read_selection() -> Option<String> {
    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }
        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }
        let attr_focused = cfstring_literal(K_AX_FOCUSED_UI_ELEMENT);
        let mut focused: *const c_void = std::ptr::null();
        let got_focused = if attr_focused.is_null() {
            -1
        } else {
            AXUIElementCopyAttributeValue(system_wide, attr_focused, &mut focused)
        };
        CFRelease(system_wide);
        if !attr_focused.is_null() {
            CFRelease(attr_focused);
        }
        if got_focused != 0 || focused.is_null() {
            return None;
        }
        let attr_selected = cfstring_literal(K_AX_SELECTED_TEXT);
        let mut value: *const c_void = std::ptr::null();
        let copied = if attr_selected.is_null() {
            -1
        } else {
            AXUIElementCopyAttributeValue(focused, attr_selected, &mut value)
        };
        CFRelease(focused);
        if !attr_selected.is_null() {
            CFRelease(attr_selected);
        }
        if copied != 0 || value.is_null() {
            return None;
        }
        let len = CFStringGetLength(value); // UTF-16 code units
        let cap = len.saturating_mul(4).saturating_add(1); // UTF-8 worst case + NUL
        let mut buf: Vec<u8> = Vec::with_capacity(cap.max(1) as usize);
        let ok = CFStringGetCString(
            value,
            buf.as_mut_ptr() as *mut c_char,
            cap.max(1),
            K_CF_STRING_ENCODING_UTF8,
        );
        CFRelease(value);
        if !ok {
            return None;
        }
        let bytes = std::ffi::CStr::from_ptr(buf.as_ptr() as *const c_char).to_bytes();
        String::from_utf8(bytes.to_vec()).ok()
    }
}

/// The hotkey press: emit-gate → trust check → read → dispatch. A HIDDEN
/// pet gets NO emit (is_visible() == false → the card would have no one to
/// see it; the user re-shows the pet from the tray). Emission is
/// fire-and-forget (broken IPC is P0-accepted, the relay-pump posture) and
/// the payload round-trips through the canonical serializer so the bytes
/// the listener parses are the bytes the tests pin (the pet-drop pattern).
#[cfg(target_os = "macos")]
pub fn handle_selection_hotkey(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    if !pet.is_visible().unwrap_or(false) {
        return; // 卡无人看——隐藏的宠物不接单
    }
    let granted = unsafe { AXIsProcessTrusted() };
    let raw = if granted { ax_read_selection() } else { None };
    let payload: serde_json::Value =
        serde_json::from_str(&selection_dispatch_payload(granted, raw.as_deref()))
            .unwrap_or_else(|_| serde_json::json!({ "text": "", "truncated": false, "granted": false }));
    let _ = app.emit(WUDAO_PET_SELECTION_EVENT, payload);
}

/// The guide card's button: open System Settings → Privacy & Security →
/// Accessibility (the ONE permission the AX read needs). Best-effort — the
/// web seam (tauriInvokeCommand) already swallows rejections; the spawn
/// result is ignored here for the same reason.
#[tauri::command]
pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

//
// ω99-110 tests — the pure layer behind 划词助手 (brief §2 Rust): clamp's
// trim/CRLF/control-char/truncation rules, the payload shape, and the
// hotkey→payload dispatch (untrusted guide / trusted-empty / trusted-text).
// The AX FFI + hotkey registration + emit edges are desktop-manual items
// (doc 114 §ω99-110) — deliberately NOT tested here.
//
#[cfg(test)]
mod selection_tests {
    use super::*;

    // ---- clamp_selection ------------------------------------------------

    #[test]
    fn clamp_trims_and_passes_clean_text_through() {
        assert_eq!(clamp_selection("  你好，划词助手  "), ("你好，划词助手".to_string(), false));
        assert_eq!(clamp_selection("plain text"), ("plain text".to_string(), false));
        // 内部空白（空格/换行/制表）不是边饰——原样保留
        assert_eq!(
            clamp_selection("第一行\n\t第二行"),
            ("第一行\n\t第二行".to_string(), false),
        );
    }

    #[test]
    fn clamp_converts_crlf_to_lf() {
        assert_eq!(
            clamp_selection("a\r\nb\r\n\r\nc"),
            ("a\nb\n\nc".to_string(), false),
        );
    }

    #[test]
    fn clamp_strips_control_chars_except_newline_and_tab() {
        // NUL / BEL / ESC / U+001F 等控制字符剔除；\n 与 \t 是仅有的幸存者
        assert_eq!(
            clamp_selection("a\u{0}b\u{7}c\u{1b}d\u{1f}e"),
            ("abcde".to_string(), false),
        );
        // 孤立的 \r（非 CRLF 一部分）也是控制字符 → 剔除
        assert_eq!(clamp_selection("a\rb"), ("ab".to_string(), false));
        // 全控制字符 → 空串（宠物面走「没划到文字」空态，不是错误）
        assert_eq!(clamp_selection("\u{0}\u{1}\u{2}"), (String::new(), false));
        // 空入参同样空串
        assert_eq!(clamp_selection(""), (String::new(), false));
        assert_eq!(clamp_selection("   \n\t "), (String::new(), false));
    }

    #[test]
    fn clamp_truncates_beyond_the_cap_with_marker() {
        let raw = "汉".repeat(MAX_SELECTION_CHARS + 5); // 多字节：按字符计，不按字节
        let (out, truncated) = clamp_selection(&raw);
        assert!(truncated);
        // 前 12000 字原样 + 标记行
        let expected = format!("{}\n…（已截断）", "汉".repeat(MAX_SELECTION_CHARS));
        assert_eq!(out, expected);
    }

    #[test]
    fn clamp_at_exactly_the_cap_is_not_truncated() {
        let raw = "a".repeat(MAX_SELECTION_CHARS);
        let (out, truncated) = clamp_selection(&raw);
        assert!(!truncated);
        assert_eq!(out.len(), MAX_SELECTION_CHARS);
        assert!(!out.contains("已截断"));
    }

    // ---- payload --------------------------------------------------------

    #[test]
    fn payload_is_exactly_three_keys() {
        let json = selection_event_payload("选段", true, true);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 3, "no extras ride the wire");
        assert_eq!(v.get("text"), Some(&serde_json::json!("选段")));
        assert_eq!(v.get("truncated"), Some(&serde_json::json!(true)));
        assert_eq!(v.get("granted"), Some(&serde_json::json!(true)));
    }

    // ---- dispatch（热键→payload 组装纯段）--------------------------------

    #[test]
    fn dispatch_untrusted_is_the_guide_payload() {
        let v: serde_json::Value = serde_json::from_str(&selection_dispatch_payload(false, None))
            .unwrap();
        // 未授权：空文本 + granted=false —— 宠物面出权限引导卡（不是错误）
        assert_eq!(v.get("text"), Some(&serde_json::json!("")));
        assert_eq!(v.get("truncated"), Some(&serde_json::json!(false)));
        assert_eq!(v.get("granted"), Some(&serde_json::json!(false)));
    }

    #[test]
    fn dispatch_trusted_read_failure_reads_as_empty_selection() {
        // 读链任何一步失败（None）→ 空文本 + granted=true —— 宠物面走「没划到文字」
        let v: serde_json::Value =
            serde_json::from_str(&selection_dispatch_payload(true, None)).unwrap();
        assert_eq!(v.get("text"), Some(&serde_json::json!("")));
        assert_eq!(v.get("truncated"), Some(&serde_json::json!(false)));
        assert_eq!(v.get("granted"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn dispatch_trusted_text_is_clamped_into_the_payload() {
        let v: serde_json::Value = serde_json::from_str(&selection_dispatch_payload(
            true,
            Some("  hello\r\nworld  "),
        ))
        .unwrap();
        assert_eq!(v.get("text"), Some(&serde_json::json!("hello\nworld")));
        assert_eq!(v.get("truncated"), Some(&serde_json::json!(false)));
        assert_eq!(v.get("granted"), Some(&serde_json::json!(true)));
        // 超长选段经 dispatch 同样截断（clamp 是唯一收口）
        let long = "x".repeat(MAX_SELECTION_CHARS + 1);
        let v: serde_json::Value =
            serde_json::from_str(&selection_dispatch_payload(true, Some(&long))).unwrap();
        assert_eq!(v.get("truncated"), Some(&serde_json::json!(true)));
    }

    // ---- pinned literals --------------------------------------------------

    #[test]
    fn event_name_and_hotkey_and_cap_are_pinned() {
        // 事件名与 web 侧 selection.ts 的 WUDAO_PET_SELECTION_EVENT 同名钉死
        assert_eq!(WUDAO_PET_SELECTION_EVENT, "wudao-pet-selection");
        assert_eq!(SELECTION_HOTKEY, "Alt+Command+E");
        assert_eq!(MAX_SELECTION_CHARS, 12_000);
    }
}
