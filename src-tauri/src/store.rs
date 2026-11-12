use crate::domain::*;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct Store {
    pub root: PathBuf,
    pub dataset_id: String,
    pub conn: Connection,
    _lock: fs::File,
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
pub fn get<T: DeserializeOwned>(conn: &Connection, table: &str, id: &str) -> Result<T> {
    let raw: Option<String> = conn
        .query_row(
            &format!("SELECT data FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(
        &raw.ok_or_else(|| AppError::new("NOT_FOUND", "所选记录已不存在，请刷新后重试。"))?,
    )
    .map_err(Into::into)
}
pub fn list<T: DeserializeOwned>(conn: &Connection, table: &str) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(&format!("SELECT data FROM {table} ORDER BY rowid"))?;
    let raw = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .collect()
}
pub fn put<T: Serialize>(conn: &Connection, table: &str, id: &str, data: &T) -> Result<()> {
    conn.execute(&format!("INSERT INTO {table}(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data"), params![id, encode(data)?])?;
    Ok(())
}
pub fn bump(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
        [],
    )?;
    Ok(())
}
pub fn revision(conn: &Connection) -> Result<u64> {
    let value: i64 = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'",
        [],
        |r| r.get(0),
    )?;
    u64::try_from(value).map_err(|_| AppError::invalid("数据版本计数损坏。"))
}
pub fn connect(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(AppError::new(
            "VERSION_UNSUPPORTED",
            "数据版本较新，请使用兼容的新版本应用。",
        ));
    }
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    if version == 0 {
        let tables: u32 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if tables > 0 {
            return Err(AppError::new(
                "VERSION_UNSUPPORTED",
                "此数据库缺少受支持的版本标识，未执行迁移。",
            ));
        }
        migrate(&mut conn, include_str!("../migrations/001_initial.sql"))?;
    }
    Ok(conn)
}
pub(crate) fn migrate(conn: &mut Connection, sql: &str) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(sql)?;
    tx.commit()?;
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::invalid("写入位置不正确。"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|_| AppError::new("WRITE_FAILED", "保存未完成，原文件保持不变。"))?;
    Ok(())
}
impl Store {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("datasets"))?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("workspace.lock"))?;
        lock.try_lock().map_err(|_| {
            AppError::new(
                "WORKSPACE_IN_USE",
                "此工作区已由另一个应用进程打开。请关闭它后重新打开本应用。",
            )
        })?;
        let pointer = root.join("active");
        let dataset_id = if pointer.exists() {
            fs::read_to_string(&pointer)?.trim().to_owned()
        } else {
            id()
        };
        uuid::Uuid::parse_str(&dataset_id).map_err(|_| {
            AppError::new(
                "DATA_CORRUPT",
                "当前数据集指针损坏。原目录仍保留，请先备份数据目录。",
            )
        })?;
        let dir = root.join("datasets").join(&dataset_id);
        if pointer.exists() && !dir.join("data.sqlite").is_file() {
            return Err(AppError::new(
                "DATA_CORRUPT",
                "当前数据库缺失，未新建空库覆盖。请从备份恢复。",
            ));
        }
        fs::create_dir_all(dir.join("assets"))?;
        let conn = connect(&dir.join("data.sqlite"))?;
        if !pointer.exists() {
            atomic_write(&pointer, dataset_id.as_bytes())?;
        }
        let mut store = Self {
            root,
            dataset_id,
            conn,
            _lock: lock,
        };
        let tx = store.conn.transaction()?;
        for mut task in list::<ModelTask>(&tx, "tasks")? {
            if task.status == "running" {
                task.status = "interrupted".into();
                task.progress = "上次运行已中断，已有内容保留；可手动重新发起。".into();
                task.updated_at = now();
                put(&tx, "tasks", &task.id, &task)?;
                bump(&tx)?;
            }
        }
        tx.commit()?;
        Ok(store)
    }
    pub fn dir(&self) -> PathBuf {
        self.root.join("datasets").join(&self.dataset_id)
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let versions = list::<ProfileVersion>(&self.conn, "profile_versions")?;
        let mut stmt = self
            .conn
            .prepare("SELECT id,name,current_version_id FROM profiles ORDER BY rowid")?;
        let profiles = stmt
            .query_map([], |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    current_version_id: r.get(2)?,
                    versions: vec![],
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|mut p| {
                p.versions = versions
                    .iter()
                    .filter(|v| v.profile_id == p.id)
                    .cloned()
                    .collect();
                p
            })
            .collect();
        Ok(Snapshot {
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            dataset_id: self.dataset_id.clone(),
            revision: revision(&self.conn)?,
            profiles,
            jobs: list(&self.conn, "jobs")?,
            applications: list(&self.conn, "applications")?,
            events: list(&self.conn, "events")?,
            interviews: list(&self.conn, "interviews")?,
            assets: list(&self.conn, "assets")?,
            providers: list(&self.conn, "providers")?,
            tasks: list(&self.conn, "tasks")?,
        })
    }
    pub fn mutate(
        &mut self,
        operation_id: &str,
        expected_dataset: &str,
        request: Mutation,
    ) -> Result<Value> {
        if self.dataset_id != expected_dataset {
            return Err(AppError::new(
                "STALE_TASK",
                "数据已整体恢复，请刷新后再操作。",
            ));
        }
        text(operation_id, "操作标识", true, 100)?;
        let hash = digest(encode(&request)?.as_bytes());
        let tx = self.conn.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT request_hash,result FROM operations WHERE id=?1",
                [operation_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior_hash, result)) = previous {
            if prior_hash != hash {
                return Err(AppError::new(
                    "OPERATION_CONFLICT",
                    "同一操作标识不能用于不同内容。",
                ));
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let result = apply(&tx, operation_id, request)?;
        tx.execute(
            "INSERT INTO operations VALUES (?1,?2,?3)",
            params![operation_id, hash, encode(&result)?],
        )?;
        bump(&tx)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn log(&self, code: &str) {
        // 日志只记录固定错误码，不记录请求、用户材料、地址或服务返回正文。
        let safe = match code {
            "WRITE_FAILED" | "FILE_FAILED" | "INPUT_INVALID" | "VERSION_CONFLICT"
            | "SERVICE_FAILED" | "KEY_UNAVAILABLE" | "STALE_TASK" => code,
            _ => "OPERATION_FAILED",
        };
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("operations.log"))
        {
            let _ = writeln!(f, "{} {}", now(), safe);
        }
    }
}
fn profile_reference(tx: &Connection, reference: &Option<String>) -> Result<()> {
    if let Some(id) = reference {
        let _: ProfileVersion = get(tx, "profile_versions", id)?;
    }
    Ok(())
}
fn insert_version(tx: &Connection, profile_id: &str, data: ProfileData) -> Result<ProfileVersion> {
    data.validate()?;
    if let Some(asset_id) = &data.resume_asset_id {
        let asset: FileAsset = get(tx, "assets", asset_id)?;
        if asset.kind != AssetKind::Resume {
            return Err(AppError::invalid("配套材料必须是简历。"));
        }
    }
    let version = ProfileVersion {
        id: id(),
        profile_id: profile_id.into(),
        created_at: now(),
        data,
    };
    tx.execute(
        "INSERT INTO profile_versions(id,profile_id,resume_asset_id,data) VALUES(?1,?2,?3,?4)",
        params![
            version.id,
            profile_id,
            version.data.resume_asset_id,
            encode(&version)?
        ],
    )?;
    Ok(version)
}
fn read_application(tx: &Connection, id: &str, expected_revision: u64) -> Result<Application> {
    let application: Application = get(tx, "applications", id)?;
    if application.revision != expected_revision {
        return Err(AppError::new(
            "VERSION_CONFLICT",
            "申请已被更新，请刷新后重试。",
        ));
    }
    Ok(application)
}
fn save_application(tx: &Connection, app: &Application) -> Result<()> {
    tx.execute("INSERT INTO applications(id,job_id,profile_version_id,data) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,profile_version_id=excluded.profile_version_id,data=excluded.data",params![app.id,app.job_snapshot_id,app.profile_version_id,encode(app)?])?;
    Ok(())
}
fn event(
    tx: &Connection,
    app: &Application,
    operation_id: &str,
    kind: &str,
    occurred_at: String,
    detail: Value,
) -> Result<()> {
    let e = ApplicationEvent {
        id: id(),
        application_id: app.id.clone(),
        operation_id: operation_id.into(),
        kind: kind.into(),
        occurred_at,
        recorded_at: now(),
        source: "user".into(),
        job_snapshot_id: app.job_snapshot_id.clone(),
        profile_version_id: app.profile_version_id.clone(),
        detail,
    };
    tx.execute(
        "INSERT INTO events VALUES (?1,?2,?3)",
        params![e.id, e.application_id, encode(&e)?],
    )?;
    Ok(())
}
fn apply(tx: &Transaction<'_>, operation_id: &str, request: Mutation) -> Result<Value> {
    match request {
        Mutation::SaveProfile {
            profile_id,
            expected_version_id,
            name,
            data,
        } => {
            text(&name, "档案名称", true, 150)?;
            let profile_id = if let Some(profile_id) = profile_id {
                let current: Option<String> = tx
                    .query_row(
                        "SELECT current_version_id FROM profiles WHERE id=?1",
                        [&profile_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if current.is_none() || current != expected_version_id {
                    return Err(AppError::new(
                        "VERSION_CONFLICT",
                        "档案已有新版本，当前编辑已保留，请重新核对。",
                    ));
                }
                profile_id
            } else {
                if expected_version_id.is_some() {
                    return Err(AppError::invalid("新档案不能引用既有版本。"));
                }
                id()
            };
            let version = insert_version(tx, &profile_id, data)?;
            tx.execute("INSERT INTO profiles(id,name,current_version_id) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,current_version_id=excluded.current_version_id",params![profile_id,name.trim(),version.id])?;
            Ok(json!({"profileId":profile_id,"versionId":version.id}))
        }
        Mutation::CopyProfile { version_id, name } => {
            text(&name, "新档案名称", true, 150)?;
            let source: ProfileVersion = get(tx, "profile_versions", &version_id)?;
            let profile_id = id();
            let version = insert_version(tx, &profile_id, source.data)?;
            tx.execute(
                "INSERT INTO profiles VALUES (?1,?2,?3)",
                params![profile_id, name.trim(), version.id],
            )?;
            Ok(json!({"profileId":profile_id,"versionId":version.id}))
        }
        Mutation::CreateApplication {
            job,
            profile_version_id,
            stage,
            duplicate_acknowledged,
        } => {
            job.validate()?;
            profile_reference(tx, &profile_version_id)?;
            if !matches!(stage, Stage::Saved | Stage::Pending) {
                return Err(AppError::invalid(
                    "新申请先保存为收藏或待投递，再明确确认实际提交与进展。",
                ));
            }
            let jobs = list::<JobSnapshot>(tx, "jobs")?;
            let duplicates: Vec<_> = list::<Application>(tx, "applications")?
                .into_iter()
                .filter(|a| {
                    jobs.iter().any(|j| {
                        j.id == a.job_snapshot_id
                            && j.data
                                .company
                                .trim()
                                .eq_ignore_ascii_case(job.company.trim())
                            && j.data.title.trim().eq_ignore_ascii_case(job.title.trim())
                            && j.data.batch.trim() == job.batch.trim()
                    })
                })
                .map(|a| a.id)
                .collect();
            if !duplicates.is_empty() && !duplicate_acknowledged {
                return Err(AppError::new(
                    "DUPLICATE_CONFIRMATION",
                    "发现同公司、岗位与批次的记录。请核对渠道，确认是独立申请后再创建。",
                ));
            }
            let snapshot = JobSnapshot {
                id: id(),
                created_at: now(),
                data: job,
            };
            put(tx, "jobs", &snapshot.id, &snapshot)?;
            let app = Application {
                id: id(),
                job_snapshot_id: snapshot.id,
                profile_version_id,
                stage,
                end_reason: None,
                confirmed_submitted_at: None,
                created_at: now(),
                updated_at: now(),
                revision: 1,
                next_action: String::new(),
                due_at: None,
                notes: String::new(),
            };
            save_application(tx, &app)?;
            event(
                tx,
                &app,
                operation_id,
                "created",
                now(),
                json!({"stage":app.stage,"possibleDuplicateIds":duplicates,"duplicateAcknowledged":duplicate_acknowledged}),
            )?;
            Ok(json!({"applicationId":app.id}))
        }
        Mutation::UpdateApplication {
            id,
            expected_revision,
            job,
            profile_version_id,
            stage,
            end_reason,
            next_action,
            due_at,
            notes,
        } => {
            job.validate()?;
            profile_reference(tx, &profile_version_id)?;
            text(&next_action, "待办事项", false, 2000)?;
            text(&notes, "备注", false, 100_000)?;
            if let Some(due) = &due_at {
                timestamp(due)?;
            }
            let mut app = read_application(tx, &id, expected_revision)?;
            if stage == Stage::Applied && app.confirmed_submitted_at.is_none() {
                return Err(AppError::new(
                    "SUBMISSION_CONFIRMATION_REQUIRED",
                    "请先确认本人已实际提交申请。",
                ));
            }
            if (stage == Stage::Closed) != end_reason.is_some() {
                return Err(AppError::invalid(
                    "已结束须选择拒绝、主动撤回或已入职；其他阶段不填写结束原因。",
                ));
            }
            let previous_stage = app.stage.clone();
            let previous_job: JobSnapshot = get(tx, "jobs", &app.job_snapshot_id)?;
            if encode(&previous_job.data)? != encode(&job)? {
                let snapshot = JobSnapshot {
                    id: crate::domain::id(),
                    created_at: now(),
                    data: job,
                };
                put(tx, "jobs", &snapshot.id, &snapshot)?;
                app.job_snapshot_id = snapshot.id;
            }
            app.profile_version_id = profile_version_id;
            app.stage = stage;
            app.end_reason = end_reason;
            app.next_action = next_action;
            app.due_at = due_at;
            app.notes = notes;
            app.updated_at = now();
            app.revision += 1;
            save_application(tx, &app)?;
            event(
                tx,
                &app,
                operation_id,
                "updated",
                now(),
                json!({"previousStage":previous_stage,"stage":app.stage,"endReason":app.end_reason}),
            )?;
            Ok(json!({"applicationId":app.id,"revision":app.revision}))
        }
        Mutation::ConfirmSubmitted {
            id,
            expected_revision,
            confirmed,
            submitted_at,
        } => {
            if !confirmed {
                return Err(AppError::new(
                    "SUBMISSION_CONFIRMATION_REQUIRED",
                    "请先确认本人已实际提交。",
                ));
            }
            timestamp(&submitted_at)?;
            let mut app = read_application(tx, &id, expected_revision)?;
            if app.confirmed_submitted_at.is_some() {
                return Ok(json!({"applicationId":app.id,"alreadyConfirmed":true}));
            }
            app.confirmed_submitted_at = Some(submitted_at.clone());
            if matches!(app.stage, Stage::Saved | Stage::Pending) {
                app.stage = Stage::Applied;
            }
            app.updated_at = now();
            app.revision += 1;
            save_application(tx, &app)?;
            event(
                tx,
                &app,
                operation_id,
                "submitted",
                submitted_at,
                json!({"confirmedByUser":true}),
            )?;
            Ok(json!({"applicationId":app.id,"revision":app.revision}))
        }
        Mutation::SaveInterview {
            id,
            application_id,
            expected_revision,
            title,
            scheduled_at,
            location,
            notes,
            completed,
        } => {
            text(&title, "面试轮次名称", true, 200)?;
            text(&location, "面试地点", false, 2000)?;
            text(&notes, "面试备注", false, 100_000)?;
            timestamp(&scheduled_at)?;
            let mut app = read_application(tx, &application_id, expected_revision)?;
            let round_id = if let Some(id) = id {
                let old: InterviewRound = get(tx, "interviews", &id)?;
                if old.application_id != application_id {
                    return Err(AppError::invalid("面试轮次不属于此申请。"));
                }
                id
            } else {
                crate::domain::id()
            };
            let round = InterviewRound {
                id: round_id,
                application_id,
                title,
                scheduled_at,
                location,
                notes,
                completed,
            };
            tx.execute("INSERT INTO interviews VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![round.id,round.application_id,encode(&round)?])?;
            app.revision += 1;
            app.updated_at = now();
            save_application(tx, &app)?;
            event(
                tx,
                &app,
                operation_id,
                "interview",
                round.scheduled_at.clone(),
                serde_json::to_value(&round)?,
            )?;
            Ok(json!({"interviewId":round.id,"revision":app.revision}))
        }
    }
}
