// wudao desktop shell (M43-C) — minimal by design.
//
// The whole job description:
//   1. resolve a workspace dir and spawn the sidecar (standalone-compiled
//      wudao-server, Node SEA) there;
//   2. read its stdout until the protocol line `open: http://127.0.0.1:<port>/#<token>`
//      (handshake, bounded by HANDSHAKE_TIMEOUT);
//   3. navigate the window to that URL — the web UI, its first-frame fragment
//      auth, and everything downstream are the EXISTING M43-A/B stack,
//      untouched;
//   4. terminate the sidecar when the window closes or the app exits:
//      SIGTERM → TERM_GRACE → SIGKILL (zombie fallback) → reap.
//
// Everything testable lives in JS (apps/desktop/src/sidecar-protocol.ts +
// tests/): the parser rules and the launch/terminate state machines are
// mirrored 1:1 here. Keep both in sync.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// 品牌弧补丁：托盘精灵帧走 PNG 内嵌解码（image-png 特性）——手搓 RGBA
// 数组曾出现字节错位花屏（斜纹），标准 PNG 解码链无此风险。

use tauri::{AppHandle, DragDropEvent, Emitter, Listener, Manager, RunEvent, WindowEvent};

// ω99-110 (P1): 划词助手 — the selection hotkey's pure clamp/payload layer,
// the macOS AX FFI read, and the open_accessibility_settings command.
mod selection;

// ω99-116 (P1): 截图快问 — the screenshot hotkey's pure decision layer
// (spawn/exit classification, size gate, payload codec) + the thin
// screencapture runner that emits the png bytes to the composer's rail.
mod screenshot;

/// How long the sidecar gets to print its protocol line (server boot is
/// ~1-2s; the bound also covers first-launch disk churn).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace period between SIGTERM (the server's clean-shutdown path) and the
/// SIGKILL fallback.
const TERM_GRACE: Duration = Duration::from_secs(3);

const PROTOCOL_PREFIX: &str = "open: ";

/// 122 项 2 — the LaunchAgent wake flag (launchd fires `open -a 悟道Harness
/// --args --schedule-wake`; the plist itself is written by the CLI-side
/// schedule daemon). argv only exists in THIS process — spawn_sidecar
/// translates it into the env below for the sidecar (the SEA entry rewrites
/// argv on boot, env survives); the sidecar reads it for an honest wake
/// receipt. The catch-up itself is the daemon boot's EXISTING
/// applyMissedFire + immediate tick — no second catch-up path.
const SCHEDULE_WAKE_ARG: &str = "--schedule-wake";
const SCHEDULE_WAKE_ENV: &str = "WUDAO_SCHEDULE_WAKE";

/// Pure argv scan (unit-testable; the std::env::args read stays at the call
/// site — the spawn/env sides never run under test).
fn schedule_wake_requested<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> bool {
    args.into_iter().any(|a| a.as_ref() == SCHEDULE_WAKE_ARG)
}

/// ω99-105 (P1): the pet's delivery bubble, clicked → summon the main
/// window. Same name as the web side's WUDAO_PET_OPEN_MAIN_EVENT (Bubble.tsx
/// emits it; there is a JS test pinning the literal).
const PET_OPEN_MAIN_EVENT: &str = "pet-open-main";

/// The one piece of live state: the sidecar child, owned exactly once so
/// terminate is idempotent across the window-close/exit/repeat event storm.
struct SidecarState {
    child: Mutex<Option<Child>>,
}

fn main() {
    tauri::Builder::default()
        // 2026-09-12 收口：单实例锁——必须注册在插件链 FIRST（锁要先于一切
        // 建立才可靠，官方文档的要求）。两次「小精灵又没了」（0.3.75、
        // 0.3.77）均在重装后自愈：同一份字节重装即恢复 = 运行态劣化而非代
        // 码回归，多实例/残留实例互踩是病根家族（桌面壳此前无锁，命令行
        // `open -n`、helper 残留等路径可起第二实例，两个 tray/宠物窗/端口
        // 互踩）。第二实例启动 → 本回调跑在已有实例里唤起主窗 → 新实例自
        // 退。锁层失败 fail-open（照常启动，绝不让「双击没反应」发生）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // M76-ux2 §4 + M77 §1: guest plugins the web UI reaches over the
        // withGlobalTauri invoke bridge (agent-finish notifications; the
        // workspace directory picker). Capabilities already pin their
        // permissions — this is what makes those entries (and the features)
        // real instead of build-failing.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // ω99-110 (P1): the selection hotkey — ⌥⌘E reads the focused
            // app's selection over AX (zero-crate FFI in selection.rs) and
            // broadcasts it to the pet's intake card. macOS-only (the AX read
            // IS the feature). Registration failure = WARN + feature no-op:
            // the app fail-opens (a taken hotkey must never kill the shell),
            // the feature fail-closes — brief §2's ruling. Rust-side
            // registration needs NO capability (the ACL gates the JS invoke
            // path; nothing here invokes the plugin from JS).
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_global_shortcut::ShortcutState;
                let builder = tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        // ω99-116: TWO hotkeys now ride this one plugin — the
                        // builder-level handler fires for EVERY registered
                        // shortcut, so it routes by identity (a ⌥⌘S press
                        // must never also run the AX selection read).
                        // Parse-compare against the pinned const: the
                        // shortcut arg arrives as the parsed HotKey.
                        if let Ok(sel) =
                            selection::SELECTION_HOTKEY.parse::<tauri_plugin_global_shortcut::Shortcut>()
                        {
                            if shortcut == &sel {
                                selection::handle_selection_hotkey(app);
                            }
                        }
                        if let Ok(shot) =
                            screenshot::SCREENSHOT_HOTKEY.parse::<tauri_plugin_global_shortcut::Shortcut>()
                        {
                            if shortcut == &shot {
                                screenshot::handle_screenshot_hotkey(app);
                            }
                        }
                    });
                match builder.with_shortcut(selection::SELECTION_HOTKEY) {
                    Ok(ready) => {
                        if let Err(err) = app.handle().plugin(ready.build()) {
                            eprintln!(
                                "wudao: selection hotkey unavailable ({}): 划词接单停用（应用继续）",
                                err
                            );
                        }
                    }
                    Err(err) => {
                        eprintln!(
                            "wudao: selection hotkey parse failed ({}): 划词接单停用（应用继续）",
                            err
                        );
                    }
                }
            }

            // ω99-116 (P1): the SECOND global hotkey — ⌥⌘S → 截图快问. It
            // registers at runtime through the SAME plugin's per-shortcut
            // lane (GlobalShortcutExt), NOT a second plugin instance, so a
            // taken ⌥⌘S fails OPEN on its own: the shell AND the ⌥⌘E
            // selection arc keep working (the 110 posture, now per-hotkey).
            // try_state (never State's panicking deref): if the plugin
            // above failed to initialize (⌥⌘E taken), the managed cell is
            // absent and this reads None — the honest face, not a crash.
            // The builder-level handler above routes by identity, so this
            // runtime-registered shortcut flows through the same dispatch.
            #[cfg(target_os = "macos")]
            {
                match app.try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>() {
                    Some(gs) => {
                        if let Err(err) = gs.register(screenshot::SCREENSHOT_HOTKEY) {
                            eprintln!("{}", screenshot::hotkey_unavailable_note(&err.to_string()));
                        }
                    }
                    None => eprintln!(
                        "{}",
                        screenshot::hotkey_unavailable_note("global-shortcut plugin not initialized")
                    ),
                }
            }

            // macOS needs SOME menu for Quit to exist; keep it to About/Quit.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, "悟道Harness")
                    .about(None)
                    .separator()
                    .quit()
                    .build()?;
                // 用户反馈 2026-08-29:「模型卡片无法复制粘贴,baseUrl 粘不进」。
                // 根因:上面的自定义菜单替换了 tauri 默认菜单,macOS 的
                // Cmd+C/V/A 键盘等效靠主菜单里的 Edit 项路由 performPaste:
                // 到第一响应者——没有 Edit 子菜单,WKWebView 输入框收不到
                // 剪贴板动作(浏览器里 wudao ui 正常,桌面端独有)。tauri
                // 2.11 无 PredefinedMenuItem::edit 便捷构造,SubmenuBuilder
                // 逐项补齐标准 Edit 菜单,零 JS 改动。
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(app).item(&app_menu).item(&edit_menu).build()?;
                app.set_menu(menu)?;
            }

            let handle = app.handle().clone();
            let state = Arc::new(SidecarState { child: Mutex::new(None) });
            app.manage(Arc::clone(&state));

            // ω99-100 (spec D7): pet position persistence state — a separate
            // managed cell from SidecarState (one struct, one job), reachable
            // from both the window-event closure and the tray handlers.
            app.manage(PetWindowState { moves: Mutex::new(MoveThrottle::new()) });
            // ω99-100: the tray — the summon-back path once windows hide (the
            // pet's Destroyed only hides it, spec D4) and the quit that
            // converges on the same RunEvent::Exit cleanup as closing the
            // main window.
            build_tray(app)?;

            // ω99-104 (P1): the drop allowlist — the ONLY bridge between
            // "the user dropped this file on the pet" and "the webview may
            // read this file". Managed separately from PetWindowState: one
            // struct, one job.
            app.manage(DropAllowlist { entries: Mutex::new(Vec::new()) });

            // ω99-105 (P1): the delivery bubble's click path — the pet
            // emits pet-open-main, the shell brings the main window forward
            // (show + focus, the handshake's existing posture at
            // handshake_and_navigate). An AppHandle-level event listener:
            // no new window, no capability (Rust-side listen is not ACL'd;
            // the pet's emit already rides pet.json's core:event:allow-emit),
            // no command. A missing window is a silent skip, same as every
            // pet-adjacent path.
            let open_handle = app.handle().clone();
            app.listen(PET_OPEN_MAIN_EVENT, move |_event| {
                if let Some(w) = open_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });

            // ω99-102 (spec D10): pet click-through sentinel — transparent
            // regions of the pet's bounding box must pass clicks through to
            // the desktop. Spawned only when the pet window exists; a missing
            // window (pet disabled/unbuilt) is a skip, same as the handshake
            // path.
            if let Some(pet) = app.get_webview_window("pet") {
                spawn_pet_penetration_poll(pet);
            }

            std::thread::spawn(move || match handshake_and_navigate(&handle, &state) {
                Ok(()) => {}
                Err(err) => show_boot_error(&handle, &err.to_string()),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // ω99-97 (spec D4): window deaths split by label. The main
            // window's death IS the app's death (the pre-pet behavior,
            // untouched); the pet window is a companion — its death only
            // hides it, never terminates the sidecar or exits.
            match (window.label(), event) {
                ("main", WindowEvent::Destroyed) => {
                    let state = window.app_handle().state::<Arc<SidecarState>>();
                    terminate(&state);
                    window.app_handle().exit(0);
                }
                ("pet", WindowEvent::Destroyed) => {
                    let _ = window.hide();
                    // ω99-100 (spec D7): the hide can land <500ms after the
                    // last throttled write — flush or the last drag delta is
                    // lost.
                    flush_pet_position(window.app_handle());
                }
                // ω99-100 (spec D7): throttled persist of dragged positions —
                // physical pixels straight from the Moved payload, written to
                // app_config_dir()/pet-window.json only as often as the
                // throttle allows.
                ("pet", WindowEvent::Moved(pos)) => {
                    record_pet_move(window.app_handle(), *pos);
                }
                // ω99-104 (P1): drop-to-delegate — files dropped on the pet
                // enter the TTL allowlist and are broadcast to the main
                // window, whose listener walks them through
                // read_dropped_file → fileSave → submit. Enter/Over/Leave
                // carry no hover feedback in P1 and are ignored (the
                // default arm of this tuple-match).
                ("pet", WindowEvent::DragDrop(event)) => {
                    if let DragDropEvent::Drop { paths, .. } = event {
                        handle_pet_drop(window.app_handle(), paths);
                    }
                }
                _ => {}
            }
        })
        // ω99-104 (P1): the ONE app command — allowlist-gated file read for
        // dropped files. The capability pin lives in capabilities/main.json
        // (allow-read-dropped-file) because both webviews run on the
        // sidecar's http://127.0.0.1 origin (a "remote" origin in tauri's
        // ACL — remote content never reaches app commands without one).
        // ω99-111 adds get_pet_skin (same remote-origin rule; its capability
        // entry lives in capabilities/pet.json — the pet window invokes it).
        // ω99-110 adds open_accessibility_settings (the pet's selection
        // guide card invokes it; capability in pet.json, same rule).
        // ω99-125 adds reveal_path (the deliverable file card's 在访达中显示
        // button; capability in main.json only — the pet window has no card).
        // ω99-129 adds open_path (the same card's 打开 button — the default
        // application via bare `open`, the make_pdf ruling's system pipeline;
        // capability in main.json only, same posture as reveal).
        // ω99-155 adds open_url (the chat answer's [label](url) markdown link
        // — scheme-whitelisted http/https only; capability in main.json, the
        // main window renders the conversation, same remote-origin rule).
        // ω99-196 adds set_pet_layout (the pet window's three-state layout
        // machine; capability in pet.json — the pet window invokes it).
        .invoke_handler(tauri::generate_handler![
            read_dropped_file,
            get_pet_skin,
            selection::open_accessibility_settings,
            reveal_path,
            open_path,
            open_url,
            set_pet_layout
        ])
        .build(tauri::generate_context!())
        .expect("failed to build wudao desktop shell")
        .run(|app, event| {
            match event {
                RunEvent::Exit => {
                    let state = app.state::<Arc<SidecarState>>();
                    terminate(&state);
                }
                // ω99-287: #3 — dock 唤回（L2 关窗后台的回来路径）。Reopen 是
                // app 级事件（NSApplicationDelegate applicationShouldHandleReopen，
                // macOS only），web 层收不到——主窗被关窗分叉 hide 后，点 dock 图
                // 标 = show+focus 主窗（同 tray「打开主窗口」/pet-open-main 的
                // 姿）。设置关时主窗从不 hide，此臂不改变默认行为；pet 不受
                // 影响（hide≠死，ω99-97 D4 原样）。
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });
}

