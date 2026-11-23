use crate::{
    backup,
    domain::*,
    model::{Runtime, SaveProvider},
    retrieval,
    source::{Evidence, SourceCommand, SourceHost, SourceVersion},
    store::{Store, digest, encode, get, list, put},
    vault::Vault,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};

fn change(store: &mut Store, value: Value) -> Value {
    store
        .mutate(
            &id(),
            &store.dataset_id.clone(),
            serde_json::from_value(value).unwrap(),
        )
        .unwrap()
}

fn add_profile(store: &mut Store, name: &str) -> (String, FileAsset) {
    let asset = store
        .import_asset(
            &store.dataset_id.clone(),
            "合成简历.pdf",
            b"%PDF-1.4\nsynthetic backup fixture",
            AssetKind::Resume,
        )
        .unwrap();
    let data = ProfileData {
        basic: Fields::from([("name".into(), "合成求职者".into())]),
        resume_asset_id: Some(asset.id.clone()),
        ..ProfileData::default()
    };
    let result = change(
        store,
        json!({"kind":"save_profile", "profileId":null,
        "expectedVersionId":null, "name":name, "data":data}),
    );
    (result["profileId"].as_str().unwrap().into(), asset)
}

fn schema_version(conn: &Connection) -> u32 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn dataset_hashes(dir: &Path) -> BTreeMap<String, String> {
    let mut hashes = BTreeMap::from([(
        "data.sqlite".into(),
        digest(&fs::read(dir.join("data.sqlite")).unwrap()),
    )]);
    for entry in fs::read_dir(dir.join("assets")).unwrap() {
        let entry = entry.unwrap();
        hashes.insert(
            format!("assets/{}", entry.file_name().to_str().unwrap()),
            digest(&fs::read(entry.path()).unwrap()),
        );
    }
    hashes
}

// 用真实 S1 写入逻辑生成业务记录，再移除空的 002 表，严格校验其结构与 001 一致。
fn legacy_workspace() -> (tempfile::TempDir, String, String, FileAsset) {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (profile, asset) = add_profile(&mut store, "旧版档案");
    let dataset = store.dataset_id.clone();
    let db_path = store.dir().join("data.sqlite");
    drop(store);
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "DROP TABLE interview_reports; DROP TABLE interview_sessions;
        DROP TABLE evidence; DROP TABLE source_files; DROP TABLE source_versions;
        DROP TABLE fill_runs; PRAGMA user_version=1; VACUUM;",
    )
    .unwrap();
    drop(conn);
    assert_eq!(
        schema_version(&backup::validate_database(&db_path).unwrap()),
        1
    );
    (root, dataset, profile, asset)
}

