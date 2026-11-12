use crate::{
    backup,
    domain::*,
    files,
    model::{Runtime, SaveProvider},
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
    let changes = !matches!(&request, Request::Snapshot | Request::ValidateResume { .. });
    let result = match request {
        Request::Snapshot => {
            let (snapshot, path) = {
                let store = runtime.lock()?;
                (store.snapshot()?, store.root.to_string_lossy().into_owned())
            };
            Ok(
                json!({"state":snapshot,"providerStatus":runtime.provider_status()?,"dataDirectory":path}),
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
            let prepared = host
                .pending
                .lock()
                .map_err(|_| AppError::invalid("恢复预检状态异常。"))?
                .take()
                .ok_or_else(|| AppError::new("PREVIEW_REQUIRED", "请先重新选择备份并核对范围。"))?;
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
        let _ = app.emit("state-changed", json!({"contractVersion":CONTRACT_VERSION}));
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
            app.manage(Host {
                runtime,
                pending: Mutex::new(None),
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
