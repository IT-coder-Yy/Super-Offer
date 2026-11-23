use crate::{
    domain::*,
    store::{Store, bump, get, list, put},
    vault::Vault,
};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use zeroize::Zeroizing;

type Observer = Arc<dyn Fn(&ModelTask) + Send + Sync>;
fn validate_versions(conn: &rusqlite::Connection, versions: &[VersionRef]) -> Result<()> {
    for reference in versions {
        match reference.kind.as_str() {
            "profile_version" => {
                let _: ProfileVersion = get(conn, "profile_versions", &reference.id)?;
            }
            "job_snapshot" => {
                let _: JobSnapshot = get(conn, "jobs", &reference.id)?;
            }
            "asset" => {
                let _: FileAsset = get(conn, "assets", &reference.id)?;
            }
            _ if crate::source::validate_reference(conn, &reference.kind, &reference.id)?
                || crate::interview::validate_reference(conn, &reference.kind, &reference.id)? => {}
            _ => return Err(AppError::invalid("不支持的输入版本类型。")),
        }
    }
    Ok(())
}
pub struct Runtime {
    pub store: Mutex<Store>,
    pub vault: Arc<dyn Vault>,
    workers: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    observer: Observer,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub purpose: Purpose,
    pub has_key: bool,
    pub error: Option<AppError>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProvider {
    pub purpose: Purpose,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub expected_version: Option<String>,
    pub key: Option<String>,
    pub remove_key: bool,
}
impl Runtime {
    pub fn new(store: Store, vault: Arc<dyn Vault>, observer: Observer) -> Arc<Self> {
        Arc::new(Self {
            store: Mutex::new(store),
            vault,
            workers: Mutex::new(HashMap::new()),
            observer,
        })
    }
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, Store>> {
        self.store
            .lock()
            .map_err(|_| AppError::new("WRITE_FAILED", "数据状态异常，请先退出并重新打开应用。"))
    }
    pub fn slot(store: &Store, provider: &ProviderConfig) -> String {
        // 同机升级保留本地命名空间；外部恢复另建，不能复用原凭证。
        format!(
            "{}:{}:{}",
            store.credential_namespace,
            provider.purpose.key(),
            provider.version
        )
    }
    pub fn provider_status(&self) -> Result<Vec<ProviderStatus>> {
        let store = self.lock()?;
        Ok(list::<ProviderConfig>(&store.conn, "providers")?
            .into_iter()
            .map(|p| match self.vault.get(&Self::slot(&store, &p)) {
                Ok(key) => ProviderStatus {
                    purpose: p.purpose,
                    has_key: key.is_some(),
                    error: None,
                },
                Err(error) => ProviderStatus {
                    purpose: p.purpose,
                    has_key: false,
                    error: Some(error),
                },
            })
            .collect())
    }
    pub fn save_provider(&self, dataset: &str, request: SaveProvider) -> Result<ProviderConfig> {
        let mut store = self.lock()?;
        if store.dataset_id != dataset {
            return Err(AppError::new("STALE_TASK", "数据已恢复，请重新加载配置。"));
        }
        let prior = list::<ProviderConfig>(&store.conn, "providers")?
            .into_iter()
            .find(|p| p.purpose == request.purpose);
        if prior.as_ref().map(|p| &p.version) != request.expected_version.as_ref() {
            return Err(AppError::new(
                "VERSION_CONFLICT",
                "服务配置已变化，请刷新后保存。",
            ));
        }
        let config = ProviderConfig {
            purpose: request.purpose,
            name: request.name,
            endpoint: request.endpoint,
            model: request.model,
            version: id(),
        };
        config.validate()?;
        let prior_slot = prior.as_ref().map(|p| Self::slot(&store, p));
        let prior_secret = prior_slot
            .as_ref()
            .map(|slot| self.vault.get(slot))
            .transpose()?
            .flatten()
            .map(Zeroizing::new);
        let secret = if request.remove_key {
            None
        } else if let Some(key) = request.key.filter(|k| !k.is_empty()) {
            if key.len() > 8192 || key.contains(['\r', '\n', '\0']) {
                return Err(AppError::invalid("Key 格式不正确。"));
            }
            Some(Zeroizing::new(key))
        } else {
            prior_secret.clone()
        };
        let slot = Self::slot(&store, &config);
        let mut old_deleted = false;
        let mut new_written = false;
        let result = (|| {
            let tx = store.conn.transaction()?;
            put(&tx, "providers", config.purpose.key(), &config)?;
            bump(&tx)?;
            // 先确认旧凭证可删除，再写新凭证；失败时原配置仍可用于重试。
            if let Some(prior_slot) = &prior_slot {
                self.vault.delete(prior_slot)?;
                old_deleted = true;
            }
            if let Some(secret) = &secret {
                self.vault.set(&slot, secret)?;
                new_written = true;
            }
            tx.commit()?;
            Ok::<_, AppError>(())
        })();
        if let Err(error) = result {
            let mut recovery_failed = false;
            if new_written {
                recovery_failed |= self.vault.delete(&slot).is_err();
            }
            if old_deleted {
                if let (Some(slot), Some(secret)) = (&prior_slot, &prior_secret) {
                    recovery_failed |= self.vault.set(slot, secret).is_err();
                }
            }
            if recovery_failed {
                return Err(AppError::new(
                    "KEY_RECOVERY_FAILED",
                    "配置未保存，且凭证回滚未完成。请检查系统凭证服务，重新配置 Key 并核对残留凭证。",
                ));
            }
            return Err(error);
        }
        Ok(config)
    }
    pub fn cancel(&self, dataset: &str, task_id: &str) -> Result<ModelTask> {
        let task = {
            let mut store = self.lock()?;
            if store.dataset_id != dataset {
                return Err(AppError::new("STALE_TASK", "数据集已经变化。"));
            }
            let mut task: ModelTask = get(&store.conn, "tasks", task_id)?;
            if task.status == "running" {
                task.status = "cancelled".into();
                task.progress = "已停止，已有内容保留。".into();
                task.updated_at = now();
                let tx = store.conn.transaction()?;
                put(&tx, "tasks", &task.id, &task)?;
                bump(&tx)?;
                tx.commit()?;
            }
            store.withhold_simulation_output(std::slice::from_mut(&mut task))?;
            task
        };
        if let Ok(mut workers) = self.workers.lock()
            && let Some(worker) = workers.remove(task_id)
        {
            worker.abort();
        }
        (self.observer)(&task);
        Ok(task)
    }
    pub fn cancel_context(&self, dataset: &str, context: &str) -> Result<()> {
        let ids = {
            let store = self.lock()?;
            list::<ModelTask>(&store.conn, "tasks")?
                .into_iter()
                .filter(|t| t.context_id == context && t.status == "running")
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };
        for id in ids {
            self.cancel(dataset, &id)?;
        }
        Ok(())
    }
    pub fn start(self: &Arc<Self>, dataset: &str, input: TaskInput) -> Result<ModelTask> {
        self.start_with_provider(dataset, input, None)
    }
    pub(crate) fn start_with_provider(
        self: &Arc<Self>,
        dataset: &str,
        input: TaskInput,
        expected_version: Option<&str>,
    ) -> Result<ModelTask> {
        text(&input.context_id, "任务上下文", true, 200)?;
        text(
            &input.text,
            "发送内容",
            input.purpose == Purpose::Chat,
            MAX_TEXT,
        )?;
        let (task, key, audio, replaced) = {
            let mut store = self.lock()?;
            if store.dataset_id != dataset {
                return Err(AppError::new(
                    "STALE_TASK",
                    "数据已整体恢复，请重新发起任务。",
                ));
            }
            let provider: ProviderConfig = get(&store.conn, "providers", input.purpose.key())
                .map_err(|_| AppError::new("CONFIG_REQUIRED", "请先保存对应服务配置。"))?;
            if expected_version.is_some_and(|version| version != provider.version) {
                return Err(AppError::new(
                    "PROVIDER_CHANGED",
                    "聊天配置已改变，请确认本场使用的服务与外发范围后再继续。",
                ));
            }
            provider.validate()?;
            let key = Zeroizing::new(self.vault.get(&Self::slot(&store, &provider))?.ok_or_else(
                || AppError::new("KEY_REQUIRED", "此服务尚未配置 Key，请在设置中填写。"),
            )?);
            validate_versions(&store.conn, &input.versions)?;
            let audio = if input.purpose == Purpose::Asr {
                let (asset, bytes) = store.read_asset(
                    input
                        .asset_id
                        .as_deref()
                        .ok_or_else(|| AppError::invalid("请先选择测试音频。"))?,
                )?;
                if asset.kind != AssetKind::Audio {
                    return Err(AppError::invalid("所选材料不是音频。"));
                }
                Some((asset, bytes))
            } else {
                None
            };
            let task = ModelTask {
                id: id(),
                context_id: input.context_id.clone(),
                generation: id(),
                dataset_id: dataset.into(),
                purpose: input.purpose,
                provider,
                versions: input.versions.clone(),
                input: input.clone(),
                status: "running".into(),
                progress: "正在连接服务…".into(),
                content: String::new(),
                usage: Usage::default(),
                error: None,
                started_at: now(),
                updated_at: now(),
            };
            let mut replaced = Vec::new();
            let tx = store.conn.transaction()?;
            for mut old in list::<ModelTask>(&tx, "tasks")? {
                if old.context_id == input.context_id && old.status == "running" {
                    replaced.push(old.id.clone());
                    old.status = "cancelled".into();
                    old.progress = "已由新任务替换，已有内容保留。".into();
                    old.updated_at = now();
                    put(&tx, "tasks", &old.id, &old)?;
                }
            }
            put(&tx, "tasks", &task.id, &task)?;
            bump(&tx)?;
            tx.commit()?;
            (task, key, audio, replaced)
        };
        if let Ok(mut workers) = self.workers.lock() {
            for id in replaced {
                if let Some(worker) = workers.remove(&id) {
                    worker.abort();
                }
            }
        }
        (self.observer)(&task);
        let runtime = Arc::clone(self);
        let running = task.clone();
        let (ready, registered) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            if registered.await.is_err() {
                return;
            }
            if let Err(error) = runtime.request(&running, input, key, audio).await {
                let _ = runtime.change_task(&running, |task| {
                    task.status = "failed".into();
                    task.progress = error.message.clone();
                    task.error = Some(error.clone());
                });
                if let Ok(store) = runtime.lock() {
                    store.log(&error.code);
                }
            }
        });
        if let Ok(mut workers) = self.workers.lock() {
            workers.retain(|_, h| !h.is_finished());
            workers.insert(task.id.clone(), worker);
            let _ = ready.send(());
        } else {
            worker.abort();
            let _ = self.cancel(dataset, &task.id);
            return Err(AppError::new(
                "TASK_FAILED",
                "任务工作器不可用，尚未发起网络请求。",
            ));
        }
        Ok(task)
    }
    pub(crate) fn change_task(
        &self,
        identity: &ModelTask,
        change: impl FnOnce(&mut ModelTask),
    ) -> Result<bool> {
        let (updated, allowed) = {
            let mut store = self.lock()?;
            if store.dataset_id != identity.dataset_id {
                return Ok(false);
            }
            let mut task: ModelTask = get(&store.conn, "tasks", &identity.id)?;
            if task.generation != identity.generation || task.status != "running" {
                return Ok(false);
            }
            // 固定材料在发起前已校验。流式接收时只需复核可被撤回的授权。
            let validation = task
                .versions
                .iter()
                .filter(|reference| reference.kind == "source_scope")
                .try_for_each(|reference| {
                    crate::source::validate_reference(&store.conn, &reference.kind, &reference.id)
                        .map(|_| ())
                });
            let allowed = validation.is_ok();
            if let Err(error) = validation {
                task.status = "cancelled".into();
                task.progress = "输入依据或授权已变化，任务停止，已有内容保留。".into();
                task.error = Some(error);
            } else {
                change(&mut task);
            }
            task.updated_at = now();
            let tx = store.conn.transaction()?;
            put(&tx, "tasks", &task.id, &task)?;
            bump(&tx)?;
            tx.commit()?;
            store.withhold_simulation_output(std::slice::from_mut(&mut task))?;
            (task, allowed)
        };
        (self.observer)(&updated);
        Ok(allowed)
    }
    async fn request(
        &self,
        identity: &ModelTask,
        input: TaskInput,
        key: Zeroizing<String>,
        audio: Option<(FileAsset, Vec<u8>)>,
    ) -> Result<()> {
        if !self.change_task(identity, |_| {})? {
            return Ok(());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| service("无法初始化网络连接。"))?;
        let mut request = client
            .post(&identity.provider.endpoint)
            .bearer_auth(key.as_str());
        if let Some((asset, bytes)) = audio {
            let mime = match asset
                .name
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_lowercase()
                .as_str()
            {
                "wav" => "audio/wav",
                "m4a" => "audio/mp4",
                _ => "audio/mpeg",
            };
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(asset.name)
                .mime_str(mime)
                .map_err(|_| AppError::invalid("音频类型不正确。"))?;
            request = request.multipart(
                reqwest::multipart::Form::new()
                    .text("model", identity.provider.model.clone())
                    .part("file", part),
            );
        } else {
            let mut body = json!({"model":identity.provider.model,"messages":[{"role":"user","content":input.text}],"stream":input.stream});
            if input.stream {
                body["stream_options"] = json!({"include_usage":true});
            }
            request = request.json(&body);
        }
        if !self.change_task(identity, |_| {})? {
            return Ok(());
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(AppError::new(
                match status {
                    401 | 403 => "SERVICE_AUTH",
                    429 => "SERVICE_RATE_LIMIT",
                    _ => "SERVICE_FAILED",
                },
                match status {
                    401 | 403 => "服务拒绝凭证，请检查 Key 与接口地址。",
                    429 => "服务商限流或额度不足。已有内容保留，请稍后手动重试。",
                    300..=399 => "服务返回重定向，未转发凭证。请填写最终接口地址。",
                    _ => "服务返回错误，已有内容保留，请检查配置后手动重试。",
                },
            ));
        }
        if !self.change_task(identity, |t| t.progress = "正在接收结果…".into())? {
            return Ok(());
        }
        if input.purpose == Purpose::Chat && input.stream {
            let mut received = 0usize;
            let bytes = response.bytes_stream().map(move |part| {
                let part = part.map_err(network_error)?;
                received += part.len();
                if received > 16 * 1024 * 1024 {
                    return Err(service("响应超过 16 MB，已停止接收；已有内容保留。"));
                }
                Ok(part)
            });
            let mut events = Box::pin(bytes.eventsource());
            let mut terminal = false;
            while let Some(event) = events.next().await {
                let event = event.map_err(|_| service("流式连接中断或格式错误，已有内容保留。"))?;
                if event.data.trim() == "[DONE]" {
                    terminal = true;
                    break;
                }
                let payload: Value = serde_json::from_str(&event.data)
                    .map_err(|_| service("服务返回了无法解析的流式消息。"))?;
                if payload.get("error").is_some() {
                    return Err(service("服务在响应中报告错误，已有内容保留。"));
                }
                if !self.change_task(identity, |t| {
                    if let Some(content) = payload
                        .pointer("/choices/0/delta/content")
                        .and_then(Value::as_str)
                    {
                        t.content.push_str(content);
                    }
                    apply_usage(t, &payload);
                })? {
                    return Ok(());
                }
            }
            if !terminal {
                return Err(service("服务流未正常结束，已有内容保留，请手动重试。"));
            }
        } else {
            let mut stream = response.bytes_stream();
            let mut body = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(network_error)?;
                if body.len() + chunk.len() > 16 * 1024 * 1024 {
                    return Err(service("服务响应超过 16 MB。"));
                }
                body.extend_from_slice(&chunk);
            }
            let payload: Value = serde_json::from_slice(&body)
                .map_err(|_| service("服务返回的内容不是有效 JSON。"))?;
            let content = if input.purpose == Purpose::Asr {
                payload.get("text")
            } else {
                payload.pointer("/choices/0/message/content")
            }
            .and_then(Value::as_str)
            .ok_or_else(|| service("服务响应缺少文字结果，请核对接口协议。"))?;
            if !self.change_task(identity, |t| {
                t.content = content.into();
                apply_usage(t, &payload);
            })? {
                return Ok(());
            }
        }
        self.change_task(identity, |t| {
            t.status = "completed".into();
            t.progress = if t.purpose == Purpose::Asr {
                "转写结果未经校对；此接口测试不代表真实识别效果或完整音频覆盖。"
            } else {
                "已完成"
            }
            .into();
        })?;
        Ok(())
    }
}
fn service(message: &str) -> AppError {
    AppError::new("SERVICE_FAILED", message)
}
fn network_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new(
            "SERVICE_TIMEOUT",
            "服务连接超时，已有内容保留，请手动重试。",
        )
    } else {
        service("网络请求失败，请检查接口地址和网络后手动重试。")
    }
}
fn apply_usage(task: &mut ModelTask, payload: &Value) {
    if let Some(usage) = payload.get("usage") {
        if let Some(n) = usage.get("prompt_tokens").and_then(Value::as_u64) {
            task.usage.input_tokens = Some(n);
        }
        if let Some(n) = usage.get("completion_tokens").and_then(Value::as_u64) {
            task.usage.output_tokens = Some(n);
        }
        if let Some(n) = usage.get("total_tokens").and_then(Value::as_u64) {
            task.usage.total_tokens = Some(n);
        }
        if let Some(n) = usage
            .get("audio_seconds")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            task.usage.audio_seconds = Some(n);
        }
    }
}
