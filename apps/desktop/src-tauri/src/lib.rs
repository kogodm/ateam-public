//! Ateam desktop shell (Tauri 2). The shell is intentionally thin: it spawns
//! the Node sidecar (the same core the TUI embeds), captures its
//! `{port,token}` handshake from stdout, and exposes it to the webview via
//! one command. All real logic stays in the TS core, reached over the
//! loopback WebSocket through @ateam/contract — no backend rewrite.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Clone, Serialize, Deserialize)]
struct Handshake {
    port: u16,
    token: String,
}

#[derive(Default, Clone)]
struct ShellState {
    handshake: Arc<Mutex<Option<Handshake>>>,
    sidecar: Arc<Mutex<Option<Child>>>,
    /// set once the user has answered "Quit" — the second close is let through
    quitting: Arc<AtomicBool>,
}

/// Closing the window or pressing ⌘Q ends every session's terminal, and the
/// red button sits a few pixels from the tab strip: one mis-click took the
/// whole cockpit down. Ask first — and only once, since the answer arms the
/// close that follows.
const MENU_QUIT_ID: &str = "ateam-quit";
const QUIT_TITLE: &str = "Quit Ateam?";
const QUIT_BODY: &str =
    "Sessions are saved and come back when you reopen Ateam, but their terminals stop now.";

fn confirm_quit<F: FnOnce() + Send + 'static>(app: &tauri::AppHandle, then: F) {
    app.dialog()
        .message(QUIT_BODY)
        .title(QUIT_TITLE)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |quit| {
            if quit {
                then();
            }
        });
}

/// The webview asks for this once on boot, then opens
/// `ws://127.0.0.1:<port>/?token=<token>` itself.
#[tauri::command]
fn get_handshake(state: State<'_, ShellState>) -> Option<Handshake> {
    state.handshake.lock().ok().and_then(|g| g.clone())
}

/// Monorepo root, derived at compile time from this crate's location
/// (`apps/desktop/src-tauri` → repo root). Dev-mode spawn; a packaged app
/// will ship a bundled sidecar binary instead (tracked follow-up).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn spawn_sidecar(app: &tauri::AppHandle, state: &ShellState) {
    // Packaged: run the bundled self-contained sidecar with system `node`
    // (node-pty shipped beside it via NODE_PATH). Dev: spawn it through
    // pnpm from the monorepo. (Embedding a Node runtime is the final
    // hardening; a packaged app currently needs `node` on PATH.)
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("sidecar"))
        .filter(|d| d.join("index.cjs").exists());

    let mut cmd = match &bundled {
        Some(dir) => {
            // Prefer the Node runtime we ship next to index.cjs (fetch-node.mjs
            // places it there during the build) so end users don't need Node
            // installed. Fall back to system `node` for backwards-compat with
            // older builds that pre-date the bundled-node change.
            let bundled_node = dir.join(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            });
            let node_bin = if bundled_node.exists() {
                bundled_node.into_os_string()
            } else {
                "node".into()
            };
            let mut c = Command::new(node_bin);
            c.arg(dir.join("index.cjs"))
                .env("NODE_PATH", dir.join("node_modules"))
                .current_dir(dir);
            c
        }
        None => {
            // `pnpm` on Windows is `pnpm.cmd`; CreateProcess won't find a
            // bare `pnpm` without the .cmd suffix. Command::new on Windows
            // does PATHEXT resolution for some shells but not reliably for
            // .cmd shims, so spell it out per OS.
            #[cfg(target_os = "windows")]
            let bin = "pnpm.cmd";
            #[cfg(not(target_os = "windows"))]
            let bin = "pnpm";
            let mut c = Command::new(bin);
            c.args(["--filter", "@ateam/sidecar", "start"])
                .current_dir(repo_root());
            c
        }
    };

    // Debug/test builds (identifier `*.debug`, built via tauri.debug.conf.json)
    // run against an ISOLATED data dir so a side-by-side `ateam-debug` app can
    // never clobber the production app's ~/.ateam state — sessions, tui-state,
    // handoff-state — while the user is actively working in the real app.
    if app.config().identifier.contains("debug") {
        if let Ok(home) = app.path().home_dir() {
            cmd.env("ATEAM_HOME", home.join(".ateam-debug"));
        }
    }

    // On Windows, spawning `node` from a windowed app pops a black console
    // unless we set CREATE_NO_WINDOW (0x08000000). No effect on macOS/Linux.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ateam: failed to spawn sidecar: {e}");
            return;
        }
    };

    if let Some(out) = child.stdout.take() {
        let slot = Arc::clone(&state.handshake);
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(hs) = serde_json::from_str::<Handshake>(&line) {
                    if let Ok(mut g) = slot.lock() {
                        *g = Some(hs);
                    }
                    // keep draining stdout so the pipe never blocks the child
                }
            }
        });
    }

    if let Ok(mut g) = state.sidecar.lock() {
        *g = Some(child);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ShellState::default())
        // macOS terminates on ⌘Q / the app menu's Quit without ever raising a
        // preventable event, so the menu gets OUR quit item instead.
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                for item in app_menu.items()? {
                    if let MenuItemKind::Predefined(p) = &item {
                        if p.text().map(|t| t.contains("Quit")).unwrap_or(false) {
                            let _ = app_menu.remove(&item);
                        }
                    }
                }
                app_menu.append(&MenuItem::with_id(
                    handle,
                    MENU_QUIT_ID,
                    "Quit Ateam",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == MENU_QUIT_ID {
                let handle = app.clone();
                confirm_quit(app, move || {
                    handle
                        .state::<ShellState>()
                        .quitting
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![get_handshake])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                if app.state::<ShellState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let w = window.clone();
                let handle = app.clone();
                confirm_quit(&app, move || {
                    handle
                        .state::<ShellState>()
                        .quitting
                        .store(true, Ordering::SeqCst);
                    let _ = w.close();
                });
            }
        })
        .setup(|app| {
            spawn_sidecar(&app.handle().clone(), &app.state::<ShellState>());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Ateam desktop")
        .run(|app, event| {
            // ⌘Q asks too — it never reaches the window's close event
            if let RunEvent::ExitRequested { api, .. } = &event {
                if !app.state::<ShellState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let handle = app.clone();
                    confirm_quit(app, move || {
                        handle
                            .state::<ShellState>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            }
            if let RunEvent::Exit = event {
                if let Ok(mut g) = app.state::<ShellState>().sidecar.lock() {
                    if let Some(mut child) = g.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