//
// Sidecar path + workspace resolution
//

fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        os => format!("{arch}-unknown-{os}"),
    }
}

/// The resolved sidecar invocation. Two shipping modes (see
/// scripts/build-sea.mjs + docs/desktop.md §SEA):
///   - single-file SEA executable  → spawn it with no arguments;
///   - bundled-runtime fallback    → the external binary is a node runtime;
///     spawn it with the server bundle (a Tauri resource) and point
///     WUDAO_UI_STATIC_DIR at the resource web build.
/// The mode is detected purely by which files exist next to the app — the
/// build decides, the shell obeys.
struct SidecarLaunch {
    bin: PathBuf,
    args: Vec<PathBuf>,
    static_dir: Option<PathBuf>,
}

fn resolve_sidecar(app: &AppHandle) -> Result<SidecarLaunch, String> {
    let exe_name = if cfg!(windows) { "wudao-server.exe" } else { "wudao-server" };
    if let Ok(path) = std::env::var("WUDAO_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(SidecarLaunch { bin: path, args: vec![], static_dir: None });
        }
        return Err(format!("WUDAO_SERVER_BIN={} does not exist", path.display()));
    }
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("cannot resolve own executable: {e}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "executable has no parent dir".to_string())?;
    let bin = [
        exe_dir.join(exe_name),
        // `tauri dev`: exe is at src-tauri/target/<profile>/wudao-harness-desktop
        exe_dir.join(format!("../../binaries/wudao-server-{}", target_triple())),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or_else(|| {
        "sidecar binary not found; run `pnpm desktop:sea` first".to_string()
    })?;

    // bundled-runtime payloads: the server bundle as an installed resource,
    // DIRECTLY next to the executable (a bundle layout that parks it in
    // MacOS/sidecar-resources/ instead of Resources/ — tolerate, don't
    // fail), or straight from the source tree (dev layout:
    // src-tauri/sidecar-resources, two up from target/<profile>/). Probe
    // order pinned in sidecar_resolve_tests (回滚重做 T2).
    let runtime_bundle = runtime_bundle_candidates(app.path().resource_dir().ok().as_deref(), &exe_dir)
        .into_iter()
        .find(|p| p.is_file());

    match runtime_bundle {
        Some(bundle) => {
            let static_dir = bundle.parent().map(|d| d.join("web")).filter(|d| d.is_dir());
            Ok(SidecarLaunch { bin, args: vec![bundle], static_dir })
        }
        None => Ok(SidecarLaunch { bin, args: vec![], static_dir: None }),
    }
}

/// The runtime-bundle probe order as a pure list (回滚重做 T2): the
/// installed resource layout, DIRECTLY next to the executable (a bundle
/// layout that parks the payload in MacOS/sidecar-resources/ instead of
/// Resources/ — tolerate, don't fail), then the source-tree dev layout.
/// Pure in its inputs so the ORDER — the contract — is unit-testable
/// (sidecar_resolve_tests); the is_file probe stays at the call site.
fn runtime_bundle_candidates(resource_dir: Option<&Path>, exe_dir: &Path) -> Vec<PathBuf> {
    [
        resource_dir.map(|d| d.join("sidecar-resources").join("wudao-server.cjs")),
        Some(exe_dir.join("sidecar-resources/wudao-server.cjs")),
        Some(exe_dir.join("../../sidecar-resources/wudao-server.cjs")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The sidecar's cwd: where .env / .wudao (sessions, settings) live. v1 keeps
/// one dedicated dir per user instead of a folder picker — documented.
fn workspace_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("WUDAO_DESKTOP_WORKSPACE") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create workspace {dir:?}: {e}"))?;
        return Ok(dir);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home directory (set WUDAO_DESKTOP_WORKSPACE)".to_string())?;
    // The data dir KEEPS the legacy `.wudao-desktop` name: the app was renamed
    // to wudao-harness-desktop in 0.3.15, but existing workspaces live here —
    // renaming would silently orphan them.
    let dir = PathBuf::from(home).join(".wudao-desktop").join("workspace");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create workspace {dir:?}: {e}"))?;
    Ok(dir)
}

//
// Handshake (mirrors launchSidecar in sidecar-protocol.ts)
//

/// 138 — the sidecar's boot WORKSPACE (not cwd): the CLI records every agent
/// root switch into ~/.wudao/recent-workspaces.json (row 0 = latest), and the
/// user ruled (2026-11-03) that desktop sessions should START in the
/// last-used workspace instead of the internal data dir. Session storage,
/// .env and .wudao all stay at the cwd — only the agent root moves, through
/// the CLI's own agentRootSwitch (typed guards, entry persistence for
/// fork/resume inheritance). Desktop-only by construction: nothing else sets
/// WUDAO_BOOT_WORKSPACE. Missing/corrupt file or a dead/not-dir path → None
/// → the v1 boot root stands.
fn boot_workspace_env() -> Option<(String, String)> {
    let home = std::env::var("HOME").ok()?;
    let recents = PathBuf::from(home).join(".wudao").join("recent-workspaces.json");
    let raw = std::fs::read_to_string(recents).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let ws = v.get(0)?.get("path")?.as_str()?.to_string();
    let md = std::fs::metadata(&ws).ok()?;
    if !md.is_dir() {
        return None;
    }
    if ws == workspace_dir().ok()? {
        return None;
    }
    Some(("WUDAO_BOOT_WORKSPACE".to_string(), ws))
}

fn spawn_sidecar(launch: &SidecarLaunch, cwd: &PathBuf) -> std::io::Result<Child> {
    let mut cmd = Command::new(&launch.bin);
    cmd.args(&launch.args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 122 项 2 — the LaunchAgent handoff: this shell was started by launchd
    // with `--schedule-wake`; hand the fact to the sidecar as env (see
    // SCHEDULE_WAKE_ENV's doc above for why env, not argv).
    if schedule_wake_requested(std::env::args()) {
        cmd.env(SCHEDULE_WAKE_ENV, "1");
    }
    if let Some(dir) = &launch.static_dir {
        cmd.env("WUDAO_UI_STATIC_DIR", dir);
    }
    if let Some((k, v)) = boot_workspace_env() {
        cmd.env(k, v);
    }
    // 139 — probes ON by default on the desktop: the built-in dashboard (📈)
    // reads them out of the box. Per-event cost is one object + a ring push
    // (fail-silent); the CLI keeps WUDAO_PROBE off by default.
    cmd.env("WUDAO_PROBE", "on");
    // The sidecar is a console-subsystem binary (a SEA-injected node). Spawned
    // from this GUI process, Windows would allocate a NEW console window for
    // it — a large black box that, when closed, KILLS the sidecar (the
    // window's close destroys the attached console's processes). CREATE_NO_WINDOW
    // detaches: the pipes keep stdout/stderr flowing, no window exists to close.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

enum StdoutMsg {
    Line(String),
    Eof,
}

fn handshake_and_navigate(app: &AppHandle, state: &Arc<SidecarState>) -> Result<(), String> {
    let launch = resolve_sidecar(app)?;
    let cwd = workspace_dir()?;
    // The child enters the state cell AT SPAWN TIME: a fast quit during a slow
    // first boot must still terminate it. Handshake failures take it back out
    // and kill it here; success leaves it for the window/exit handlers.
    let mut child = spawn_sidecar(&launch, &cwd)
        .map_err(|e| format!("failed to spawn {}: {e}", launch.bin.display()))?;
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;

    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut tail = tail.lock().unwrap();
                tail.push(line);
                let len = tail.len();
                if len > 40 {
                    tail.drain(0..len - 40);
                }
            }
        });
    }

    let (tx, rx) = channel::<StdoutMsg>();
    let stdout_pipe = {
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
        guard.as_mut().and_then(|c| c.stdout.take())
    };
    if let Some(stdout) = stdout_pipe {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(StdoutMsg::Line(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(StdoutMsg::Eof);
        });
    } else {
        let mut guard = state.child.lock().unwrap();
        if let Some(mut orphan) = guard.take() {
            kill_child(&mut orphan);
        }
        return Err("sidecar spawned without stdout".to_string());
    }

    let url: Option<String>;
    loop {
        // If the app is tearing down mid-handshake, the exit path already
        // owns (and terminated) the child — stop quietly.
        if state.child.lock().unwrap().is_none() {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            take_and_kill(state);
            return Err(format!(
                "sidecar handshake timed out after {}s (no {PROTOCOL_PREFIX}line on stdout)",
                HANDSHAKE_TIMEOUT.as_secs()
            ));
        }
        match rx.recv_timeout(remaining) {
            Ok(StdoutMsg::Line(line)) => {
                if let Some(found) = parse_protocol_line(&line) {
                    url = Some(found);
                    break;
                }
                // Banner noise — keep reading.
            }
            Ok(StdoutMsg::Eof) => {
                // stdout closed before a protocol line: the process is going
                // down (e.g. "No API key found"). Collect its status + stderr.
                let status = take_and_reap_until(state, deadline);
                let tail = stderr_tail.lock().unwrap().join("\n");
                return Err(format!(
                    "sidecar exited before the handshake ({status}){}",
                    if tail.is_empty() { String::new() } else { format!("\n{tail}") }
                ));
            }
            Err(RecvTimeoutError::Timeout) => {
                take_and_kill(state);
                return Err(format!(
                    "sidecar handshake timed out after {}s (no {PROTOCOL_PREFIX}line on stdout)",
                    HANDSHAKE_TIMEOUT.as_secs()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                take_and_kill(state);
                return Err("sidecar stdout thread died".to_string());
            }
        }
    }

    let url = url.unwrap_or_default();

    // M65-space §1: mark the desktop shell — the web entry reads
    // ?shell=desktop and stamps <html data-shell="desktop"> before first
    // paint, so the topbar reserves the 84px traffic-light inset only inside
    // this shell (a plain browser tab keeps the tight 12px). The marker rides
    // the query string, so the token fragment (auth) is untouched.
    // parse_protocol_line guarantees the `http://127.0.0.1:<port>/#<token>`
    // shape, so the replacen below inserts exactly one `?shell=desktop`.
    let shell_url = url.replacen("/#", "/?shell=desktop#", 1);

    // Navigate + reveal. The token rides the URL fragment; the web UI's
    // first-frame auth is untouched. eval(location.replace) is deliberately
    // version-proof (no Webview::navigate API surface assumptions).
    if let Some(window) = app.get_webview_window("main") {
        let js = format!("location.replace({})", serde_json::to_string(&shell_url).unwrap_or_default());
        let _ = window.eval(&js);
        let _ = window.show();
        let _ = window.set_focus();
    }

    // ω99-97: the pet window rides the same handshake — same sidecar origin,
    // same token fragment; `view=pet` selects the pet entry (its own page,
    // never the main shell). Shown WITHOUT focus: the pet must not steal the
    // startup focus (spec D8). A missing window (pet disabled/unbuilt) is a
    // skip, not a panic.
    let pet_url = url.replacen("/#", "/pet.html?shell=desktop&view=pet#", 1);
    if let Some(window) = app.get_webview_window("pet") {
        let js = format!("location.replace({})", serde_json::to_string(&pet_url).unwrap_or_default());
        let _ = window.eval(&js);
        // ω99-100 (spec D7): restore the remembered position BEFORE show —
        // the user must never see the pet jump from the conf-registered spot
        // to the remembered one. The clamp pulls it into the current work
        // area so an unplugged monitor can't strand it off-screen.
        restore_pet_position(app, &window);
        // ω99-196: pre-shrink the conf 220×320 down to compact BEFORE show —
        // visible:false means the user never sees the jump, and the very
        // first frame already lands with the dead rect gone. The remembered
        // position may come from ANY form's geometry; the reanchor anchors
        // the bottom-center, so it self-heals — nothing about form is
        // persisted. Best-effort: on failure the web side's mount-frame
        // compact call (main.tsx) is the safety net.
        let _ = apply_pet_layout(&window, "compact");
        let _ = window.show();
    }
    Ok(())
}

fn take_and_kill(state: &Arc<SidecarState>) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        kill_child(&mut child);
    }
}

fn take_and_reap_until(state: &Arc<SidecarState>, deadline: Instant) -> String {
    let Some(mut child) = state.child.lock().unwrap().take() else {
        return "already terminated during teardown".to_string();
    };
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.to_string(),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => return format!("wait failed: {err}"),
        }
    }
    kill_child(&mut child);
    "killed after hanging past the handshake deadline".to_string()
}