#[test]
fn v1_startup_backs_up_before_migrating_a_new_dataset_and_preserves_original_files() {
    let (root, old_id, profile, asset) = legacy_workspace();
    let old_dir = root.path().join("datasets").join(&old_id);
    let hashes = dataset_hashes(&old_dir);
    let store = Store::open(root.path()).unwrap();
    assert_ne!(store.dataset_id, old_id);
    assert_eq!(schema_version(&store.conn), 2);
    assert_eq!(
        fs::read_to_string(root.path().join("active")).unwrap(),
        store.dataset_id
    );
    assert_eq!(dataset_hashes(&old_dir), hashes);
    assert_eq!(
        schema_version(&backup::validate_database(&old_dir.join("data.sqlite")).unwrap()),
        1
    );
    assert_eq!(store.snapshot().unwrap().profiles[0].id, profile);
    assert_eq!(
        digest(&store.read_asset(&asset.id).unwrap().1),
        asset.sha256
    );

    let backups = fs::read_dir(root.path().join("backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1, "迁移必须先生成一个有效的旧版备份");
    let prepared = backup::prepare_path(&store, &backups[0]).unwrap();
    assert_eq!(prepared.preview.manifest.format_version, 1);
    assert_eq!(prepared.preview.manifest.schema_version, 1);
    assert_eq!(prepared.preview.manifest.counts.len(), 10);
    assert_eq!(
        schema_version(
            &backup::validate_database(&prepared.staged.path().join("data.sqlite")).unwrap()
        ),
        1
    );
    drop(prepared);

    let destination = tempfile::tempdir().unwrap();
    let mut restored = Store::open(destination.path()).unwrap();
    let (discarded, _) = add_profile(&mut restored, "恢复前档案，不应合并");
    let previous_id = restored.dataset_id.clone();
    let previous_hashes = dataset_hashes(&restored.dir());
    let prepared = backup::prepare_path(&restored, &backups[0]).unwrap();
    let token = prepared.preview.token.clone();
    let receipt = backup::commit(&mut restored, prepared, &token, true, false).unwrap();
    assert_ne!(receipt.dataset_id, previous_id);
    assert_eq!(schema_version(&restored.conn), 2);
    let profiles = restored.snapshot().unwrap().profiles;
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id, profile);
    assert_ne!(profiles[0].id, discarded);
    assert_eq!(receipt.previous_backup.manifest.schema_version, 2);
    assert_eq!(
        dataset_hashes(&destination.path().join("datasets").join(previous_id)),
        previous_hashes
    );
    assert_eq!(
        digest(&restored.read_asset(&asset.id).unwrap().1),
        asset.sha256
    );
    let restored_id = restored.dataset_id.clone();
    drop(restored);
    assert_eq!(
        Store::open(destination.path()).unwrap().dataset_id,
        restored_id
    );
}

#[test]
fn failed_v1_upgrade_keeps_the_active_pointer_database_and_assets() {
    for failure in [
        "backup_destination",
        "unknown_schema",
        "asset_hash",
        "future_version",
    ] {
        let (root, dataset, _, asset) = legacy_workspace();
        let dir = root.path().join("datasets").join(&dataset);
        match failure {
            "backup_destination" => {
                fs::write(root.path().join("backups"), b"synthetic obstruction").unwrap()
            }
            "unknown_schema" => Connection::open(dir.join("data.sqlite"))
                .unwrap()
                .execute_batch("CREATE TABLE unexpected (value TEXT);")
                .unwrap(),
            "asset_hash" => fs::write(
                dir.join("assets").join(asset.id),
                b"changed synthetic bytes",
            )
            .unwrap(),
            "future_version" => Connection::open(dir.join("data.sqlite"))
                .unwrap()
                .execute_batch("PRAGMA user_version=3;")
                .unwrap(),
            _ => unreachable!(),
        }
        let active = fs::read(root.path().join("active")).unwrap();
        let hashes = dataset_hashes(&dir);
        let error = Store::open(root.path())
            .err()
            .expect("无效旧数据不能激活新数据集");
        if failure == "future_version" {
            assert_eq!(error.code, "VERSION_UNSUPPORTED");
        }
        assert_eq!(
            fs::read(root.path().join("active")).unwrap(),
            active,
            "{failure}"
        );
        assert_eq!(dataset_hashes(&dir), hashes, "{failure}");
    }
}

#[test]
fn changed_prepared_files_are_rechecked_before_active_switch() {
    for changed in ["database", "asset", "current_asset"] {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        let (_, asset) = add_profile(&mut store, "当前档案");
        let receipt = backup::export(&store, true, true).unwrap();
        let prepared = backup::prepare_path(&store, Path::new(&receipt.path)).unwrap();
        let token = prepared.preview.token.clone();
        let target = match changed {
            "database" => prepared.staged.path().join("data.sqlite"),
            "asset" => prepared.staged.path().join("assets").join(&asset.id),
            "current_asset" => store.dir().join("assets").join(&asset.id),
            _ => unreachable!(),
        };
        let mut bytes = fs::read(&target).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&target, bytes).unwrap();
        let old_id = store.dataset_id.clone();
        let hashes = dataset_hashes(&store.dir());
        let active = fs::read(root.path().join("active")).unwrap();
        assert!(
            backup::commit(&mut store, prepared, &token, true, false).is_err(),
            "{changed}"
        );
        assert_eq!(store.dataset_id, old_id, "{changed}");
        assert_eq!(
            fs::read(root.path().join("active")).unwrap(),
            active,
            "{changed}"
        );
        assert_eq!(dataset_hashes(&store.dir()), hashes, "{changed}");
    }
}

struct NoVault;
impl Vault for NoVault {
    fn get(&self, _: &str) -> Result<Option<String>> {
        panic!("备份测试不能访问凭证")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        panic!("备份测试不能写入凭证")
    }
    fn delete(&self, _: &str) -> Result<()> {
        panic!("备份测试不能删除凭证")
    }
}

struct ProjectFixture {
    _root: tempfile::TempDir,
    original: tempfile::TempDir,
    runtime: Arc<Runtime>,
    version: SourceVersion,
    evidence: Evidence,
    session: Value,
    report: Value,
    resume: FileAsset,
}

