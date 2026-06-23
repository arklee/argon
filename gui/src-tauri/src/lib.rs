use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct RpcBridgeState {
    bridge: Mutex<Option<Arc<RpcBridge>>>,
}

struct RpcBridge {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

impl Drop for RpcBridge {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcStartParams {
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcStartResult {
    cwd: String,
    command: String,
    already_running: bool,
}

#[derive(Debug, Deserialize)]
struct RpcRequestParams {
    method: String,
    params: Option<Value>,
}

#[tauri::command]
fn rpc_start(
    app: AppHandle,
    state: State<'_, RpcBridgeState>,
    params: Option<RpcStartParams>,
) -> Result<RpcStartResult, String> {
    let mut slot = state.bridge.lock().map_err(|_| "RPC state lock poisoned".to_string())?;
    if let Some(existing) = slot.as_ref() {
        return Ok(RpcStartResult {
            cwd: repo_root().display().to_string(),
            command: existing.command_label(),
            already_running: true,
        });
    }

    let cwd = params
        .and_then(|params| params.cwd)
        .map(PathBuf::from)
        .unwrap_or_else(repo_root);
    let cli = repo_root().join("dist").join("tui").join("cli.js");
    if !cli.exists() {
        return Err(format!(
            "Argon RPC entrypoint is missing at {}. Run `npm run build` in the repository root first.",
            cli.display()
        ));
    }

    let mut child = Command::new("node")
        .arg(cli)
        .arg("--mode")
        .arg("rpc")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start Argon RPC process: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open RPC stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open RPC stdout".to_string())?;
    let stderr = child.stderr.take();

    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    spawn_stdout_reader(app.clone(), pending.clone(), stdout);
    if let Some(stderr) = stderr {
        spawn_stderr_reader(app, stderr);
    }

    let bridge = Arc::new(RpcBridge {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
    });
    let result = RpcStartResult {
        cwd: cwd.display().to_string(),
        command: bridge.command_label(),
        already_running: false,
    };
    *slot = Some(bridge);
    Ok(result)
}

#[tauri::command]
fn rpc_request(
    state: State<'_, RpcBridgeState>,
    params: RpcRequestParams,
) -> Result<Value, String> {
    let bridge = state
        .bridge
        .lock()
        .map_err(|_| "RPC state lock poisoned".to_string())?
        .as_ref()
        .cloned()
        .ok_or_else(|| "RPC bridge is not running".to_string())?;
    bridge.request(params.method, params.params)
}

#[tauri::command]
fn rpc_stop(state: State<'_, RpcBridgeState>) -> Result<(), String> {
    let mut slot = state.bridge.lock().map_err(|_| "RPC state lock poisoned".to_string())?;
    *slot = None;
    Ok(())
}

#[tauri::command]
fn rpc_protocol_version() -> u16 {
    1
}

impl RpcBridge {
    fn request(&self, method: String, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let payload = match params {
            Some(params) => json!({ "id": id, "method": method, "params": params }),
            None => json!({ "id": id, "method": method }),
        };
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "RPC pending lock poisoned".to_string())?
            .insert(id, tx);

        let write_result = self
            .stdin
            .lock()
            .map_err(|_| "RPC stdin lock poisoned".to_string())
            .and_then(|mut stdin| {
                writeln!(stdin, "{payload}").map_err(|error| format!("Failed to write RPC request: {error}"))?;
                stdin.flush().map_err(|error| format!("Failed to flush RPC request: {error}"))
            });

        if let Err(error) = write_result {
            let _ = self.pending.lock().map(|mut pending| pending.remove(&id));
            return Err(error);
        }

        rx.recv_timeout(Duration::from_secs(180))
            .map_err(|_| format!("RPC request timed out: {method}"))?
    }

    fn command_label(&self) -> String {
        "node dist/tui/cli.js --mode rpc".to_string()
    }
}

fn spawn_stdout_reader(
    app: AppHandle,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    stdout: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) if !line.trim().is_empty() => line,
                Ok(_) => continue,
                Err(error) => {
                    reject_all(&pending, format!("Failed to read RPC stdout: {error}"));
                    let _ = app.emit("argon-rpc-error", json!({ "message": error.to_string() }));
                    return;
                }
            };

            let message: Value = match serde_json::from_str(&line) {
                Ok(message) => message,
                Err(error) => {
                    let _ = app.emit(
                        "argon-rpc-error",
                        json!({ "message": format!("Invalid RPC JSON: {error}"), "line": line }),
                    );
                    continue;
                }
            };

            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                let sender = pending.lock().ok().and_then(|mut pending| pending.remove(&id));
                if let Some(sender) = sender {
                    let result = if let Some(error) = message.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("RPC request failed")
                            .to_string())
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
                continue;
            }

            let _ = app.emit("argon-rpc-notification", message);
        }
        reject_all(&pending, "Argon RPC process exited".to_string());
        let _ = app.emit("argon-rpc-error", json!({ "message": "Argon RPC process exited" }));
    });
}

fn spawn_stderr_reader(app: AppHandle, stderr: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit("argon-rpc-log", json!({ "stream": "stderr", "line": line }));
            }
        }
    });
}

fn reject_all(
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    message: String,
) {
    if let Ok(mut pending) = pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(message.clone()));
        }
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RpcBridgeState::default())
        .invoke_handler(tauri::generate_handler![
            rpc_protocol_version,
            rpc_start,
            rpc_request,
            rpc_stop
        ])
        .setup(|app| {
            let _ = app.handle().emit("argon-rpc-log", json!({ "stream": "gui", "line": "Argon GUI ready" }));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Argon desktop GUI");
}