/// The Rust mirror of parseProtocolLine (sidecar-protocol.ts):
/// `open: http://127.0.0.1:<port>/#<token>` — loopback only, port 1-65535,
/// base64url token of >= 16 chars. Total: never panics, never over-accepts.
fn parse_protocol_line(line: &str) -> Option<String> {
    let rest = line.trim_end_matches('\r').strip_prefix(PROTOCOL_PREFIX)?;
    let (authority, token) = rest.split_once("/#")?;
    let port_str = authority.strip_prefix("http://127.0.0.1:")?;
    let port: u32 = port_str.parse().ok()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    if token.len() < 16 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}/#{token}"))
}

fn show_boot_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let js = format!(
            "document.getElementById('status').textContent = 'wudao ui failed to start\\n\\n{}';",
            serde_json::to_string(message).unwrap_or_else(|_| "\"(unprintable error)\"".to_string())
        );
        let _ = window.eval(&js);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("desktop://boot-error", message);
    }
}

//
// Termination (mirrors terminateSidecar in sidecar-protocol.ts)
//

fn terminate(state: &Arc<SidecarState>) {
    let Some(mut child) = state.child.lock().unwrap().take() else {
        return; // already terminated (or never launched) — idempotent
    };
    term_child(&mut child);
    // Reap: without wait() a SIGTERMed-but-unwatched child stays a zombie.
    let _ = child.wait();
}

fn term_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // SAFETY: kill(2) on our own child pid; errors (ESRCH etc.) surface
        // through the wait loop below instead.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let deadline = Instant::now() + TERM_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return, // graceful: died on SIGTERM
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
    // Zombie fallback: ignore-TERM or hung — SIGKILL it.
    kill_child(child);
}

fn kill_child(child: &mut Child) {
    let _ = child.kill(); // SIGKILL on unix
    let _ = child.wait();
}

//
// ω99-100: pet window position persistence (spec D7)
//
// The pet window starts at its tauri.conf-registered spot every launch, and
// localStorage cannot remember a better one — the sidecar's random port makes
// every boot a new origin. So the Rust side persists physical pixels to
// app_config_dir()/pet-window.json: one file, nothing else (arc red line).
//

/// Pet window size mirrored from tauri.conf.json (label "pet"); the clamp
/// math needs it, and a test pins the pair so a conf change can't drift by
/// silently.
const PET_WINDOW_WIDTH: i32 = 220;
const PET_WINDOW_HEIGHT: i32 = 320;

/// Trailing-throttle floor between two disk writes. Chosen over a debounce
/// timer thread on purpose (brief §0): persistence only needs rate-limiting,
/// not "settled" semantics, and a threadless state machine is deterministically
/// testable with an injected clock — zero real waiting, zero threads.
const MOVE_WRITE_MIN_INTERVAL_MS: u64 = 500;

/// Persisted pet window position — physical pixels end to end: the Moved
/// payload, the JSON file, and set_position all speak the same unit, so there
/// is no DPR conversion to get wrong on any display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PetWindowPosition {
    x: i32,
    y: i32,
}

/// serde_json-only codec — `serde` itself stays out of the dependency list
/// (no new crates on this arc's red line). The exact shape is pinned by a
/// round-trip test: lowercase keys, no extras, stable order.
fn position_to_json(pos: &PetWindowPosition) -> String {
    serde_json::json!({ "x": pos.x, "y": pos.y }).to_string()
}

fn position_from_json(text: &str) -> Option<PetWindowPosition> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(PetWindowPosition {
        // try_from, not `as`: a value beyond i32 is rejected, never wrapped.
        x: i32::try_from(value.get("x")?.as_i64()?).ok()?,
        y: i32::try_from(value.get("y")?.as_i64()?).ok()?,
    })
}

/// Trailing throttle for pet Moved events: the first move writes immediately;
/// moves arriving sooner than MOVE_WRITE_MIN_INTERVAL_MS after the last write
/// are only buffered (latest wins); the first move after the interval writes
/// again; `flush` covers the hide path. `now_ms` is injected so tests never
/// sleep, and a clock running backwards saturates instead of panicking.
#[derive(Debug, Default)]
struct MoveThrottle {
    /// Latest position not yet on disk (None = clean).
    pending: Option<PetWindowPosition>,
    /// When the last write happened (None = never).
    last_write_ms: Option<u64>,
}

impl MoveThrottle {
    fn new() -> Self {
        Self::default()
    }

    /// Feed one Moved event. Some(pos) = persist pos now; None = pos is only
    /// buffered and a later on_move or flush will carry it out.
    fn on_move(&mut self, pos: PetWindowPosition, now_ms: u64) -> Option<PetWindowPosition> {
        self.pending = Some(pos);
        let due = match self.last_write_ms {
            None => true, // first event ever writes immediately
            Some(last) => now_ms.saturating_sub(last) >= MOVE_WRITE_MIN_INTERVAL_MS,
        };
        if due {
            self.last_write_ms = Some(now_ms);
            self.pending = None;
            Some(pos)
        } else {
            None
        }
    }

    /// Hide/destroy path: persist-and-clear the buffered position, if any —
    /// a hide can land <500ms after the last write and would otherwise lose
    /// the last drag delta.
    fn flush(&mut self, now_ms: u64) -> Option<PetWindowPosition> {
        let pos = self.pending.take()?;
        self.last_write_ms = Some(now_ms);
        Some(pos)
    }
}

/// Work area in physical pixels — the adapter between Monitor::work_area()
/// and the pure clamp math (keeps tauri types out of the tested surface).
#[derive(Debug, Clone, Copy)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// One axis of the clamp: keep [pos, pos + window) inside
/// [origin, origin + size). A window wider/taller than the area parks at the
/// origin — never negative, never hanging off the right/bottom.
fn clamp_axis(pos: i32, origin: i32, size: u32, window: u32) -> i32 {
    let end = origin.saturating_add(size as i32);
    pos.max(origin).min(end.saturating_sub(window as i32)).max(origin)
}

/// Restore-time guard — the arc's step beyond the usual "just store it":
/// a position remembered under another monitor geometry (unplugged display,
/// changed resolution) must land inside the CURRENT work area (dock/menubar
/// deducted by Monitor::work_area) or the pet respawns off-screen, under the
/// dock, unrecoverable. In-area positions pass through unchanged.
fn clamp_to_work_area(pos: PetWindowPosition, area: WorkArea) -> PetWindowPosition {
    PetWindowPosition {
        x: clamp_axis(pos.x, area.x, area.width, PET_WINDOW_WIDTH as u32),
        y: clamp_axis(pos.y, area.y, area.height, PET_WINDOW_HEIGHT as u32),
    }
}

//
// ω99-196: pet window layout machine — compact / bubble / answer (用户令
// 09-08 痛点①：220×320 全量吞点击的死区)。
//
// The bubble-less pet hugging 104×84 kills the dead rect above the sprite
// (the old window ate clicks over the whole bubble reserve — the「遮罩」the
// user felt — even while showing nothing). The anchor: the sprite sits at
// the window's bottom-center in EVERY size (pet.css: .pet-root bottom:12px
// centered, the bubble floats above it), so reanchoring on the bottom-center
// point keeps the pet visually frozen while the window grows/shrinks around
// it. Every morph is itself a visual event (a bubble rising/falling), so one
// resize per bubble start/end is the accepted cost.
//

/// The layout modes' LOGICAL sizes (tauri.conf.json's domain; scale_factor
/// converts to physical at the impure edge). compact hugs the sprite: 96px
/// wide + 4px breathing room per side, 12px bottom margin + the ~59px sprite
/// (96×238/390, pinned by pet.css) + 13px headroom — ω99-196 走查裁定：动作
/// 峰值谱 done-hop -10px×1.02 = 81.8px（pet.css :146），71px 裁切瞬态削顶，
/// 84 覆盖全谱+2px 余量（死区代价 +1352px² 仍 ≈1/8 原窗）。bubble = the conf size (the 204px
/// input/ask/hint forms need it). answer = the widened reading form (the
/// 344px stream bubble + scroll headroom). Unknown modes never guess.
/// 力量形态（power，2026-11-05）随肤增高：compact 84→120——1:1 帧 88px 高
/// （pet.css power 块缩小后的宽度）+ 峰值动画 ×1.07 + hop 5px + 头部余量；
/// 四色 slime 族 58.6px 高维持既有 84 零变。宽度 104 两肤同值（root 96 +
/// 边距）。换肤即时重应用由 web 侧 usePetLayoutSync 的 skinId 依赖驱动
/// （Rust 本函数读 pet-skin.json 的持久肤），底中心锚定精灵视觉位置不动。
fn pet_layout_size(mode: &str, skin: &str) -> Result<(f64, f64), String> {
    match mode {
        "compact" => Ok((104.0, if skin == "power" { 120.0 } else { 84.0 })), // ω99-196 走查修正：71→84，动作峰值 headroom（见上 doc）
        "bubble" => Ok((f64::from(PET_WINDOW_WIDTH), f64::from(PET_WINDOW_HEIGHT))),
        // ω99-271: #15 — 360×440 → 420×560（用户令 09-10「渲染要更美观」+完整
        // 史）：回答窗从「一屏 344px 流」升为可读的阅读面——史轮进来后 30 轮
        // 转写 + 2000 字尾窗需要真实的滚动空间；底中心锚定不变（精灵不动）。
        "answer" => Ok((420.0, 560.0)),
        _ => Err(format!("set_pet_layout: unknown mode {mode:?}")),
    }
}

/// The reanchor core (pure, physical pixels — the Moved/persist family's
/// domain): keep the window's BOTTOM-CENTER fixed while resizing to
/// (new_w, new_h), then clamp into the work area — left/right overflow pulls
/// back; a top-starved clamp parks at the area's top (the bottom edge rises;
/// safer than hanging over the dock). The bottom-center invariant IS the
/// "sprite never moves" guarantee.
fn reanchor_pet_rect(
    old: (i32, i32, u32, u32),
    new_w: u32,
    new_h: u32,
    work: (i32, i32, u32, u32),
) -> PetWindowPosition {
    let (ox, oy, ow, oh) = old;
    let center_x = ox.saturating_add((ow / 2) as i32);
    let bottom = oy.saturating_add(oh as i32);
    let raw = PetWindowPosition {
        x: center_x.saturating_sub((new_w / 2) as i32),
        y: bottom.saturating_sub(new_h as i32),
    };
    let (wx, wy, ww, wh) = work;
    PetWindowPosition {
        x: clamp_axis(raw.x, wx, ww, new_w),
        y: clamp_axis(raw.y, wy, wh, new_h),
    }
}