fn project_fixture() -> ProjectFixture {
    let root = tempfile::tempdir().unwrap();
    let original = tempfile::tempdir().unwrap();
    fs::create_dir(original.path().join("src")).unwrap();
    fs::write(
        original.path().join("src/main.rs"),
        "fn verified_marker() -> u32 {\n    7\n}\n",
    )
    .unwrap();
    let mut store = Store::open(root.path()).unwrap();
    let (_, resume) = add_profile(&mut store, "备份测试档案");
    let dataset = store.dataset_id.clone();
    let runtime = Runtime::new(store, Arc::new(NoVault), Arc::new(|_| {}));
    let host = Arc::new(SourceHost::new());
    let selection = host
        .select(&dataset, original.path().to_path_buf(), true)
        .unwrap();
    let version: SourceVersion = serde_json::from_value(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Import {
                token: selection.token,
                project_id: None,
                name: "只读合成项目".into(),
                operation_id: id(),
            },
        )
        .unwrap(),
    )
    .unwrap();
    let version: SourceVersion = serde_json::from_value(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::SetScope {
                version_id: version.id,
                expected_scope_version: version.scope_version,
                paths: vec!["src/main.rs".into()],
                confirmed: true,
            },
        )
        .unwrap(),
    )
    .unwrap();
    let store = runtime.lock().unwrap();
    let evidence = retrieval::search(&store, &version.id, "verified_marker", 5, false)
        .unwrap()
        .remove(0)
        .evidence;
    let session_id = id();
    let report_id = id();
    let task_id = id();
    let provider = ProviderConfig {
        purpose: Purpose::Chat,
        name: "合成配置，不调用网络".into(),
        endpoint: "https://example.invalid/v1".into(),
        model: "fixture".into(),
        version: id(),
    };
    // 仅构造已保存的合成问答/报告验证备份关系；不把它算作真实模型效果验收。
    let session = json!({
        "id":session_id, "revision":1, "createdAt":now(), "updatedAt":now(),
        "applicationId":null, "profileVersionId":null, "jobSnapshotId":null,
        "sources":[{"versionId":version.id,"scopeVersion":version.scope_version}],
        "contribution":"合成测试，不声明个人贡献", "role":"Rust 开发", "stage":"项目面试", "focus":"返回值",
        "mode":"simulation", "questionCount":1, "provider":provider, "status":"completed", "draft":"保留的合成草稿",
        "turns":[{"id":id(),"mainNumber":1,"followUp":0,"question":"verified_marker 返回什么？",
            "evidenceIds":[evidence.id],"answer":{"id":id(),"text":"源码返回 7。","disposition":"answer","savedAt":now()},"closed":true}],
        "pending":null,"reportIds":[report_id],"finished":true,"partial":"","error":null,"repracticeOf":null
    });
    let report = json!({"id":report_id,"sessionId":session_id,"createdAt":now(),"mainNumber":null,"taskId":task_id,
        "content":{"summary":"合成回答与保存的片段一致。","referenceAnswer":"函数返回 7。",
            "points":[{"category":"strength","basis":"source_fact","answerQuote":"源码返回 7。",
                "observation":"该回答得到所引版本的源码支持。","action":"","evidenceIds":[evidence.id]}],
            "weaknesses":[]},"evidenceIds":[evidence.id]});
    let references = vec![
        VersionRef {
            kind: "source_version".into(),
            id: version.id.clone(),
        },
        VersionRef {
            kind: "source_scope".into(),
            id: format!("{}:{}", version.id, version.scope_version),
        },
        VersionRef {
            kind: "evidence".into(),
            id: evidence.id.clone(),
        },
    ];
    let task = ModelTask {
        id: task_id,
        context_id: format!("interview:{session_id}"),
        generation: id(),
        dataset_id: dataset,
        purpose: Purpose::Chat,
        provider,
        versions: references.clone(),
        input: TaskInput {
            purpose: Purpose::Chat,
            context_id: format!("interview:{session_id}"),
            text: "合成已保存任务".into(),
            asset_id: None,
            stream: false,
            versions: references,
        },
        status: "completed".into(),
        progress: "已完成合成任务".into(),
        content: encode(&report["content"]).unwrap(),
        usage: Usage::default(),
        error: None,
        started_at: now(),
        updated_at: now(),
    };
    put(&store.conn, "tasks", &task.id, &task).unwrap();
    store
        .conn
        .execute(
            "INSERT INTO interview_sessions(id,application_id,data) VALUES (?1,NULL,?2)",
            params![session_id, encode(&session).unwrap()],
        )
        .unwrap();
    store
        .conn
        .execute(
            "INSERT INTO interview_reports(id,session_id,data) VALUES (?1,?2,?3)",
            params![report_id, session_id, encode(&report).unwrap()],
        )
        .unwrap();
    backup::validate_database(&store.dir().join("data.sqlite")).unwrap();
    drop(store);
    ProjectFixture {
        _root: root,
        original,
        runtime,
        version,
        evidence,
        session,
        report,
        resume,
    }
}

