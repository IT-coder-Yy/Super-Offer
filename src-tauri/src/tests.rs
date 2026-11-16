use crate::{
    backup,
    domain::*,
    files,
    model::{Runtime, SaveProvider},
    store::{self, Store, get, list},
    vault::{SystemVault, Vault},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    (dir, store)
}
fn change(store: &mut Store, value: Value) -> Result<Value> {
    store.mutate(
        &id(),
        &store.dataset_id.clone(),
        serde_json::from_value(value).unwrap(),
    )
}
fn profile(store: &mut Store, name: &str) -> (String, String) {
    let mut data = ProfileData::default();
    data.basic.insert("name".into(), "合成求职者".into());
    data.education.push(Fields::from([
        ("school".into(), "样本大学".into()),
        ("startDate".into(), "2022-09".into()),
        ("endDate".into(), "2026-06".into()),
    ]));
    data.answers.push(Fields::from([
        ("question".into(), "为什么选择该岗位？".into()),
        ("answer".into(), "合成回答，非真实经历。".into()),
    ]));
    let saved=change(store,json!({"kind":"save_profile","profileId":null,"expectedVersionId":null,"name":name,"data":data})).unwrap();
    (
        saved["profileId"].as_str().unwrap().into(),
        saved["versionId"].as_str().unwrap().into(),
    )
}
fn application(store: &mut Store, version: Option<&str>, batch: &str) -> String {
    change(store,json!({"kind":"create_application","job":{"company":"样本公司","title":"AI 开发","channel":"官网","batch":batch,"jd":"合成岗位内容"},"profileVersionId":version,"stage":"saved","duplicateAcknowledged":false})).unwrap()["applicationId"].as_str().unwrap().into()
}
fn update(store: &mut Store, id: &str, stage: &str, end: Option<&str>) -> Result<Value> {
    let app: Application = get(&store.conn, "applications", id)?;
    let job: JobSnapshot = get(&store.conn, "jobs", &app.job_snapshot_id)?;
    change(
        store,
        json!({"kind":"update_application","id":id,"expectedRevision":app.revision,"job":job.data,"profileVersionId":app.profile_version_id,"stage":stage,"endReason":end,"nextAction":"准备一面","dueAt":"2026-11-20T10:00:00+08:00","notes":"合成记录"}),
    )
}
fn zip_entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..zip.len())
        .map(|i| {
            let mut f = zip.by_index(i).unwrap();
            let name = f.name().unwrap().into_owned();
            let mut bytes = vec![];
            f.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        })
        .collect()
}
fn zip_bytes(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn package(store: &Store) -> Vec<u8> {
    fs::read(backup::export(store, true, true).unwrap().path).unwrap()
}

#[test]
fn saved_versions_copy_isolation_and_restart() {
    let (dir, mut s) = fixture();
    let (owner, version) = profile(&mut s, "原档案");
    let copied = change(
        &mut s,
        json!({"kind":"copy_profile","versionId":version,"name":"另一个岗位"}),
    )
    .unwrap();
    let mut data: ProfileVersion = get(
        &s.conn,
        "profile_versions",
        copied["versionId"].as_str().unwrap(),
    )
    .unwrap();
    data.data.answers[0].insert("answer".into(), "独立编辑".into());
    data.data.basic.insert("phone".into(), "13800000000".into());
    change(&mut s,json!({"kind":"save_profile","profileId":copied["profileId"],"expectedVersionId":data.id,"name":"副本新名称","data":data.data})).unwrap();
    let old: ProfileVersion = get(&s.conn, "profile_versions", &version).unwrap();
    assert_eq!(old.data.answers[0]["answer"], "合成回答，非真实经历。");
    drop(s);
    let s = Store::open(dir.path()).unwrap();
    let snap = s.snapshot().unwrap();
    assert_eq!(snap.profiles.len(), 2);
    assert_eq!(
        snap.profiles
            .iter()
            .find(|p| p.id == owner)
            .unwrap()
            .current_version_id,
        version
    );
    assert_eq!(
        snap.profiles
            .iter()
            .map(|p| p.versions.len())
            .sum::<usize>(),
        3
    );
}
#[test]
fn failed_write_version_conflict_and_migration_are_atomic() {
    let (_dir, mut s) = fixture();
    let (owner, version) = profile(&mut s, "保留草稿");
    let before = store::encode(&s.snapshot().unwrap()).unwrap();
    s.conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let mutation = json!({"kind":"save_profile","profileId":owner,"expectedVersionId":version,"name":"未成功","data":ProfileData::default()});
    assert!(change(&mut s, mutation.clone()).is_err());
    assert_eq!(before, store::encode(&s.snapshot().unwrap()).unwrap());
    s.conn.execute_batch("PRAGMA query_only=OFF").unwrap();
    change(&mut s, mutation.clone()).unwrap();
    assert_eq!(
        change(&mut s, mutation).unwrap_err().code,
        "VERSION_CONFLICT"
    );
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    assert!(
        store::migrate(
            &mut db,
            "CREATE TABLE partial(id TEXT); PRAGMA user_version=1; INVALID SQL;"
        )
        .is_err()
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='partial'",
            [],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.pragma_query_value::<u32, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn missing_database_and_newer_schema_never_create_empty_replacement() {
    let (dir, s) = fixture();
    let db = s.dir().join("data.sqlite");
    let pointer = fs::read(dir.path().join("active")).unwrap();
    drop(s);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("PRAGMA user_version=99").unwrap();
    drop(conn);
    assert!(matches!(Store::open(dir.path()),Err(e) if e.code=="VERSION_UNSUPPORTED"));
    fs::rename(&db, db.with_extension("retained")).unwrap();
    assert!(matches!(Store::open(dir.path()),Err(e) if e.code=="DATA_CORRUPT"));
    assert!(!db.exists());
    assert_eq!(pointer, fs::read(dir.path().join("active")).unwrap());
}
#[test]
fn another_process_cannot_open_the_same_workspace_during_restore() {
    let (dir, s) = fixture();
    assert!(matches!(Store::open(dir.path()),Err(e) if e.code=="WORKSPACE_IN_USE"));
    drop(s);
    assert!(Store::open(dir.path()).is_ok());
}
#[test]
fn submission_is_explicit_idempotent_and_independent_of_stage() {
    let (_dir, mut s) = fixture();
    let app = application(&mut s, None, "秋招");
    assert_eq!(
        update(&mut s, &app, "applied", None).unwrap_err().code,
        "SUBMISSION_CONFIRMATION_REQUIRED"
    );
    update(&mut s, &app, "interview", None).unwrap();
    let current: Application = get(&s.conn, "applications", &app).unwrap();
    assert!(current.confirmed_submitted_at.is_none());
    let value = json!({"kind":"confirm_submitted","id":app,"expectedRevision":current.revision,"confirmed":true,"submittedAt":"2026-11-12T08:00:00+08:00"});
    let op = id();
    let dataset = s.dataset_id.clone();
    let first = s
        .mutate(
            &op,
            &dataset,
            serde_json::from_value(value.clone()).unwrap(),
        )
        .unwrap();
    let again = s
        .mutate(&op, &dataset, serde_json::from_value(value).unwrap())
        .unwrap();
    assert_eq!(first, again);
    assert!(update(&mut s, &app, "closed", None).is_err());
    update(&mut s, &app, "closed", Some("joined")).unwrap();
    let snap = s.snapshot().unwrap();
    assert_eq!(
        snap.applications
            .iter()
            .filter(|a| a.confirmed_submitted_at.is_some())
            .count(),
        1
    );
    assert_eq!(
        snap.events.iter().filter(|e| e.kind == "submitted").count(),
        1
    );
    assert_eq!(snap.applications[0].stage, Stage::Closed);
    assert_eq!(snap.applications[0].end_reason, Some(EndReason::Joined));
}
#[test]
fn duplicates_need_acknowledgement_and_interview_rounds_keep_history() {
    let (_dir, mut s) = fixture();
    let app = application(&mut s, None, "秋招");
    let duplicate = json!({"kind":"create_application","job":{"company":"样本公司","title":"AI 开发","channel":"内推","batch":"秋招"},"profileVersionId":null,"stage":"pending","duplicateAcknowledged":false});
    assert_eq!(
        change(&mut s, duplicate.clone()).unwrap_err().code,
        "DUPLICATE_CONFIRMATION"
    );
    let mut acknowledged = duplicate;
    acknowledged["duplicateAcknowledged"] = json!(true);
    change(&mut s, acknowledged).unwrap();
    application(&mut s, None, "春招");
    for n in 1..=2 {
        let current: Application = get(&s.conn, "applications", &app).unwrap();
        change(&mut s,json!({"kind":"save_interview","id":null,"applicationId":app,"expectedRevision":current.revision,"title":format!("技术 {n} 面"),"scheduledAt":format!("2026-11-2{n}T10:00:00+08:00"),"location":"线上","notes":"样本","completed":false})).unwrap();
    }
    let snap = s.snapshot().unwrap();
    assert_eq!(snap.applications.len(), 3);
    assert_eq!(snap.interviews.len(), 2);
    assert_eq!(
        snap.events.iter().filter(|e| e.kind == "interview").count(),
        2
    );
    assert!(
        snap.applications
            .iter()
            .all(|a| a.confirmed_submitted_at.is_none())
    );
}
#[test]
fn material_copies_hash_validation_and_bad_archives() {
    let (dir, mut s) = fixture();
    let source = dir.path().join("original.pdf");
    let bytes = b"%PDF-1.4\nsynthetic storage fixture";
    fs::write(&source, bytes).unwrap();
    let a = s
        .import_asset(
            &s.dataset_id.clone(),
            "resume.pdf",
            bytes,
            AssetKind::Resume,
        )
        .unwrap();
    assert_eq!(s.read_asset(&a.id).unwrap().1, bytes);
    assert_eq!(fs::read(source).unwrap(), bytes);
    fs::write(s.dir().join("assets").join(&a.id), b"changed").unwrap();
    assert_eq!(s.read_asset(&a.id).unwrap_err().code, "MATERIAL_CHANGED");
    assert!(files::validate_resume("bad.docx", b"garbage").is_err());
    assert!(files::validate_resume("bad.pdf", b"not a PDF").is_err());
    assert!(
        files::validate_resume(
            "bad.docx",
            &zip_bytes(vec![("../escape".into(), b"x".to_vec())])
        )
        .is_err()
    );
    assert!(
        s.import_asset(
            &s.dataset_id.clone(),
            "../resume.pdf",
            bytes,
            AssetKind::Resume
        )
        .is_err()
    );
}
#[test]
fn backup_restore_roundtrip_retains_current_backup_and_changes_generation() {
    let (dir, mut s) = fixture();
    let (_dir, v) = profile(&mut s, "备份样本");
    let app = application(&mut s, Some(&v), "秋招");
    update(&mut s, &app, "interview", None).unwrap();
    let original = s.dataset_id.clone();
    let bytes = package(&s);
    profile(&mut s, "恢复后不应合并此档案");
    let preview = backup::prepare(&s, &bytes).unwrap();
    let token = preview.preview.token.clone();
    let receipt = backup::commit(&mut s, preview, &token, true, false).unwrap();
    assert_ne!(s.dataset_id, original);
    assert!(std::path::Path::new(&receipt.previous_backup.path).is_file());
    assert_eq!(s.snapshot().unwrap().profiles.len(), 1);
    assert_eq!(s.snapshot().unwrap().applications.len(), 1);
    let before = backup::prepare(&s, &fs::read(receipt.previous_backup.path).unwrap()).unwrap();
    assert_eq!(before.preview.manifest.counts["profiles"], 2);
    assert_eq!(
        s.mutate(
            &id(),
            &original,
            Mutation::CopyProfile {
                version_id: v,
                name: "过期任务".into()
            }
        )
        .unwrap_err()
        .code,
        "STALE_TASK"
    );
    drop(s);
    let reopened = Store::open(dir.path()).unwrap();
    assert_eq!(reopened.snapshot().unwrap().profiles.len(), 1);
    assert_eq!(
        reopened.snapshot().unwrap().applications[0].stage,
        Stage::Interview
    );
}
#[test]
fn restore_cancel_dirty_stale_and_prebackup_failure_preserve_current_state() {
    let (dir, mut s) = fixture();
    profile(&mut s, "当前");
    let bytes = package(&s);
    let before = store::encode(&s.snapshot().unwrap()).unwrap();
    let prepared = backup::prepare(&s, &bytes).unwrap();
    drop(prepared);
    assert_eq!(before, store::encode(&s.snapshot().unwrap()).unwrap());
    let p = backup::prepare(&s, &bytes).unwrap();
    let token = p.preview.token.clone();
    assert_eq!(
        backup::commit(&mut s, p, &token, true, true)
            .unwrap_err()
            .code,
        "UNSAVED_EDITS"
    );
    let p = backup::prepare(&s, &bytes).unwrap();
    let token = p.preview.token.clone();
    assert_eq!(
        backup::commit(&mut s, p, &token, false, false)
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    let p = backup::prepare(&s, &bytes).unwrap();
    let token = p.preview.token.clone();
    profile(&mut s, "新编辑");
    assert_eq!(
        backup::commit(&mut s, p, &token, true, false)
            .unwrap_err()
            .code,
        "VERSION_CONFLICT"
    );
    let p = backup::prepare(&s, &bytes).unwrap();
    let token = p.preview.token.clone();
    let current = store::encode(&s.snapshot().unwrap()).unwrap();
    fs::rename(
        dir.path().join("backups"),
        dir.path().join("retained-backups"),
    )
    .unwrap();
    fs::write(
        dir.path().join("backups"),
        b"simulate unavailable backup directory",
    )
    .unwrap();
    assert!(backup::commit(&mut s, p, &token, true, false).is_err());
    assert_eq!(current, store::encode(&s.snapshot().unwrap()).unwrap());
}
#[test]
fn restore_staging_failure_keeps_pointer_and_pre_restore_backup() {
    let (dir, mut s) = fixture();
    profile(&mut s, "恢复失败仍保留");
    let bytes = package(&s);
    let p = backup::prepare(&s, &bytes).unwrap();
    let token = p.preview.token.clone();
    fs::write(
        p.staged.path().join("data.sqlite"),
        b"changed after preview",
    )
    .unwrap();
    let pointer = fs::read(dir.path().join("active")).unwrap();
    let before = store::encode(&s.snapshot().unwrap()).unwrap();
    assert!(backup::commit(&mut s, p, &token, true, false).is_err());
    assert_eq!(before, store::encode(&s.snapshot().unwrap()).unwrap());
    assert_eq!(pointer, fs::read(dir.path().join("active")).unwrap());
    assert_eq!(fs::read_dir(dir.path().join("backups")).unwrap().count(), 2);
}
#[test]
fn corrupt_hash_new_version_unknown_entries_and_db_relationships_rejected() {
    let (_dir, mut s) = fixture();
    profile(&mut s, "原数据");
    let bytes = package(&s);
    let entries = zip_entries(&bytes);
    for kind in ["hash", "version", "extra", "missing", "schema", "relation"] {
        let mut entries = entries.clone();
        let mut manifest: Value = serde_json::from_slice(&entries[0].1).unwrap();
        match kind {
            "missing" => {
                entries.pop();
            }
            "hash" => {
                entries.iter_mut().find(|e| e.0 == "data.sqlite").unwrap().1[120] ^= 1;
            }
            "version" => manifest["schemaVersion"] = json!(99),
            "extra" => entries.push(("../outside".into(), b"escape".to_vec())),
            "schema" | "relation" => {
                let temp = tempfile::tempdir().unwrap();
                let dbfile = temp.path().join("edit.sqlite");
                let file = entries.iter_mut().find(|e| e.0 == "data.sqlite").unwrap();
                fs::write(&dbfile, &file.1).unwrap();
                let db = rusqlite::Connection::open(&dbfile).unwrap();
                if kind == "schema" {
                    db.execute_batch("CREATE TRIGGER unknown AFTER INSERT ON profiles BEGIN DELETE FROM assets; END").unwrap();
                } else {
                    db.execute_batch("UPDATE profile_versions SET data=json_set(data,'$.profileId','wrong-owner')").unwrap();
                }
                drop(db);
                file.1 = fs::read(dbfile).unwrap();
                manifest["files"][0]["sha256"] = json!(store::digest(&file.1));
                manifest["files"][0]["bytes"] = json!(file.1.len());
            }
            _ => unreachable!(),
        }
        entries[0].1 = serde_json::to_vec(&manifest).unwrap();
        assert!(backup::prepare(&s, &zip_bytes(entries)).is_err(), "{kind}");
    }
    assert_eq!(s.snapshot().unwrap().profiles.len(), 1);
}
#[test]
fn excluded_and_missing_files_are_explicit_and_allow_further_profile_edits() {
    let (_dir, mut s) = fixture();
    let resume = s
        .import_asset(
            &s.dataset_id.clone(),
            "resume.pdf",
            b"%PDF-1.4 sample",
            AssetKind::Resume,
        )
        .unwrap();
    s.import_asset(
        &s.dataset_id.clone(),
        "audio.wav",
        b"RIFF sample",
        AssetKind::Audio,
    )
    .unwrap();
    let mut data = ProfileData::default();
    data.resume_asset_id = Some(resume.id.clone());
    change(&mut s,json!({"kind":"save_profile","profileId":null,"expectedVersionId":null,"name":"缺文件测试","data":data})).unwrap();
    fs::remove_file(s.dir().join("assets").join(resume.id)).unwrap();
    let receipt = backup::export(&s, false, false).unwrap();
    assert!(
        receipt
            .manifest
            .assets
            .iter()
            .any(|a| a.status == AssetStatus::Missing)
    );
    assert!(
        receipt
            .manifest
            .assets
            .iter()
            .any(|a| a.status == AssetStatus::ExcludedByUser)
    );
    let p = backup::prepare(&s, &fs::read(receipt.path).unwrap()).unwrap();
    let token = p.preview.token.clone();
    backup::commit(&mut s, p, &token, true, false).unwrap();
    let saved = s.snapshot().unwrap().profiles[0].clone();
    change(&mut s,json!({"kind":"save_profile","profileId":saved.id,"expectedVersionId":saved.current_version_id,"name":"继续补资料","data":saved.versions[0].data})).unwrap();
}

#[derive(Default)]
struct MemoryVault {
    values: Mutex<HashMap<String, String>>,
    denied: AtomicBool,
    reject_delete: AtomicBool,
    set_failures: Mutex<usize>,
}
impl Vault for MemoryVault {
    fn get(&self, slot: &str) -> Result<Option<String>> {
        if self.denied.load(Ordering::SeqCst) {
            return Err(AppError::new("KEY_UNAVAILABLE", "合成凭证拒绝"));
        }
        Ok(self.values.lock().unwrap().get(slot).cloned())
    }
    fn set(&self, slot: &str, value: &str) -> Result<()> {
        let mut failures = self.set_failures.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err(AppError::new("KEY_UNAVAILABLE", "合成凭证写入失败"));
        }
        if self.denied.load(Ordering::SeqCst) {
            return Err(AppError::new("KEY_UNAVAILABLE", "合成凭证拒绝"));
        }
        self.values
            .lock()
            .unwrap()
            .insert(slot.into(), value.into());
        Ok(())
    }
    fn delete(&self, slot: &str) -> Result<()> {
        if self.reject_delete.load(Ordering::SeqCst) {
            return Err(AppError::new("KEY_UNAVAILABLE", "合成凭证删除失败"));
        }
        self.values.lock().unwrap().remove(slot);
        Ok(())
    }
}
fn provider_update(config: &ProviderConfig, key: Option<&str>, remove_key: bool) -> SaveProvider {
    SaveProvider {
        purpose: config.purpose,
        name: config.name.clone(),
        endpoint: config.endpoint.clone(),
        model: config.model.clone(),
        expected_version: Some(config.version.clone()),
        key: key.map(str::to_owned),
        remove_key,
    }
}

#[test]
fn rejected_key_deletion_preserves_config_and_retry_for_removal_and_replacement() {
    for remove in [true, false] {
        let (_dir, s) = fixture();
        let vault = Arc::new(MemoryVault::default());
        let runtime = Runtime::new(s, vault.clone(), Arc::new(|_| {}));
        let config = provider(&runtime, Purpose::Chat, "https://example.test/chat");
        let dataset = runtime.lock().unwrap().dataset_id.clone();
        let slot = Runtime::slot(&runtime.lock().unwrap(), &config);
        let before = runtime.lock().unwrap().snapshot().unwrap();
        vault.reject_delete.store(true, Ordering::SeqCst);
        let error = runtime
            .save_provider(
                &dataset,
                provider_update(&config, Some("replacement-fixture"), remove),
            )
            .unwrap_err();
        assert_eq!(error.code, "KEY_UNAVAILABLE");
        let after = runtime.lock().unwrap().snapshot().unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.providers[0].version, config.version);
        assert_eq!(vault.values.lock().unwrap().len(), 1);
        assert_eq!(
            vault.get(&slot).unwrap().as_deref(),
            Some("synthetic-key-not-real")
        );
        assert!(runtime.provider_status().unwrap()[0].has_key);
        vault.reject_delete.store(false, Ordering::SeqCst);
        let saved = runtime
            .save_provider(
                &dataset,
                provider_update(&config, Some("replacement-fixture"), remove),
            )
            .unwrap();
        assert_ne!(saved.version, config.version);
        assert!(vault.get(&slot).unwrap().is_none());
        assert_eq!(runtime.provider_status().unwrap()[0].has_key, !remove);
        assert_eq!(vault.values.lock().unwrap().len(), usize::from(!remove));
    }
}

#[test]
fn key_write_failure_restores_old_key_and_allows_retry() {
    let (_dir, s) = fixture();
    let vault = Arc::new(MemoryVault::default());
    let runtime = Runtime::new(s, vault.clone(), Arc::new(|_| {}));
    let config = provider(&runtime, Purpose::Chat, "https://example.test/chat");
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    let slot = Runtime::slot(&runtime.lock().unwrap(), &config);
    *vault.set_failures.lock().unwrap() = 1;
    assert_eq!(
        runtime
            .save_provider(
                &dataset,
                provider_update(&config, Some("replacement-fixture"), false)
            )
            .unwrap_err()
            .code,
        "KEY_UNAVAILABLE"
    );
    assert_eq!(
        runtime.lock().unwrap().snapshot().unwrap().providers[0].version,
        config.version
    );
    assert_eq!(
        vault.get(&slot).unwrap().as_deref(),
        Some("synthetic-key-not-real")
    );
    assert_eq!(vault.values.lock().unwrap().len(), 1);
    runtime
        .save_provider(&dataset, provider_update(&config, None, false))
        .unwrap();
    assert!(runtime.provider_status().unwrap()[0].has_key);
    assert_eq!(vault.values.lock().unwrap().len(), 1);
}

#[test]
fn failed_database_commit_compensates_keys_and_reports_failed_compensation() {
    for (remove, fail_recovery) in [(false, false), (true, false), (true, true)] {
        let (_dir, s) = fixture();
        let vault = Arc::new(MemoryVault::default());
        let runtime = Runtime::new(s, vault.clone(), Arc::new(|_| {}));
        let config = provider(&runtime, Purpose::Chat, "https://example.test/chat");
        let dataset = runtime.lock().unwrap().dataset_id.clone();
        let slot = Runtime::slot(&runtime.lock().unwrap(), &config);
        let before = runtime.lock().unwrap().snapshot().unwrap().revision;
        // 延迟外键约束在 COMMIT 时失败，覆盖凭证操作成功之后的补偿路径。
        runtime.lock().unwrap().conn.execute_batch(
            "CREATE TEMP TABLE fault_parent(id INTEGER PRIMARY KEY);
             CREATE TEMP TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TEMP TRIGGER fail_commit AFTER UPDATE ON providers BEGIN INSERT INTO fault_child VALUES(1); END;"
        ).unwrap();
        if fail_recovery {
            *vault.set_failures.lock().unwrap() = 1;
        }
        let error = runtime
            .save_provider(
                &dataset,
                provider_update(&config, Some("replacement-fixture"), remove),
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            if fail_recovery {
                "KEY_RECOVERY_FAILED"
            } else {
                "WRITE_FAILED"
            }
        );
        let after = runtime.lock().unwrap().snapshot().unwrap();
        assert_eq!(after.providers[0].version, config.version);
        assert_eq!(after.revision, before);
        assert_eq!(
            vault.get(&slot).unwrap().as_deref(),
            if fail_recovery {
                None
            } else {
                Some("synthetic-key-not-real")
            }
        );
        assert_eq!(
            vault.values.lock().unwrap().len(),
            usize::from(!fail_recovery)
        );
        runtime
            .lock()
            .unwrap()
            .conn
            .execute_batch("DROP TRIGGER fail_commit;")
            .unwrap();
        runtime
            .save_provider(
                &dataset,
                provider_update(&config, Some("retry-fixture"), false),
            )
            .unwrap();
        assert!(runtime.provider_status().unwrap()[0].has_key);
        assert_eq!(vault.values.lock().unwrap().len(), 1);
    }
}
fn provider(runtime: &Runtime, purpose: Purpose, endpoint: &str) -> ProviderConfig {
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    runtime
        .save_provider(
            &dataset,
            SaveProvider {
                purpose,
                name: format!("fixture {}", purpose.key()),
                endpoint: endpoint.into(),
                model: "fixture-model".into(),
                expected_version: None,
                key: Some("synthetic-key-not-real".into()),
                remove_key: false,
            },
        )
        .unwrap()
}
fn input(purpose: Purpose, stream: bool) -> TaskInput {
    TaskInput {
        purpose,
        context_id: format!("fixture:{}", purpose.key()),
        text: if purpose == Purpose::Chat {
            "合成请求".into()
        } else {
            String::new()
        },
        asset_id: None,
        stream,
        versions: vec![],
    }
}
fn server(
    status: &str,
    content_type: &str,
    body: &str,
    delay: Duration,
) -> (
    String,
    std::sync::mpsc::Receiver<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/fixture", listener.local_addr().unwrap());
    let status = status.to_owned();
    let content_type = content_type.to_owned();
    let body = body.as_bytes().to_vec();
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        let mut data = Vec::new();
        let mut part = [0; 4096];
        loop {
            let n = socket.read(&mut part).unwrap();
            if n == 0 {
                break;
            }
            data.extend_from_slice(&part[..n]);
            if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
                let len = headers
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if data.len() >= end + 4 + len {
                    break;
                }
            }
        }
        tx.send(data).unwrap();
        std::thread::sleep(delay);
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        if socket.write_all(header.as_bytes()).is_ok() {
            for chunk in body.chunks(7) {
                if socket.write_all(chunk).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    });
    (endpoint, rx, handle)
}
async fn finished(runtime: &Runtime, id: &str) -> ModelTask {
    for _ in 0..200 {
        let task = get::<ModelTask>(&runtime.lock().unwrap().conn, "tasks", id).unwrap();
        if task.status != "running" {
            return task;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("fixture task timeout")
}
#[tokio::test]
async fn chat_normal_sse_and_asr_record_actual_usage_and_multipart() {
    for (purpose, stream, body) in [
        (
            Purpose::Chat,
            false,
            r#"{"choices":[{"message":{"content":"普通中文结果"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}"#,
        ),
        (
            Purpose::Chat,
            true,
            "data: {\"choices\":[{\"delta\":{\"content\":\"流式中文\"}}]}\r\n\r\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":5,\"total_tokens\":7}}\n\ndata: [DONE]\n\n",
        ),
        (Purpose::Asr, false, r#"{"text":"合成转写结果"}"#),
    ] {
        let (_dir, s) = fixture();
        let runtime = Runtime::new(s, Arc::new(MemoryVault::default()), Arc::new(|_| {}));
        let (url, rx, worker) = server(
            "200 OK",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
            body,
            Duration::ZERO,
        );
        provider(&runtime, purpose, &url);
        let dataset = runtime.lock().unwrap().dataset_id.clone();
        let mut task_input = input(purpose, stream);
        if purpose == Purpose::Asr {
            let asset = runtime
                .lock()
                .unwrap()
                .import_asset(
                    &dataset,
                    "test.wav",
                    b"RIFF synthetic audio",
                    AssetKind::Audio,
                )
                .unwrap();
            task_input.asset_id = Some(asset.id.clone());
            task_input.versions.push(VersionRef {
                kind: "asset".into(),
                id: asset.id,
            });
        }
        let task = runtime.start(&dataset, task_input).unwrap();
        let result = finished(&runtime, &task.id).await;
        assert_eq!(result.status, "completed", "{:?}", result.error);
        assert!(!result.content.is_empty());
        assert!(result.usage.cost.is_none());
        if purpose == Purpose::Chat {
            assert_eq!(result.usage.total_tokens, Some(7));
        } else {
            assert!(result.usage.total_tokens.is_none());
        }
        let sent =
            String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(3)).unwrap()).into_owned();
        assert!(sent.contains("Bearer synthetic-key-not-real"));
        if purpose == Purpose::Asr {
            assert!(sent.contains("multipart/form-data"));
            assert!(sent.contains("name=\"model\""));
            assert!(sent.contains("filename=\"test.wav\""));
        }
        worker.join().unwrap();
    }
}
#[tokio::test]
async fn service_errors_are_safe_and_interrupted_stream_keeps_partial_content() {
    for (status, body, stream, code) in [
        ("401 Unauthorized", "secret raw body", false, "SERVICE_AUTH"),
        (
            "429 Too Many Requests",
            "secret raw body",
            false,
            "SERVICE_RATE_LIMIT",
        ),
        (
            "200 OK",
            "data: {\"choices\":[{\"delta\":{\"content\":\"已收到部分\"}}]}\n\n",
            true,
            "SERVICE_FAILED",
        ),
    ] {
        let (_dir, s) = fixture();
        let runtime = Runtime::new(s, Arc::new(MemoryVault::default()), Arc::new(|_| {}));
        let (url, _rx, worker) = server(status, "text/event-stream", body, Duration::ZERO);
        provider(&runtime, Purpose::Chat, &url);
        let dataset = runtime.lock().unwrap().dataset_id.clone();
        let task = runtime
            .start(&dataset, input(Purpose::Chat, stream))
            .unwrap();
        let result = finished(&runtime, &task.id).await;
        assert_eq!(result.status, "failed");
        assert_eq!(result.error.as_ref().unwrap().code, code);
        assert!(!store::encode(&result).unwrap().contains("secret raw body"));
        if stream {
            assert_eq!(result.content, "已收到部分");
        }
        worker.join().unwrap();
    }
}
#[tokio::test]
async fn cancellation_late_generation_replacement_and_restart_are_isolated() {
    let (dir, s) = fixture();
    let runtime = Runtime::new(s, Arc::new(MemoryVault::default()), Arc::new(|_| {}));
    let (url, _rx, worker) = server(
        "200 OK",
        "application/json",
        r#"{"choices":[{"message":{"content":"晚到结果"}}]}"#,
        Duration::from_millis(300),
    );
    provider(&runtime, Purpose::Chat, &url);
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    let task = runtime
        .start(&dataset, input(Purpose::Chat, false))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    runtime
        .change_task(&task, |t| t.content = "已收到".into())
        .unwrap();
    runtime.cancel(&dataset, &task.id).unwrap();
    assert!(
        !runtime
            .change_task(&task, |t| t.content = "不应写入".into())
            .unwrap()
    );
    worker.join().unwrap();
    let ended = get::<ModelTask>(&runtime.lock().unwrap().conn, "tasks", &task.id).unwrap();
    assert_eq!(ended.content, "已收到");
    assert_eq!(ended.status, "cancelled");
    let mut pending = ended.clone();
    pending.id = id();
    pending.status = "running".into();
    pending.generation = id();
    store::put(
        &runtime.lock().unwrap().conn,
        "tasks",
        &pending.id,
        &pending,
    )
    .unwrap();
    let mut stale = pending.clone();
    stale.generation = id();
    assert!(
        !runtime
            .change_task(&stale, |t| t.content = "stale".into())
            .unwrap()
    );
    tokio::task::yield_now().await;
    drop(runtime);
    let s = Store::open(dir.path()).unwrap();
    let interrupted: ModelTask = get(&s.conn, "tasks", &pending.id).unwrap();
    assert_eq!(interrupted.status, "interrupted");
    assert_eq!(interrupted.content, "已收到");
}
#[test]
fn key_vault_failure_is_atomic_and_backups_contain_no_key_or_slot() {
    let (_dir, s) = fixture();
    let vault = Arc::new(MemoryVault::default());
    let runtime = Runtime::new(s, vault.clone(), Arc::new(|_| {}));
    let config = provider(&runtime, Purpose::Chat, "http://127.0.0.1:1/chat");
    provider(&runtime, Purpose::Asr, "http://127.0.0.1:2/asr");
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    let slot = Runtime::slot(&runtime.lock().unwrap(), &config);
    vault.denied.store(true, Ordering::SeqCst);
    assert_eq!(
        runtime
            .save_provider(
                &dataset,
                SaveProvider {
                    purpose: Purpose::Chat,
                    name: "failed".into(),
                    endpoint: config.endpoint.clone(),
                    model: "new".into(),
                    expected_version: Some(config.version.clone()),
                    key: Some("new-secret".into()),
                    remove_key: false
                }
            )
            .unwrap_err()
            .code,
        "KEY_UNAVAILABLE"
    );
    assert_eq!(
        list::<ProviderConfig>(&runtime.lock().unwrap().conn, "providers").unwrap()[0].version,
        config.version
    );
    vault.denied.store(false, Ordering::SeqCst);
    let task_input = input(Purpose::Chat, false);
    let task = ModelTask {
        id: id(),
        context_id: task_input.context_id.clone(),
        generation: id(),
        dataset_id: dataset.clone(),
        purpose: Purpose::Chat,
        provider: config.clone(),
        versions: vec![],
        input: task_input,
        status: "running".into(),
        progress: "合成运行中".into(),
        content: "保留的部分内容".into(),
        usage: Usage::default(),
        error: None,
        started_at: now(),
        updated_at: now(),
    };
    store::put(&runtime.lock().unwrap().conn, "tasks", &task.id, &task).unwrap();
    let bytes = package(&runtime.lock().unwrap());
    for (_, content) in zip_entries(&bytes) {
        let text = String::from_utf8_lossy(&content);
        assert!(!text.contains("synthetic-key-not-real"));
        assert!(!text.contains(&slot));
        assert!(!text.contains(&dataset));
    }
    let blocked = backup::prepare(&runtime.lock().unwrap(), &bytes).unwrap();
    let token = blocked.preview.token.clone();
    assert_eq!(
        backup::commit(&mut runtime.lock().unwrap(), blocked, &token, true, false)
            .unwrap_err()
            .code,
        "TASK_ACTIVE"
    );
    runtime.cancel(&dataset, &task.id).unwrap();
    let p = backup::prepare(&runtime.lock().unwrap(), &bytes).unwrap();
    let token = p.preview.token.clone();
    backup::commit(&mut runtime.lock().unwrap(), p, &token, true, false).unwrap();
    assert!(
        !runtime
            .change_task(&task, |t| t.content = "旧数据集晚到内容".into())
            .unwrap()
    );
    assert!(
        runtime
            .provider_status()
            .unwrap()
            .iter()
            .all(|p| !p.has_key)
    );
}
#[test]
#[ignore = "需显式运行，仅创建和删除唯一合成凭证，不访问用户已有凭证"]
fn system_vault_roundtrip() {
    let vault = SystemVault;
    let slot = format!("s1-fixture-{}", id());
    vault.set(&slot, "synthetic-not-a-real-api-key").unwrap();
    let result = vault.get(&slot);
    let cleanup = vault.delete(&slot);
    assert_eq!(
        result.unwrap().as_deref(),
        Some("synthetic-not-a-real-api-key")
    );
    cleanup.unwrap();
    assert!(vault.get(&slot).unwrap().is_none());
}