//
// ω99-100: impure edges — clock, file, window, tray. Everything above is
// pure and test-injected; everything below touches the OS and is covered by
// the desktop-manual checklist (doc 114).
//

/// The one file this feature is allowed to touch.
const PET_POSITION_FILE: &str = "pet-window.json";

/// Wall-clock milliseconds feeding the throttle. unwrap_or_default: a
/// pre-epoch clock yields 0 instead of panicking inside an event handler.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// The one piece of pet runtime state (position persistence only).
struct PetWindowState {
    moves: Mutex<MoveThrottle>,
}

/// pet-window.json under the OS app config dir (macOS:
/// ~/Library/Application Support/com.feiniaojin.wudao-harness-desktop/).
fn pet_position_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(PET_POSITION_FILE))
}

/// Best-effort persist: a failing config write must never take the app down.
fn save_pet_position(path: &std::path::Path, pos: PetWindowPosition) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, position_to_json(&pos));
}

fn load_pet_position(path: &std::path::Path) -> Option<PetWindowPosition> {
    position_from_json(&std::fs::read_to_string(path).ok()?)
}

/// Moved handler: throttle → maybe persist.
fn record_pet_move(app: &AppHandle, pos: tauri::PhysicalPosition<i32>) {
    let state = app.state::<PetWindowState>();
    let mut moves = state.moves.lock().unwrap();
    if let Some(to_write) = moves.on_move(PetWindowPosition { x: pos.x, y: pos.y }, now_ms()) {
        if let Some(path) = pet_position_path(app) {
            save_pet_position(&path, to_write);
        }
    }
}

/// Destroyed/hide handler: flush whatever the throttle still holds.
fn flush_pet_position(app: &AppHandle) {
    let state = app.state::<PetWindowState>();
    let mut moves = state.moves.lock().unwrap();
    if let Some(pos) = moves.flush(now_ms()) {
        if let Some(path) = pet_position_path(app) {
            save_pet_position(&path, pos);
        }
    }
}

/// Read pet-window.json, clamp into the CURRENT work area, apply. Best-effort
/// all the way down: no file, no monitor info, any error = keep the
/// conf-registered position.
fn restore_pet_position(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some(path) = pet_position_path(app) else { return };
    let Some(saved) = load_pet_position(&path) else { return };
    // Which monitor does the remembered point live on? Unplugged / changed
    // resolution → fall back to the primary; no monitor info at all → skip.
    let monitor = app
        .monitor_from_point(saved.x as f64, saved.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let area = monitor.work_area();
    let clamped = clamp_to_work_area(
        saved,
        WorkArea {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
    );
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        clamped.x, clamped.y,
    )));
}

//
// ω99-111: pet skins (brief §2 Rust) — tray 换肤 submenu + persistence.
//
// The pet is the product's face, and the user asked to dress it: four hue
// variants of the SAME logo slime (the look the user explicitly likes — no
// redesign) plus the grown form (power — a figure swap, not a hue swap),
// switched from the tray with zero restart: click → persist to
// pet-skin.json → broadcast wudao-pet-skin → the live webview re-skins.
//

/// The pinned skin registry — MUST stay in lockstep with the TS side's
/// PET_SKINS (packages/web/src/pet/skins/index.ts). Both sides pin their own
/// copy and their own tests; a drift is not normalized away at runtime, it
/// shows up as a review-time diff against either pin (the brief's trade).
/// power (2026-11-05 用户令「换肤能切换小精灵或 power 两种展示，直接改变
/// 形象」)：小精灵长大之后的成年形态——不是色变是形象变，与四色肤并列第
/// 五项；sheet 两帧同图（单姿势无眨眼），资产 scripts/make-power-sprite.py。
const PET_SKIN_IDS: [&str; 5] = ["default", "sakura", "lake", "honey", "power"];

/// Tray display names, one per PET_SKIN_IDS entry, same order.
const PET_SKIN_NAMES: [&str; 5] = ["经典绿", "樱花粉", "湖水蓝", "蜜橙金", "力量形态"];

fn pet_skin_display_name(id: &str) -> Option<&'static str> {
    PET_SKIN_IDS
        .iter()
        .position(|s| *s == id)
        .map(|i| PET_SKIN_NAMES[i])
}

/// serde_json-only codec (the pet-window.json discipline — no serde derive,
/// no new crates): exactly `{"skin":"<id>"}`.
fn pet_skin_to_json(skin: &str) -> String {
    serde_json::json!({ "skin": skin }).to_string()
}

/// Strict shape read: an object with EXACTLY one string "skin" key — extras,
/// wrong types, non-JSON all read None (never partially trusted). This layer
/// is shape-only; registry membership is normalize_pet_skin's job.
fn pet_skin_from_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    Some(obj.get("skin")?.as_str()?.to_string())
}

/// The ONE read path every edge funnels through: file text (None = missing)
/// → always a registry id. Missing / corrupt / unknown → "default" — a
/// hand-edited or foreign pet-skin.json can never render a skin that isn't
/// in the registry (the web side normalizes independently, same rule).
fn normalize_pet_skin(text: Option<&str>) -> &'static str {
    let candidate = text.and_then(pet_skin_from_json).unwrap_or_default();
    PET_SKIN_IDS
        .iter()
        .find(|s| **s == candidate)
        .copied()
        .unwrap_or(PET_SKIN_IDS[0])
}

/// The Tauri event broadcasting a skin switch to the pet webview.
const PET_SKIN_EVENT: &str = "wudao-pet-skin";

/// The event payload: `{"skin":"<id>"}` — round-tripped through the canonical
/// serializer so the bytes the listener parses are the bytes the tests pin.
fn pet_skin_event_payload(skin: &str) -> String {
    serde_json::json!({ "skin": skin }).to_string()
}

/// The one file this feature is allowed to touch (pet-window.json's sibling
/// under the OS app config dir, same serde_json-only mode).
const PET_SKIN_FILE: &str = "pet-skin.json";

fn pet_skin_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(PET_SKIN_FILE))
}

/// Read pet-skin.json → a registry id, always (missing/corrupt/unknown →
/// "default"; best-effort — a read failure is never an error state).
fn load_pet_skin(app: &AppHandle) -> &'static str {
    let text = pet_skin_path(app).and_then(|path| std::fs::read_to_string(path).ok());
    normalize_pet_skin(text.as_deref())
}

/// Best-effort persist: a failing config write must never take the app down.
fn save_pet_skin(app: &AppHandle, skin: &str) {
    let Some(path) = pet_skin_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, pet_skin_to_json(skin));
}

/// The pet window's skin query (mount-time initial value). Like
/// read_dropped_file this MUST be capability-gated: the pet webview runs on
/// the sidecar's http://127.0.0.1 origin (remote in tauri's ACL) — see
/// permissions/get-pet-skin.toml + capabilities/pet.json.
#[tauri::command]
fn get_pet_skin(app: AppHandle) -> String {
    load_pet_skin(&app).to_string()
}

/// The tray menu: 打开主窗口 / 显示宠物 / 隐藏宠物 / 退出. Why a tray at all —
/// once BOTH windows are hidden there is no way back (pet Destroyed only
/// hides, spec D4); and tray quit goes through app.exit(0) so it converges on
/// the RunEvent::Exit → terminate path, keeping sidecar shutdown single-point
/// (same as closing the main window). All Rust-side: no JS invoke, no extra
/// capability, no new crate.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
    use tauri::tray::TrayIconBuilder;

    let show_main = MenuItem::with_id(app, "show-main", "打开主窗口", true, None::<&str>)?;
    let show_pet = MenuItem::with_id(app, "show-pet", "显示宠物", true, None::<&str>)?;
    let hide_pet = MenuItem::with_id(app, "hide-pet", "隐藏宠物", true, None::<&str>)?;
    let app_quit = MenuItem::with_id(app, "app-quit", "退出 wudao ui", true, None::<&str>)?;

    // ω99-111: the 换肤 submenu — four CheckMenuItems, the persisted skin
    // checked at build. The handles ride the on_menu_event closure (Arc-
    // backed, Send+Sync): selecting one persists + broadcasts + MOVES the
    // check, so the menu and the pet can never disagree about the skin.
    let current = load_pet_skin(app.app_handle());
    let skin_items = PET_SKIN_IDS
        .iter()
        .map(|id| {
            CheckMenuItem::with_id(
                app,
                id,
                pet_skin_display_name(id).unwrap_or(id),
                true,
                *id == current,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let skin_item_refs: Vec<&dyn tauri::menu::IsMenuItem<_>> =
        skin_items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<_>).collect();
    let skin_menu =
        Submenu::with_id_and_items(app, "pet-skin", "换肤", true, &skin_item_refs)?;
    // (id, handle) pairs for the event closure — after the submenu copied
    // the items, the Vec is free to move out of the borrow.
    let skin_checks: Vec<(&str, CheckMenuItem<_>)> =
        PET_SKIN_IDS.iter().map(|id| *id).zip(skin_items).collect();

    let menu = Menu::with_items(app, &[&show_main, &show_pet, &hide_pet, &skin_menu, &app_quit])?;

    let mut tray = TrayIconBuilder::with_id("wudao-tray")
        .menu(&menu)
        .tooltip("wudao ui")
        // macOS 09-09 用户令:状态栏直显安装包彩色图标。原 template 模式把
        // 满幅彩色 logo 渲染成单色遮罩——塌成一块纯色「正方形」,正是本次
        // 报障;关掉 template 后 default_window_icon 的彩色图标原样显示。
        .icon_as_template(false)
        // macOS: left click opens the menu (matches the platform idiom).
        .show_menu_on_left_click(true)
        // NB: this handler sees menu events from EVERY menu (app menu
        // included) — the match arms below act only on this tray's ids.
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "show-main" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "show-pet" => {
                    if let Some(w) = app.get_webview_window("pet") {
                        let _ = w.show();
                    }
                }
                "hide-pet" => {
                    if let Some(w) = app.get_webview_window("pet") {
                        let _ = w.hide();
                    }
                }
                // ω99-111: a skin id → persist, broadcast, move the check.
                // Fire-and-forget emit (broken IPC is P0-accepted, same as
                // the relay pump); the write is best-effort (a failing config
                // write never takes the app down).
                skin if PET_SKIN_IDS.contains(&skin) => {
                    save_pet_skin(app, skin);
                    let payload: serde_json::Value =
                        serde_json::from_str(&pet_skin_event_payload(skin))
                            .unwrap_or_else(|_| serde_json::json!({ "skin": PET_SKIN_IDS[0] }));
                    let _ = app.emit(PET_SKIN_EVENT, payload);
                    for (item_id, item) in &skin_checks {
                        let _ = item.set_checked(*item_id == skin);
                    }
                }
                // Converge on RunEvent::Exit — the single sidecar-termination
                // point (the run closure in main), not a second terminate path.
                "app-quit" => app.exit(0),
                _ => {}
            }
        });
    // 品牌弧补丁（0.3.97 验装回执）：托盘图标不再吃 app 主图标——玉渐变
    // squircle 在菜单栏显示为纯绿色方块。菜单栏要求透明底：专属精灵帧
    // （44×44 方形居中裁、透明底，sips 居中裁+视觉核验，PNG 编译期内嵌）。
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-pet.png")) {
        Ok(pet) => tray = tray.icon(pet),
        Err(err) => {
            eprintln!("wudao: tray pet icon decode failed ({err:?})");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    // The returned handle is Arc-registered in the app's tray table; letting
    // it drop here does NOT remove the icon.
    tray.build(app)?;
    Ok(())
}

//
// ω99-102: pet click-through (spec D10) — the transparent-bounding-box fix.
//
// The 220x320 pet window carries large transparent regions (the ~96px sprite
// hugs the bottom, the bubble reserves the rest); an always-on-top window
// makes that whole rectangle eat desktop clicks. Brief plan B: a Rust-side
// hit-test sentinel polls the GLOBAL cursor and the pet's live rect, toggling
// set_ignore_cursor_events — pointer on the window → interactive, pointer
// elsewhere → clicks fall through to whatever sits underneath. The JS side
// is untouched (plan A deadlocks: with events ignored WKWebView stops seeing
// the mouse at all, so JS could never detect the pointer coming back).
//