#[test]
fn v2_roundtrip_preserves_answers_evidence_and_reports_with_or_without_source() {
    for material in ["included", "excluded", "missing"] {
        let fixture = project_fixture();
        let store = fixture.runtime.lock().unwrap();
        let source_asset: FileAsset =
            get(&store.conn, "assets", &fixture.version.asset_id).unwrap();
        if material == "missing" {
            fs::remove_file(store.asset_path(&source_asset).unwrap()).unwrap();
        }
        let original_hash = digest(&fs::read(fixture.original.path().join("src/main.rs")).unwrap());
        let backup = backup::export(&store, true, material != "excluded").unwrap();
        assert_eq!(
            (
                backup.manifest.format_version,
                backup.manifest.schema_version
            ),
            (2, 2)
        );
        assert_eq!(backup.manifest.counts["evidence"], 1);
        assert_eq!(backup.manifest.counts["interview_reports"], 1);
        let expected_status = match material {
            "included" => AssetStatus::Available,
            "excluded" => AssetStatus::ExcludedByUser,
            "missing" => AssetStatus::Missing,
            _ => unreachable!(),
        };
        assert_eq!(
            backup
                .manifest
                .assets
                .iter()
                .find(|asset| asset.id == source_asset.id)
                .unwrap()
                .status,
            expected_status
        );
        assert_eq!(
            backup
                .manifest
                .files
                .iter()
                .any(|file| file.path == format!("assets/{}", source_asset.id)),
            material == "included"
        );
        let destination = tempfile::tempdir().unwrap();
        let mut restored = Store::open(destination.path()).unwrap();
        let prepared = backup::prepare_path(&restored, Path::new(&backup.path)).unwrap();
        let token = prepared.preview.token.clone();
        backup::commit(&mut restored, prepared, &token, true, false).unwrap();
        let evidence: Value = get(&restored.conn, "evidence", &fixture.evidence.id).unwrap();
        assert_eq!(evidence, json!(fixture.evidence));
        let report: Value = get(
            &restored.conn,
            "interview_reports",
            fixture.report["id"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(report, fixture.report);
        let session: Value = get(
            &restored.conn,
            "interview_sessions",
            fixture.session["id"].as_str().unwrap(),
        )
        .unwrap();
        for field in ["turns", "reportIds", "draft", "finished", "sources"] {
            assert_eq!(
                session[field], fixture.session[field],
                "{material}: {field}"
            );
        }
        let version: SourceVersion =
            get(&restored.conn, "source_versions", &fixture.version.id).unwrap();
        assert!(version.allowed_paths.is_empty(), "恢复不能沿用旧的外发授权");
        assert_ne!(version.scope_version, fixture.version.scope_version);
        assert!(
            version
                .scope_history
                .iter()
                .any(|scope| scope.id == fixture.version.scope_version
                    && scope.paths == vec!["src/main.rs"])
        );
        let tasks = list::<ModelTask>(&restored.conn, "tasks").unwrap();
        assert_eq!(tasks[0].dataset_id, restored.dataset_id);
        assert!(!tasks[0].generation.is_empty());
        if material == "included" {
            assert_eq!(
                digest(&restored.read_asset(&source_asset.id).unwrap().1),
                source_asset.sha256
            );
            assert_eq!(
                retrieval::search(&restored, &version.id, "verified_marker", 5, false).unwrap()[0]
                    .evidence
                    .id,
                fixture.evidence.id
            );
        } else {
            assert_eq!(
                restored.read_asset(&source_asset.id).unwrap_err().code,
                "MATERIAL_MISSING"
            );
            assert_eq!(
                retrieval::search(&restored, &version.id, "verified_marker", 5, false)
                    .unwrap_err()
                    .code,
                "MATERIAL_MISSING"
            );
        }
        assert_eq!(
            digest(&fs::read(fixture.original.path().join("src/main.rs")).unwrap()),
            original_hash
        );
        backup::validate_database(&restored.dir().join("data.sqlite")).unwrap();
    }
}

#[test]
fn v2_rejects_mismatched_relational_columns_and_record_ids() {
    let fixture = project_fixture();
    let mut store = fixture.runtime.lock().unwrap();
    let path = store.dir().join("data.sqlite");
    let application = change(
        &mut store,
        json!({"kind":"create_application",
        "job":{"company":"合成公司","title":"测试岗位","channel":"官网","batch":"合成批次","jd":"合成岗位"},
        "profileVersionId":null,"stage":"saved","duplicateAcknowledged":false}),
    );
    let other_id = id();
    let mut other_session = fixture.session.clone();
    other_session["id"] = json!(other_id);
    other_session["reportIds"] = json!([]);
    store
        .conn
        .execute(
            "INSERT INTO interview_sessions(id,application_id,data) VALUES(?1,NULL,?2)",
            params![other_id, encode(&other_session).unwrap()],
        )
        .unwrap();
    backup::validate_database(&path).unwrap();
    let file_id = store
        .conn
        .query_row("SELECT id FROM source_files LIMIT 1", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap();
    let cases = [
        (
            "source asset column",
            "UPDATE source_versions SET asset_id=?1 WHERE id=?2",
            json!(fixture.resume.id),
            fixture.version.id.clone(),
            json!(fixture.version.asset_id),
        ),
        (
            "source file id",
            "UPDATE source_files SET data=json_set(data,'$.id',?1) WHERE id=?2",
            json!(id()),
            file_id.clone(),
            json!(file_id),
        ),
        (
            "evidence id",
            "UPDATE evidence SET data=json_set(data,'$.id',?1) WHERE id=?2",
            json!("0".repeat(64)),
            fixture.evidence.id.clone(),
            json!(fixture.evidence.id),
        ),
        (
            "interview application column",
            "UPDATE interview_sessions SET application_id=?1 WHERE id=?2",
            application["applicationId"].clone(),
            fixture.session["id"].as_str().unwrap().into(),
            Value::Null,
        ),
        (
            "interview report session column",
            "UPDATE interview_reports SET session_id=?1 WHERE id=?2",
            json!(other_id),
            fixture.report["id"].as_str().unwrap().into(),
            fixture.session["id"].clone(),
        ),
        (
            "interview session id",
            "UPDATE interview_sessions SET data=json_set(data,'$.id',?1) WHERE id=?2",
            json!(id()),
            other_id.clone(),
            json!(other_id),
        ),
    ];
    let mut accepted = Vec::new();
    for (name, sql, changed, record_id, original) in cases {
        store
            .conn
            .execute(sql, params![changed.as_str(), record_id])
            .unwrap();
        if backup::validate_database(&path).is_ok() {
            accepted.push(name);
        }
        store
            .conn
            .execute(sql, params![original.as_str(), record_id])
            .unwrap();
        backup::validate_database(&path).unwrap();
    }
    assert!(
        accepted.is_empty(),
        "备份不能接受不一致的列或主键: {accepted:?}"
    );
}

#[test]
fn v2_rejects_missing_or_changed_evidence_and_fabricated_report_quotes() {
    let fixture = project_fixture();
    let store = fixture.runtime.lock().unwrap();
    let path = store.dir().join("data.sqlite");
    let evidence = encode(&fixture.evidence).unwrap();
    store
        .conn
        .execute("DELETE FROM evidence WHERE id=?1", [&fixture.evidence.id])
        .unwrap();
    assert!(backup::validate_database(&path).is_err());
    store
        .conn
        .execute(
            "INSERT INTO evidence(id,source_version_id,data) VALUES (?1,?2,?3)",
            params![fixture.evidence.id, fixture.version.id, evidence],
        )
        .unwrap();
    store
        .conn
        .execute(
            "UPDATE evidence SET data=json_set(data,'$.text','changed quote') WHERE id=?1",
            [&fixture.evidence.id],
        )
        .unwrap();
    assert!(backup::validate_database(&path).is_err());
    store
        .conn
        .execute(
            "UPDATE evidence SET data=?1 WHERE id=?2",
            params![evidence, fixture.evidence.id],
        )
        .unwrap();
    store.conn.execute("UPDATE interview_reports SET data=json_set(data,'$.content.points[0].answerQuote','用户未说过的话')", []).unwrap();
    assert!(backup::validate_database(&path).is_err());
}

#[test]
fn future_backup_manifest_is_rejected_without_changing_current_workspace() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    add_profile(&mut store, "当前");
    let backup = backup::export(&store, true, true).unwrap();
    let before = dataset_hashes(&store.dir());
    let active = fs::read(root.path().join("active")).unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(backup.path).unwrap()).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        let name = file.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        if name == "manifest.json" {
            let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
            manifest["formatVersion"] = json!(3);
            manifest["schemaVersion"] = json!(3);
            bytes = serde_json::to_vec(&manifest).unwrap();
        }
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    assert_eq!(
        backup::prepare(&store, &bytes).err().unwrap().code,
        "VERSION_UNSUPPORTED"
    );
    assert_eq!(dataset_hashes(&store.dir()), before);
    assert_eq!(fs::read(root.path().join("active")).unwrap(), active);
}

fn pr2_import(runtime: &Arc<Runtime>, path: &Path, directory: bool) -> SourceVersion {
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    let host = Arc::new(SourceHost::new());
    let selected = host
        .select(&dataset, path.to_path_buf(), directory)
        .unwrap();
    serde_json::from_value(
        host.handle(
            runtime,
            &dataset,
            SourceCommand::Import {
                token: selected.token,
                project_id: None,
                name: "PR2 合成只读项目".into(),
                operation_id: id(),
            },
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn pr2_case_distinct_directory_files_can_be_backed_up_and_restored() {
    let original = tempfile::tempdir().unwrap();
    // Some volumes fold these names together; probe without overwriting either original.
    let names = ["\u{0130}.rs", "i\u{0307}.rs"];
    for (index, (name, content)) in names
        .iter()
        .zip(["const UPPER: u8 = 1;", "const LOWER: u8 = 2;"])
        .enumerate()
    {
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(original.path().join(name))
        {
            Ok(file) => file,
            Err(error) if index == 1 && error.kind() == std::io::ErrorKind::AlreadyExists => {
                eprintln!(
                    "PR2 case: skipped directory sample: this volume cannot represent both names; ZIP roundtrip remains covered separately"
                );
                return;
            }
            Err(error) => panic!("cannot create case-distinct fixture: {error}"),
        };
        file.write_all(content.as_bytes()).unwrap();
    }
    assert_eq!(fs::read_dir(original.path()).unwrap().count(), 2);
    assert_ne!(
        fs::read(original.path().join(names[0])).unwrap(),
        fs::read(original.path().join(names[1])).unwrap()
    );
    let root = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        Arc::new(NoVault),
        Arc::new(|_| {}),
    );
    let version = pr2_import(&runtime, original.path(), true);
    let store = runtime.lock().unwrap();
    assert_eq!(version.readable_files, 2);
    eprintln!("PR2 case: directory imported two distinct readable source paths");
    let receipt = backup::export(&store, true, true).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let mut restored = Store::open(destination.path()).unwrap();
    let prepared = backup::prepare_path(&restored, Path::new(&receipt.path)).unwrap();
    let token = prepared.preview.token.clone();
    backup::commit(&mut restored, prepared, &token, true, false).unwrap();
    let files = crate::source::files_for(&restored.conn, &version.id).unwrap();
    assert_eq!(files.len(), 2);
    let asset: FileAsset = get(&restored.conn, "assets", &version.asset_id).unwrap();
    let mut archive =
        zip::ZipArchive::new(Cursor::new(restored.read_asset(&asset.id).unwrap().1)).unwrap();
    for name in names {
        let mut content = Vec::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_end(&mut content)
            .unwrap();
        assert_eq!(content, fs::read(original.path().join(name)).unwrap());
    }
}

#[test]
fn pr2_missing_submodule_is_reported_for_directory_and_zip() {
    let mut missing = Vec::new();
    for directory in [true, false] {
        let original = tempfile::tempdir().unwrap();
        let declarations = "[submodule \"missing\"]\n path = deps/missing\n url = https://example.invalid/missing.git\n";
        let selected = if directory {
            fs::write(original.path().join(".gitmodules"), declarations).unwrap();
            fs::write(original.path().join("main.rs"), "fn main() {}\n").unwrap();
            original.path().to_path_buf()
        } else {
            let path = original.path().join("source.zip");
            let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, text) in [(".gitmodules", declarations), ("main.rs", "fn main() {}\n")] {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(text.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
            path
        };
        let root = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            Store::open(root.path()).unwrap(),
            Arc::new(NoVault),
            Arc::new(|_| {}),
        );
        let version = pr2_import(&runtime, &selected, directory);
        let store = runtime.lock().unwrap();
        let files = crate::source::files_for(&store.conn, &version.id).unwrap();
        eprintln!(
            "PR2 submodule: directory={directory}, readable={}, gaps={}",
            version.readable_files,
            files
                .iter()
                .filter(|file| file.status != "readable")
                .count()
        );
        if !files.iter().any(|file| {
            file.path == "deps/missing/"
                && file.status == "failed"
                && file.reason.contains("子模块")
        }) {
            missing.push(directory);
        }
        backup::export(&store, true, true).unwrap();
    }
    assert!(
        missing.is_empty(),
        "缺失子模块清单缺口，directory={missing:?}"
    );
}

#[test]
fn pr2_case_distinct_zip_paths_are_kept_as_archive_paths() {
    let original = tempfile::tempdir().unwrap();
    let path = original.path().join("case.zip");
    let entries = [
        ("Readme.rs", "const FIRST: u8 = 1;"),
        ("readme.rs", "const SECOND: u8 = 2;"),
        ("Src/task.rs", "const UPPER_DIR: u8 = 3;"),
        ("src/task.rs", "const LOWER_DIR: u8 = 4;"),
        ("\u{0130}.rs", "const UNICODE_UPPER: u8 = 5;"),
        ("i\u{0307}.rs", "const UNICODE_LOWER: u8 = 6;"),
    ];
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (name, content) in entries {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    let original_hash = digest(&fs::read(&path).unwrap());
    let root = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        Arc::new(NoVault),
        Arc::new(|_| {}),
    );
    let version = pr2_import(&runtime, &path, false);
    assert_eq!(version.readable_files, entries.len());
    let store = runtime.lock().unwrap();
    let receipt = backup::export(&store, true, true).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let mut restored = Store::open(destination.path()).unwrap();
    let prepared = backup::prepare_path(&restored, Path::new(&receipt.path)).unwrap();
    let token = prepared.preview.token.clone();
    backup::commit(&mut restored, prepared, &token, true, false).unwrap();
    assert_eq!(
        crate::source::files_for(&restored.conn, &version.id)
            .unwrap()
            .len(),
        entries.len()
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(
        restored.read_asset(&version.asset_id).unwrap().1,
    ))
    .unwrap();
    for (name, content) in entries {
        let mut saved = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut saved)
            .unwrap();
        assert_eq!(saved, content);
    }
    assert_eq!(digest(&fs::read(&path).unwrap()), original_hash);
}

#[derive(Default)]
struct Pr2Vault(Mutex<BTreeMap<String, String>>);
impl Vault for Pr2Vault {
    fn get(&self, slot: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(slot).cloned())
    }
    fn set(&self, slot: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(slot.into(), value.into());
        Ok(())
    }
    fn delete(&self, slot: &str) -> Result<()> {
        self.0.lock().unwrap().remove(slot);
        Ok(())
    }
}

#[test]
fn pr2_local_upgrade_keeps_credentials_but_external_restore_does_not() {
    let root = tempfile::tempdir().unwrap();
    let vault = Arc::new(Pr2Vault::default());
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        vault.clone(),
        Arc::new(|_| {}),
    );
    let dataset = runtime.lock().unwrap().dataset_id.clone();
    let config = runtime
        .save_provider(
            &dataset,
            SaveProvider {
                purpose: Purpose::Chat,
                name: "本机合成配置".into(),
                endpoint: "https://example.invalid/v1".into(),
                model: "synthetic".into(),
                expected_version: None,
                key: Some("synthetic-pr2-key-only".into()),
                remove_key: false,
            },
        )
        .unwrap();
    assert!(runtime.provider_status().unwrap()[0].has_key);
    let old_slot = Runtime::slot(&runtime.lock().unwrap(), &config);
    drop(runtime);
    let old_dir = root.path().join("datasets").join(&dataset);
    let conn = Connection::open(old_dir.join("data.sqlite")).unwrap();
    conn.execute_batch("DROP TABLE interview_reports; DROP TABLE interview_sessions; DROP TABLE evidence; DROP TABLE source_files; DROP TABLE source_versions; DROP TABLE fill_runs; PRAGMA user_version=1; VACUUM;").unwrap();
    drop(conn);
    let original_hashes = dataset_hashes(&old_dir);
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        vault.clone(),
        Arc::new(|_| {}),
    );
    assert_ne!(runtime.lock().unwrap().dataset_id, dataset);
    assert_eq!(dataset_hashes(&old_dir), original_hashes);
    let has_key = runtime.provider_status().unwrap()[0].has_key;
    eprintln!("PR2 credential: after real Store::open v1-to-v2 upgrade has_key={has_key}");
    assert!(has_key, "同机升级后应仍能使用原系统凭证命名空间");
    assert_eq!(Runtime::slot(&runtime.lock().unwrap(), &config), old_slot);
    let v1_backup = fs::read_dir(root.path().join("backups"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let v1_backup_hash = digest(&fs::read(&v1_backup).unwrap());
    drop(runtime);
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        vault.clone(),
        Arc::new(|_| {}),
    );
    assert!(
        runtime.provider_status().unwrap()[0].has_key,
        "重启后仍保留同机凭证"
    );
    let receipt = backup::export(&runtime.lock().unwrap(), true, true).unwrap();
    assert!(
        receipt
            .manifest
            .files
            .iter()
            .all(|file| file.path != crate::store::CREDENTIAL_NAMESPACE_FILE)
    );
    let mut portable = zip::ZipArchive::new(fs::File::open(&receipt.path).unwrap()).unwrap();
    assert!(
        portable
            .by_name(crate::store::CREDENTIAL_NAMESPACE_FILE)
            .is_err()
    );
    {
        let mut store = runtime.lock().unwrap();
        let prepared = backup::prepare_path(&store, Path::new(&receipt.path)).unwrap();
        // Even a staged, unlisted local sidecar must not be copied during an external restore.
        fs::write(
            prepared
                .staged
                .path()
                .join(crate::store::CREDENTIAL_NAMESPACE_FILE),
            &dataset,
        )
        .unwrap();
        let token = prepared.preview.token.clone();
        backup::commit(&mut store, prepared, &token, true, false).unwrap();
        assert_ne!(Runtime::slot(&store, &config), old_slot);
    }
    assert!(
        !runtime.provider_status().unwrap()[0].has_key,
        "同机导入外部备份也不能复用旧凭证"
    );
    assert_eq!(
        vault.0.lock().unwrap().len(),
        1,
        "迁移及恢复不复制或删除凭证"
    );
    {
        let mut store = runtime.lock().unwrap();
        let prepared = backup::prepare_path(&store, &v1_backup).unwrap();
        assert_eq!(prepared.preview.manifest.schema_version, 1);
        let token = prepared.preview.token.clone();
        backup::commit(&mut store, prepared, &token, true, false).unwrap();
    }
    assert!(
        !runtime.provider_status().unwrap()[0].has_key,
        "外部旧版备份恢复不能等同于同机升级"
    );
    assert_eq!(digest(&fs::read(&v1_backup).unwrap()), v1_backup_hash);
    drop(runtime);
    let runtime = Runtime::new(
        Store::open(root.path()).unwrap(),
        vault.clone(),
        Arc::new(|_| {}),
    );
    assert!(
        !runtime.provider_status().unwrap()[0].has_key,
        "外部恢复重启后也不沿用旧凭证"
    );

    let mut injected = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..portable.len() {
        let mut entry = portable.by_index(index).unwrap();
        injected
            .start_file(
                entry.name().unwrap(),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        std::io::copy(&mut entry, &mut injected).unwrap();
    }
    injected
        .start_file(
            crate::store::CREDENTIAL_NAMESPACE_FILE,
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    injected.write_all(dataset.as_bytes()).unwrap();
    let injection = injected.finish().unwrap().into_inner();
    let store = runtime.lock().unwrap();
    let active = fs::read(root.path().join("active")).unwrap();
    assert!(
        backup::prepare(&store, &injection).is_err(),
        "外部备份不能夹带本地凭证命名空间"
    );
    assert_eq!(fs::read(root.path().join("active")).unwrap(), active);
}

#[test]
fn pr2_submodule_coverage_checks_real_path_boundaries_without_executing_or_fetching() {
    for directory in [true, false] {
        let original = tempfile::tempdir().unwrap();
        let entries = [
            (
                "bundle/.gitmodules",
                "[submodule \"existing\"]\n path = libs/present\n fetchRecurseSubmodules\n[submodule \"quoted\"]\n path = \"libs/with space\" # comment\n[submodule \"absent\"]\n path = libs/absent\n[submodule \"empty\"]\n path = libs/empty\n[submodule \"excluded\"]\n path = vendor/excluded\n",
            ),
            ("bundle/main.rs", "fn synthetic_only() {}\n"),
            ("bundle/libs/present/main.rs", "fn present() {}\n"),
            ("bundle/libs/with space/main.rs", "fn quoted() {}\n"),
            (
                "bundle/libs/absent-neighbour/main.rs",
                "fn not_the_submodule() {}\n",
            ),
            ("bundle/vendor/excluded/main.rs", "fn excluded() {}\n"),
            (
                "bundle/libs/present/.gitmodules",
                "[submodule \"nested-missing\"]\n path = nested\n",
            ),
            (
                "malformed/.gitmodules",
                "[submodule \"escape\"]\n path = ../../outside\n",
            ),
        ];
        let path = if directory {
            for (name, content) in entries {
                let path = original.path().join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }
            fs::create_dir_all(original.path().join("bundle/libs/empty")).unwrap();
            original.path().to_path_buf()
        } else {
            let path = original.path().join("project.zip");
            let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, content) in entries {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer
                .add_directory(
                    "bundle/libs/empty/",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.finish().unwrap();
            path
        };
        let root = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            Store::open(root.path()).unwrap(),
            Arc::new(NoVault),
            Arc::new(|_| {}),
        );
        let version = pr2_import(&runtime, &path, directory);
        let store = runtime.lock().unwrap();
        let files = crate::source::files_for(&store.conn, &version.id).unwrap();
        let missing = files
            .iter()
            .filter(|file| file.status == "failed" && file.reason.contains("声明的子模块"))
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            missing,
            [
                "bundle/libs/absent/",
                "bundle/libs/empty/",
                "bundle/libs/present/nested/",
                "bundle/vendor/excluded/"
            ],
            "directory={directory}"
        );
        assert!(files.iter().any(|file| file.path == "malformed/.gitmodules"
            && file.status == "failed"
            && file.reason.contains("子模块声明无法完整核对")));
        assert!(!files.iter().any(|file| file.path.contains("../")));
        assert_eq!(version.total_files, files.len());
        backup::export(&store, true, true).unwrap();
    }
}

#[test]
fn pr2_source_archive_still_rejects_exact_duplicates_and_traversal() {
    for (names, duplicate) in [
        (["sameA.rs", "sameB.rs"], true),
        (["../outside.rs", "safe.rs"], false),
        (["/absolute.rs", "safe.rs"], false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in names {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"fn synthetic() {}\n").unwrap();
        }
        let mut bytes = writer.finish().unwrap().into_inner();
        if duplicate {
            for index in 0..bytes.len() - 8 {
                if &bytes[index..index + 8] == b"sameB.rs" {
                    bytes[index + 4] = b'A';
                }
            }
        }
        let path = root.path().join("bad.zip");
        fs::write(&path, bytes).unwrap();
        let data = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            Store::open(data.path()).unwrap(),
            Arc::new(NoVault),
            Arc::new(|_| {}),
        );
        let dataset = runtime.lock().unwrap().dataset_id.clone();
        let host = Arc::new(SourceHost::new());
        let selection = host.select(&dataset, path, false).unwrap();
        assert!(
            host.handle(
                &runtime,
                &dataset,
                SourceCommand::Import {
                    token: selection.token,
                    project_id: None,
                    name: "拒绝坏包".into(),
                    operation_id: id()
                }
            )
            .is_err()
        );
        assert!(
            list::<SourceVersion>(&runtime.lock().unwrap().conn, "source_versions")
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn pr2_portable_backup_rejects_identical_duplicate_entries() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    add_profile(&mut store, "完全同名条目合成测试");
    let receipt = backup::export(&store, true, true).unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&receipt.path).unwrap()).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut manifest = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        if name == "manifest.json" {
            manifest = bytes.clone();
        }
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer
        .start_file("duplicate.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(&manifest).unwrap();
    let mut bytes = writer.finish().unwrap().into_inner();
    for index in 0..bytes.len() - 13 {
        if &bytes[index..index + 13] == b"duplicate.txt" {
            bytes[index..index + 13].copy_from_slice(b"manifest.json");
        }
    }
    assert!(
        zip::ZipArchive::new(Cursor::new(&bytes))
            .unwrap()
            .has_duplicate_names()
    );
    let active = fs::read(root.path().join("active")).unwrap();
    let before = dataset_hashes(&store.dir());
    assert!(
        backup::prepare(&store, &bytes).is_err(),
        "整库包不能接受被库内部折叠的完全同名条目"
    );
    assert_eq!(fs::read(root.path().join("active")).unwrap(), active);
    assert_eq!(dataset_hashes(&store.dir()), before);
}

#[test]
fn pr2_invalid_local_credential_namespace_does_not_rewrite_data() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path()).unwrap();
    add_profile(&mut store, "损坏本地关联测试");
    let dir = store.dir();
    let active = fs::read(root.path().join("active")).unwrap();
    drop(store);
    let before = dataset_hashes(&dir);
    fs::write(
        dir.join(crate::store::CREDENTIAL_NAMESPACE_FILE),
        b"not-a-valid-namespace",
    )
    .unwrap();
    assert_eq!(Store::open(root.path()).err().unwrap().code, "DATA_CORRUPT");
    assert_eq!(fs::read(root.path().join("active")).unwrap(), active);
    assert_eq!(dataset_hashes(&dir), before);
}
