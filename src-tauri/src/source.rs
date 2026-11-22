use crate::{
    domain::*,
    model::Runtime,
    safe_fs::{Entry, SafeDir},
    store::{Store, bump, digest, encode, get, list},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub const MAX_FILES: usize = 20_000;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub asset_id: String,
    pub created_at: String,
    pub readable_files: usize,
    pub total_files: usize,
    pub source_bytes: u64,
    pub scope_version: String,
    pub allowed_paths: Vec<String>,
    pub scope_history: Vec<ScopeGrant>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeGrant {
    pub id: String,
    pub paths: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFile {
    pub id: String,
    pub source_version_id: String,
    pub path: String,
    pub status: String,
    pub reason: String,
    pub bytes: u64,
    pub sha256: String,
    pub lines: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub source_version_id: String,
    pub path: String,
    pub file_sha256: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub token: String,
    pub name: String,
    pub is_directory: bool,
}
struct Selected {
    dataset: String,
    input: SelectedInput,
}
enum SelectedInput {
    Directory(SafeDir),
    Zip(fs::File),
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceCommand {
    List,
    Files {
        version_id: String,
        offset: usize,
    },
    Import {
        token: String,
        project_id: Option<String>,
        name: String,
        operation_id: String,
    },
    Cancel {
        token: String,
    },
    Search {
        version_id: String,
        query: String,
        token: String,
    },
    Evidence {
        id: String,
    },
    SetScope {
        version_id: String,
        expected_scope_version: String,
        paths: Vec<String>,
        confirmed: bool,
    },
    Cleanup {
        version_id: String,
        confirmed: bool,
    },
}
#[derive(Default)]
struct SourceOperations {
    selected: HashMap<String, Selected>,
    active: HashMap<String, Arc<AtomicBool>>,
}
#[derive(Default)]
pub struct SourceHost {
    operations: Mutex<SourceOperations>,
}
impl SourceHost {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn select(&self, dataset: &str, path: PathBuf, is_directory: bool) -> Result<Selection> {
        let token = id();
        let name = path
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| "项目".into());
        let input = if is_directory {
            SelectedInput::Directory(SafeDir::open_root(&path)?)
        } else {
            let parent = path
                .parent()
                .ok_or_else(|| AppError::invalid("请选择本地ZIP文件。"))?;
            let leaf = path
                .file_name()
                .ok_or_else(|| AppError::invalid("ZIP文件名不正确。"))?;
            match SafeDir::open_root(parent)?.open_child(leaf)? {
                Entry::File(file) => SelectedInput::Zip(file),
                Entry::Directory(_) => return Err(AppError::invalid("请选择ZIP文件。")),
            }
        };
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| AppError::invalid("选择状态异常。"))?;
        let choices = &mut operations.selected;
        if choices.len() >= 8 {
            choices.clear();
        }
        choices.insert(
            token.clone(),
            Selected {
                dataset: dataset.into(),
                input,
            },
        );
        Ok(Selection {
            token,
            name,
            is_directory,
        })
    }
    pub fn has_active(&self) -> bool {
        self.operations
            .lock()
            .map(|v| !v.active.is_empty())
            .unwrap_or(true)
    }
    pub fn cancel_all(&self) {
        if let Ok(mut operations) = self.operations.lock() {
            for flag in operations.active.values() {
                flag.store(true, Ordering::SeqCst);
            }
            operations.selected.clear();
        }
    }
    fn claim_import(&self, dataset: &str, token: &str) -> Result<(Selected, Arc<AtomicBool>)> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| AppError::invalid("导入状态异常。"))?;
        if operations.active.contains_key(token) {
            return Err(AppError::new(
                "OPERATION_ACTIVE",
                "该项目操作仍在进行，请等待结束或停止。",
            ));
        }
        let selected = operations
            .selected
            .remove(token)
            .ok_or_else(|| AppError::new("SELECTION_REQUIRED", "请重新选择项目目录或ZIP。"))?;
        if selected.dataset != dataset {
            return Err(AppError::new(
                "STALE_TASK",
                "选择属于旧数据集，请重新选择。",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        operations
            .active
            .insert(token.into(), Arc::clone(&cancelled));
        Ok((selected, cancelled))
    }
    pub fn handle(
        self: &Arc<Self>,
        runtime: &Arc<Runtime>,
        dataset: &str,
        command: SourceCommand,
    ) -> Result<Value> {
        if let SourceCommand::Cancel { token } = &command {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| AppError::invalid("导入状态异常。"))?;
            if let Some(flag) = operations.active.get(token) {
                flag.store(true, Ordering::SeqCst);
            }
            operations.selected.remove(token);
            return Ok(json!(true));
        }
        if !matches!(&command, SourceCommand::Search { .. }) {
            check_dataset(&*runtime.lock()?, dataset)?;
        }
        match command {
            SourceCommand::List => {
                let store = runtime.lock()?;
                let mut versions = list::<SourceVersion>(&store.conn, "source_versions")?;
                versions.reverse();
                Ok(json!({ "versions": versions, "limits": {
                    "files": MAX_FILES, "fileBytes": MAX_FILE_BYTES, "totalBytes": MAX_SOURCE_BYTES,
                    "encoding": "UTF-8、带BOM的UTF-16；超限或不可读文件逐项列出"
                }}))
            }
            SourceCommand::Files { version_id, offset } => {
                let store = runtime.lock()?;
                let _: SourceVersion = get(&store.conn, "source_versions", &version_id)?;
                let mut stmt = store.conn.prepare("SELECT data FROM source_files WHERE source_version_id=?1 ORDER BY rowid LIMIT 200 OFFSET ?2")?;
                let rows = stmt
                    .query_map(
                        params![version_id, i64::try_from(offset).unwrap_or(i64::MAX)],
                        |r| r.get::<_, String>(0),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let rows = rows
                    .into_iter()
                    .map(|x| serde_json::from_str::<SourceFile>(&x))
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(json!(rows))
            }
            SourceCommand::Import {
                token,
                project_id,
                name,
                operation_id,
            } => {
                text(&name, "项目名称", true, 200)?;
                text(&operation_id, "操作标识", true, 100)?;
                let request_hash = digest(encode(&json!([project_id, name, token]))?.as_bytes());
                {
                    let store = runtime.lock()?;
                    if let Some(prior) = prior_operation(&store.conn, &operation_id, &request_hash)?
                    {
                        return Ok(prior);
                    }
                }
                let (selected, cancelled) = self.claim_import(dataset, &token)?;
                let result = (|| {
                    check_cancel(&cancelled)?;
                    let prepared = match selected.input {
                        SelectedInput::Directory(root) => read_directory(&root, &cancelled)?,
                        SelectedInput::Zip(file) => read_zip(file, &cancelled)?,
                    };
                    check_cancel(&cancelled)?;
                    let mut store = runtime.lock()?;
                    check_dataset(&store, dataset)?;
                    save_import(
                        &mut store,
                        prepared,
                        &name,
                        project_id.as_deref(),
                        &operation_id,
                        &request_hash,
                        &cancelled,
                    )
                })();
                if let Ok(mut operations) = self.operations.lock() {
                    operations.active.remove(&token);
                }
                result
            }
            SourceCommand::Cancel { .. } => Ok(json!(true)),
            SourceCommand::Search {
                version_id,
                query,
                token,
            } => {
                text(&token, "检索标识", true, 100)?;
                let flag = Arc::new(AtomicBool::new(false));
                {
                    let mut operations = self
                        .operations
                        .lock()
                        .map_err(|_| AppError::invalid("检索状态异常。"))?;
                    if operations.active.contains_key(&token)
                        || operations.selected.contains_key(&token)
                    {
                        return Err(AppError::new(
                            "OPERATION_ACTIVE",
                            "该项目操作标识正在使用，请等待结束或使用新的检索标识。",
                        ));
                    }
                    operations.active.insert(token.clone(), Arc::clone(&flag));
                }
                let result = (|| {
                    let input = {
                        let store = runtime.lock()?;
                        check_dataset(&store, dataset)?;
                        check_cancel(&flag)?;
                        crate::retrieval::prepare(&store, &version_id)?
                    };
                    let hits = crate::retrieval::scan(&input, &query, 20, false, &flag)?;
                    let store = runtime.lock()?;
                    check_dataset(&store, dataset)?;
                    check_cancel(&flag)?;
                    crate::retrieval::persist(&store.conn, &hits)?;
                    Ok(json!(hits))
                })();
                if let Ok(mut operations) = self.operations.lock() {
                    operations.active.remove(&token);
                }
                result
            }
            SourceCommand::Evidence { id } => {
                let store = runtime.lock()?;
                let evidence: Evidence = get(&store.conn, "evidence", &id)?;
                validate_evidence(&store.conn, &evidence)?;
                Ok(json!(evidence))
            }
            SourceCommand::SetScope {
                version_id,
                expected_scope_version,
                paths,
                confirmed,
            } => {
                let (version, cancel_ids) = {
                    let mut store = runtime.lock()?;
                    let tx = store.conn.transaction()?;
                    let mut version: SourceVersion = get(&tx, "source_versions", &version_id)?;
                    if version.scope_version != expected_scope_version {
                        return Err(AppError::new(
                            "VERSION_CONFLICT",
                            "授权范围已改变，请重新核对。",
                        ));
                    }
                    if !paths.is_empty() && !confirmed {
                        return Err(AppError::new(
                            "CONFIRMATION_REQUIRED",
                            "请先确认可外发范围。",
                        ));
                    }
                    if paths.len() > MAX_FILES {
                        return Err(AppError::invalid("外发范围条目过多。"));
                    }
                    let files = files_for(&tx, &version_id)?;
                    for path in &paths {
                        if path != "*"
                            && !files.iter().any(|f| {
                                f.status == "readable"
                                    && (f.path == *path
                                        || (path.ends_with('/') && f.path.starts_with(path)))
                            })
                        {
                            return Err(AppError::invalid("范围只能包含已读取的文件或目录。"));
                        }
                    }
                    let old_scope = format!("{}:{}", version.id, version.scope_version);
                    version.scope_version = id();
                    version.allowed_paths = paths;
                    version.scope_history.push(ScopeGrant {
                        id: version.scope_version.clone(),
                        paths: version.allowed_paths.clone(),
                    });
                    tx.execute(
                        "UPDATE source_versions SET data=?2 WHERE id=?1",
                        params![version.id, encode(&version)?],
                    )?;
                    let cancel_ids = list::<ModelTask>(&tx, "tasks")?
                        .into_iter()
                        .filter(|t| {
                            t.status == "running"
                                && t.versions
                                    .iter()
                                    .any(|v| v.kind == "source_scope" && v.id == old_scope)
                        })
                        .map(|t| t.id)
                        .collect::<Vec<_>>();
                    bump(&tx)?;
                    tx.commit()?;
                    (version, cancel_ids)
                };
                for task_id in cancel_ids {
                    runtime.cancel(dataset, &task_id)?;
                }
                Ok(json!(version))
            }
            SourceCommand::Cleanup {
                version_id,
                confirmed,
            } => {
                if !confirmed {
                    return Err(AppError::new(
                        "CONFIRMATION_REQUIRED",
                        "清理后仅保留引用片段；重新分析完整项目需重新导入。",
                    ));
                }
                let mut store = runtime.lock()?;
                Ok(json!(cleanup_material(&mut store, &version_id, |path| {
                    fs::remove_file(path)
                })?))
            }
        }
    }
}

fn cleanup_material(
    store: &mut Store,
    version_id: &str,
    remove_file: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<FileAsset> {
    let mut version: SourceVersion = get(&store.conn, "source_versions", version_id)?;
    if list::<ModelTask>(&store.conn, "tasks")?.iter().any(|t| {
        t.status == "running"
            && t.versions
                .iter()
                .any(|v| v.kind == "source_version" && v.id == version_id)
    }) {
        return Err(AppError::new(
            "TASK_ACTIVE",
            "材料正在使用，请先停止相关任务。",
        ));
    }
    let mut asset: FileAsset = get(&store.conn, "assets", &version.asset_id)?;
    let original = if asset.status == AssetStatus::Available {
        Some(store.asset_path(&asset)?)
    } else {
        None
    };
    let staged = original
        .as_ref()
        .map(|p| p.with_file_name(format!(".cleanup-{}", id())));
    if let (Some(original), Some(staged)) = (&original, &staged) {
        fs::rename(original, staged)
            .map_err(|_| AppError::new("FILE_FAILED", "副本未清理成功，状态和原件保持不变。"))?;
    }
    asset.status = AssetStatus::Cleaned;
    let saved = (|| {
        let tx = store.conn.transaction()?;
        crate::store::put(&tx, "assets", &asset.id, &asset)?;
        version.scope_version = id();
        version.allowed_paths.clear();
        version.scope_history.push(ScopeGrant {
            id: version.scope_version.clone(),
            paths: vec![],
        });
        tx.execute(
            "UPDATE source_versions SET data=?2 WHERE id=?1",
            params![version.id, encode(&version)?],
        )?;
        bump(&tx)?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })();
    if let Err(error) = saved {
        if let (Some(original), Some(staged)) = (&original, &staged) {
            fs::rename(staged, original)?;
        }
        return Err(error);
    }
    if let (Some(staged), Some(original)) = (staged, original) {
        if remove_file(&staged).is_err() {
            fs::rename(&staged, &original).map_err(|_| {
                AppError::new(
                    "RECOVERY_REQUIRED",
                    "清理失败且副本未归位，请保留数据目录以便恢复。",
                )
            })?;
            asset.status = AssetStatus::Available;
            let tx = store.conn.transaction()?;
            crate::store::put(&tx, "assets", &asset.id, &asset)?;
            bump(&tx)?;
            tx.commit()?;
            return Err(AppError::new(
                "FILE_FAILED",
                "清理失败，完整副本已恢复可用；外发授权已撤回，可稍后重试清理。",
            ));
        }
    }
    Ok(asset)
}

pub(crate) fn check_dataset(store: &Store, dataset: &str) -> Result<()> {
    if store.dataset_id != dataset {
        Err(AppError::new(
            "STALE_TASK",
            "数据集已改变，请重新打开当前页面。",
        ))
    } else {
        Ok(())
    }
}
fn check_cancel(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::SeqCst) {
        Err(AppError::new(
            "CANCELLED",
            "项目导入已停止，未保存未完成版本。",
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn prior_operation(
    conn: &Connection,
    operation: &str,
    hash: &str,
) -> Result<Option<Value>> {
    let prior: Option<(String, String)> = conn
        .query_row(
            "SELECT request_hash,result FROM operations WHERE id=?1",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match prior {
        Some((h, _)) if h != hash => Err(AppError::new(
            "OPERATION_CONFLICT",
            "同一操作标识不能用于不同内容。",
        )),
        Some((_, value)) => Ok(Some(serde_json::from_str(&value)?)),
        None => Ok(None),
    }
}
pub fn files_for(conn: &Connection, version_id: &str) -> Result<Vec<SourceFile>> {
    let mut stmt =
        conn.prepare("SELECT data FROM source_files WHERE source_version_id=?1 ORDER BY rowid")?;
    let raw = stmt
        .query_map([version_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .collect()
}
pub fn allows(version: &SourceVersion, path: &str) -> bool {
    version
        .allowed_paths
        .iter()
        .any(|p| p == "*" || p == path || (p.ends_with('/') && path.starts_with(p)))
}
pub fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err(AppError::invalid("UTF-16文件长度不正确。"));
        }
        let little = bytes[0] == 0xff;
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|x| {
                if little {
                    u16::from_le_bytes([x[0], x[1]])
                } else {
                    u16::from_be_bytes([x[0], x[1]])
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16(&units).map_err(|_| AppError::invalid("UTF-16文件含无效字符。"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if bytes.contains(&0) {
        return Err(AppError::invalid("二进制文件未作为源码读取。"));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::invalid("此文件不是支持的UTF-8或带BOM的UTF-16。"))
}
pub fn safe_relative(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 2048
        && !name.starts_with('/')
        && !name.contains(['\\', ':'])
        && !name.chars().any(char::is_control)
        && name
            .trim_end_matches('/')
            .split('/')
            .all(|x| !x.is_empty() && x != "." && x != "..")
}
pub fn excluded(path: &str) -> Option<&'static str> {
    let parts = path.split('/').map(str::to_lowercase).collect::<Vec<_>>();
    if parts.iter().any(|p| {
        [
            ".git",
            ".svn",
            ".hg",
            "node_modules",
            "target",
            "dist",
            "build",
            ".next",
            ".venv",
            "venv",
            "__pycache__",
            "vendor",
            "coverage",
            ".s0-work",
            ".test-runs",
            ".codex-run",
            ".agent-runs",
            ".pytest_cache",
            ".mypy_cache",
            ".ruff_cache",
            ".cache",
            "output",
            "outputs",
            "logs",
            "test-results",
            "playwright-report",
        ]
        .contains(&p.as_str())
    }) {
        return Some("默认排除版本历史、依赖或构建目录");
    }
    let name = parts.last().map(String::as_str).unwrap_or("");
    if name.ends_with(".log")
        || name.rsplit_once(".log.").is_some_and(|(_, suffix)| {
            !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
        })
    {
        return Some("默认排除运行日志");
    }
    if name == ".env"
        || name.starts_with(".env.")
        || [
            "id_rsa",
            "id_ed25519",
            ".npmrc",
            ".pypirc",
            "credentials",
            "credentials.json",
            "service-account.json",
            "secrets.json",
            "secrets.yaml",
            "secrets.yml",
        ]
        .contains(&name)
        || [".pem", ".p12", ".pfx", ".key", ".keystore"]
            .iter()
            .any(|x| name.ends_with(x))
    {
        return Some("默认排除可能包含凭证的文件");
    }
    None
}
pub fn has_secret(text: &str) -> bool {
    let upper = text.to_uppercase();
    if upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----") {
        return true;
    }
    text.split(|c: char| {
        c.is_whitespace() || ['"', '\'', '=', ',', ';', '(', ')', '{', '}'].contains(&c)
    })
    .any(|part| {
        (part.starts_with("sk-") && part.len() >= 24)
            || (part.starts_with("ghp_") && part.len() >= 30)
            || (part.starts_with("github_pat_") && part.len() >= 40)
            || (part.starts_with("AKIA") && part.len() == 20)
    })
}

// Read declarations only. Never run Git, follow a declaration as a path, or fetch its URL.
fn submodule_paths(text: &str) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    let mut incomplete = false;
    let mut in_module = false;
    let mut has_path = false;
    for line in text.lines() {
        let mut line = line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.starts_with('[') {
            if in_module && !has_path {
                incomplete = true;
            }
            in_module = false;
            has_path = false;
            let mut quoted = false;
            let mut escaped = false;
            let end = line.char_indices().skip(1).find_map(|(index, character)| {
                if escaped {
                    escaped = false;
                } else if character == '\\' && quoted {
                    escaped = true;
                } else if character == '"' {
                    quoted = !quoted;
                } else if character == ']' && !quoted {
                    return Some(index);
                }
                None
            });
            let Some(end) = end else {
                incomplete = true;
                continue;
            };
            let (section, tail) = (&line[1..end], &line[end + 1..]);
            let section = section.trim().to_ascii_lowercase();
            in_module = section.starts_with("submodule ")
                || section.starts_with("submodule\t")
                || section.starts_with("submodule.");
            line = tail.trim();
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
        }
        if !in_module {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            if line
                .split_whitespace()
                .next()
                .is_some_and(|key| key.eq_ignore_ascii_case("path"))
            {
                incomplete = true;
            }
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("path") {
            continue;
        }
        if has_path || paths.len() >= MAX_FILES {
            incomplete = true;
            continue;
        }
        match submodule_path_value(raw) {
            Ok(value) => paths.push(value),
            Err(()) => incomplete = true,
        }
        has_path = true;
    }
    if in_module && !has_path {
        incomplete = true;
    }
    (paths, incomplete)
}

fn submodule_path_value(raw: &str) -> std::result::Result<String, ()> {
    let mut value = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut value_end = 0;
    for character in raw.trim().chars() {
        if escaped {
            value.push(match character {
                '\\' | '"' => character,
                'n' => '\n',
                't' => '\t',
                'b' => '\u{8}',
                _ => return Err(()),
            });
            value_end = value.len();
            escaped = false;
        } else {
            match character {
                '\\' => escaped = true,
                '"' => {
                    quoted = !quoted;
                    value_end = value.len();
                }
                '#' | ';' if !quoted => break,
                _ => {
                    value.push(character);
                    if quoted || !character.is_whitespace() {
                        value_end = value.len();
                    }
                }
            }
        }
    }
    value.truncate(value_end);
    if quoted || escaped || !safe_relative(&value) || value.ends_with('/') {
        return Err(());
    }
    Ok(value)
}

struct PreparedSource {
    archive: tempfile::NamedTempFile,
    files: Vec<SourceFile>,
    bytes: u64,
}
struct Collector {
    writer: zip::ZipWriter<tempfile::NamedTempFile>,
    files: Vec<SourceFile>,
    bytes: u64,
    version_id: String,
    visited: usize,
    submodules: HashSet<String>,
}
impl Collector {
    fn new() -> Result<Self> {
        Ok(Self {
            writer: zip::ZipWriter::new(tempfile::NamedTempFile::new()?),
            files: vec![],
            bytes: 0,
            version_id: id(),
            visited: 0,
            submodules: HashSet::new(),
        })
    }
    fn record(
        &mut self,
        path: &str,
        status: &str,
        reason: &str,
        bytes: u64,
        hash: String,
        lines: usize,
    ) {
        self.files.push(SourceFile {
            id: id(),
            source_version_id: self.version_id.clone(),
            path: path.into(),
            status: status.into(),
            reason: reason.into(),
            bytes,
            sha256: hash,
            lines,
        });
    }
    fn accept(
        &mut self,
        path: &str,
        reader: impl Read,
        declared: u64,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        check_cancel(cancelled)?;
        if let Some(reason) = excluded(path) {
            self.record(path, "excluded", reason, declared, String::new(), 0);
            return Ok(());
        }
        if declared > MAX_FILE_BYTES || self.bytes.saturating_add(declared) > MAX_SOURCE_BYTES {
            self.record(
                path,
                "excluded",
                "超过当前单文件或项目读取上限",
                declared,
                String::new(),
                0,
            );
            return Ok(());
        }
        let mut bytes = Vec::new();
        if reader
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            self.record(
                path,
                "failed",
                "内容读取或校验失败",
                declared,
                String::new(),
                0,
            );
            return Ok(());
        }
        check_cancel(cancelled)?;
        if bytes.len() as u64 > MAX_FILE_BYTES || bytes.len() as u64 != declared {
            self.record(
                path,
                "failed",
                "读取期间文件大小改变或超过限制",
                declared,
                String::new(),
                0,
            );
            return Ok(());
        }
        let content = match decode(&bytes) {
            Ok(content) => content,
            Err(error) => {
                self.record(path, "excluded", &error.message, declared, String::new(), 0);
                return Ok(());
            }
        };
        if has_secret(&content) {
            self.record(
                path,
                "excluded",
                "检测到可识别凭证，未保存内容",
                declared,
                String::new(),
                0,
            );
            return Ok(());
        }
        self.writer.start_file(
            path,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        self.writer.write_all(&bytes)?;
        self.bytes += declared;
        self.record(
            path,
            "readable",
            "",
            declared,
            digest(&bytes),
            content.lines().count().max(1),
        );
        if path.rsplit('/').next() == Some(".gitmodules") {
            let parent = path.strip_suffix(".gitmodules").unwrap();
            let (paths, incomplete) = submodule_paths(&content);
            let mut truncated = false;
            for module in paths {
                let path = format!("{parent}{module}/");
                if self.submodules.len() >= MAX_FILES && !self.submodules.contains(&path) {
                    truncated = true;
                    break;
                }
                self.submodules.insert(path);
            }
            if incomplete || truncated {
                self.record(
                    path,
                    "failed",
                    "子模块声明无法完整核对，可能含不安全路径或超出数量限制；未执行或下载。",
                    0,
                    String::new(),
                    0,
                );
            }
        }
        Ok(())
    }
    fn finish(mut self) -> Result<PreparedSource> {
        if !self.files.iter().any(|f| f.status == "readable") {
            return Err(AppError::new(
                "SOURCE_EMPTY",
                "没有可读取的源码材料；请检查空项目、权限、文件类型和排除规则。",
            ));
        }
        let mut readable_paths = self
            .files
            .iter()
            .filter(|file| file.status == "readable")
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        readable_paths.sort_unstable();
        let mut missing = self
            .submodules
            .iter()
            .filter(|prefix| {
                let index = readable_paths.partition_point(|path| *path < prefix.as_str());
                !readable_paths
                    .get(index)
                    .is_some_and(|path| path.starts_with(prefix.as_str()))
            })
            .cloned()
            .collect::<Vec<_>>();
        missing.sort();
        for path in missing {
            self.record(
                &path,
                "failed",
                "声明的子模块未导入可读文件：可能缺失、未初始化或被排除；未执行或下载。",
                0,
                String::new(),
                0,
            );
        }
        let mut archive = self.writer.finish()?;
        archive.as_file_mut().sync_all()?;
        Ok(PreparedSource {
            archive,
            files: self.files,
            bytes: self.bytes,
        })
    }
}
fn read_zip(file: fs::File, cancelled: &AtomicBool) -> Result<PreparedSource> {
    if file.metadata()?.len() > MAX_SOURCE_BYTES {
        return Err(AppError::invalid(
            "ZIP文件超过256 MiB，请选择项目目录或缩小导入范围。",
        ));
    }
    let mut zip = zip::ZipArchive::new(file)?;
    if zip.has_duplicate_names() {
        return Err(AppError::invalid("ZIP含重复条目，未导入。"));
    }
    let mut output = Collector::new()?;
    let mut names = HashSet::new();
    for i in 0..zip.len().min(MAX_FILES) {
        check_cancel(cancelled)?;
        let file = zip.by_index(i)?;
        let name = file.name()?.into_owned();
        if !safe_relative(&name) || !names.insert(name.clone()) {
            return Err(AppError::invalid("ZIP含路径越界、非法或重复条目，未导入。"));
        }
        if file.is_symlink() || file.encrypted() {
            output.record(
                &name,
                "excluded",
                "链接或加密条目",
                file.size(),
                String::new(),
                0,
            );
        } else if !file.is_dir() {
            let size = file.size();
            let mode = file.unix_mode().unwrap_or(0) & 0o170000;
            if mode != 0 && mode != 0o100000 {
                output.record(
                    &name,
                    "excluded",
                    "特殊文件不能作为源码",
                    size,
                    String::new(),
                    0,
                );
            } else {
                output.accept(&name, file, size, cancelled)?;
            }
        }
    }
    if zip.len() > MAX_FILES {
        output.record(
            "（剩余条目）",
            "excluded",
            "超过20000条目，剩余范围未读取",
            0,
            String::new(),
            0,
        );
    }
    output.finish()
}
fn read_directory(root: &SafeDir, cancelled: &AtomicBool) -> Result<PreparedSource> {
    let mut output = Collector::new()?;
    walk_directory(root, "", 0, &mut output, cancelled)?;
    output.finish()
}
fn walk_directory(
    dir: &SafeDir,
    prefix: &str,
    depth: usize,
    output: &mut Collector,
    cancelled: &AtomicBool,
) -> Result<()> {
    check_cancel(cancelled)?;
    if depth >= 64 || output.visited >= MAX_FILES {
        output.record(
            prefix,
            "excluded",
            "超过目录深度或文件数量限制，剩余范围未读取",
            0,
            String::new(),
            0,
        );
        return Ok(());
    }
    let names = match dir.names(MAX_FILES - output.visited + 1) {
        Ok(names) => names,
        Err(_) => {
            output.record(prefix, "failed", "目录无法枚举", 0, String::new(), 0);
            return Ok(());
        }
    };
    for name in names {
        check_cancel(cancelled)?;
        if output.visited >= MAX_FILES {
            output.record(
                prefix,
                "excluded",
                "文件数量达到上限，剩余范围未读取",
                0,
                String::new(),
                0,
            );
            break;
        }
        output.visited += 1;
        let Some(part) = name.to_str() else {
            output.record(prefix, "failed", "文件名编码不受支持", 0, String::new(), 0);
            continue;
        };
        let relative = format!("{prefix}{part}");
        if !safe_relative(&relative) {
            output.record(&relative, "excluded", "文件名不安全", 0, String::new(), 0);
            continue;
        }
        if let Some(reason) = excluded(&relative) {
            output.record(&relative, "excluded", reason, 0, String::new(), 0);
            continue;
        }
        match dir.open_child(&name) {
            Ok(Entry::Directory(child)) => walk_directory(
                &child,
                &format!("{relative}/"),
                depth + 1,
                output,
                cancelled,
            )?,
            Ok(Entry::File(file)) => match file.metadata() {
                Ok(meta) => output.accept(&relative, file, meta.len(), cancelled)?,
                Err(_) => output.record(
                    &relative,
                    "failed",
                    "无法读取文件元数据",
                    0,
                    String::new(),
                    0,
                ),
            },
            Err(_) => output.record(
                &relative,
                "failed",
                "不可读文件、链接或特殊文件，未跟随",
                0,
                String::new(),
                0,
            ),
        }
    }
    Ok(())
}

fn save_import(
    store: &mut Store,
    mut prepared: PreparedSource,
    name: &str,
    project: Option<&str>,
    operation: &str,
    hash: &str,
    cancelled: &AtomicBool,
) -> Result<Value> {
    if let Some(project) = project {
        uuid::Uuid::parse_str(project).map_err(|_| AppError::invalid("项目标识不正确。"))?;
        if !list::<SourceVersion>(&store.conn, "source_versions")?
            .iter()
            .any(|v| v.project_id == project)
        {
            return Err(AppError::new("NOT_FOUND", "刷新所用项目已不存在。"));
        }
    }
    let asset_id = id();
    prepared.archive.as_file_mut().seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancel(cancelled)?;
        let count = prepared.archive.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let asset = FileAsset {
        id: asset_id.clone(),
        kind: AssetKind::Source,
        name: "项目源码.zip".into(),
        sha256: format!("{:x}", hasher.finalize()),
        bytes: prepared.archive.as_file().metadata()?.len(),
        status: AssetStatus::Available,
        created_at: now(),
    };
    let scope_version = id();
    let version = SourceVersion {
        id: prepared.files[0].source_version_id.clone(),
        project_id: project.map(str::to_owned).unwrap_or_else(id),
        name: name.into(),
        asset_id,
        created_at: now(),
        readable_files: prepared
            .files
            .iter()
            .filter(|f| f.status == "readable")
            .count(),
        total_files: prepared.files.len(),
        source_bytes: prepared.bytes,
        scope_version: scope_version.clone(),
        allowed_paths: vec![],
        scope_history: vec![ScopeGrant {
            id: scope_version,
            paths: vec![],
        }],
    };
    let destination = store.dir().join("assets").join(&asset.id);
    prepared.archive.as_file_mut().seek(SeekFrom::Start(0))?;
    let mut temp = tempfile::NamedTempFile::new_in(store.dir().join("assets"))?;
    std::io::copy(&mut prepared.archive, &mut temp)?;
    temp.as_file().sync_all()?;
    check_cancel(cancelled)?;
    temp.persist_noclobber(&destination)
        .map_err(|_| AppError::new("WRITE_FAILED", "项目副本未保存，旧材料保持不变。"))?;
    let result = (|| {
        let tx = store.conn.transaction()?;
        crate::store::put(&tx, "assets", &asset.id, &asset)?;
        tx.execute(
            "INSERT INTO source_versions(id,asset_id,data) VALUES(?1,?2,?3)",
            params![version.id, version.asset_id, encode(&version)?],
        )?;
        for file in &prepared.files {
            tx.execute(
                "INSERT INTO source_files(id,source_version_id,data) VALUES(?1,?2,?3)",
                params![file.id, version.id, encode(file)?],
            )?;
        }
        let result = json!(version);
        tx.execute(
            "INSERT INTO operations(id,request_hash,result) VALUES(?1,?2,?3)",
            params![operation, hash, encode(&result)?],
        )?;
        bump(&tx)?;
        check_cancel(cancelled)?;
        tx.commit()?;
        Ok::<_, AppError>(result)
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

pub fn validate_evidence(conn: &Connection, evidence: &Evidence) -> Result<()> {
    let files = files_for(conn, &evidence.source_version_id)?;
    let file = files
        .iter()
        .find(|f| f.path == evidence.path && f.status == "readable")
        .ok_or_else(|| AppError::invalid("引用没有对应的可读材料记录。"))?;
    let expected_id = digest(
        encode(&(
            evidence.source_version_id.as_str(),
            evidence.path.as_str(),
            evidence.start_line,
            evidence.end_line,
            &evidence.sha256,
        ))?
        .as_bytes(),
    );
    if evidence.id != expected_id
        || file.sha256 != evidence.file_sha256
        || evidence.start_line == 0
        || evidence.end_line < evidence.start_line
        || evidence.end_line > file.lines
        || evidence.text.len() > 32_000
        || digest(evidence.text.as_bytes()) != evidence.sha256
        || evidence.text.split('\n').count() != evidence.end_line - evidence.start_line + 1
    {
        return Err(AppError::invalid("引用版本、位置或内容校验不一致。"));
    }
    Ok(())
}
pub fn validate_reference(conn: &Connection, kind: &str, value: &str) -> Result<bool> {
    match kind {
        "source_version" => {
            let _: SourceVersion = get(conn, "source_versions", value)?;
            Ok(true)
        }
        "source_scope" => {
            let (version_id, scope_id) = value
                .split_once(':')
                .ok_or_else(|| AppError::invalid("项目授权引用缺少材料版本。"))?;
            let version: SourceVersion = get(conn, "source_versions", version_id)?;
            if version.scope_version != scope_id || version.allowed_paths.is_empty() {
                return Err(AppError::new(
                    "SCOPE_REVOKED",
                    "项目外发范围已改变或撤回，请重新确认后创建新场次。",
                ));
            }
            Ok(true)
        }
        "evidence" => {
            let evidence: Evidence = get(conn, "evidence", value)?;
            validate_evidence(conn, &evidence)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}
pub fn validate_history_reference(conn: &Connection, kind: &str, value: &str) -> Result<bool> {
    if kind != "source_scope" {
        return validate_reference(conn, kind, value);
    }
    let (version_id, scope_id) = value
        .split_once(':')
        .ok_or_else(|| AppError::invalid("历史授权引用缺少材料版本。"))?;
    let version: SourceVersion = get(conn, "source_versions", version_id)?;
    if !version
        .scope_history
        .iter()
        .any(|scope| scope.id == scope_id && !scope.paths.is_empty())
    {
        return Err(AppError::invalid("历史任务没有对应的项目授权记录。"));
    }
    Ok(true)
}
pub fn validate_database(conn: &Connection) -> Result<()> {
    validate_columns(conn, "source_versions", "asset_id", "assetId")?;
    validate_columns(conn, "source_files", "source_version_id", "sourceVersionId")?;
    validate_columns(conn, "evidence", "source_version_id", "sourceVersionId")?;
    let versions = list::<SourceVersion>(conn, "source_versions")?;
    let mut version_ids = HashSet::new();
    for version in versions {
        if !version_ids.insert(version.id.clone())
            || uuid::Uuid::parse_str(&version.id).is_err()
            || uuid::Uuid::parse_str(&version.project_id).is_err()
        {
            return Err(AppError::invalid("材料版本或项目标识不正确。"));
        }
        let asset: FileAsset = get(conn, "assets", &version.asset_id)?;
        if asset.kind != AssetKind::Source {
            return Err(AppError::invalid("项目版本引用了非源码资产。"));
        }
        let files = files_for(conn, &version.id)?;
        let mut grants = HashSet::new();
        if !version
            .scope_history
            .iter()
            .any(|scope| scope.id == version.scope_version && scope.paths == version.allowed_paths)
        {
            return Err(AppError::invalid("当前项目授权没有对应的历史记录。"));
        }
        for scope in &version.scope_history {
            if !grants.insert(scope.id.clone())
                || uuid::Uuid::parse_str(&scope.id).is_err()
                || scope.paths.iter().any(|p| {
                    p != "*"
                        && !files.iter().any(|f| {
                            f.status == "readable"
                                && (f.path == *p || (p.ends_with('/') && f.path.starts_with(p)))
                        })
                })
            {
                return Err(AppError::invalid("项目授权历史损坏。"));
            }
        }
        let mut paths = HashSet::new();
        for file in &files {
            if uuid::Uuid::parse_str(&file.id).is_err()
                || file.source_version_id != version.id
                || !["readable", "excluded", "failed"].contains(&file.status.as_str())
                || (file.status == "readable"
                    && (!safe_relative(&file.path)
                        || !paths.insert(file.path.clone())
                        || file.sha256.len() != 64
                        || file.lines == 0))
            {
                return Err(AppError::invalid("项目文件清单损坏。"));
            }
        }
        if files.len() != version.total_files
            || files.iter().filter(|f| f.status == "readable").count() != version.readable_files
        {
            return Err(AppError::invalid("材料清单数量不一致。"));
        }
    }
    for evidence in list::<Evidence>(conn, "evidence")? {
        validate_evidence(conn, &evidence)?;
    }
    Ok(())
}
pub(crate) fn validate_columns(
    conn: &Connection,
    table: &str,
    owner_column: &str,
    owner_field: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(&format!("SELECT id,{owner_column},data FROM {table}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, owner, raw) in rows {
        let data: Value = serde_json::from_str(&raw)?;
        if data["id"].as_str() != Some(id.as_str())
            || data[owner_field].as_str() != owner.as_deref()
        {
            return Err(AppError::invalid("业务记录标识或关联列与内容不一致。"));
        }
    }
    Ok(())
}
pub fn sanitize_after_restore(conn: &Connection) -> Result<()> {
    for mut version in list::<SourceVersion>(conn, "source_versions")? {
        version.scope_version = id();
        version.allowed_paths.clear();
        version.scope_history.push(ScopeGrant {
            id: version.scope_version.clone(),
            paths: vec![],
        });
        conn.execute(
            "UPDATE source_versions SET data=?2 WHERE id=?1",
            params![version.id, encode(&version)?],
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "s3_tests.rs"]
mod s3_tests;