/// Poll cadence: 120ms trades a worst-case one lost first click after a fast
/// swipe-in (rare; P0-accepted in the brief) against burning CPU on a
/// tighter loop.
const PENETRATION_POLL_INTERVAL_MS: u64 = 120;

/// Physical-pixel hit test: is the cursor on the window rect? Inclusive on
/// all four edges (a pointer exactly on an edge is ON the window). The
/// cursor arrives fractional (cursor_position() is PhysicalPosition<f64> in
/// desktop coordinates — negative on a left-side monitor) while the rect is
/// integral (outer_position/outer_size), so the cursor rounds to the nearest
/// pixel FIRST (half away from zero) and only then compares — one explicit
/// convention, pinned by tests, instead of an implicit float comparison.
/// Saturating cast: NaN/±inf degrade to a far-away miss, never a panic.
fn hit_test(cursor: (f64, f64), origin: (i32, i32), size: (u32, u32)) -> bool {
    let (cx, cy) = (cursor.0.round() as i32, cursor.1.round() as i32);
    let (ox, oy) = origin;
    let (w, h) = (size.0 as i32, size.1 as i32);
    cx >= ox && cx <= ox.saturating_add(w) && cy >= oy && cy <= oy.saturating_add(h)
}

/// Focus-first penetration: a FOCUSED pet window stays interactive
/// unconditionally — the user is typing into the bubble or just clicked, and
/// position polling must not punch through under their keystrokes (the arc's
/// step beyond plain position hit-testing). Unfocused windows are
/// interactive exactly while the cursor is on them.
fn penetration_decision(focused: bool, hit: bool) -> bool {
    !(focused || hit)
}

/// IPC debounce: set_ignore_cursor_events fires only when the VERDICT
/// changes, not on every 120ms tick. `apply` returns Some(ignore) = call the
/// window with this value now; None = same as last time, skip the call.
#[derive(Debug, Default)]
struct PenetrationLatch {
    last: Option<bool>,
}

impl PenetrationLatch {
    fn apply(&mut self, ignore: bool) -> Option<bool> {
        if self.last == Some(ignore) {
            return None;
        }
        self.last = Some(ignore);
        Some(ignore)
    }
}

/// The sentinel loop. Implementer choices (brief §1.3 leaves them open):
///   - the thread OWNS a cloned WebviewWindow handle (a cheap Arc) instead
///     of re-fetching through the AppHandle every cycle, so a teardown-time
///     lookup race cannot yield a mid-cycle None — the handle simply goes
///     stale and the first failed query ends the loop;
///   - it is a daemon thread by design: RunEvent::Exit tears the process
///     down under it — no join, no stop flag;
///   - a HIDDEN pet (Destroyed → hide, spec D4) still answers these queries
///     on macOS, and toggling ignore-cursor-events on a hidden window is a
///     visual no-op, so the loop needs no visibility tracking.
/// Any failed query or failed toggle breaks the loop: an unusable window is
/// a dead sentinel.
fn spawn_pet_penetration_poll(pet: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        let mut latch = PenetrationLatch::default();
        loop {
            std::thread::sleep(Duration::from_millis(PENETRATION_POLL_INTERVAL_MS));
            let (Ok(cursor), Ok(origin), Ok(size), Ok(focused)) = (
                pet.app_handle().cursor_position(),
                pet.outer_position(),
                pet.outer_size(),
                pet.is_focused(),
            ) else {
                break; // window gone — stop polling
            };
            let hit = hit_test(
                (cursor.x, cursor.y),
                (origin.x, origin.y),
                (size.width, size.height),
            );
            let ignore = penetration_decision(focused, hit);
            if latch
                .apply(ignore)
                .is_some_and(|ignore| pet.set_ignore_cursor_events(ignore).is_err())
            {
                break; // the toggle itself failing = dead window too
            }
        }
    });
}

//
// ω99-104: drop-to-delegate (P1 首弧) — the pet window as a drop target.
//
// 「把文件拖到宠物身上 = 把任务交给 agent」。The pet's webview must never
// gain general disk-read powers for that: WKWebView keeps JS path-blind by
// design, and the asset-protocol alternative would need a `**` scope (= the
// webview can read the whole disk) — a security red line. Instead the Drop
// event lands HERE (Rust, native DragDrop), the dropped paths enter a
// short-TTL allowlist — drop 即授权: the physical drop IS the authorization
// grant — and the webview can only ever ask `read_dropped_file` for a path
// that is currently admitted. Anything else is refused without leaking the
// list's contents.
//

/// How long a dropped path stays readable — the grace for the JS round trip
/// (size precheck → invoke read → fileSave → submit), not a session.
const DROP_TTL_MS: u64 = 30_000;

/// Allowlist bound. macOS hands one Vec per drop; only a pathological burst
// within a single TTL window can outrun the lazy prune, and when it does the
// OLDEST grants fall off first (bounded memory, newest drops win).
const DROP_LIST_CAP: usize = 128;

/// Single-file gate in `read_dropped_file` — 20MiB, mirroring core's
/// DEFAULT_MAX_REQUEST_IMAGE_BYTES spirit. The fileSave lane re-enforces its
/// own 50MiB batch budget server-side; this gate stops one giant file from
/// base64-ballooning through the command + WS in the first place.
const MAX_DROP_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// One allowlist entry: a dropped path and the wall-clock deadline (ms)
/// after which it stops being readable.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DropEntry {
    path: PathBuf,
    deadline_ms: u64,
}

/// Drop expired entries. Called on every touch (remember + admit) so the
/// list never carries a stale grant. `now_ms == deadline_ms` is EXPIRED —
/// the last readable instant is deadline − 1.
fn prune_expired(list: &mut Vec<DropEntry>, now_ms: u64) {
    list.retain(|e| now_ms < e.deadline_ms);
}

/// Remember a drop batch: prune, then insert/refresh each path with
/// deadline = now + DROP_TTL_MS (a repeated path refreshes in place — never
/// duplicates). The list stays bounded: past the cap the oldest entries go.
fn remember_drops(list: &mut Vec<DropEntry>, paths: &[PathBuf], now_ms: u64) {
    prune_expired(list, now_ms);
    for path in paths {
        let deadline_ms = now_ms.saturating_add(DROP_TTL_MS);
        match list.iter_mut().find(|e| e.path == *path) {
            Some(entry) => entry.deadline_ms = deadline_ms,
            None => list.push(DropEntry { path: path.clone(), deadline_ms }),
        }
    }
    let overflow = list.len().saturating_sub(DROP_LIST_CAP);
    if overflow > 0 {
        list.drain(0..overflow);
    }
}

/// Is this path currently admitted? (Present AND inside its TTL — admit
/// prunes first, so an expired grant reads as unknown, same as never-dropped.)
fn admit_drop(list: &mut Vec<DropEntry>, path: &std::path::Path, now_ms: u64) -> bool {
    prune_expired(list, now_ms);
    list.iter().any(|e| e.path == path)
}

/// Standard base64 (RFC 4648 `+/` alphabet, mandatory `=` padding) — the
/// exact codec the JS side's `atob` expects. Hand-rolled and pinned by the
/// RFC's own test vectors rather than adding a crate for one call site: a
/// NEW dependency needs a stronger case than twenty lines of table lookup.
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// ω99-116: pub(crate) — screenshot.rs's payload codec reuses the ONE
// codec (same alphabet/padding discipline; no second implementation).
pub(crate) fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(n >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(n >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(n >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[n as usize & 0x3f] as char } else { '=' });
    }
    out
}

/// The pet-file-drop event payload: every dropped path with its display name
/// and byte size (the metadata the JS size precheck needs — the JS side
/// never stats the disk itself). Pure: the caller collects (path, bytes)
/// pairs; a path without a file_name falls back to the full lossy string.
fn drop_event_payload(entries: &[(PathBuf, u64)]) -> String {
    let paths: Vec<serde_json::Value> = entries
        .iter()
        .map(|(path, bytes)| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            serde_json::json!({ "path": path.display().to_string(), "name": name, "bytes": bytes })
        })
        .collect();
    serde_json::json!({ "paths": paths }).to_string()
}

/// The Tauri event carrying a pet drop to the main window's listener.
const PET_FILE_DROP_EVENT: &str = "pet-file-drop";

/// The managed allowlist cell. One struct, one job (the PetWindowState
/// discipline): paths dropped on the pet + their deadlines.
struct DropAllowlist {
    entries: Mutex<Vec<DropEntry>>,
}

/// DragDrop::Drop handler: remember the batch, then broadcast the payload
/// over the event bus (both windows may listen; only the main window does —
/// the pet web face stays untouched). The `bytes` metadata degrades to 0 on
/// a stat failure; the read gate re-checks the real file anyway. Emission
/// is fire-and-forget (broken IPC is P0-accepted, same as the relay pump).
fn handle_pet_drop(app: &AppHandle, paths: &[PathBuf]) {
    {
        let state = app.state::<DropAllowlist>();
        let mut list = state.entries.lock().unwrap();
        remember_drops(&mut list, paths, now_ms());
    }
    let entries: Vec<(PathBuf, u64)> = paths
        .iter()
        .map(|p| (p.clone(), std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)))
        .collect();
    // Round-trip through the canonical serializer: the payload the listener
    // parses is byte-identical to the shape the pure layer's tests pin.
    let payload: serde_json::Value = serde_json::from_str(&drop_event_payload(&entries))
        .unwrap_or_else(|_| serde_json::json!({ "paths": [] }));
    let _ = app.emit(PET_FILE_DROP_EVENT, payload);
}

/// The ONE file-read command exposed to the webview: a path is readable iff
/// it is currently on the drop allowlist (the user dropped it on the pet
/// less than DROP_TTL_MS ago). Refusals say WHY without listing WHAT is
/// admitted. A pass returns the file's bytes as base64 (the single codec,
/// atop-decodable). The 20MiB gate runs on the stat BEFORE the read — a
/// giant file is refused, never slurped-then-dropped.
#[tauri::command]
fn read_dropped_file(path: String, app: AppHandle) -> Result<String, String> {
    let requested = PathBuf::from(&path);
    {
        let state = app.state::<DropAllowlist>();
        let mut list = state.entries.lock().unwrap();
        if !admit_drop(&mut list, &requested, now_ms()) {
            return Err("path not admitted: drop the file on the pet again".to_string());
        }
    }
    let meta = std::fs::metadata(&requested)
        .map_err(|e| format!("cannot stat {}: {e}", requested.display()))?;
    if meta.len() > MAX_DROP_FILE_BYTES {
        return Err(format!("{} exceeds the 20MiB drop limit", requested.display()));
    }
    let bytes = std::fs::read(&requested)
        .map_err(|e| format!("cannot read {}: {e}", requested.display()))?;
    Ok(base64_encode(&bytes))
}

/// The pure half of ω99-125's reveal: trim; empty-after-trim refuses AND
/// says why; a pass returns the normalized PathBuf. Pure so the tests can
/// pin it (the ω99-104 discipline — the metadata/spawn side never runs
/// under test).
fn reveal_path_gate(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("reveal_path: empty path".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

/// ω99-125: 在访达中定位交付物。门槛=路径必须真实存在于盘
/// （fs::metadata）——URL 串不存在于盘即拒，杀掉 open 被诱开 URL 的面。
/// args 数组传递=无 shell 注入。不返回数据（对照 read_dropped_file 返
/// bytes 才要 TTL allowlist，这里无需）。仅主窗 capability。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = reveal_path_gate(&path)?;
    // The existence gate: a URL string (or any invented path) is not on
    // disk and stops HERE — `open -R` is never handed one.
    std::fs::metadata(&target)
        .map_err(|e| format!("cannot stat {}: {e}", target.display()))?;
    Command::new("open")
        .arg("-R")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("cannot open {}: {e}", target.display()))?;
    // Fire-and-forget: Finder's reveal is a UI affordance, not a result we
    // wait on (no .wait() — a wedged Finder must never wedge the handler).
    Ok(())
}

/// The pure half of ω99-129's open: trim; empty-after-trim refuses AND
/// says why. Unlike reveal (whose existence check rides inside the
/// command), the on-disk gate lives HERE because the ω99-129 brief pins
/// all three refusals as unit cases (empty / not-on-disk / exists) — and
/// stat is not a spawn, so the ω99-104 discipline (spawn sides never run
/// under test) still holds. A pass returns the normalized PathBuf.
fn open_path_gate(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("open_path: empty path".to_string());
    }
    let target = PathBuf::from(trimmed);
    // The existence gate: a URL string (or any invented path) is not on
    // disk and stops HERE — bare `open` must never be handed one (the
    // same surface reveal_path kills).
    std::fs::metadata(&target)
        .map_err(|e| format!("cannot stat {}: {e}", target.display()))?;
    Ok(target)
}

