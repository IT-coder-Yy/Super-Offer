use crate::{
    backup,
    domain::*,
    model::Runtime,
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
    sync::Arc,
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
