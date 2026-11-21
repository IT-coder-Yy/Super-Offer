use crate::{
    backup,
    browser::{BrowserCommand, BrowserEvent, BrowserHost},
    domain::*,
    files,
    interview::{InterviewCommand, InterviewHost},
    model::{Runtime, SaveProvider},
    source::{SourceCommand, SourceHost},
    store::Store,
    vault::SystemVault,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct Host {
    runtime: Result<Arc<Runtime>>,
    pending: Mutex<Option<backup::Prepared>>,
    browser: Option<Arc<BrowserHost>>,
    source: Arc<SourceHost>,
    interview: Arc<InterviewHost>,
    transitions: tokio::sync::RwLock<()>,
}
impl Host {
    fn activity(&self) -> Value {
        json!({"browser":self.browser.as_ref().is_some_and(|b| b.is_active()),"source":self.source.has_active(),"interview":self.interview.has_active()})
    }
    fn is_active(&self) -> bool {
        self.browser.as_ref().is_some_and(|b| b.is_active())
            || self.source.has_active()
            || self.interview.has_active()
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Snapshot,
    Mutate {
        dataset_id: String,
        operation_id: String,
        mutation: Mutation,
    },
    ValidateResume {
        name: String,
        bytes: Vec<u8>,
    },
    ImportAsset {
        dataset_id: String,
        name: String,
        bytes: Vec<u8>,
        asset_kind: AssetKind,
    },
    SaveProvider {
        dataset_id: String,
        config: SaveProvider,
    },
    StartTask {
        dataset_id: String,
        input: TaskInput,
    },
    CancelTask {
        dataset_id: String,
        task_id: String,
    },
    CancelContext {
        dataset_id: String,
        context_id: String,
    },
    Browser {
        dataset_id: String,
        command: BrowserCommand,
    },
    SourceSelect {
        dataset_id: String,
        is_directory: bool,
    },
    Source {
        dataset_id: String,
        command: SourceCommand,
    },
    Interview {
        dataset_id: String,
        command: InterviewCommand,
    },
    BackupCreate {
        include_audio: bool,
        include_source: bool,
    },
    BackupSaveAs {
        backup_id: String,
    },
    RestorePreview {
        bytes: Vec<u8>,
    },
    RestoreSelect,
    RestoreCancel,
    RestoreCommit {
        token: String,
        confirmed: bool,
        has_unsaved_edits: bool,
    },
    Exit {
        confirmed: bool,
    },
}
fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420))
}
#[cfg(test)]
mod tests {
    use super::local_url;
    #[test]
    fn ipc_origin_requires_exact_local_scheme_host_and_port() {
        for url in ["tauri://localhost/", "http://tauri.localhost/"] {
            assert!(local_url(&url.parse().unwrap()));
        }
        for url in [
            "https://example.test/",
            "http://tauri.localhost:9000/",
            "tauri://other/",
            "https://127.0.0.1:1420/",
        ] {
            assert!(!local_url(&url.parse().unwrap()));
        }
    }
}
#[tauri::command]
async fn request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: tauri::State<'_, Host>,
    request: Request,
) -> Result<Value> {
    if window.label() != "main"
        || !local_url(
            &window
                .url()
                .map_err(|_| AppError::new("AUTH_REQUIRED", "无法核对当前窗口。"))?,
        )
    {
        return Err(AppError::new("AUTH_REQUIRED", "此页面没有本地业务权限。"));
    }
    if matches!(&request, Request::Exit { confirmed: true }) && host.runtime.is_err() {
        app.exit(0);
        return Ok(json!(true));
    }
    let runtime = host.runtime.as_ref().map_err(Clone::clone)?;
    // 恢复独占数据集切换；其它请求可并发，停止不会被正在填写或导入的请求挡住。
    // 特别覆盖原生选择对话框尚未返回、或浏览器连接正在建立时的恢复竞态。
    let restoring = matches!(&request, Request::RestoreCommit { .. });
    let _restore_guard = if restoring {
        Some(host.transitions.try_write().map_err(|_| {
            AppError::new(
                "TASK_ACTIVE",
                "请先完成当前操作或关闭文件选择窗口，再恢复备份。",
            )
        })?)
    } else {
        None
    };
    let _request_guard = if restoring {
        None
    } else {
        Some(host.transitions.read().await)
    };
    let previous = {
        let store = runtime.lock()?;
        (
            store.dataset_id.clone(),
            crate::store::revision(&store.conn)?,
        )
    };
    let changes = !matches!(&request, Request::Snapshot | Request::ValidateResume { .. });
    let result = match request {
        Request::Snapshot => {
            let (snapshot, path) = {
                let store = runtime.lock()?;
                (store.snapshot()?, store.root.to_string_lossy().into_owned())
            };
            Ok(
                json!({"state":snapshot,"providerStatus":runtime.provider_status()?,"dataDirectory":path,"activity":host.activity()}),
            )
        }
        Request::Mutate {
            dataset_id,
            operation_id,
            mutation,
        } => runtime.lock()?.mutate(&operation_id, &dataset_id, mutation),
        Request::ValidateResume { name, bytes } => {
            files::validate_resume(&name, &bytes)?;
            Ok(json!(true))
        }
        Request::ImportAsset {
            dataset_id,
            name,
            bytes,
            asset_kind,
        } => Ok(serde_json::to_value(runtime.lock()?.import_asset(
            &dataset_id,
            &name,
            &bytes,
            asset_kind,
        )?)?),
        Request::SaveProvider { dataset_id, config } => Ok(serde_json::to_value(
            runtime.save_provider(&dataset_id, config)?,
        )?),
        Request::StartTask { dataset_id, input } => {
            Ok(serde_json::to_value(runtime.start(&dataset_id, input)?)?)
        }
        Request::CancelTask {
            dataset_id,
            task_id,
        } => Ok(serde_json::to_value(
            runtime.cancel(&dataset_id, &task_id)?,
        )?),
        Request::CancelContext {
            dataset_id,
            context_id,
        } => {
            runtime.cancel_context(&dataset_id, &context_id)?;
            Ok(json!(true))
        }
        Request::Browser {
            dataset_id,
            command,
        } => {
            host.browser
                .as_ref()
                .ok_or_else(|| AppError::new("BROWSER_FAILED", "浏览器服务不可用。"))?
                .handle(&dataset_id, command)
                .await
        }
        Request::SourceSelect {
            dataset_id,
            is_directory,
        } => {
            if runtime.lock()?.dataset_id != dataset_id {
                return Err(AppError::new("STALE_TASK", "数据集已经变化。"));
            }
            let dialog = app.dialog().file().set_title(if is_directory {
                "选择只读导入的项目目录"
            } else {
                "选择项目 ZIP"
            });
            let path = if is_directory {
                dialog.blocking_pick_folder()
            } else {
                dialog.add_filter("项目 ZIP", &["zip"]).blocking_pick_file()
            };
            match path {
                Some(path) => Ok(serde_json::to_value(
                    host.source.select(
                        &dataset_id,
                        path.into_path()
                            .map_err(|_| AppError::invalid("请选择本地项目。"))?,
                        is_directory,
                    )?,
                )?),
                None => Ok(Value::Null),
            }
        }
        Request::Source {
            dataset_id,
            command,
        } => {
            let source = Arc::clone(&host.source);
            let runtime = Arc::clone(runtime);
            tokio::task::spawn_blocking(move || source.handle(&runtime, &dataset_id, command))
                .await
                .map_err(|_| AppError::new("SOURCE_FAILED", "项目操作中断，已保存内容保留。"))?
        }
        Request::Interview {
            dataset_id,
            command,
        } => {
            let interview = Arc::clone(&host.interview);
            let runtime = Arc::clone(runtime);
            tokio::task::spawn_blocking(move || interview.handle(&runtime, &dataset_id, command))
                .await
                .map_err(|_| AppError::new("INTERVIEW_FAILED", "面试操作中断，已保存回答保留。"))?
        }
        Request::BackupCreate {
            include_audio,
            include_source,
        } => Ok(serde_json::to_value(backup::export(
            &*runtime.lock()?,
            include_audio,
            include_source,
        )?)?),
        Request::BackupSaveAs { backup_id } => {
            let destination = app
                .dialog()
                .file()
                .set_title("将备份另存为")
                .set_file_name("Super-Offer.superoffer")
                .add_filter("Super-Offer 备份", &["superoffer"])
                .blocking_save_file();
            if let Some(path) = destination {
                let path = path
                    .into_path()
                    .map_err(|_| AppError::invalid("请选择本地文件。"))?;
                backup::copy_backup(&*runtime.lock()?, &backup_id, &path)?;
                Ok(json!({"saved":true,"path":path.to_string_lossy()}))
            } else {
                Ok(json!({"saved":false}))
            }
        }
        Request::RestorePreview { bytes } => {
            let prepared = backup::prepare(&*runtime.lock()?, &bytes)?;
            let value = serde_json::to_value(&prepared.preview)?;
            *host
                .pending
                .lock()
                .map_err(|_| AppError::invalid("恢复预检状态异常。"))? = Some(prepared);
            Ok(value)
        }
        Request::RestoreSelect => {
            let selected = app
                .dialog()
                .file()
                .set_title("选择 Super-Offer 备份")
                .add_filter("Super-Offer 备份", &["superoffer"])
                .blocking_pick_file();
            if let Some(path) = selected {
                let prepared = backup::prepare_path(
                    &*runtime.lock()?,
                    &path
                        .into_path()
                        .map_err(|_| AppError::invalid("请选择本地备份。"))?,
                )?;
                let value = serde_json::to_value(&prepared.preview)?;
                *host
                    .pending
                    .lock()
                    .map_err(|_| AppError::invalid("恢复预检状态异常。"))? = Some(prepared);
                Ok(value)
            } else {
                Ok(Value::Null)
            }
        }
        Request::RestoreCancel => {
            host.pending
                .lock()
                .map_err(|_| AppError::invalid("恢复预检状态异常。"))?
                .take();
            Ok(json!(true))
        }
        Request::RestoreCommit {
            token,
            confirmed,
            has_unsaved_edits,
        } => {
            if host.is_active() {
                return Err(AppError::new(
                    "TASK_ACTIVE",
                    "请先停止填写、项目导入或面试生成，再恢复备份。",
                ));
            }
            let prepared = host
                .pending
                .lock()
                .map_err(|_| AppError::invalid("恢复预检状态异常。"))?
                .take()
                .ok_or_else(|| AppError::new("PREVIEW_REQUIRED", "请先重新选择备份并核对范围。"))?;
            if let Some(browser) = &host.browser {
                browser.shutdown()?;
            }
            host.source.cancel_all();
            host.interview.cancel_all();
            Ok(serde_json::to_value(backup::commit(
                &mut *runtime.lock()?,
                prepared,
                &token,
                confirmed,
                has_unsaved_edits,
            )?)?)
        }
        Request::Exit { confirmed } => {
            if !confirmed {
                return Err(AppError::new(
                    "CONFIRMATION_REQUIRED",
                    "请先处理未保存内容。",
                ));
            }
            if let Some(browser) = &host.browser {
                browser.shutdown()?;
            }
            host.source.cancel_all();
            host.interview.cancel_all();
            let (dataset, tasks) = {
                let store = runtime.lock()?;
                (store.dataset_id.clone(), store.snapshot()?.tasks)
            };
            for task in tasks.into_iter().filter(|t| t.status == "running") {
                runtime.cancel(&dataset, &task.id)?;
            }
            app.exit(0);
            Ok(json!(true))
        }
    };
    if let Err(error) = &result
        && let Ok(store) = runtime.lock()
    {
        store.log(&error.code);
    }
    if changes && result.is_ok() {
        let changed = {
            let store = runtime.lock()?;
            previous
                != (
                    store.dataset_id.clone(),
                    crate::store::revision(&store.conn)?,
                )
        };
        if changed {
            let _ = app.emit("state-changed", json!({"contractVersion":CONTRACT_VERSION}));
        }
    }
    result
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_root = std::env::var_os("SUPER_OFFER_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let handle = app.handle().clone();
            let runtime = Store::open(data_root).map(|store| {
                Runtime::new(
                    store,
                    Arc::new(SystemVault),
                    Arc::new(move |task| {
                        let _ = handle.emit("model-task-updated", task);
                    }),
                )
            });
            let resources = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../.s0-work/browser-runtime")
            } else {
                app.path().resource_dir()?.join("browser-runtime")
            };
            let handle = app.handle().clone();
            let browser = runtime.as_ref().ok().map(|runtime| {
                BrowserHost::new(
                    Arc::clone(runtime),
                    resources.join(if cfg!(windows) { "node.exe" } else { "node" }),
                    resources.join("browser/host.mjs"),
                    Arc::new(move |event| {
                        match event {
                            BrowserEvent::Ready => {
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.minimize();
                                }
                            }
                            BrowserEvent::Return => {
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.unminimize();
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            BrowserEvent::Changed => {}
                        }
                        let _ = handle
                            .emit("state-changed", json!({"contractVersion":CONTRACT_VERSION}));
                    }),
                )
            });
            app.manage(Host {
                runtime,
                pending: Mutex::new(None),
                browser,
                source: Arc::new(SourceHost::new()),
                interview: Arc::new(InterviewHost::new()),
                transitions: tokio::sync::RwLock::new(()),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("request-close", ());
            }
        })
        .invoke_handler(tauri::generate_handler![request])
        .run(tauri::generate_context!())
        .expect("无法启动桌面窗口");
}