/// ω99-129: 用系统默认应用打开交付物（docx/xlsx/pptx → Word/Numbers/
/// Keynote；⌘P 存 PDF 走系统打印管线——make_pdf 裁决的替代路径，系统
/// 管线自带内嵌字体与版式）。同 reveal_path 姿：存在性门控 + args 数组
/// 传递=无 shell 注入 + 不返回数据；`open` 无 `-R` 直开默认应用（ω99-110
/// selection.rs 的 open spawn 先例）。fire-and-forget——卡死的默认应用
/// 不许卡死 handler。仅主窗 capability。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = open_path_gate(&path)?;
    Command::new("open")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("cannot open {}: {e}", target.display()))?;
    Ok(())
}

/// ω99-155: markdown 链接外开——同 open_path 姿（args 数组传递无 shell 注入、
/// fire-and-forget），但门是 scheme 白名单不是磁盘存在性：仅 http/https，
/// 截空白拒绝。仅主窗 capability。
fn open_url_gate(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.is_empty() { return Err("open_url: empty url".to_string()); }
    if u.chars().any(|c| c.is_whitespace()) { return Err("open_url: whitespace in url".to_string()); }
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("open_url: scheme not allowed".to_string());
    }
    Ok(u.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let target = open_url_gate(&url)?;
    Command::new("open").arg(&target).spawn()
        .map_err(|e| format!("cannot open {target}: {e}"))?;
    Ok(())
}

//
// ω99-196: the layout machine's impure edge — the ONE command of this arc.
//

/// Apply a layout mode to the live pet window: read the current rect and the
/// monitor it sits on, scale the logical size by the window's scale factor,
/// reanchor (bottom-center), then set_size BEFORE set_position (the anchor
/// math holds no matter where the OS parks the resized window). The Moved
/// events this fires ride the existing throttle — no persistence change.
/// String errors; the two callers decide (startup: best-effort; command:
/// propagate to the web side).
fn apply_pet_layout(window: &tauri::WebviewWindow, mode: &str) -> Result<(), String> {
    let (lw, lh) = pet_layout_size(mode, load_pet_skin(window.app_handle()))?;
    let (Ok(origin), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return Err("set_pet_layout: pet window rect unreadable".to_string());
    };
    let area = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            // copy the fields out — work_area() borrows the monitor
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .ok_or_else(|| "set_pet_layout: no monitor for the pet window".to_string())?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("set_pet_layout: scale factor unreadable: {e}"))?;
    let new_w = (lw * scale).round().max(1.0) as u32;
    let new_h = (lh * scale).round().max(1.0) as u32;
    let pos = reanchor_pet_rect(
        (origin.x, origin.y, size.width, size.height),
        new_w,
        new_h,
        area,
    );
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(new_w, new_h)))
        .map_err(|e| format!("set_pet_layout: set_size failed: {e}"))?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(pos.x, pos.y)))
        .map_err(|e| format!("set_pet_layout: set_position failed: {e}"))?;
    Ok(())
}

/// ω99-196: set_pet_layout(mode) — mode ∈ "compact"|"bubble"|"answer". The
/// pet origin is REMOTE in tauri's ACL (the sidecar's http://127.0.0.1), so
/// the capability pin lives in capabilities/pet.json (allow-set-pet-layout).
/// Unknown modes and a missing window are Err — fail-closed, never a guess.
#[tauri::command]
fn set_pet_layout(app: AppHandle, mode: String) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "set_pet_layout: pet window missing".to_string())?;
    apply_pet_layout(&window, &mode)
}

//
// ω99-100 tests — the pure layer behind pet position persistence (spec D7):
// MoveThrottle, clamp math, and the position JSON codec. The clock is
// injected (`now_ms: u64`) so no test ever sleeps (the ω99-101 discipline);
// the window/monitor/tray sides are desktop-manual items (doc 114).
//

#[cfg(test)]
mod pet_position_tests {
    use super::*;

    // ---- MoveThrottle -------------------------------------------------

    #[test]
    fn throttle_first_move_writes_immediately() {
        let mut t = MoveThrottle::new();
        let p = PetWindowPosition { x: 10, y: 20 };
        assert_eq!(t.on_move(p, 0), Some(p));
    }

    #[test]
    fn throttle_moves_inside_interval_only_buffer() {
        let mut t = MoveThrottle::new();
        t.on_move(PetWindowPosition { x: 0, y: 0 }, 0);
        assert_eq!(t.on_move(PetWindowPosition { x: 100, y: 100 }, 100), None);
        assert_eq!(t.on_move(PetWindowPosition { x: 200, y: 200 }, 499), None);
        // the buffer holds the LATEST position only
        assert_eq!(t.flush(500), Some(PetWindowPosition { x: 200, y: 200 }));
    }

    #[test]
    fn throttle_move_after_interval_writes() {
        let mut t = MoveThrottle::new();
        t.on_move(PetWindowPosition { x: 0, y: 0 }, 1_000);
        let p = PetWindowPosition { x: 5, y: 5 };
        assert_eq!(t.on_move(p, 1_500), Some(p)); // exactly 500ms since the write → due
        assert_eq!(t.on_move(PetWindowPosition { x: 6, y: 6 }, 1_600), None);
    }

    #[test]
    fn throttle_flush_clean_and_pending() {
        let mut t = MoveThrottle::new();
        assert_eq!(t.flush(0), None); // never moved → nothing to persist
        t.on_move(PetWindowPosition { x: 1, y: 2 }, 0); // wrote
        assert_eq!(t.flush(10), None); // nothing buffered right after a write
        t.on_move(PetWindowPosition { x: 3, y: 4 }, 10); // buffered
        assert_eq!(t.flush(20), Some(PetWindowPosition { x: 3, y: 4 }));
        assert_eq!(t.flush(30), None); // flush drains
    }

    #[test]
    fn throttle_arbitrary_sequence_self_consistent() {
        let mut t = MoveThrottle::new();
        t.on_move(PetWindowPosition { x: 1, y: 1 }, 0); // write (first ever)
        t.on_move(PetWindowPosition { x: 2, y: 2 }, 100); // buffer
        t.on_move(PetWindowPosition { x: 3, y: 3 }, 400); // buffer
        assert_eq!(t.flush(450), Some(PetWindowPosition { x: 3, y: 3 })); // write
        t.on_move(PetWindowPosition { x: 4, y: 4 }, 470); // buffer (<500 since 450)
        t.on_move(PetWindowPosition { x: 5, y: 5 }, 1_000); // write (≥500 since 450)
        assert_eq!(t.flush(1_100), None); // clean
        // a clock running backwards saturates instead of panicking or blocking forever
        assert_eq!(t.on_move(PetWindowPosition { x: 6, y: 6 }, 500), None);
        assert_eq!(t.flush(600), Some(PetWindowPosition { x: 6, y: 6 }));
    }

    // ---- position JSON codec ------------------------------------------

    #[test]
    fn position_json_round_trip() {
        let p = PetWindowPosition { x: 1280, y: -70 };
        let json = position_to_json(&p);
        // exact shape: lowercase keys, no extra fields, stable key order
        assert_eq!(json, r#"{"x":1280,"y":-70}"#);
        assert_eq!(position_from_json(&json), Some(p));
    }

    #[test]
    fn position_json_rejects_bad_shapes_without_panicking() {
        assert_eq!(position_from_json(r#"{"x":1,"y":2}"#), Some(PetWindowPosition { x: 1, y: 2 }));
        // unknown keys are tolerated (forward compat), the values still read
        assert_eq!(position_from_json(r#"{"x":7,"y":8,"z":9}"#), Some(PetWindowPosition { x: 7, y: 8 }));
        assert_eq!(position_from_json("null"), None);
        assert_eq!(position_from_json(r#"{"x":1}"#), None); // missing key
        assert_eq!(position_from_json(r#"{"x":"a","y":2}"#), None); // non-numeric
        assert_eq!(position_from_json("garbage"), None);
        assert_eq!(position_from_json(r#"{"x":9999999999,"y":0}"#), None); // beyond i32
    }

    // ---- clamp math ---------------------------------------------------

    // a plausible main screen: 1920x1080 panel, dock + menubar leave 1055px
    const AREA: WorkArea = WorkArea { x: 0, y: 0, width: 1920, height: 1055 };

    #[test]
    fn clamp_inside_work_area_returns_unchanged() {
        let p = PetWindowPosition { x: 100, y: 100 };
        assert_eq!(clamp_to_work_area(p, AREA), p);
        // flush against the right/bottom edge is still inside
        let edge = PetWindowPosition { x: 1920 - 220, y: 1055 - 320 };
        assert_eq!(clamp_to_work_area(edge, AREA), edge);
    }

    #[test]
    fn clamp_left_top_overflow_pulls_to_work_area_origin() {
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: -60, y: -40 }, AREA),
            PetWindowPosition { x: 0, y: 0 },
        );
    }

    #[test]
    fn clamp_right_bottom_overflow_flushes_to_edges() {
        // right: 2500 + 220 > 1920 → x = 1920 − 220 = 1700 (y untouched)
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: 2500, y: 100 }, AREA),
            PetWindowPosition { x: 1700, y: 100 },
        );
        // bottom: 2000 + 320 > 1055 → y = 1055 − 320 = 735 (x untouched)
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: 100, y: 2000 }, AREA),
            PetWindowPosition { x: 100, y: 735 },
        );
        // off both axes → far corner of the work area
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: 5000, y: 5000 }, AREA),
            PetWindowPosition { x: 1700, y: 735 },
        );
    }

    #[test]
    fn clamp_nonzero_origin_and_window_wider_than_area() {
        // second monitor sitting right of a 1440-wide main: origin (1440, 0)
        let second = WorkArea { x: 1440, y: 0, width: 1920, height: 1055 };
        // remembered on the (now unplugged) left monitor → pulled into the survivor
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: 500, y: 500 }, second),
            PetWindowPosition { x: 1440, y: 500 },
        );
        // work area smaller than the window: park at the origin, never negative
        let tiny = WorkArea { x: 10, y: 20, width: 100, height: 100 };
        assert_eq!(
            clamp_to_work_area(PetWindowPosition { x: 400, y: 400 }, tiny),
            PetWindowPosition { x: 10, y: 20 },
        );
    }

    #[test]
    fn pet_window_size_constants_match_conf() {
        // tauri.conf.json label "pet" is 220x320; the clamp math leans on it.
        assert_eq!((PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT), (220, 320));
    }
}

//
// ω99-196 tests — the layout machine's pure core: the bottom-center reanchor
// (the anchor keeps the SPRITE visually frozen while the window morphs) and
// the mode→size table. The window/monitor edges (apply_pet_layout, the
// command) are desktop-manual items (doc 114), same split as ω99-100.
//

#[cfg(test)]
mod pet_layout_tests {
    use super::*;

    // the same plausible main screen as pet_position_tests (physical px).
    const WORK: (i32, i32, u32, u32) = (0, 0, 1920, 1055);

    #[test]
    fn reanchor_same_size_is_noop() {
        // 220×320 → 220×320: the anchor point is the window itself.
        assert_eq!(
            reanchor_pet_rect((100, 200, 220, 320), 220, 320, WORK),
            PetWindowPosition { x: 100, y: 200 },
        );
    }

    #[test]
    fn reanchor_grow_and_shrink_keep_bottom_center() {
        // bubble 220×320 @ (100,735) → answer 420×560 (ω99-271): bottom edge
        // stays 1055, center stays 210 → x=210−210=0, y=1055−560=495.
        assert_eq!(
            reanchor_pet_rect((100, 735, 220, 320), 420, 560, WORK),
            PetWindowPosition { x: 0, y: 495 },
        );
        // and back: answer → compact keeps the SAME bottom-center (sprite
        // never moves); 0+210−52=158, 1055−71=984.
        assert_eq!(
            reanchor_pet_rect((0, 495, 420, 560), 104, 71, WORK),
            PetWindowPosition { x: 158, y: 984 },
        );
    }

