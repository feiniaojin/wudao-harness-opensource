// 0.5.10 — Windows 宠物窗「常驻 layered」修复（用户报障 2026-11-12：Windows
// 0.5.9 上提问后 thinking/回答不流式——等很久一次性出现；mac 同链路正常）。
//
// 根因（代码级证据，非猜测）：
//   1. 宠物窗是 transparent + decorations:false 的浮窗。tao 对 transparent
//      本身不加 WS_EX_LAYERED——只有 set_ignore_cursor_events(true)（穿透）
//      才置位 WS_EX_TRANSPARENT|WS_EX_LAYERED（tao-0.35.3 window_state.rs
//      的 IGNORE_CURSOR_EVENT 臂），且 tao/wry/tauri 全库从不调
//      SetLayeredWindowAttributes（registry 源码 grep 零命中）。
//   2. 穿透轮询（spawn_pet_penetration_poll，120ms）随光标进出反复增删
//      WS_EX_LAYERED：一个「带 layered 位但从未设过 attributes」的窗口，
//      其重定向面处于未定义态——WebView2 的透明 DComp 子面可以停止
//      present，直到样式/尺寸变化强制 DWM 重建（tauri#12800 一族：内容
//      变了不重绘、resize/交互才一次性出现）。报障里「等很久突然出现」的
//      时刻正是 set_pet_layout 的 resize 或鼠标掠过（轮询翻转样式）触发
//      的那次重建。
//   3. mac（WKWebView）不走该路径，同链路正常——平台差异与版本时间线
//      （0.5.6 恢复 Windows 宠物窗透明；此前 Windows 端从未真正在精灵里
//      流式过）都吻合。
//
// 修复（不是照搬社区 resize-jiggle 对策，而是把窗口面放进确定态）：
// Windows 上给宠物窗「常驻 WS_EX_LAYERED + SetLayeredWindowAttributes(
// α=255、无颜色键)」——重定向面一旦初始化就由 DWM 持续合成，present 不再
// 依赖「下一次样式变更」；α=255 是窗口面全不透明（视觉零变化），WebView2
// 子面自己的透明合成照常。穿透语义仍只归 WS_EX_TRANSPARENT（本就不该由
// layered 位承载）。生产先例：music-island（Windows Tauri 悬浮岛，持续
// 进度更新）同款配方——「layered parent + uniform opacity 255 + no color
// key」，其 ARCHITECTURE.md 明言这是防「未定/陈旧重定向面」的关键层。
//
// 兜底（若实机仍不流式）：tauri-build.mjs 一行即可回到 0.5.5 形——把
// `w.label === "pet"` 的 transparent 也构建期翻掉（代价：精灵变不透明方卡，
// 即 0.5.6 修掉的那个观感，故只作二线）。
//
// 结构沿用 selection.rs 的纪律：纯逻辑（样式位的判定）跨平台可测；FFI 块
// hand-rolled 零 crate、签名即文档、不做运行时测试（x64 假设与主工程一致：
// Windows 构建目标是 x86_64-pc-windows-msvc，SetWindowLongPtrW 存在）。

/// The extended-style index (GWL_EXSTYLE) — the only slot we touch.
#[cfg_attr(not(windows), allow(dead_code))]
const GWL_EXSTYLE: i32 = -20;
/// WS_EX_LAYERED: route the window through DWM's layered redirection surface.
const WS_EX_LAYERED: isize = 0x0008_0000;
/// LWA_ALPHA: SetLayeredWindowAttributes' alpha mode (no color key).
#[cfg_attr(not(windows), allow(dead_code))]
const LWA_ALPHA: u32 = 0x2;
/// Full opacity for the window surface itself — the WebView2 child composites
/// its own transparency on top; the parent must not scale it.
#[cfg_attr(not(windows), allow(dead_code))]
const ALPHA_FULL: u8 = 255;

/// Pure: the EXSTYLE the pet window should carry (the layered bit, added or
/// already present). Cross-platform and unit-tested — the FFI half only moves
/// styles between here and Win32.
pub fn exstyle_with_layered(exstyle: isize) -> isize {
    exstyle | WS_EX_LAYERED
}

/// Pure: does this EXSTYLE already carry the layered bit?
pub fn exstyle_is_layered(exstyle: isize) -> bool {
    exstyle & WS_EX_LAYERED != 0
}

// The thin Win32 half — hand-rolled FFI, zero crates, deliberately untested
// (same note as selection.rs's AX block: signatures ARE the documentation).
#[cfg(windows)]
mod win32 {
    // BOOL widens to i32; the long-pointer APIs are isize on x64.
    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        pub fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        pub fn SetLayeredWindowAttributes(hwnd: isize, colorkey: u32, alpha: u8, flags: u32) -> i32;
    }
}

/// The real Windows body lives in one place: reading hwnd() needs the windows
/// runtime's HWND type, so the whole implementation is cfg-gated here.
#[cfg(windows)]
pub fn ensure_layered(pet: &tauri::WebviewWindow) -> bool {
    let Ok(hwnd) = pet.hwnd() else { return false };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let current = win32::GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if !exstyle_is_layered(current) {
            let prev = win32::SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exstyle_with_layered(current));
            if prev == 0 && current != 0 {
                // The write failed (SetWindowLongPtr returns the previous value;
                // 0-with-nonzero-previous means error). Fail soft: next poll
                // tick retries.
                return false;
            }
        }
        // Attributes ride the window (they persist), but re-asserting after any
        // absent→present transition is cheap and closes the tao-toggle race:
        // if tao stripped and we re-added within one tick, this is the call
        // that puts the redirection surface back into a defined state.
        win32::SetLayeredWindowAttributes(hwnd, 0, ALPHA_FULL, LWA_ALPHA) != 0
    }
}

/// Non-Windows: nothing to do — WKWebView's transparent windows present fine
/// (the bug class is WebView2/layered-redirection specific).
#[cfg(not(windows))]
pub fn ensure_layered(_pet: &tauri::WebviewWindow) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{exstyle_is_layered, exstyle_with_layered, WS_EX_LAYERED};

    #[test]
    fn adds_the_bit_to_any_style() {
        assert_eq!(exstyle_with_layered(0), WS_EX_LAYERED);
        assert_eq!(exstyle_with_layered(0x0001_0100), 0x0001_0100 | WS_EX_LAYERED);
    }

    #[test]
    fn idempotent_when_already_layered() {
        let layered = 0x0100 | WS_EX_LAYERED;
        assert_eq!(exstyle_with_layered(layered), layered);
        assert!(exstyle_is_layered(layered));
    }

    #[test]
    fn detects_absence() {
        assert!(!exstyle_is_layered(0));
        assert!(!exstyle_is_layered(0x0008_0000 - 1));
        assert!(!exstyle_is_layered(0x0001_0100));
    }
}
