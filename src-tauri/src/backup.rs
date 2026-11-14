use crate::{
    domain::*,
    store::{Store, atomic_write, bump, connect, digest, get, list, migrate, put, revision},
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub const MAX_BACKUP_BYTES: usize = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 512 * 1024 * 1024;
const TABLES: [&str; 10] = [
    "profiles",
    "profile_versions",
    "jobs",
    "applications",
    "events",
    "interviews",
    "assets",
    "providers",
    "tasks",
    "operations",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub created_at: String,
    pub counts: BTreeMap<String, u64>,
    pub files: Vec<BackupFile>,
    pub assets: Vec<FileAsset>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub manifest: Manifest,
    pub current_counts: BTreeMap<String, u64>,
    pub current_dataset_id: String,
    pub current_revision: u64,
}
pub struct Prepared {
    pub preview: Preview,
    pub(crate) staged: tempfile::TempDir,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReceipt {
    pub id: String,
    pub path: String,
    pub manifest: Manifest,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReceipt {
    pub dataset_id: String,
    pub previous_backup: BackupReceipt,
}

fn counts(conn: &Connection) -> Result<BTreeMap<String, u64>> {
    TABLES
        .into_iter()
        .map(|table| {
            Ok((
                table.into(),
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })? as u64,
            ))
        })
        .collect()
}
fn backup_db(source: &Connection, destination: &Path) -> Result<()> {
    let mut target = Connection::open(destination)?;
    rusqlite::backup::Backup::new(source, &mut target)?.run_to_completion(
        128,
        Duration::from_millis(5),
        None,
    )?;
    Ok(())
}
fn write_zip_file(writer: &mut zip::ZipWriter<fs::File>, name: &str, bytes: &[u8]) -> Result<()> {
    writer.start_file(
        name,
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated),
    )?;
    writer.write_all(bytes)?;
    Ok(())
}
pub fn export(store: &Store, include_audio: bool, include_source: bool) -> Result<BackupReceipt> {
    fs::create_dir_all(store.root.join("backups"))?;
    let temp = tempfile::tempdir_in(&store.root)?;
    let db_path = temp.path().join("data.sqlite");
    backup_db(&store.conn, &db_path)?;
    let db = connect(&db_path)?;
    db.execute_batch("PRAGMA secure_delete=ON;")?;
    let mut assets = list::<FileAsset>(&db, "assets")?;
    let mut files = Vec::new();
    for asset in &mut assets {
        if asset.status == AssetStatus::Available {
            if (asset.kind == AssetKind::Audio && !include_audio)
                || (asset.kind == AssetKind::Source && !include_source)
            {
                asset.status = AssetStatus::ExcludedByUser;
            } else {
                match store.read_asset(&asset.id) {
                    Ok((_, bytes)) => {
                        let relative = format!("assets/{}", asset.id);
                        fs::create_dir_all(temp.path().join("assets"))?;
                        fs::write(temp.path().join(&relative), &bytes)?;
                        files.push(BackupFile {
                            path: relative,
                            bytes: bytes.len() as u64,
                            sha256: digest(&bytes),
                        });
                    }
                    Err(error) if error.code == "MATERIAL_MISSING" => {
                        asset.status = AssetStatus::Missing;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        put(&db, "assets", &asset.id, asset)?;
    }
    for mut task in list::<ModelTask>(&db, "tasks")? {
        task.dataset_id.clear();
        task.generation.clear();
        if task.status == "running" {
            task.status = "interrupted".into();
            task.progress = "备份时任务未结束；已保存内容可查看。".into();
        }
        put(&db, "tasks", &task.id, &task)?;
    }
    let snapshot_counts = counts(&db)?;
    db.execute_batch("VACUUM;")?;
    drop(db);
    let database = fs::read(&db_path)?;
    files.insert(
        0,
        BackupFile {
            path: "data.sqlite".into(),
            bytes: database.len() as u64,
            sha256: digest(&database),
        },
    );
    let manifest = Manifest {
        format: "super-offer".into(),
        format_version: 1,
        schema_version: SCHEMA_VERSION,
        created_at: now(),
        counts: snapshot_counts,
        files,
        assets,
    };
    if manifest.files.iter().map(|f| f.bytes).sum::<u64>() > MAX_EXPANDED {
        return Err(AppError::invalid(
            "备份展开大小超过当前 512 MB 限制，请先减少可选材料。",
        ));
    }
    let backup_id = id();
    let final_path = store
        .root
        .join("backups")
        .join(format!("{backup_id}.superoffer"));
    let temp_file = tempfile::NamedTempFile::new_in(store.root.join("backups"))?;
    let mut writer = zip::ZipWriter::new(temp_file.reopen()?);
    write_zip_file(
        &mut writer,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    for file in &manifest.files {
        write_zip_file(
            &mut writer,
            &file.path,
            &fs::read(temp.path().join(&file.path))?,
        )?;
    }
    let finished = writer.finish()?;
    finished.sync_all()?;
    if finished.metadata()?.len() > MAX_BACKUP_BYTES as u64 {
        return Err(AppError::invalid("压缩备份超过当前 256 MB 限制。"));
    }
    drop(finished);
    // 同一校验路径验证刚生成的包，校验通过才向用户报告导出成功。
    let verify = prepare(store, &fs::read(temp_file.path())?)?;
    drop(verify);
    temp_file
        .persist(&final_path)
        .map_err(|_| AppError::new("WRITE_FAILED", "备份文件未保存，原数据未变。"))?;
    Ok(BackupReceipt {
        id: backup_id,
        path: final_path.to_string_lossy().into_owned(),
        manifest,
    })
}
fn safe_name(name: &str) -> bool {
    name == "data.sqlite"
        || name == "manifest.json"
        || name
            .strip_prefix("assets/")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && !id.contains('/'))
}
pub fn prepare(store: &Store, bytes: &[u8]) -> Result<Prepared> {
    if bytes.is_empty() || bytes.len() > MAX_BACKUP_BYTES {
        return Err(AppError::invalid("备份为空或超过 256 MB。"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    if archive.len() > 10_002 {
        return Err(AppError::invalid("备份条目超过限制。"));
    }
    let mut names = HashSet::new();
    let mut size = 0u64;
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name()?.into_owned();
        if !safe_name(&name)
            || file.enclosed_name().is_none()
            || file.is_symlink()
            || file.encrypted()
            || file.is_dir()
            || !names.insert(name)
        {
            return Err(AppError::invalid("备份含有越界、链接、重复或未知条目。"));
        }
        size = size
            .checked_add(file.size())
            .ok_or_else(|| AppError::invalid("备份大小不正确。"))?;
        if size > MAX_EXPANDED || file.size() > 256 * 1024 * 1024 {
            return Err(AppError::invalid("备份展开大小超过限制。"));
        }
    }
    let manifest_bytes = {
        let mut f = archive.by_name("manifest.json")?;
        if f.size() > 4 * 1024 * 1024 {
            return Err(AppError::invalid("备份清单过大。"));
        }
        let mut b = Vec::new();
        f.by_ref().take(4 * 1024 * 1024 + 1).read_to_end(&mut b)?;
        b
    };
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.format != "super-offer"
        || manifest.format_version != 1
        || manifest.schema_version != SCHEMA_VERSION
    {
        return Err(AppError::new(
            "VERSION_UNSUPPORTED",
            "备份格式或数据版本不兼容，未替换当前数据。",
        ));
    }
    timestamp(&manifest.created_at)?;
    let listed: HashSet<_> = manifest.files.iter().map(|f| f.path.clone()).collect();
    if listed.len() != manifest.files.len()
        || !listed.contains("data.sqlite")
        || listed.contains("manifest.json")
        || listed.len() + 1 != names.len()
        || !listed.iter().all(|n| names.contains(n))
    {
        return Err(AppError::invalid("备份清单与实际文件不一致。"));
    }
    let staged = tempfile::tempdir_in(&store.root)?;
    fs::create_dir(staged.path().join("assets"))?;
    for file in &manifest.files {
        let mut source = archive.by_name(&file.path)?;
        if source.size() != file.bytes {
            return Err(AppError::invalid("备份文件长度不匹配。"));
        }
        let mut content = Vec::new();
        source
            .by_ref()
            .take(file.bytes + 1)
            .read_to_end(&mut content)?;
        if content.len() as u64 != file.bytes || digest(&content) != file.sha256 {
            return Err(AppError::invalid("备份文件校验失败，可能损坏或被修改。"));
        }
        fs::write(staged.path().join(&file.path), content)?;
    }
    let db = validate_database(&staged.path().join("data.sqlite"))?;
    if counts(&db)? != manifest.counts {
        return Err(AppError::invalid("备份对象数量与清单不一致。"));
    }
    let assets = list::<FileAsset>(&db, "assets")?;
    if serde_json::to_value(&assets)? != serde_json::to_value(&manifest.assets)? {
        return Err(AppError::invalid("备份材料状态与清单不一致。"));
    }
    let included: HashSet<_> = assets
        .iter()
        .filter(|a| a.status == AssetStatus::Available)
        .map(|a| format!("assets/{}", a.id))
        .collect();
    if listed
        .iter()
        .filter(|p| p.as_str() != "data.sqlite")
        .cloned()
        .collect::<HashSet<_>>()
        != included
    {
        return Err(AppError::invalid("材料包含状态与实际副本不一致。"));
    }
    for asset in &assets {
        if asset.status == AssetStatus::Available {
            let entry = manifest
                .files
                .iter()
                .find(|f| f.path == format!("assets/{}", asset.id))
                .ok_or_else(|| AppError::invalid("备份缺少材料。"))?;
            if entry.bytes != asset.bytes || entry.sha256 != asset.sha256 {
                return Err(AppError::invalid("备份材料哈希与业务记录不一致。"));
            }
        }
    }
    Ok(Prepared {
        preview: Preview {
            token: id(),
            manifest,
            current_counts: counts(&store.conn)?,
            current_dataset_id: store.dataset_id.clone(),
            current_revision: revision(&store.conn)?,
        },
        staged,
    })
}
fn schema(conn: &Connection) -> Result<Vec<(String, String, String, String)>> {
    Ok(conn.prepare("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<std::result::Result<Vec<_>,_>>()?)
}
pub fn validate_database(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA query_only=ON;")?;
    let mut expected = Connection::open_in_memory()?;
    migrate(&mut expected, include_str!("../migrations/001_initial.sql"))?;
    if db.pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))? != SCHEMA_VERSION
        || schema(&db)? != schema(&expected)?
    {
        return Err(AppError::invalid(
            "数据库结构不符合本版本，拒绝未知表、触发器或迁移。",
        ));
    }
    let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if integrity != "ok" || db.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(AppError::invalid("备份数据库完整性或引用关系校验失败。"));
    }
    revision(&db)?;
    for table in [
        "profile_versions",
        "jobs",
        "applications",
        "events",
        "interviews",
        "assets",
        "tasks",
    ] {
        let mut rows = db.prepare(&format!("SELECT id,data FROM {table}"))?;
        for row in rows.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, data) = row?;
            let data: serde_json::Value = serde_json::from_str(&data)?;
            uuid::Uuid::parse_str(&id).map_err(|_| AppError::invalid("记录标识无效。"))?;
            if data.get("id").and_then(serde_json::Value::as_str) != Some(id.as_str()) {
                return Err(AppError::invalid("记录标识与内容不一致。"));
            }
        }
    }
    let versions = list::<ProfileVersion>(&db, "profile_versions")?;
    for v in &versions {
        v.data.validate()?;
        timestamp(&v.created_at)?;
        let columns: (String, String, Option<String>) = db.query_row(
            "SELECT id,profile_id,resume_asset_id FROM profile_versions WHERE id=?1",
            [&v.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if columns
            != (
                v.id.clone(),
                v.profile_id.clone(),
                v.data.resume_asset_id.clone(),
            )
        {
            return Err(AppError::invalid("档案版本关系不一致。"));
        }
    }
    let mut stmt = db.prepare("SELECT id,current_version_id FROM profiles")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (profile, version) = row?;
        if !versions
            .iter()
            .any(|v| v.id == version && v.profile_id == profile)
        {
            return Err(AppError::invalid("档案当前版本不属于该档案。"));
        }
    }
    drop(stmt);
    for asset in list::<FileAsset>(&db, "assets")? {
        uuid::Uuid::parse_str(&asset.id).map_err(|_| AppError::invalid("材料标识不正确。"))?;
        text(&asset.name, "材料名", true, 240)?;
    }
    for job in list::<JobSnapshot>(&db, "jobs")? {
        job.data.validate()?;
        timestamp(&job.created_at)?;
    }
    for app in list::<Application>(&db, "applications")? {
        let columns: (String, Option<String>) = db.query_row(
            "SELECT job_id,profile_version_id FROM applications WHERE id=?1",
            [&app.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if columns != (app.job_snapshot_id.clone(), app.profile_version_id.clone())
            || (app.stage == Stage::Closed) != app.end_reason.is_some()
        {
            return Err(AppError::invalid("申请关系或结束状态不一致。"));
        }
        let submissions = list::<ApplicationEvent>(&db, "events")?
            .into_iter()
            .filter(|e| e.application_id == app.id && e.kind == "submitted")
            .collect::<Vec<_>>();
        if let Some(at) = &app.confirmed_submitted_at {
            timestamp(at)?;
            if submissions.len() != 1
                || submissions[0].occurred_at != *at
                || submissions[0].source != "user"
                || submissions[0].detail.get("confirmedByUser")
                    != Some(&serde_json::Value::Bool(true))
            {
                return Err(AppError::invalid("提交事实缺少唯一的用户确认事件。"));
            }
        } else if !submissions.is_empty() || app.stage == Stage::Applied {
            return Err(AppError::invalid("未确认提交的申请不能标为已投递。"));
        }
        if let Some(at) = &app.due_at {
            timestamp(at)?;
        }
        timestamp(&app.created_at)?;
        timestamp(&app.updated_at)?;
    }
    for event in list::<ApplicationEvent>(&db, "events")? {
        let owner: String = db.query_row(
            "SELECT application_id FROM events WHERE id=?1",
            [&event.id],
            |r| r.get(0),
        )?;
        if owner != event.application_id {
            return Err(AppError::invalid("时间线所属申请不一致。"));
        }
        let _: Application = get(&db, "applications", &event.application_id)?;
        let _: JobSnapshot = get(&db, "jobs", &event.job_snapshot_id)?;
        if let Some(v) = event.profile_version_id {
            let _: ProfileVersion = get(&db, "profile_versions", &v)?;
        }
        timestamp(&event.occurred_at)?;
        timestamp(&event.recorded_at)?;
    }
    for round in list::<InterviewRound>(&db, "interviews")? {
        let owner: String = db.query_row(
            "SELECT application_id FROM interviews WHERE id=?1",
            [&round.id],
            |r| r.get(0),
        )?;
        if owner != round.application_id {
            return Err(AppError::invalid("面试轮次所属申请不一致。"));
        }
        let _: Application = get(&db, "applications", &round.application_id)?;
        timestamp(&round.scheduled_at)?;
    }
    for provider in list::<ProviderConfig>(&db, "providers")? {
        provider.validate()?;
        let stored: ProviderConfig = get(&db, "providers", provider.purpose.key())?;
        if stored.version != provider.version {
            return Err(AppError::invalid("服务用途与配置标识不一致。"));
        }
    }
    for task in list::<ModelTask>(&db, "tasks")? {
        task.provider.validate()?;
        if task.purpose != task.input.purpose
            || task.purpose != task.provider.purpose
            || task.context_id != task.input.context_id
            || serde_json::to_value(&task.versions)? != serde_json::to_value(&task.input.versions)?
        {
            return Err(AppError::invalid("任务输入或配置用途不一致。"));
        }
        timestamp(&task.started_at)?;
        timestamp(&task.updated_at)?;
        for reference in &task.versions {
            match reference.kind.as_str() {
                "profile_version" => {
                    let _: ProfileVersion = get(&db, "profile_versions", &reference.id)?;
                }
                "job_snapshot" => {
                    let _: JobSnapshot = get(&db, "jobs", &reference.id)?;
                }
                "asset" => {
                    let _: FileAsset = get(&db, "assets", &reference.id)?;
                }
                _ => return Err(AppError::invalid("任务引用类型无效。")),
            }
        }
        if let Some(asset) = &task.input.asset_id {
            let _: FileAsset = get(&db, "assets", asset)?;
        }
        if !["running", "completed", "cancelled", "failed", "interrupted"]
            .contains(&task.status.as_str())
        {
            return Err(AppError::invalid("模型任务状态无效。"));
        }
    }
    Ok(db)
}
pub fn commit(
    store: &mut Store,
    prepared: Prepared,
    token: &str,
    confirmed: bool,
    has_unsaved_edits: bool,
) -> Result<RestoreReceipt> {
    if !confirmed || prepared.preview.token != token {
        return Err(AppError::new(
            "CONFIRMATION_REQUIRED",
            "请先核对恢复范围并明确确认整体替换。",
        ));
    }
    if has_unsaved_edits {
        return Err(AppError::new(
            "UNSAVED_EDITS",
            "请先保存或放弃当前编辑，再恢复备份。",
        ));
    }
    if prepared.preview.current_dataset_id != store.dataset_id
        || prepared.preview.current_revision != revision(&store.conn)?
    {
        return Err(AppError::new(
            "VERSION_CONFLICT",
            "预检后当前数据已改变，请重新选择备份并核对。",
        ));
    }
    if list::<ModelTask>(&store.conn, "tasks")?
        .iter()
        .any(|t| t.status == "running")
    {
        return Err(AppError::new(
            "TASK_ACTIVE",
            "请先停止活动任务，再恢复备份。",
        ));
    }
    let previous_backup = export(store, true, true)?;
    let dataset_id = id();
    let target = store.root.join("datasets").join(&dataset_id);
    fs::create_dir(&target)?;
    fs::create_dir(target.join("assets"))?;
    // 在活动指针切换前完成全部校验、复制和写入；旧目录始终保留。
    for file in &prepared.preview.manifest.files {
        let content = fs::read(prepared.staged.path().join(&file.path))?;
        if content.len() as u64 != file.bytes || digest(&content) != file.sha256 {
            return Err(AppError::invalid("预检材料已改变，未执行恢复。"));
        }
        atomic_write(&target.join(&file.path), &content)?;
    }
    validate_database(&target.join("data.sqlite"))?;
    let mut connection = connect(&target.join("data.sqlite"))?;
    let tx = connection.transaction()?;
    for mut task in list::<ModelTask>(&tx, "tasks")? {
        task.dataset_id = dataset_id.clone();
        task.generation = id();
        if task.status == "running" {
            task.status = "interrupted".into();
        }
        put(&tx, "tasks", &task.id, &task)?;
    }
    bump(&tx)?;
    tx.commit()?;
    atomic_write(&store.root.join("active"), dataset_id.as_bytes())?;
    store.conn = connection;
    store.dataset_id = dataset_id.clone();
    Ok(RestoreReceipt {
        dataset_id,
        previous_backup,
    })
}
pub fn copy_backup(store: &Store, backup_id: &str, destination: &Path) -> Result<()> {
    uuid::Uuid::parse_str(backup_id).map_err(|_| AppError::invalid("备份标识无效。"))?;
    let source: PathBuf = store
        .root
        .join("backups")
        .join(format!("{backup_id}.superoffer"));
    let bytes = fs::read(source)?;
    atomic_write(destination, &bytes)
}