    #[test]
    fn reanchor_left_overflow_pulls_back_into_work_area() {
        // pet hugging the left edge grows to answer: raw x = 120−210 = −90 → 0.
        assert_eq!(
            reanchor_pet_rect((10, 700, 220, 320), 420, 560, WORK),
            PetWindowPosition { x: 0, y: 460 },
        );
    }

    #[test]
    fn reanchor_right_overflow_pulls_back_into_work_area() {
        // pet hugging the right edge (1690+220=1910 ≤ 1920): raw x =
        // 1800−210 = 1590 → clamped to 1920−420 = 1500.
        assert_eq!(
            reanchor_pet_rect((1690, 700, 220, 320), 420, 560, WORK),
            PetWindowPosition { x: 1500, y: 460 },
        );
    }

    #[test]
    fn reanchor_top_starved_clamp_parks_at_work_area_top() {
        // a work area shorter than the window: y clamps to the area top (the
        // bottom edge rises — safer than hanging over the dock), never above.
        let short = (0, 0, 1920, 400);
        assert_eq!(
            reanchor_pet_rect((100, 100, 220, 320), 420, 560, short),
            PetWindowPosition { x: 0, y: 0 },
        );
    }

    #[test]
    fn pet_layout_mode_sizes_pinned() {
        // compact hugs the sprite (96 + 4/侧, 12 底距 + ~59 精灵高 + 13 动作
        // headroom——走查裁定 71→84，done-hop 峰值 81.8 不裁切), bubble =
        // the conf size, answer = the widened reading form; unknown → Err.
        assert_eq!(pet_layout_size("compact", "default").unwrap(), (104.0, 84.0));
        // 力量形态随肤增高：88px 1:1 帧 + 峰值动画/hop + 余量 → 120；
        // 其余肤维持 84（slime 58.6px 族不变）。
        assert_eq!(pet_layout_size("compact", "power").unwrap(), (104.0, 120.0));
        assert_eq!(pet_layout_size("compact", "sakura").unwrap(), (104.0, 84.0));
        // bubble/answer 不随肤（两形态窗高均远超 88px 帧峰值）
        assert_eq!(pet_layout_size("bubble", "power").unwrap(), (220.0, 320.0));
        assert_eq!(pet_layout_size("answer", "default").unwrap(), (420.0, 560.0)); // ω99-271: 阅读面
        assert!(pet_layout_size("expanded", "default").is_err());
    }
}

//
// ω99-102 tests — the pure layer behind pet click-through (spec D10):
// hit_test boundaries/rounding, the focus-first decision, and the IPC
// debounce latch. The polling thread only wires these together around a
// sleep no test should pay for — its behavior is desktop-manual (doc 114).
//

#[cfg(test)]
mod pet_penetration_tests {
    use super::*;

    // ---- hit_test ------------------------------------------------------
    // rect under test: x ∈ [100, 320], y ∈ [200, 520] — the real 220x320 pet
    // window parked at (100, 200).
    const ORIGIN: (i32, i32) = (100, 200);
    const SIZE: (u32, u32) = (220, 320);

    #[test]
    fn hit_inside_window() {
        assert!(hit_test((210.0, 360.0), ORIGIN, SIZE)); // dead center
        assert!(hit_test((100.4, 519.6), ORIGIN, SIZE)); // hugging bottom-left, inside
    }

    #[test]
    fn hit_on_all_four_boundaries() {
        assert!(hit_test((100.0, 360.0), ORIGIN, SIZE)); // left edge
        assert!(hit_test((320.0, 360.0), ORIGIN, SIZE)); // right edge
        assert!(hit_test((210.0, 200.0), ORIGIN, SIZE)); // top edge
        assert!(hit_test((210.0, 520.0), ORIGIN, SIZE)); // bottom edge
        assert!(hit_test((320.0, 520.0), ORIGIN, SIZE)); // corner = on
    }

    #[test]
    fn miss_outside_each_side() {
        assert!(!hit_test((99.0, 360.0), ORIGIN, SIZE)); // left
        assert!(!hit_test((321.0, 360.0), ORIGIN, SIZE)); // right
        assert!(!hit_test((210.0, 199.0), ORIGIN, SIZE)); // above
        assert!(!hit_test((210.0, 521.0), ORIGIN, SIZE)); // below
    }

    #[test]
    fn negative_coordinates_left_monitor() {
        // a monitor LEFT of the primary: the whole window lives at negative
        // global x — x ∈ [−1920, −1700], y ∈ [0, 320] (app.rs: cursor
        // coordinates can be negative there).
        let origin = (-1920, 0);
        let size = (220u32, 320u32);
        assert!(hit_test((-1810.0, 160.0), origin, size)); // inside
        assert!(hit_test((-1700.0, 320.0), origin, size)); // bottom-right corner
        assert!(!hit_test((-1921.0, 160.0), origin, size)); // off the left edge
        assert!(!hit_test((-1699.0, 160.0), origin, size)); // off the right edge
        assert!(!hit_test((-1810.0, -1.0), origin, size)); // above
        assert!(!hit_test((-1810.0, 321.0), origin, size)); // below
    }

    #[test]
    fn rounding_half_pixel_boundary() {
        // the brief's pinned case: origin.x + size.w − 0.5 = 319.5 rounds to
        // 320 = exactly the right edge → still ON the window
        assert!(hit_test((319.5, 360.0), ORIGIN, SIZE));
        // half a pixel beyond the edge rounds off it
        assert!(!hit_test((320.5, 360.0), ORIGIN, SIZE));
        // mirrored on the left edge: 99.5 → 100 → on, 99.4 → 99 → off
        assert!(hit_test((99.5, 360.0), ORIGIN, SIZE));
        assert!(!hit_test((99.4, 360.0), ORIGIN, SIZE));
        // a NaN cursor degrades to a miss instead of panicking
        assert!(!hit_test((f64::NAN, 360.0), ORIGIN, SIZE));
    }

    // ---- penetration_decision ------------------------------------------

    #[test]
    fn decision_is_focus_first() {
        // focused windows NEVER punch through — position polling only applies
        // to unfocused ones (typing in the bubble while the mouse wanders
        // off-window must not lose the window)
        assert!(!penetration_decision(true, false));
        assert!(!penetration_decision(true, true));
        // unfocused + cursor on the window → interactive
        assert!(!penetration_decision(false, true));
        // the only penetrating state: unfocused AND cursor elsewhere
        assert!(penetration_decision(false, false));
    }

    // ---- PenetrationLatch ----------------------------------------------

    #[test]
    fn latch_applies_only_on_decision_change() {
        let mut latch = PenetrationLatch::default();
        // no last verdict yet → the first one always reaches the window
        assert_eq!(latch.apply(true), Some(true));
        assert_eq!(latch.apply(true), None); // same verdict → no IPC
        assert_eq!(latch.apply(false), Some(false)); // flip → IPC
        assert_eq!(latch.apply(false), None);
        assert_eq!(latch.apply(true), Some(true)); // and back again
    }
}

//
// ω99-104 tests — the pure layer behind drop-to-delegate (P1 首弧):
// the drop allowlist (admit/remember/TTL/lazy prune/cap), the base64 codec
// (RFC 4648 vectors — the JS side's atob must decode exactly this), and the
// pet-file-drop event payload shape. The window/emit/IPC/command sides are
// desktop-manual items (doc 114 §ω99-104). Clocks are injected (`now_ms:
// u64`) so no test ever sleeps — the ω99-100/101/102 discipline.
//

#[cfg(test)]
mod pet_drop_tests {
    use super::*;

    fn pb(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    // ---- remember/admit -------------------------------------------------

    #[test]
    fn admit_rejects_empty_list_and_unknown_paths() {
        let mut list = Vec::new();
        assert!(!admit_drop(&mut list, &pb("/tmp/a.txt"), 0));
        remember_drops(&mut list, &[pb("/tmp/a.txt")], 0);
        assert!(admit_drop(&mut list, &pb("/tmp/a.txt"), 1));
        // a path that was never dropped — the JS side must not be able to
        // invent one ("drop 即授权": admission IS the authorization)
        assert!(!admit_drop(&mut list, &pb("/tmp/secrets"), 1));
    }

    #[test]
    fn admit_expires_at_the_deadline() {
        let mut list = Vec::new();
        remember_drops(&mut list, &[pb("/tmp/a.txt")], 1_000);
        // valid through the last millisecond INSIDE the TTL window
        assert!(admit_drop(&mut list, &pb("/tmp/a.txt"), 1_000 + DROP_TTL_MS - 1));
        // at the deadline the entry is gone: now_ms == deadline_ms → expired
        assert!(!admit_drop(&mut list, &pb("/tmp/a.txt"), 1_000 + DROP_TTL_MS));
    }

    #[test]
    fn re_dropping_refreshes_the_deadline() {
        let mut list = Vec::new();
        remember_drops(&mut list, &[pb("/tmp/a.txt")], 0);
        remember_drops(&mut list, &[pb("/tmp/a.txt")], DROP_TTL_MS); // dropped again at t=TTL
        // old deadline (TTL) would have expired the entry at t=TTL; the
        // refresh moved it to 2*TTL
        assert!(admit_drop(&mut list, &pb("/tmp/a.txt"), 2 * DROP_TTL_MS - 1));
        assert!(!admit_drop(&mut list, &pb("/tmp/a.txt"), 2 * DROP_TTL_MS));
    }

    #[test]
    fn a_batch_is_admitted_wholesale_and_duplicates_do_not_pile_up() {
        let mut list = Vec::new();
        remember_drops(&mut list, &[pb("/a"), pb("/b"), pb("/c"), pb("/a")], 5);
        // dedupe: the same path remembered twice holds ONE slot (refreshed)
        assert_eq!(list.len(), 3);
        for p in ["/a", "/b", "/c"] {
            assert!(admit_drop(&mut list, &pb(p), 6));
        }
    }

    #[test]
    fn prune_is_lazy_and_runs_on_every_touch() {
        let mut list = Vec::new();
        remember_drops(&mut list, &[pb("/a"), pb("/b")], 0);
        assert_eq!(list.len(), 2);
        // time passes beyond the TTL; a read attempt for an UNRELATED path
        // still prunes the stale entries (read-time lazy cleanup)
        assert!(!admit_drop(&mut list, &pb("/c"), DROP_TTL_MS + 1));
        assert_eq!(list.len(), 0);
        // and remember prunes too — expired leftovers never linger
        remember_drops(&mut list, &[pb("/a"), pb("/b")], 0);
        remember_drops(&mut list, &[pb("/d")], DROP_TTL_MS + 1);
        assert!(list.iter().all(|e| e.path == pb("/d")));
    }

    #[test]
    fn list_is_bounded_oldest_evicted_first() {
        let mut list = Vec::new();
        let batch: Vec<PathBuf> = (0..DROP_LIST_CAP + 3).map(|i| pb(&format!("/f{i}"))).collect();
        remember_drops(&mut list, &batch, 0);
        assert_eq!(list.len(), DROP_LIST_CAP);
        // the FIRST paths fell off the back of the cap…
        assert!(!admit_drop(&mut list, &pb("/f0"), 1));
        assert!(!admit_drop(&mut list, &pb("/f2"), 1));
        // …the LAST ones are still admitted
        assert!(admit_drop(&mut list, &pb(&format!("/f{}", DROP_LIST_CAP + 2)), 1));
    }

    // ---- base64 ----------------------------------------------------------
    // The JS side decodes with atob (standard alphabet, mandatory padding) —
    // RFC 4648 §10's exact vectors are the contract.

    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_all_byte_values_shape_and_padding() {
        let all: Vec<u8> = (0..=255u8).collect();
        let enc = base64_encode(&all);
        // 256 bytes → ceil(256/3)=86 groups → 344 chars, no inner whitespace
        assert_eq!(enc.len(), 344);
        assert!(enc.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='
        }));
        // padding only at the tail, and the length is a multiple of 4
        assert_eq!(enc.len() % 4, 0);
        let pad = enc.len() - enc.trim_end_matches('=').len();
        assert!(pad < 3);
        // the decoded length is recoverable from the padded length alone
        let decoded = 3 * (enc.len() / 4) - pad;
        assert_eq!(decoded, 256);
    }

    // ---- the pet-file-drop payload ---------------------------------------

    #[test]
    fn payload_carries_path_name_and_bytes() {
        let json = drop_event_payload(&[(pb("/tmp/report.pdf"), 123_456)]);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let paths = v.get("paths").and_then(|p| p.as_array()).unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].get("path"), Some(&serde_json::json!("/tmp/report.pdf")));
        assert_eq!(paths[0].get("name"), Some(&serde_json::json!("report.pdf")));
        assert_eq!(paths[0].get("bytes"), Some(&serde_json::json!(123_456)));
    }

    #[test]
    fn payload_keeps_drop_order_and_survives_nameless_paths() {
        let json = drop_event_payload(&[(pb("/a.txt"), 1), (pb("/"), 2), (pb("/b.txt"), 3)]);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let paths = v.get("paths").and_then(|p| p.as_array()).unwrap();
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[0].get("name"), Some(&serde_json::json!("a.txt")));
        assert_eq!(paths[2].get("name"), Some(&serde_json::json!("b.txt")));
        // a path with no file_name (the filesystem root) falls back to the
        // full lossy string instead of panicking
        assert_eq!(paths[1].get("name"), Some(&serde_json::json!("/")));
    }
}

//
// ω99-111 tests — the pure layer behind pet skins (brief §2 Rust): the
// skin-file codec, the missing/corrupt/unknown → "default" normalization,
// the skin registry list + display names, and the PET_SKIN_EVENT payload
// shape. The tray/emit/command edges are desktop-manual items (doc 114).
//
// ω99-125 tests — the reveal gate is the ONLY pure layer under test (the
// command's fs::metadata existence check and the `open -R` spawn stay
// outside: the ω99-104 discipline, spawn sides never run under test).
#[cfg(test)]
mod reveal_path_tests {
    use super::*;

    #[test]
    fn gate_rejects_empty_and_whitespace() {
        assert!(reveal_path_gate("").is_err());
        assert!(reveal_path_gate("   ").is_err());
        assert!(reveal_path_gate(" \t\n ").is_err());
    }

    #[test]
    fn gate_accepts_a_real_path_and_trims_surrounding_whitespace() {
        assert_eq!(reveal_path_gate("/tmp/报表.xlsx"), Ok(PathBuf::from("/tmp/报表.xlsx")));
        // surrounding whitespace is trimmed, never carried into open args
        assert_eq!(reveal_path_gate("  /tmp/a.xlsx\n"), Ok(PathBuf::from("/tmp/a.xlsx")));
    }

    #[test]
    fn gate_error_names_the_refusal() {
        let err = reveal_path_gate("   ").unwrap_err();
        assert!(err.contains("empty"), "refusal should say why: {err}");
    }
}

//
// ω99-129 tests — the open gate folds the existence check INTO the pure
// layer (the brief pins 空路径拒/不存在拒/存在过 as unit cases; stat is not
// a spawn, so the ω99-104 discipline holds — only the bare-`open` spawn
// stays outside, exactly like reveal's `open -R`).
#[cfg(test)]
mod open_path_tests {
    use super::*;

    #[test]
    fn gate_rejects_empty_and_whitespace() {
        assert!(open_path_gate("").is_err());
        assert!(open_path_gate("   ").is_err());
        assert!(open_path_gate(" \t\n ").is_err());
    }

    #[test]
    fn gate_rejects_a_path_not_on_disk() {
        // A URL string (or any invented path) is not on disk — bare `open`
        // must never be handed one; the refusal names the stat failure.
        let err = open_path_gate("/nonexistent-omega99-129/交付物.xlsx").unwrap_err();
        assert!(err.contains("cannot stat"), "refusal should say why: {err}");
    }

    #[test]
    fn gate_accepts_a_path_that_exists_on_disk() {
        // A real temp fixture (write → gate → remove): deterministic
        // because the gate only stats; surrounding whitespace is trimmed,
        // never carried into the open args (reveal's trim pin, ported).
        let p =
            std::env::temp_dir().join(format!("omega99-129-gate-{}.xlsx", std::process::id()));
        std::fs::write(&p, b"pin").expect("temp fixture");
        let trimmed = format!("  {} \n", p.display());
        assert_eq!(open_path_gate(&trimmed), Ok(p.clone()));
        let _ = std::fs::remove_file(&p);
    }
}

//
// ω99-155 tests — the url gate is pure string policy (empty / internal
// whitespace / non-http scheme refuse, http(s) passes trimmed; the brief's
// 空/含空白/ftp:// 拒、https:// 过). Only the bare-`open` spawn stays
// outside — the ω99-104 discipline, same posture as reveal/open_path.
#[cfg(test)]
mod open_url_tests {
    use super::*;

    #[test]
    fn gate_rejects_empty_and_whitespace() {
        assert!(open_url_gate("").is_err());
        assert!(open_url_gate("   ").is_err());
        assert!(open_url_gate(" \t\n ").is_err());
    }

    #[test]
    fn gate_rejects_internal_whitespace() {
        let err = open_url_gate("https://example.com/a b").unwrap_err();
        assert!(err.contains("whitespace"), "refusal should say why: {err}");
    }

    #[test]
    fn gate_rejects_non_http_schemes() {
        // ftp/file/javascript (the model-output poison) never reach `open`.
        let err = open_url_gate("ftp://example.com/f.xlsx").unwrap_err();
        assert!(err.contains("scheme"), "refusal should say why: {err}");
        assert!(open_url_gate("file:///etc/passwd").is_err());
        assert!(open_url_gate("javascript:alert(1)").is_err());
    }

    #[test]
    fn gate_accepts_http_https_and_trims() {
        assert_eq!(open_url_gate("https://example.com/x"), Ok("https://example.com/x".to_string()));
        assert_eq!(open_url_gate("http://127.0.0.1:8080/a"), Ok("http://127.0.0.1:8080/a".to_string()));
        // surrounding whitespace is trimmed, never carried into open args
        assert_eq!(open_url_gate("  https://example.com/a\n"), Ok("https://example.com/a".to_string()));
    }
}

#[cfg(test)]
mod pet_skin_tests {
    use super::*;

    // ---- the skin list ----------------------------------------------------

    #[test]
    fn skin_list_is_pinned_and_matches_display_names() {
        // The five ids are pinned ON PURPOSE against the TS side's PET_SKINS
        // (packages/web/src/pet/skins/index.ts): a drift is not silently
        // normalized away at runtime — it reads as a review-time diff here.
        assert_eq!(PET_SKIN_IDS, ["default", "sakura", "lake", "honey", "power"]);
        assert_eq!(pet_skin_display_name("default"), Some("经典绿"));
        assert_eq!(pet_skin_display_name("sakura"), Some("樱花粉"));
        assert_eq!(pet_skin_display_name("lake"), Some("湖水蓝"));
        assert_eq!(pet_skin_display_name("honey"), Some("蜜橙金"));
        assert_eq!(pet_skin_display_name("power"), Some("力量形态"));
        assert_eq!(pet_skin_display_name("wow"), None);
    }

    // ---- the pet-skin.json codec ------------------------------------------

    #[test]
    fn skin_json_codec_round_trips_every_id() {
        for id in PET_SKIN_IDS {
            let text = pet_skin_to_json(id);
            // exact shape: one lowercase key, quoted id, no extras
            assert_eq!(text, format!("{{\"skin\":\"{id}\"}}"));
            assert_eq!(pet_skin_from_json(&text).as_deref(), Some(id));
        }
    }

    #[test]
    fn skin_json_rejects_wrong_shapes_whole() {
        // missing key / wrong type / extra keys → None, never a partial read
        assert_eq!(pet_skin_from_json("{}"), None);
        assert_eq!(pet_skin_from_json(r#"{"skin":42}"#), None);
        assert_eq!(pet_skin_from_json(r#"{"skin":"sakura","x":1}"#), None);
        assert_eq!(pet_skin_from_json("not json at all"), None);
    }

    // ---- normalization: the one read path every edge funnels through ------

    #[test]
    fn missing_file_normalizes_to_default() {
        // None = the file is absent (first boot) — never an error state
        assert_eq!(normalize_pet_skin(None), "default");
    }

    #[test]
    fn corrupt_file_normalizes_to_default() {
        assert_eq!(normalize_pet_skin(Some("{broken json")), "default");
        assert_eq!(normalize_pet_skin(Some(r#"{"skin":42}"#)), "default");
        assert_eq!(normalize_pet_skin(Some("")), "default");
    }

    #[test]
    fn unknown_id_normalizes_to_default_and_known_ids_pass() {
        assert_eq!(normalize_pet_skin(Some(r#"{"skin":"wow"}"#)), "default");
        assert_eq!(normalize_pet_skin(Some(r#"{"skin":"DEFAULT"}"#)), "default");
        for id in PET_SKIN_IDS {
            assert_eq!(normalize_pet_skin(Some(&pet_skin_to_json(id))), id);
        }
    }

    // ---- the wudao-pet-skin event payload ----------------------------------

    #[test]
    fn pet_skin_event_payload_is_exactly_one_skin_key() {
        let json = pet_skin_event_payload("sakura");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1, "no extras ride the wire");
        assert_eq!(v.get("skin"), Some(&serde_json::json!("sakura")));
        // the event name is pinned: the web side listens on this exact string
        assert_eq!(PET_SKIN_EVENT, "wudao-pet-skin");
    }
}

//
// 回滚重做 T2 tests — the sidecar runtime-bundle probe ORDER as a pure
// list (the 0.3.76 exe-adjacent fallback 53d0d2e4 carried, re-landed
// alone this time): installed resource layout first, then DIRECTLY next
// to the executable (a bundle layout that parks the payload in
// MacOS/sidecar-resources/ instead of Resources/ — tolerate, don't
// fail), then the source-tree dev layout. The fs::is_file probe and the
// AppHandle edge stay at the call site (the ω99-104 discipline, env and
// spawn sides never run under test).
//
#[cfg(test)]
mod sidecar_resolve_tests {
    use super::*;

    fn pb(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn installed_bundle_probes_in_order() {
        // the installed .app: exe in Contents/MacOS, resources in
        // Contents/Resources (the array-form resources layout).
        let candidates = runtime_bundle_candidates(
            Some(Path::new("/Applications/wudao-harness-desktop.app/Contents/Resources")),
            Path::new("/Applications/wudao-harness-desktop.app/Contents/MacOS"),
        );
        assert_eq!(
            candidates,
            vec![
                pb("/Applications/wudao-harness-desktop.app/Contents/Resources/sidecar-resources/wudao-server.cjs"),
                // T2: DIRECTLY next to the executable — the bundle layout
                // 0.3.76 found in the wild (payload parked in
                // MacOS/sidecar-resources/), tolerated instead of fatal
                pb("/Applications/wudao-harness-desktop.app/Contents/MacOS/sidecar-resources/wudao-server.cjs"),
                pb("/Applications/wudao-harness-desktop.app/Contents/MacOS/../../sidecar-resources/wudao-server.cjs"),
            ]
        );
    }

    #[test]
    fn resource_dir_unavailable_falls_to_the_exe_sides() {
        // resource_dir() failed (Err → None): the exe-adjacent probe leads,
        // then the dev layout — the list is never empty.
        let candidates = runtime_bundle_candidates(None, Path::new("/w/src-tauri/target/release"));
        assert_eq!(
            candidates,
            vec![
                pb("/w/src-tauri/target/release/sidecar-resources/wudao-server.cjs"),
                // dev layout: src-tauri/sidecar-resources, two up from the
                // profile dir (literal .. segments — the probe never normalizes)
                pb("/w/src-tauri/target/release/../../sidecar-resources/wudao-server.cjs"),
            ]
        );
    }
}


//
// 122 项 2 tests — the LaunchAgent wake flag's pure argv scan (the env
// handoff and the real launchd round-trip are the manual/真机 face; here
// only the literal-token contract: exact match, no prefix/value confusion).
//
#[cfg(test)]
mod schedule_wake_tests {
    use super::*;

    #[test]
    fn exact_flag_wakes_prefixes_and_values_do_not() {
        assert!(schedule_wake_requested(["wudao-harness-desktop", "--schedule-wake"]));
        assert!(!schedule_wake_requested(["wudao-harness-desktop"]));
        assert!(!schedule_wake_requested(["wudao-harness-desktop", "--schedule-wake=1"]));
        assert!(!schedule_wake_requested(["wudao-harness-desktop", "--schedule"]));
        assert!(!schedule_wake_requested(["--args", "--schedule-wake.txt"]));
        assert!(!schedule_wake_requested(Vec::<String>::new()));
    }
}
