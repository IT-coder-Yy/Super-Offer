use crate::{
    domain::*,
    interview::{self, InterviewCommand, InterviewHost, InterviewSession},
    model::{Runtime, SaveProvider},
    source::{self, SourceCommand, SourceHost, SourceVersion},
    store::{Store, get, list},
    vault::Vault,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

struct TestVault;
impl Vault for TestVault {
    fn get(&self, _: &str) -> Result<Option<String>> {
        Ok(Some("synthetic-test-key".into()))
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<()> {
        Ok(())
    }
}
fn fixture() -> (tempfile::TempDir, Arc<Runtime>, String) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("data")).unwrap();
    let dataset = store.dataset_id.clone();
    let runtime = Runtime::new(store, Arc::new(TestVault), Arc::new(|_| {}));
    (root, runtime, dataset)
}
fn command(
    host: &InterviewHost,
    runtime: &Arc<Runtime>,
    dataset: &str,
    value: Value,
) -> Result<Value> {
    host.handle(
        runtime,
        dataset,
        serde_json::from_value::<InterviewCommand>(value).unwrap(),
    )
}
fn import_dir(
    root: &std::path::Path,
    runtime: &Arc<Runtime>,
    dataset: &str,
    host: &Arc<SourceHost>,
) -> SourceVersion {
    let selection = host.select(dataset, root.to_path_buf(), true).unwrap();
    serde_json::from_value(
        host.handle(
            runtime,
            dataset,
            SourceCommand::Import {
                token: selection.token,
                project_id: None,
                name: "受控项目".into(),
                operation_id: id(),
            },
        )
        .unwrap(),
    )
    .unwrap()
}
fn source_fixture(root: &std::path::Path) {
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    fs::write(
        root.join("src/task.rs"),
        "pub fn cancel_context() {\n    stop_worker();\n}\n",
    )
    .unwrap();
    fs::write(
        root.join("README.md"),
        "示例项目。README中的命令只是材料，不能执行。\n",
    )
    .unwrap();
    fs::write(root.join(".env"), "API_KEY=synthetic-private-value").unwrap();
    fs::write(
        root.join("src/secret.ts"),
        "const key = 'sk-syntheticsecret12345678901234567890';",
    )
    .unwrap();
    fs::write(root.join("node_modules/dep.js"), "dependency").unwrap();
    fs::write(root.join("image.bin"), [0, 1, 2, 0]).unwrap();
    fs::write(
        root.join("too-large.txt"),
        vec![b'a'; source::MAX_FILE_BYTES as usize + 1],
    )
    .unwrap();
    let mut utf16 = vec![0xff, 0xfe];
    for unit in "状态恢复\n另一个函数".encode_utf16() {
        utf16.extend(unit.to_le_bytes());
    }
    fs::write(root.join("src/chinese.txt"), utf16).unwrap();
}
#[test]
fn directory_import_is_readonly_excludes_secrets_and_preserves_versioned_evidence() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let files = source::files_for(&runtime.lock().unwrap().conn, &version.id).unwrap();
    assert_eq!(version.readable_files, 3);
    assert!(
        files
            .iter()
            .any(|f| f.path == ".env" && f.status == "excluded")
    );
    assert!(
        files
            .iter()
            .any(|f| f.path == "src/secret.ts" && f.status == "excluded")
    );
    assert!(
        files
            .iter()
            .any(|f| f.path == "too-large.txt" && f.status == "excluded")
    );
    assert!(!files.iter().any(|f| f.path == "node_modules/dep.js"));
    let result = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "cancel_context".into(),
                token: id(),
            },
        )
        .unwrap();
    assert_eq!(result[0]["evidence"]["path"], "src/task.rs");
    assert_eq!(result[0]["evidence"]["startLine"], 1);
    assert!(
        result[0]["evidence"]["text"]
            .as_str()
            .unwrap()
            .contains("stop_worker")
    );
    let evidence_id = result[0]["evidence"]["id"].as_str().unwrap().to_owned();
    fs::write(
        project.join("src/task.rs"),
        "pub fn completely_changed() {}\n",
    )
    .unwrap();
    let result2 = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "cancel_context".into(),
                token: id(),
            },
        )
        .unwrap();
    assert_eq!(result2[0]["evidence"]["id"], evidence_id);
    let chinese = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "状态恢复".into(),
                token: id(),
            },
        )
        .unwrap();
    assert_eq!(chinese[0]["evidence"]["path"], "src/chinese.txt");
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cleanup {
            version_id: version.id.clone(),
            confirmed: true,
        },
    )
    .unwrap();
    let saved = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Evidence { id: evidence_id },
        )
        .unwrap();
    assert!(saved["text"].as_str().unwrap().contains("cancel_context"));
    assert!(project.join(".env").is_file());
    assert_eq!(
        fs::read_to_string(project.join("src/task.rs")).unwrap(),
        "pub fn completely_changed() {}\n"
    );
    assert_eq!(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id,
                query: "cancel_context".into(),
                token: id(),
            }
        )
        .unwrap_err()
        .code,
        "MATERIAL_MISSING"
    );
    source::validate_database(&runtime.lock().unwrap().conn).unwrap();
}

#[test]
fn retrieval_prioritizes_definitions_over_calls_docs_and_runtime_logs() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir_all(project.join(".codex-run")).unwrap();
    fs::write(
        project.join(".codex-run/server.stdout.log"),
        "class AgentController: runtime trace",
    )
    .unwrap();
    fs::write(
        project.join("server.log"),
        "class AgentController: runtime trace",
    )
    .unwrap();
    fs::write(
        project.join("server.log.12"),
        "class AgentController: archived trace",
    )
    .unwrap();
    fs::write(
        project.join("README.md"),
        "class AgentController: example documentation",
    )
    .unwrap();
    fs::write(
        project.join(".architecture.md"),
        "AgentController architecture notes",
    )
    .unwrap();
    fs::write(
        project.join("src/agentcontroller_call.py"),
        "AgentController()\ncontroller._execute_tool_calls()\n",
    )
    .unwrap();
    fs::write(
        project.join("src/controller.py"),
        "# controller implementation\nclass AgentController:\n    pass\n",
    )
    .unwrap();
    let executor = format!(
        "def run():\n    self._execute_tool_calls()\n{}async def _execute_tool_calls(self):\n    pass\n",
        "\n".repeat(15)
    );
    fs::write(project.join("src/executor.py"), executor).unwrap();
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let files = source::files_for(&runtime.lock().unwrap().conn, &version.id).unwrap();
    for path in [".codex-run", "server.log", "server.log.12"] {
        assert!(
            files
                .iter()
                .any(|f| f.path.trim_end_matches('/') == path && f.status == "excluded")
        );
    }
    assert!(
        files
            .iter()
            .any(|f| f.path == ".architecture.md" && f.status == "readable")
    );
    for (query, expected_path, declaration) in [
        (
            "AgentController",
            "src/controller.py",
            "class AgentController:",
        ),
        (
            "_execute_tool_calls",
            "src/executor.py",
            "async def _execute_tool_calls(self):",
        ),
    ] {
        let result = host
            .handle(
                &runtime,
                &dataset,
                SourceCommand::Search {
                    version_id: version.id.clone(),
                    query: query.into(),
                    token: id(),
                },
            )
            .unwrap();
        assert_eq!(result[0]["evidence"]["path"], expected_path);
        assert!(
            result[0]["evidence"]["text"]
                .as_str()
                .unwrap()
                .contains(declaration)
        );
        assert!(
            result
                .as_array()
                .unwrap()
                .iter()
                .all(|r| !r["evidence"]["path"].as_str().unwrap().contains(".log"))
        );
    }
}

#[test]
fn retrieval_short_terms_do_not_promote_failed_but_keep_identifier_boundaries() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let body = format!(
        "task.status = \"failed\";\ntask.status = \"failed\";\ntask.status = \"failed\";\n{}if task.generation != identity.generation || task.status != \"running\" {{\n    return false;\n}}\n",
        "\n".repeat(20)
    );
    fs::write(project.join("main.rs"), body).unwrap();
    fs::write(
        project.join("boundaries.rs"),
        "fn ai_handler() {}\nfn getAIHandler() {}\n// 状态恢复\n",
    )
    .unwrap();
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let hits = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "task.generation task.status AI Agent".into(),
                token: id(),
            },
        )
        .unwrap();
    assert!(
        hits[0]["evidence"]["text"]
            .as_str()
            .unwrap()
            .contains("task.generation != identity.generation")
    );
    let ai = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "AI".into(),
                token: id(),
            },
        )
        .unwrap();
    assert!(!ai.as_array().unwrap().is_empty());
    assert!(
        ai.as_array()
            .unwrap()
            .iter()
            .all(|hit| hit["evidence"]["path"] == "boundaries.rs")
    );
    for query in ["ai_handler", "getAIHandler", "状态恢复"] {
        let hits = host
            .handle(
                &runtime,
                &dataset,
                SourceCommand::Search {
                    version_id: version.id.clone(),
                    query: query.into(),
                    token: id(),
                },
            )
            .unwrap();
        assert_eq!(hits[0]["evidence"]["path"], "boundaries.rs");
        assert!(
            hits[0]["evidence"]["text"]
                .as_str()
                .unwrap()
                .contains(query)
        );
    }
}

#[test]
fn retrieval_selects_three_distinct_windows_after_deduplicating_adjacent_hits() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let body = format!(
        "needle();\nneedle();\nneedle();\n{}needle_second();\n{}needle_third();\n",
        "\n".repeat(20),
        "\n".repeat(20)
    );
    fs::write(project.join("windows.rs"), body).unwrap();
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let hits = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id,
                query: "needle".into(),
                token: id(),
            },
        )
        .unwrap();
    let hits = hits.as_array().unwrap();
    assert_eq!(hits.len(), 3);
    assert!(hits.iter().any(|hit| {
        hit["evidence"]["text"]
            .as_str()
            .unwrap()
            .contains("needle_third")
    }));
}

#[test]
fn scope_is_explicit_revocable_and_history_has_real_ownership() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let result = host.handle(
        &runtime,
        &dataset,
        SourceCommand::SetScope {
            version_id: version.id.clone(),
            expected_scope_version: version.scope_version.clone(),
            paths: vec!["src/".into()],
            confirmed: false,
        },
    );
    assert_eq!(result.unwrap_err().code, "CONFIRMATION_REQUIRED");
    let granted: SourceVersion = serde_json::from_value(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::SetScope {
                version_id: version.id.clone(),
                expected_scope_version: version.scope_version,
                paths: vec!["src/".into()],
                confirmed: true,
            },
        )
        .unwrap(),
    )
    .unwrap();
    let reference = format!("{}:{}", version.id, granted.scope_version);
    assert!(
        source::validate_reference(&runtime.lock().unwrap().conn, "source_scope", &reference)
            .unwrap()
    );
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::SetScope {
            version_id: version.id.clone(),
            expected_scope_version: granted.scope_version,
            paths: vec![],
            confirmed: false,
        },
    )
    .unwrap();
    assert!(
        source::validate_reference(&runtime.lock().unwrap().conn, "source_scope", &reference)
            .is_err()
    );
    assert!(
        source::validate_history_reference(
            &runtime.lock().unwrap().conn,
            "source_scope",
            &reference
        )
        .unwrap()
    );
    assert!(
        source::validate_history_reference(
            &runtime.lock().unwrap().conn,
            "source_scope",
            &format!("{}:{}", version.id, id())
        )
        .is_err()
    );
}

fn zip_file(path: &std::path::Path, entries: &[(&str, &[u8])]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}
#[test]
fn zip_rejects_escape_damage_and_stale_selection() {
    for entries in [
        vec![
            ("../outside.txt", &b"outside"[..]),
            ("src/main.rs", &b"fn main() {}"[..]),
        ],
        vec![("C:/secret", &b"outside"[..])],
    ] {
        let (root, runtime, dataset) = fixture();
        let path = root.path().join("input.zip");
        zip_file(&path, &entries);
        let host = Arc::new(SourceHost::new());
        let selected = host.select(&dataset, path, false).unwrap();
        assert!(
            host.handle(
                &runtime,
                &dataset,
                SourceCommand::Import {
                    token: selected.token,
                    project_id: None,
                    name: "坏包".into(),
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
    let (root, runtime, dataset) = fixture();
    let path = root.path().join("broken.zip");
    fs::write(&path, b"not a zip").unwrap();
    let host = Arc::new(SourceHost::new());
    let selected = host.select(&dataset, path, false).unwrap();
    assert!(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Import {
                token: selected.token,
                project_id: None,
                name: "损坏".into(),
                operation_id: id()
            }
        )
        .is_err()
    );
    let project = root.path().join("project");
    source_fixture(&project);
    let selected = host.select(&dataset, project, true).unwrap();
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cancel {
            token: selected.token.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Import {
                token: selected.token,
                project_id: None,
                name: "已取消".into(),
                operation_id: id()
            }
        )
        .unwrap_err()
        .code,
        "SELECTION_REQUIRED"
    );
}

#[test]
fn import_cancel_before_or_after_claim_never_reads_or_saves_the_project() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let cancelled = host.select(&dataset, project.clone(), true).unwrap();
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cancel {
            token: cancelled.token.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        host.claim_import(&dataset, &cancelled.token)
            .err()
            .unwrap()
            .code,
        "SELECTION_REQUIRED"
    );

    let selected = host.select(&dataset, project, true).unwrap();
    let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
    let (continue_tx, continue_rx) = std::sync::mpsc::channel();
    let worker_host = Arc::clone(&host);
    let worker_dataset = dataset.clone();
    let token = selected.token.clone();
    let worker = std::thread::spawn(move || {
        let (input, flag) = worker_host.claim_import(&worker_dataset, &token).unwrap();
        claimed_tx.send(()).unwrap();
        continue_rx.recv().unwrap();
        let result = match input.input {
            source::SelectedInput::Directory(root) => source::read_directory(&root, &flag),
            source::SelectedInput::Zip(file) => source::read_zip(file, &flag),
        }
        .map(|_| ());
        worker_host.operations.lock().unwrap().active.remove(&token);
        result
    });
    claimed_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(host.has_active());
    assert_eq!(
        host.claim_import(&dataset, &selected.token)
            .err()
            .unwrap()
            .code,
        "OPERATION_ACTIVE"
    );
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cancel {
            token: selected.token,
        },
    )
    .unwrap();
    continue_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "CANCELLED");
    assert!(!host.has_active());
    assert!(
        list::<SourceVersion>(&runtime.lock().unwrap().conn, "source_versions")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn search_registers_before_database_wait_and_rejects_duplicate_token_without_losing_cancel() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let token = id();
    let store = runtime.lock().unwrap();
    let worker_host = Arc::clone(&host);
    let worker_runtime = Arc::clone(&runtime);
    let worker_dataset = dataset.clone();
    let worker_token = token.clone();
    let version_id = version.id.clone();
    let worker = std::thread::spawn(move || {
        worker_host.handle(
            &worker_runtime,
            &worker_dataset,
            SourceCommand::Search {
                version_id,
                query: "cancel_context".into(),
                token: worker_token,
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !host.has_active() {
        assert!(
            Instant::now() < deadline,
            "检索未在等待数据库前登记活动状态"
        );
        std::thread::yield_now();
    }
    assert_eq!(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "cancel_context".into(),
                token: token.clone(),
            }
        )
        .unwrap_err()
        .code,
        "OPERATION_ACTIVE"
    );
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cancel {
            token: token.clone(),
        },
    )
    .unwrap();
    drop(store);
    assert_eq!(worker.join().unwrap().unwrap_err().code, "CANCELLED");
    assert!(!host.has_active());
    assert!(
        list::<source::Evidence>(&runtime.lock().unwrap().conn, "evidence")
            .unwrap()
            .is_empty()
    );
    let result = host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id,
                query: "cancel_context".into(),
                token,
            },
        )
        .unwrap();
    assert_eq!(result[0]["evidence"]["path"], "src/task.rs");
}

#[test]
fn cleanup_database_failure_restores_the_only_material_copy() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    runtime.lock().unwrap().conn.execute_batch("CREATE TRIGGER fail_cleanup BEFORE UPDATE ON assets BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        host.handle(
            &runtime,
            &dataset,
            SourceCommand::Cleanup {
                version_id: version.id,
                confirmed: true
            }
        )
        .is_err()
    );
    let store = runtime.lock().unwrap();
    let asset: FileAsset = get(&store.conn, "assets", &version.asset_id).unwrap();
    assert_eq!(asset.status, AssetStatus::Available);
    assert!(store.read_asset(&asset.id).is_ok());
}

#[test]
fn cleanup_delete_failure_keeps_material_available_for_retry() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    source_fixture(&project);
    let host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &host);
    let path = {
        let store = runtime.lock().unwrap();
        let asset: FileAsset = get(&store.conn, "assets", &version.asset_id).unwrap();
        store.asset_path(&asset).unwrap()
    };
    let result = source::cleanup_material(&mut runtime.lock().unwrap(), &version.id, |staged| {
        assert!(staged.is_file());
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert_eq!(result.unwrap_err().code, "FILE_FAILED");
    {
        let store = runtime.lock().unwrap();
        let asset: FileAsset = get(&store.conn, "assets", &version.asset_id).unwrap();
        assert_eq!(asset.status, AssetStatus::Available);
        assert!(store.read_asset(&asset.id).is_ok());
    }
    host.handle(
        &runtime,
        &dataset,
        SourceCommand::Cleanup {
            version_id: version.id,
            confirmed: true,
        },
    )
    .unwrap();
    assert!(!path.exists());
}

enum Reply {
    Content(Value),
    FromContext(Box<dyn Fn(&Value) -> Value + Send>),
    Status(u16),
    Delayed(Value, Duration),
}
struct Server {
    endpoint: String,
    inputs: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&inputs);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            while !stopping.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(x) => x,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::Interrupted | std::io::ErrorKind::ConnectionAborted
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => {
                        eprintln!("受控服务监听失败：{error}");
                        break;
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let mut expected = None;
                loop {
                    let n = match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    bytes.extend(&buffer[..n]);
                    if expected.is_none() {
                        if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..index]);
                            let len = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|s| s.trim().parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                            expected = Some((index + 4, index + 4 + len));
                        }
                    }
                    if expected.is_some_and(|(_, n)| bytes.len() >= n) {
                        break;
                    }
                }
                let Some((start, end)) = expected else {
                    continue;
                };
                let parsed: Value = serde_json::from_slice(&bytes[start..end]).unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(parsed["messages"][0]["content"].as_str().unwrap().into());
                let reply = match replies.next().unwrap_or(Reply::Status(500)) {
                    Reply::FromContext(make) => {
                        let input = parsed["messages"][0]["content"].as_str().unwrap();
                        let context =
                            serde_json::from_str(input.split_once("\n资料：").unwrap().1).unwrap();
                        Reply::Content(make(&context))
                    }
                    reply => reply,
                };
                let (status, body) = match reply {
                    Reply::Content(value) => (
                        200,
                        format!(
                            "data: {}\n\ndata: [DONE]\n\n",
                            json!({"choices":[{"delta":{"content":value.to_string()}}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}})
                        ),
                    ),
                    Reply::Delayed(value, delay) => {
                        std::thread::sleep(delay);
                        (
                            200,
                            format!(
                                "data: {}\n\ndata: [DONE]\n\n",
                                json!({"choices":[{"delta":{"content":value.to_string()}}]})
                            ),
                        )
                    }
                    Reply::Status(code) => (
                        code,
                        json!({"error":{"message":"synthetic service error"}}).to_string(),
                    ),
                    Reply::FromContext(_) => unreachable!(),
                };
                let content_type = if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            endpoint: format!("http://{address}/chat/completions"),
            inputs,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn configure(runtime: &Arc<Runtime>, dataset: &str, endpoint: &str) {
    runtime
        .save_provider(
            dataset,
            SaveProvider {
                purpose: Purpose::Chat,
                name: "受控替身".into(),
                endpoint: endpoint.into(),
                model: "fixture-model".into(),
                expected_version: None,
                key: Some("synthetic-test-key".into()),
                remove_key: false,
            },
        )
        .unwrap();
}
fn create_session(
    host: &InterviewHost,
    runtime: &Arc<Runtime>,
    dataset: &str,
    mode: &str,
    count: usize,
) -> Value {
    command(host, runtime, dataset, json!({"kind":"create","operationId":id(),"applicationId":null,"profileVersionId":null,"jobSnapshotId":null,
        "sources":[],"contribution":"我会先保存状态","role":"AI Agent","stage":"intern","focus":"任务取消","mode":mode,"questionCount":count,"repracticeOf":null})).unwrap()
}

fn save_resume_profile(
    runtime: &Arc<Runtime>,
    dataset: &str,
    asset_id: Option<&str>,
    previous: Option<(&str, &str)>,
    marker: &str,
) -> Value {
    let data = ProfileData {
        basic: Fields::from([("name".into(), marker.into())]),
        resume_asset_id: asset_id.map(str::to_owned),
        ..ProfileData::default()
    };
    runtime
        .lock()
        .unwrap()
        .mutate(
            &id(),
            dataset,
            serde_json::from_value(json!({
                "kind":"save_profile","profileId":previous.map(|p|p.0),
                "expectedVersionId":previous.map(|p|p.1),"name":"合成简历档案","data":data
            }))
            .unwrap(),
        )
        .unwrap()
}

#[test]
fn resume_preview_is_bound_to_profile_version_and_rejects_missing_changed_or_oversize_assets() {
    let (_root, runtime, dataset) = fixture();
    let bytes = b"%PDF-1.4\nSYNTHETIC_BINARY_NOT_FOR_MODEL";
    let asset = runtime
        .lock()
        .unwrap()
        .import_asset(&dataset, "fixed.pdf", bytes, AssetKind::Resume)
        .unwrap();
    let saved = save_resume_profile(&runtime, &dataset, Some(&asset.id), None, "旧档案");
    let other = save_resume_profile(&runtime, &dataset, None, None, "不配套档案");
    let host = InterviewHost::new();
    let request = json!({"kind":"resume_preview","profileId":saved["profileId"],"profileVersionId":saved["versionId"]});
    let before = crate::store::encode(&runtime.lock().unwrap().snapshot().unwrap()).unwrap();
    let preview = command(&host, &runtime, &dataset, request.clone()).unwrap();
    assert_eq!(preview["assetId"], asset.id);
    assert_eq!(preview["bytes"], json!(bytes.to_vec()));
    assert_eq!(
        crate::store::encode(&runtime.lock().unwrap().snapshot().unwrap()).unwrap(),
        before
    );
    let mut mismatched = request.clone();
    mismatched["profileId"] = other["profileId"].clone();
    assert_eq!(
        command(&host, &runtime, &dataset, mismatched)
            .unwrap_err()
            .code,
        "INPUT_INVALID"
    );
    assert_eq!(
        command(
            &host,
            &runtime,
            &dataset,
            json!({"kind":"resume_preview",
        "profileId":other["profileId"],"profileVersionId":other["versionId"]})
        )
        .unwrap_err()
        .code,
        "MATERIAL_MISSING"
    );
    let mut arbitrary = request.clone();
    arbitrary["path"] = json!("../outside-private-file");
    assert!(serde_json::from_value::<InterviewCommand>(arbitrary).is_err());
    let path = runtime.lock().unwrap().asset_path(&asset).unwrap();
    fs::write(&path, b"modified synthetic bytes").unwrap();
    assert_eq!(
        command(&host, &runtime, &dataset, request.clone())
            .unwrap_err()
            .code,
        "MATERIAL_CHANGED"
    );
    fs::write(&path, bytes).unwrap();
    let mut oversized = asset.clone();
    oversized.bytes = crate::files::MAX_RESUME_BYTES as u64 + 1;
    crate::store::put(
        &runtime.lock().unwrap().conn,
        "assets",
        &asset.id,
        &oversized,
    )
    .unwrap();
    assert_eq!(
        command(&host, &runtime, &dataset, request.clone())
            .unwrap_err()
            .code,
        "INPUT_INVALID"
    );
    crate::store::put(&runtime.lock().unwrap().conn, "assets", &asset.id, &asset).unwrap();
    fs::remove_file(path).unwrap();
    assert_eq!(
        command(&host, &runtime, &dataset, request)
            .unwrap_err()
            .code,
        "MATERIAL_MISSING"
    );
}

#[tokio::test]
async fn pr18_interview_http_sends_only_confirmed_resume_not_the_structured_profile() {
    let mut leaks = Vec::new();
    for mode in ["practice", "simulation"] {
        for confirmed in [false, true] {
            let mut replies = vec![
                Reply::Status(503),
                Reply::Content(json!({"question":"主问：如何保存状态？","evidenceIds":[]})),
                Reply::Status(503),
                Reply::Content(
                    json!({"question":"追问：保存失败如何处理？","decision":"needs_clarification","evidenceIds":[]}),
                ),
                Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
            ];
            if mode == "practice" {
                replies.extend([Reply::Status(503), Reply::Content(report())]);
            }
            replies.extend([Reply::Status(503), Reply::Content(report())]);
            let server = Server::new(replies);
            let (_root, runtime, dataset) = fixture();
            configure(&runtime, &dataset, &server.endpoint);
            let asset = runtime
                .lock()
                .unwrap()
                .import_asset(
                    &dataset,
                    "synthetic.pdf",
                    b"%PDF-1.4\nPRIVATE_RESUME_BINARY",
                    AssetKind::Resume,
                )
                .unwrap();
            let profile_data = json!({"basic":{"name":"PRIVATE_NAME","phone":"PRIVATE_PHONE","email":"private-contact@example.invalid","address":"PRIVATE_ADDRESS"},
                "education":[{"school":"PRIVATE_SCHOOL"}],"experience":[{"company":"PRIVATE_COMPANY"}],"projects":[{"name":"PRIVATE_PROJECT"}],
                "skills":{"other":"PRIVATE_SKILL"},"certificates":[{"name":"PRIVATE_CERTIFICATE"}],"intentions":{"city":"PRIVATE_INTENTION"},
                "answers":[{"question":"PRIVATE_QUESTION","answer":"PRIVATE_UNRELATED_ANSWER"}],"resumeAssetId":asset.id});
            let saved = runtime.lock().unwrap().mutate(&id(),&dataset,serde_json::from_value(json!({"kind":"save_profile","profileId":null,"expectedVersionId":null,"name":"PRIVATE_PROFILE_NAME","data":profile_data})).unwrap()).unwrap();
            let application = runtime.lock().unwrap().mutate(&id(),&dataset,serde_json::from_value(json!({"kind":"create_application",
                "job":{"company":"SYNTHETIC_JOB_COMPANY","title":"目标岗位","jd":"EXPLICIT_SELECTED_JD"},"profileVersionId":saved["versionId"],
                "stage":"saved","duplicateAcknowledged":false})).unwrap()).unwrap();
            let app: Application = get(
                &runtime.lock().unwrap().conn,
                "applications",
                application["applicationId"].as_str().unwrap(),
            )
            .unwrap();
            let selected_before: ProfileVersion = get(
                &runtime.lock().unwrap().conn,
                "profile_versions",
                saved["versionId"].as_str().unwrap(),
            )
            .unwrap();
            let approved = "明确确认的简历片段 CONFIRMED_RESUME；已确认邮箱 approved-contact@example.invalid；用户原话里的 profile 不应被删除。";
            let answer_text = "我会先保存状态；回答中的 profile 字段名应当保留。";
            let host = InterviewHost::new();
            let created = command(&host,&runtime,&dataset,json!({"kind":"create","operationId":id(),"applicationId":app.id,
                "profileVersionId":saved["versionId"],"confirmedResume":if confirmed {json!({"assetId":asset.id,"text":approved})} else {Value::Null},
                "jobSnapshotId":app.job_snapshot_id,"sources":[],"contribution":"EXPLICIT_CONTRIBUTION","role":"AI Agent","stage":"intern","focus":"任务保存",
                "mode":mode,"questionCount":1,"repracticeOf":null})).unwrap();
            save_resume_profile(
                &runtime,
                &dataset,
                Some(&asset.id),
                Some((
                    saved["profileId"].as_str().unwrap(),
                    saved["versionId"].as_str().unwrap(),
                )),
                "PRIVATE_NEW_VERSION",
            );
            let session_id = created["session"]["id"].as_str().unwrap();
            advance(&host, &runtime, &dataset, &created);
            let mut current = settled(&host, &runtime, &dataset, session_id).await;
            assert_eq!(current["session"]["status"], "paused");
            advance(&host, &runtime, &dataset, &current);
            current = settled(&host, &runtime, &dataset, session_id).await;
            command(&host,&runtime,&dataset,json!({"kind":"answer","sessionId":session_id,
                "expectedRevision":current["session"]["revision"],"operationId":id(),"text":answer_text,"disposition":"answer"})).unwrap();
            current = settled(&host, &runtime, &dataset, session_id).await;
            assert_eq!(current["session"]["status"], "paused");
            advance(&host, &runtime, &dataset, &current);
            current = settled(&host, &runtime, &dataset, session_id).await;
            answer(&host, &runtime, &dataset, &current, &id(), "answer");
            current = settled(&host, &runtime, &dataset, session_id).await;
            for _ in 0..if mode == "practice" { 2 } else { 1 } {
                advance(&host, &runtime, &dataset, &current);
                current = settled(&host, &runtime, &dataset, session_id).await;
                assert_eq!(current["session"]["status"], "paused");
                advance(&host, &runtime, &dataset, &current);
                current = settled(&host, &runtime, &dataset, session_id).await;
            }
            assert_eq!(
                current["session"]["status"], "completed",
                "{}",
                current["session"]["error"]
            );
            let requests = server.inputs.lock().unwrap();
            assert_eq!(requests.len(), if mode == "practice" { 9 } else { 7 });
            for (index, input) in requests.iter().enumerate() {
                let context: Value =
                    serde_json::from_str(input.split_once("\n资料：").unwrap().1).unwrap();
                let leaked =
                    input.contains("PRIVATE_") || input.contains("private-contact@example.invalid");
                if leaked {
                    leaks.push(format!(
                        "{mode}/confirmed={confirmed}/{}:{}",
                        index + 1,
                        context["step"]
                    ));
                }
                assert!(input.contains("EXPLICIT_SELECTED_JD"));
                assert!(input.contains("EXPLICIT_CONTRIBUTION"));
                if context["step"] != "question" {
                    assert_eq!(context["turns"][0]["answer"]["text"], answer_text);
                }
                assert_eq!(
                    context["confirmedResume"],
                    if confirmed {
                        json!({"assetId":asset.id,"text":approved})
                    } else {
                        Value::Null
                    }
                );
            }
            drop(requests);
            let store = runtime.lock().unwrap();
            let selected_after: ProfileVersion = get(
                &store.conn,
                "profile_versions",
                saved["versionId"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(
                crate::store::encode(&selected_after).unwrap(),
                crate::store::encode(&selected_before).unwrap()
            );
            for task in list::<ModelTask>(&store.conn, "tasks").unwrap() {
                assert!(
                    task.versions
                        .iter()
                        .any(|r| r.kind == "profile_version" && r.id == saved["versionId"])
                );
                assert!(
                    task.versions
                        .iter()
                        .any(|r| r.kind == "job_snapshot" && r.id == app.job_snapshot_id)
                );
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "实际 HTTP 请求仍包含未授权整档内容：{leaks:?}"
    );
}

#[tokio::test]
async fn pr18_retry_redacts_a_legacy_profile_only_in_the_new_task_and_unknown_inputs_stop_locally()
{
    for recognized in [true, false] {
        let server = Server::new(vec![
            Reply::Status(503),
            Reply::Content(json!({"question":"只使用已确认材料的题目","evidenceIds":[]})),
        ]);
        let (_root, runtime, dataset) = fixture();
        configure(&runtime, &dataset, &server.endpoint);
        let host = InterviewHost::new();
        let created = create_session(&host, &runtime, &dataset, "practice", 1);
        let session_id = created["session"]["id"].as_str().unwrap();
        advance(&host, &runtime, &dataset, &created);
        let failed = settled(&host, &runtime, &dataset, session_id).await;
        let old_id = failed["session"]["pending"]["taskId"].as_str().unwrap();
        let old_raw = {
            let store = runtime.lock().unwrap();
            let mut old: ModelTask = get(&store.conn, "tasks", old_id).unwrap();
            let (instruction, body) = old.input.text.split_once("\n资料：").unwrap();
            let mut context: Value = serde_json::from_str(body).unwrap();
            context["profile"] = json!({"data":{"basic":{"email":"legacy-private@example.invalid"},"answers":[{"answer":"LEGACY_PRIVATE_ANSWER"}]}});
            context["userContribution"] =
                json!("原话保留 profile 与资料：这些字符，不应按文字替换。");
            old.input.text = if recognized {
                format!("{instruction}\n资料：{context}")
            } else {
                "无法识别的旧请求 LEGACY_PRIVATE_ANSWER".into()
            };
            crate::store::put(&store.conn, "tasks", old_id, &old).unwrap();
            store
                .conn
                .query_row("SELECT data FROM tasks WHERE id=?1", [old_id], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap()
        };
        advance(&host, &runtime, &dataset, &failed);
        let result = settled(&host, &runtime, &dataset, session_id).await;
        let actual = server.inputs.lock().unwrap().clone();
        let store = runtime.lock().unwrap();
        assert_eq!(
            store
                .conn
                .query_row("SELECT data FROM tasks WHERE id=?1", [old_id], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            old_raw,
            "不能改写旧审计请求"
        );
        drop(store);
        if recognized {
            assert_eq!(result["session"]["status"], "waiting_answer");
            assert_eq!(actual.len(), 2);
            assert!(actual[1].contains("原话保留 profile 与资料："));
            assert!(
                !actual[1].contains("LEGACY_PRIVATE_ANSWER")
                    && !actual[1].contains("legacy-private@example.invalid"),
                "旧格式重试重新发送了整档"
            );
            let context: Value =
                serde_json::from_str(actual[1].split_once("\n资料：").unwrap().1).unwrap();
            assert!(context.get("profile").is_none());
        } else {
            assert_eq!(result["session"]["status"], "paused");
            assert_eq!(
                result["session"]["error"]["code"],
                "CONTEXT_CONFIRMATION_REQUIRED"
            );
            assert_eq!(actual.len(), 1, "无法安全重建的旧输入不能发送");
            let confirmed = command(&host,&runtime,&dataset,json!({"kind":"confirm_context",
                "sessionId":session_id,"expectedRevision":result["session"]["revision"],"confirmed":true})).unwrap();
            advance(&host, &runtime, &dataset, &confirmed);
            let resumed = settled(&host, &runtime, &dataset, session_id).await;
            assert_eq!(resumed["session"]["status"], "waiting_answer");
            let requests = server.inputs.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert!(!requests[1].contains("LEGACY_PRIVATE_ANSWER"));
            assert_eq!(
                runtime
                    .lock()
                    .unwrap()
                    .conn
                    .query_row("SELECT data FROM tasks WHERE id=?1", [old_id], |r| r
                        .get::<_, String>(0))
                    .unwrap(),
                old_raw
            );
        }
    }
}

#[test]
fn pr18_bad_submodule_declaration_keeps_other_missing_entries() {
    let declarations = r#"[submodule "before"]
path = libs/before
[submodule "unsafe"]
path = ../outside
[submodule "missing-path"]
url = https://example.invalid/do-not-fetch.git
[submodule "invalid-escape"]
path = "libs/invalid\q"
[submodule "unterminated]
path = libs/do-not-guess
[include]
path = ../do-not-read
[submodule "inline]name"] path = libs/inline
[submodule "quoted-value"]
path = "libs/with \"quote\""
[submodule "after"]
path = libs/after
"#;
    for directory in [true, false] {
        let (root, runtime, dataset) = fixture();
        let project = root.path().join("mixed-declarations");
        fs::create_dir(&project).unwrap();
        fs::write(project.join(".gitmodules"), declarations).unwrap();
        let path = if directory {
            project
        } else {
            let path = root.path().join("mixed.zip");
            zip_file(&path, &[(".gitmodules", declarations.as_bytes())]);
            path
        };
        let host = Arc::new(SourceHost::new());
        let selection = host.select(&dataset, path, directory).unwrap();
        let version: SourceVersion = serde_json::from_value(
            host.handle(
                &runtime,
                &dataset,
                SourceCommand::Import {
                    token: selection.token,
                    project_id: None,
                    name: "局部声明错误".into(),
                    operation_id: id(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        let files = source::files_for(&runtime.lock().unwrap().conn, &version.id).unwrap();
        let missing = files
            .iter()
            .filter(|f| f.status == "failed" && f.reason.contains("声明的子模块"))
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            missing,
            [
                "libs/after/",
                "libs/before/",
                "libs/inline/",
                "libs/with \"quote\"/"
            ],
            "directory={directory}"
        );
        assert!(
            files
                .iter()
                .any(|f| f.path == ".gitmodules" && f.status == "failed")
        );
        assert!(
            files
                .iter()
                .any(|f| f.path == ".gitmodules" && f.status == "readable")
        );
        assert!(!files.iter().any(|f| f.path.contains("outside")
            || f.path.contains("do-not-read")
            || f.path.contains("do-not-guess")));
        let store = runtime.lock().unwrap();
        crate::backup::export(&store, true, true).unwrap();
    }
}

#[test]
fn pr18_quoted_submodule_names_preserve_all_missing_paths_for_directory_and_zip() {
    let declarations = r#"[submodule "ordinary"]
path = libs/ordinary
[submodule "plugins/[ui]"]
path = plugins/[ui]
[submodule "escaped\"quote]and\\slash"]
path = libs/escaped
[submodule "hash#;]name"]
path = "libs/with #; marks"
[submodule "last"]
path = libs/last
"#;
    let expected = vec![
        "libs/escaped/",
        "libs/last/",
        "libs/ordinary/",
        "libs/with #; marks/",
        "plugins/[ui]/",
    ];
    let mut failures = Vec::new();
    for directory in [true, false] {
        let (root, runtime, dataset) = fixture();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join(".gitmodules"), declarations).unwrap();
        fs::write(project.join("main.rs"), "fn do_not_execute() {}\n").unwrap();
        let path = if directory {
            project.clone()
        } else {
            let path = root.path().join("project.zip");
            zip_file(
                &path,
                &[
                    (".gitmodules", declarations.as_bytes()),
                    ("main.rs", b"fn do_not_execute() {}\n"),
                ],
            );
            path
        };
        let original =
            fs::read(&path.join(".gitmodules")).unwrap_or_else(|_| fs::read(&path).unwrap());
        let host = Arc::new(SourceHost::new());
        let selection = host.select(&dataset, path.clone(), directory).unwrap();
        let version: SourceVersion = serde_json::from_value(
            host.handle(
                &runtime,
                &dataset,
                SourceCommand::Import {
                    token: selection.token,
                    project_id: None,
                    name: "声明语法样本".into(),
                    operation_id: id(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        let files = source::files_for(&runtime.lock().unwrap().conn, &version.id).unwrap();
        let missing = files
            .iter()
            .filter(|f| f.status == "failed" && f.reason.contains("声明的子模块"))
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>();
        if missing != expected
            || files
                .iter()
                .any(|f| f.path == ".gitmodules" && f.status == "failed")
        {
            failures.push(format!("directory={directory}: actual={missing:?}"));
        }
        assert_eq!(
            fs::read(&path.join(".gitmodules")).unwrap_or_else(|_| fs::read(&path).unwrap()),
            original
        );
    }
    assert!(
        failures.is_empty(),
        "合法声明导致缺失清单被丢弃：{failures:?}"
    );
}

#[tokio::test]
async fn confirmed_resume_text_is_opt_in_frozen_to_old_profile_and_survives_backup() {
    let server = Server::new(
        (0..3)
            .map(|_| {
                Reply::Content(json!({"question":"请说明合成经历的材料边界。","evidenceIds":[]}))
            })
            .collect(),
    );
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let old_asset = runtime
        .lock()
        .unwrap()
        .import_asset(
            &dataset,
            "old.pdf",
            b"%PDF-1.4\nNEVER_SEND_BINARY_OLD",
            AssetKind::Resume,
        )
        .unwrap();
    let old = save_resume_profile(
        &runtime,
        &dataset,
        Some(&old_asset.id),
        None,
        "OLD_PROFILE_SELECTED",
    );
    let new_asset = runtime
        .lock()
        .unwrap()
        .import_asset(
            &dataset,
            "new.pdf",
            b"%PDF-1.4\nNEVER_SEND_BINARY_NEW",
            AssetKind::Resume,
        )
        .unwrap();
    save_resume_profile(
        &runtime,
        &dataset,
        Some(&new_asset.id),
        Some((
            old["profileId"].as_str().unwrap(),
            old["versionId"].as_str().unwrap(),
        )),
        "NEW_PROFILE_NOT_SELECTED",
    );
    save_resume_profile(&runtime, &dataset, None, None, "UNRELATED_PROFILE_PRIVATE");
    let host = InterviewHost::new();
    let create = |resume: Value| {
        json!({"kind":"create","operationId":id(),"applicationId":null,
        "profileVersionId":old["versionId"],"confirmedResume":resume,"jobSnapshotId":null,"sources":[],
        "contribution":"合成说明","role":"AI Agent","stage":"intern","focus":"边界","mode":"practice",
        "questionCount":1,"repracticeOf":null})
    };
    let text = "用户核对并编辑的旧版简历 RESUME_OPT_IN_351";
    assert_eq!(
        command(
            &host,
            &runtime,
            &dataset,
            create(json!({"assetId":new_asset.id,"text":text}))
        )
        .unwrap_err()
        .code,
        "INPUT_INVALID"
    );
    assert_eq!(
        command(
            &host,
            &runtime,
            &dataset,
            create(json!({"assetId":old_asset.id,"text":"x".repeat(MAX_TEXT + 1)}))
        )
        .unwrap_err()
        .code,
        "INPUT_INVALID"
    );
    let unchecked = command(&host, &runtime, &dataset, create(Value::Null)).unwrap();
    advance(&host, &runtime, &dataset, &unchecked);
    settled(
        &host,
        &runtime,
        &dataset,
        unchecked["session"]["id"].as_str().unwrap(),
    )
    .await;
    let checked = command(
        &host,
        &runtime,
        &dataset,
        create(json!({"assetId":old_asset.id,"text":text})),
    )
    .unwrap();
    advance(&host, &runtime, &dataset, &checked);
    let confirmed_id = checked["session"]["id"].as_str().unwrap();
    let received = settled(&host, &runtime, &dataset, confirmed_id).await;
    assert_eq!(
        received["session"]["confirmedResume"],
        json!({"assetId":old_asset.id,"text":text})
    );
    let task = list::<ModelTask>(&runtime.lock().unwrap().conn, "tasks")
        .unwrap()
        .into_iter()
        .find(|task| task.context_id == format!("interview:{confirmed_id}"))
        .unwrap();
    assert!(
        task.versions
            .iter()
            .any(|reference| reference.kind == "asset" && reference.id == old_asset.id)
    );
    assert!(
        task.input.asset_id.is_none(),
        "聊天只带确认文字，不附简历二进制"
    );
    fs::remove_file(runtime.lock().unwrap().asset_path(&old_asset).unwrap()).unwrap();
    assert_eq!(
        command(
            &host,
            &runtime,
            &dataset,
            create(json!({"assetId":old_asset.id,"text":text}))
        )
        .unwrap_err()
        .code,
        "MATERIAL_MISSING"
    );
    let missing = command(&host, &runtime, &dataset, create(Value::Null)).unwrap();
    advance(&host, &runtime, &dataset, &missing);
    settled(
        &host,
        &runtime,
        &dataset,
        missing["session"]["id"].as_str().unwrap(),
    )
    .await;
    let requests = server.inputs.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let contexts = requests
        .iter()
        .map(|input| {
            serde_json::from_str::<Value>(input.split_once("\n资料：").unwrap().1).unwrap()
        })
        .collect::<Vec<_>>();
    assert!(contexts[0]["confirmedResume"].is_null());
    assert_eq!(
        contexts[1]["confirmedResume"],
        json!({"assetId":old_asset.id,"text":text})
    );
    assert!(contexts[2]["confirmedResume"].is_null());
    assert_eq!(contexts[2]["materialGap"], true);
    for request in requests.iter() {
        for private in [
            "OLD_PROFILE_SELECTED",
            "NEVER_SEND_BINARY_OLD",
            "NEVER_SEND_BINARY_NEW",
            "NEW_PROFILE_NOT_SELECTED",
            "UNRELATED_PROFILE_PRIVATE",
        ] {
            assert!(!request.contains(private), "外发包含未选择内容: {private}");
        }
    }
    assert!(!requests[0].contains(text));
    assert!(!requests[2].contains(text));
    drop(requests);
    let store = runtime.lock().unwrap();
    // 真正移除新字段，验证旧场次 JSON 经校验、导出、恢复后仍按未确认处理。
    store
        .conn
        .execute(
            "UPDATE interview_sessions SET data=json_remove(data,'$.confirmedResume') WHERE id=?1",
            [unchecked["session"]["id"].as_str().unwrap()],
        )
        .unwrap();
    let backup = crate::backup::export(&store, true, true).unwrap();
    drop(store);
    let destination = tempfile::tempdir().unwrap();
    let mut restored = Store::open(destination.path()).unwrap();
    let prepared =
        crate::backup::prepare_path(&restored, std::path::Path::new(&backup.path)).unwrap();
    let token = prepared.preview.token.clone();
    crate::backup::commit(&mut restored, prepared, &token, true, false).unwrap();
    let restored_confirmed: InterviewSession =
        get(&restored.conn, "interview_sessions", confirmed_id).unwrap();
    assert_eq!(restored_confirmed.confirmed_resume.unwrap().text, text);
    let restored_legacy: InterviewSession = get(
        &restored.conn,
        "interview_sessions",
        unchecked["session"]["id"].as_str().unwrap(),
    )
    .unwrap();
    assert!(restored_legacy.confirmed_resume.is_none());
    let asset: FileAsset = get(&restored.conn, "assets", &old_asset.id).unwrap();
    assert_eq!(asset.status, AssetStatus::Missing);
    crate::backup::validate_database(&restored.dir().join("data.sqlite")).unwrap();
}
async fn settled(
    host: &InterviewHost,
    runtime: &Arc<Runtime>,
    dataset: &str,
    session_id: &str,
) -> Value {
    let end = Instant::now() + Duration::from_secs(6);
    loop {
        let value = command(
            host,
            runtime,
            dataset,
            json!({"kind":"get","sessionId":session_id}),
        )
        .unwrap();
        if value["session"]["status"] != "generating" {
            return value;
        }
        assert!(Instant::now() < end, "model fixture timed out");
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}
fn report() -> Value {
    json!({"summary":"按回答提供反馈","referenceAnswer":"先保存状态再取消任务；知识参考仍需核查。",
        "points":[{"category":"strength","basis":"user_statement","answerQuote":"我会先保存状态","observation":"回答说明了保存顺序","action":"补充失败分支","evidenceIds":[]}],
        "weaknesses":[{"title":"取消边界","practicePrompt":"说明晚到结果的处理","evidenceIds":[]}]})
}
fn advance(host: &InterviewHost, runtime: &Arc<Runtime>, dataset: &str, current: &Value) -> Value {
    command(host, runtime, dataset, json!({"kind":"advance","sessionId":current["session"]["id"],"expectedRevision":current["session"]["revision"]})).unwrap()
}
fn answer(
    host: &InterviewHost,
    runtime: &Arc<Runtime>,
    dataset: &str,
    current: &Value,
    operation: &str,
    disposition: &str,
) -> Value {
    assert_eq!(
        current["session"]["status"], "waiting_answer",
        "{}",
        current["session"]["error"]
    );
    command(host, runtime, dataset, json!({"kind":"answer","sessionId":current["session"]["id"],"expectedRevision":current["session"]["revision"],"operationId":operation,
        "text":if disposition=="answer" {"我会先保存状态"} else {""},"disposition":disposition})).unwrap()
}

#[tokio::test]
async fn practice_followups_stop_at_two_and_answer_replay_is_idempotent() {
    let server = Server::new(vec![
        Reply::Content(json!({"question":"如何取消任务？","evidenceIds":[]})),
        Reply::Content(
            json!({"question":"取消前如何保存？","decision":"needs_clarification","evidenceIds":[]}),
        ),
        Reply::Content(
            json!({"question":"晚到结果如何处理？","decision":"needs_clarification","evidenceIds":[]}),
        ),
        Reply::Content(report()),
        Reply::Content(report()),
    ]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "practice", 1);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    let operation = id();
    answer(&host, &runtime, &dataset, &first, &operation, "answer");
    answer(&host, &runtime, &dataset, &first, &operation, "answer");
    let second = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(second["session"]["turns"].as_array().unwrap().len(), 2);
    answer(&host, &runtime, &dataset, &second, &id(), "answer");
    let third = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(third["session"]["turns"][2]["followUp"], 2);
    answer(&host, &runtime, &dataset, &third, &id(), "answer");
    let feedback = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(feedback["reports"].as_array().unwrap().len(), 1);
    assert_eq!(feedback["session"]["turns"].as_array().unwrap().len(), 3);
    advance(&host, &runtime, &dataset, &feedback);
    let complete = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(
        complete["session"]["status"], "completed",
        "{}",
        complete["session"]["error"]
    );
    assert_eq!(complete["reports"].as_array().unwrap().len(), 2);
    assert_eq!(server.inputs.lock().unwrap().len(), 5);
    interview::validate_database(&runtime.lock().unwrap().conn).unwrap();
}

#[tokio::test]
async fn revealing_a_practice_question_does_not_carry_its_draft_to_the_next_question() {
    let mut teaching = report();
    teaching["points"] = json!([{"category":"material_gap","basis":"knowledge","answerQuote":"",
        "observation":"本题没有提交回答。","action":"阅读解析。","evidenceIds":[]}]);
    let server = Server::new(vec![
        Reply::Content(json!({"question":"第一题？","evidenceIds":[]})),
        Reply::Content(teaching),
        Reply::Content(json!({"question":"第二题？","evidenceIds":[]})),
    ]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "practice", 2);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    let private_draft = "只属于第一题的未发草稿";
    let saved = command(
        &host,
        &runtime,
        &dataset,
        json!({
            "kind":"save_draft", "sessionId":session_id, "expectedRevision":first["session"]["revision"],
            "operationId":id(), "text":private_draft
        }),
    )
    .unwrap();
    assert_eq!(saved["session"]["draft"], private_draft);
    command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"reveal","sessionId":session_id,"expectedRevision":saved["session"]["revision"]}),
    )
    .unwrap();
    let feedback = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(feedback["reports"].as_array().unwrap().len(), 1);
    advance(&host, &runtime, &dataset, &feedback);
    let second = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(second["session"]["turns"][1]["question"], "第二题？");
    assert!(second["session"]["turns"][0]["answer"].is_null());
    assert!(
        server
            .inputs
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.contains(private_draft))
    );
    assert_eq!(second["session"]["draft"], "");
}

#[tokio::test]
async fn unsubmitted_answers_allow_teaching_but_cannot_be_graded_as_omissions() {
    for action in ["skip", "dont_know", "reveal", "finish"] {
        let mut feedback = report();
        feedback["points"] = json!([{"category":"not_mentioned","basis":"knowledge","answerQuote":"",
            "observation":"作答遗漏了重试边界。","action":"请说明重试。","evidenceIds":[]}]);
        let mut teaching = feedback.clone();
        teaching["points"][0]["category"] = json!("material_gap");
        teaching["points"][0]["observation"] = json!("本题没有提交回答，可以参考以下练习。");
        let server = Server::new(vec![
            Reply::Content(json!({"question":"如何处理重试？","evidenceIds":[]})),
            Reply::Content(feedback),
            Reply::Content(teaching.clone()),
        ]);
        let (_root, runtime, dataset) = fixture();
        configure(&runtime, &dataset, &server.endpoint);
        let host = InterviewHost::new();
        let mode = if action == "finish" { "simulation" } else { "practice" };
        let created = create_session(&host, &runtime, &dataset, mode, 1);
        let session_id = created["session"]["id"].as_str().unwrap();
        advance(&host, &runtime, &dataset, &created);
        let question = settled(&host, &runtime, &dataset, session_id).await;
        if action == "skip" || action == "dont_know" {
            answer(&host, &runtime, &dataset, &question, &id(), action);
        } else {
            command(&host, &runtime, &dataset, json!({"kind":action,"sessionId":session_id,
                "expectedRevision":question["session"]["revision"]})).unwrap();
        }
        let rejected = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(rejected["session"]["status"], "paused", "{action}: a closed question is not an answer");
        assert_eq!(rejected["session"]["error"]["code"], "EVIDENCE_INVALID");
        assert_eq!(rejected["reports"], json!([]));
        assert_eq!(server.inputs.lock().unwrap().len(), 2);
        advance(&host, &runtime, &dataset, &rejected);
        let recovered = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(recovered["reports"][0]["content"], teaching);
        assert_eq!(recovered["session"]["turns"], rejected["session"]["turns"]);
        assert_eq!(server.inputs.lock().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn unfinished_simulation_withholds_unexpected_feedback_in_interview_and_settings() {
    let unsolicited = report();
    let server = Server::new(vec![
        Reply::Content(json!({"question":"如何取消任务？","evidenceIds":[]})),
        Reply::Content(unsolicited.clone()), // The provider returns an evaluation instead of a follow-up.
        Reply::Content(report()),
    ]);
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let dataset = store.dataset_id.clone();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&notifications);
    let runtime = Runtime::new(store, Arc::new(TestVault), Arc::new(move |task| {
        observer.lock().unwrap().push((task.id.clone(), task.content.clone()));
    }));
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "simulation", 1);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let question = settled(&host, &runtime, &dataset, session_id).await;
    answer(&host, &runtime, &dataset, &question, &id(), "answer");
    let failed = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(failed["session"]["status"], "paused");
    assert_eq!(failed["session"]["error"]["code"], "MODEL_OUTPUT_INVALID");
    assert_eq!(failed["reports"], json!([]));
    let task_id = failed["session"]["pending"]["taskId"].as_str().unwrap();
    assert!(runtime.cancel(&dataset, task_id).unwrap().content.is_empty());
    let updates = notifications.lock().unwrap().clone();
    assert!(updates.iter().any(|(id, _)| id == task_id));
    assert!(updates.iter().all(|(_, content)| content.is_empty()));
    {
        let store = runtime.lock().unwrap();
        let saved: ModelTask = get(&store.conn, "tasks", task_id).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved.content).unwrap(), unsolicited);
        let snapshot_task = store.snapshot().unwrap().tasks.into_iter().find(|t| t.id == task_id).unwrap();
        assert_eq!(snapshot_task.usage.total_tokens, saved.usage.total_tokens);
        assert!(failed["session"]["partial"].as_str().unwrap().is_empty(), "interview reveals the rejected report");
        assert!(snapshot_task.content.is_empty(), "settings reveals the rejected report");
    }
    command(&host, &runtime, &dataset, json!({"kind":"finish", "sessionId":session_id,
        "expectedRevision":failed["session"]["revision"]})).unwrap();
    let done = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(done["session"]["status"], "completed");
    assert_eq!(done["reports"].as_array().unwrap().len(), 1);
    let task = runtime.lock().unwrap().snapshot().unwrap().tasks.into_iter().find(|t| t.id == task_id).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&task.content).unwrap(), unsolicited);
}

#[tokio::test]
async fn simulation_feedback_is_withheld_and_service_failure_keeps_answers() {
    let server = Server::new(vec![
        Reply::Content(json!({"question":"说明一次取消流程？","evidenceIds":[]})),
        Reply::Status(429),
        Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
        Reply::Content(report()),
    ]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "simulation", 1);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    assert!(command(&host, &runtime, &dataset, json!({"kind":"reveal","sessionId":session_id,"expectedRevision":first["session"]["revision"]})).is_err());
    answer(&host, &runtime, &dataset, &first, &id(), "answer");
    let failed = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(failed["session"]["status"], "paused");
    assert_eq!(
        failed["session"]["turns"][0]["answer"]["text"],
        "我会先保存状态"
    );
    assert!(failed["reports"].as_array().unwrap().is_empty());
    advance(&host, &runtime, &dataset, &failed);
    let recovered = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(
        recovered["session"]["status"],
        "ready",
        "恢复状态：{}，收到请求数：{}",
        recovered["session"]["error"],
        server.inputs.lock().unwrap().len()
    );
    assert!(recovered["reports"].as_array().unwrap().is_empty());
    advance(&host, &runtime, &dataset, &recovered);
    let complete = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(
        complete["session"]["status"], "completed",
        "{}",
        complete["session"]["error"]
    );
    assert_eq!(complete["reports"].as_array().unwrap().len(), 1);
    assert!(
        runtime
            .lock()
            .unwrap()
            .snapshot()
            .unwrap()
            .applications
            .is_empty()
    );
}

#[tokio::test]
async fn shrinking_source_scope_omits_historical_evidence_from_http_but_preserves_local_history() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(
        project.join("withdraw.py"),
        "def withdrawn_marker():\n    return 'WITHDRAWN_PAYLOAD_58294'\n",
    )
    .unwrap();
    fs::write(
        project.join("keep.py"),
        "def keep_marker():\n    return 'ALLOWED_PAYLOAD_72431'\n",
    )
    .unwrap();
    let source_host = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &source_host);
    let granted: SourceVersion = serde_json::from_value(
        source_host
            .handle(
                &runtime,
                &dataset,
                SourceCommand::SetScope {
                    version_id: version.id.clone(),
                    expected_scope_version: version.scope_version,
                    paths: vec!["*".into()],
                    confirmed: true,
                },
            )
            .unwrap(),
    )
    .unwrap();
    let evidence = source_host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "withdrawn_marker".into(),
                token: id(),
            },
        )
        .unwrap();
    let withdrawn_id = evidence[0]["evidence"]["id"].as_str().unwrap().to_owned();
    let mut cited_report = report();
    cited_report["points"][0]["basis"] = json!("source_fact");
    cited_report["points"][0]["evidenceIds"] = json!([withdrawn_id]);
    let server = Server::new(vec![
        Reply::Content(json!({"question":"说明任务保存顺序？","evidenceIds":[withdrawn_id]})),
        Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
        Reply::Content(cited_report),
        Reply::Content(json!({"question":"如何处理当前可用材料中的失败分支？","evidenceIds":[]})),
    ]);
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = command(&host, &runtime, &dataset, json!({"kind":"create","operationId":id(),
        "applicationId":null,"profileVersionId":null,"jobSnapshotId":null,
        "sources":[{"versionId":version.id,"scopeVersion":granted.scope_version}],
        "contribution":"我会先保存状态","role":"AI Agent","stage":"intern",
        "focus":"withdrawn_marker keep_marker","mode":"practice","questionCount":2,"repracticeOf":null})).unwrap();
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(first["session"]["turns"][0]["evidenceIds"][0], withdrawn_id);
    answer(&host, &runtime, &dataset, &first, &id(), "answer");
    let closed = settled(&host, &runtime, &dataset, session_id).await;
    advance(&host, &runtime, &dataset, &closed);
    let feedback = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(feedback["reports"].as_array().unwrap().len(), 1);
    source_host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::SetScope {
                version_id: version.id,
                expected_scope_version: granted.scope_version,
                paths: vec!["keep.py".into()],
                confirmed: true,
            },
        )
        .unwrap();
    let confirmed = command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"confirm_context","sessionId":session_id,
        "expectedRevision":feedback["session"]["revision"],"confirmed":true}),
    )
    .unwrap();
    advance(&host, &runtime, &dataset, &confirmed);
    let next = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(
        next["session"]["status"], "waiting_answer",
        "{}",
        next["session"]["error"]
    );
    let requests = server.inputs.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].contains("WITHDRAWN_PAYLOAD_58294"));
    assert!(requests[0].contains(&withdrawn_id));
    assert!(!requests[3].contains("WITHDRAWN_PAYLOAD_58294"));
    assert!(!requests[3].contains(&withdrawn_id));
    assert!(requests[3].contains("ALLOWED_PAYLOAD_72431"));
    let outbound: Value =
        serde_json::from_str(requests[3].split_once("\n资料：").unwrap().1).unwrap();
    assert_eq!(outbound["historicalEvidenceWithheld"], true);
    assert!(
        outbound["turns"][0]["evidenceIds"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        next["session"]["turns"][0]["answer"]["text"],
        "我会先保存状态"
    );
    assert_eq!(next["session"]["turns"][0]["evidenceIds"][0], withdrawn_id);
    assert_eq!(
        next["reports"][0]["content"]["points"][0]["evidenceIds"][0],
        withdrawn_id
    );
    let historical = source_host
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Evidence { id: withdrawn_id },
        )
        .unwrap();
    assert!(
        historical["text"]
            .as_str()
            .unwrap()
            .contains("WITHDRAWN_PAYLOAD_58294")
    );
    interview::validate_database(&runtime.lock().unwrap().conn).unwrap();
}

#[tokio::test]
async fn final_report_receives_current_evidence_without_overwriting_old_feedback_or_answers() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("guard.rs"), "if task.generation != identity.generation || task.status != \"running\" {\n    return false;\n}\n").unwrap();
    let sources = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &sources);
    let granted: SourceVersion = serde_json::from_value(
        sources
            .handle(
                &runtime,
                &dataset,
                SourceCommand::SetScope {
                    version_id: version.id.clone(),
                    expected_scope_version: version.scope_version,
                    paths: vec!["*".into()],
                    confirmed: true,
                },
            )
            .unwrap(),
    )
    .unwrap();
    let hits = sources
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "task.generation task.status".into(),
                token: id(),
            },
        )
        .unwrap();
    let evidence_id = hits[0]["evidence"]["id"].as_str().unwrap().to_owned();
    let mut old = report();
    old["referenceAnswer"] = json!("历史描述：尚未展示晚到结果守卫");
    let mut corrected = report();
    corrected["referenceAnswer"] =
        json!("本次材料已展示 generation/status 局部守卫；整条调用链的覆盖仍需核查");
    corrected["points"].as_array_mut().unwrap().push(json!({
        "category":"material_gap","basis":"source_fact","answerQuote":"",
        "observation":"补充展示局部守卫，完整调用链仍待核对，不将材料覆盖缺口记为答题过错。",
        "action":"继续阅读调用点。","evidenceIds":[evidence_id]
    }));
    corrected["weaknesses"][0]["evidenceIds"] = json!([evidence_id]);
    let server = Server::new(vec![
        Reply::Content(
            json!({"question":"历史问题称尚未展示守卫，你如何设计？","evidenceIds":[evidence_id]}),
        ),
        Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
        Reply::Content(old),
        Reply::Content(corrected),
    ]);
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = command(&host, &runtime, &dataset, json!({"kind":"create","operationId":id(),
        "applicationId":null,"profileVersionId":null,"jobSnapshotId":null,
        "sources":[{"versionId":version.id,"scopeVersion":granted.scope_version}],
        "contribution":"仅为合成阅读练习","role":"AI Agent","stage":"intern",
        "focus":"task.generation task.status","mode":"practice","questionCount":1,"repracticeOf":null})).unwrap();
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    let answer_id = id();
    answer(&host, &runtime, &dataset, &first, &answer_id, "answer");
    let closed = settled(&host, &runtime, &dataset, session_id).await;
    advance(&host, &runtime, &dataset, &closed);
    let feedback = settled(&host, &runtime, &dataset, session_id).await;
    advance(&host, &runtime, &dataset, &feedback);
    let finished = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(finished["session"]["status"], "completed");
    assert_eq!(finished["session"]["turns"][0]["answer"]["id"], answer_id);
    assert_eq!(finished["reports"][0], feedback["reports"][0]);
    assert_eq!(finished["reports"].as_array().unwrap().len(), 2);
    let inputs = server.inputs.lock().unwrap();
    let final_input = inputs.last().unwrap();
    assert!(final_input.contains("源码判断以本次evidence正文为准"));
    let body: Value = serde_json::from_str(final_input.split_once("\n资料：").unwrap().1).unwrap();
    assert_eq!(body["step"], "final_report");
    assert!(
        body["turns"][0]["question"]
            .as_str()
            .unwrap()
            .contains("历史问题称尚未展示")
    );
    assert!(
        body["evidence"][0]["text"]
            .as_str()
            .unwrap()
            .contains("task.generation != identity.generation")
    );
}

#[tokio::test]
async fn report_corrections_bind_existing_evidence_preserve_history_and_roundtrip_offline() {
    let (root, runtime, dataset) = fixture();
    let project = root.path().join("reviewed-project");
    fs::create_dir_all(&project).unwrap();
    let source_text =
        "pub fn accepts(revision: u64, expected: u64) -> bool {\n    revision == expected\n}\n";
    fs::write(project.join("rule.rs"), source_text).unwrap();
    fs::write(
        project.join("display.rs"),
        "pub fn label() -> &'static str {\n    \"ready\"\n}\n",
    )
    .unwrap();
    fs::write(project.join("auxiliary.rs"), "pub fn auxiliary() {}\n").unwrap();
    let sources = Arc::new(SourceHost::new());
    let version = import_dir(&project, &runtime, &dataset, &sources);
    let granted: SourceVersion = serde_json::from_value(
        sources
            .handle(
                &runtime,
                &dataset,
                SourceCommand::SetScope {
                    version_id: version.id.clone(),
                    expected_scope_version: version.scope_version,
                    paths: vec!["*".into()],
                    confirmed: true,
                },
            )
            .unwrap(),
    )
    .unwrap();
    let hits = sources
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "accepts label auxiliary".into(),
                token: id(),
            },
        )
        .unwrap();
    let rule = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["evidence"]["path"] == "rule.rs")
        .unwrap()["evidence"]
        .clone();
    let label = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["evidence"]["path"] == "display.rs")
        .unwrap()["evidence"]
        .clone();
    let rule_id = rule["id"].as_str().unwrap();
    let label_id = label["id"].as_str().unwrap();
    let unused_id = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["evidence"]["path"] == "auxiliary.rs")
        .unwrap()["evidence"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut conflicting = report();
    conflicting["summary"] = json!("模型摘要中也可能保留未经核实的断言");
    conflicting["points"] = json!([
        {"category":"strength","basis":"source_fact","answerQuote":"我会先保存状态",
            "observation":"材料没有展示版本比较。","action":"请补充实现。","evidenceIds":[label_id]},
        {"category":"expression","basis":"source_fact","answerQuote":"我会先保存状态",
            "observation":"accepts 已比较 revision 与 expected。","action":"整条调用链仍需核对。","evidenceIds":[rule_id]},
        {"category":"not_mentioned","basis":"inference","answerQuote":"",
            "observation":"本回答没有展开所有调用点。","action":"补充验证。","evidenceIds":[]}
    ]);
    let server = Server::new(vec![
        Reply::Content(
            json!({"question":"accepts 与 label 的职责是什么？","evidenceIds":[rule_id,label_id]}),
        ),
        Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
        Reply::Content(conflicting.clone()),
    ]);
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"create","operationId":id(),
        "applicationId":null,"profileVersionId":null,"jobSnapshotId":null,
        "sources":[{"versionId":version.id,"scopeVersion":granted.scope_version}],
        "contribution":"仅为合成阅读练习","role":"AI Agent","stage":"intern",
        "focus":"accepts label auxiliary","mode":"practice","questionCount":1,"repracticeOf":null}),
    )
    .unwrap();
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    answer(&host, &runtime, &dataset, &first, &id(), "answer");
    let closed = settled(&host, &runtime, &dataset, session_id).await;
    advance(&host, &runtime, &dataset, &closed);
    let original = settled(&host, &runtime, &dataset, session_id).await;
    let report_id = original["reports"][0]["id"].as_str().unwrap();
    assert_eq!(original["reports"][0]["content"], conflicting);
    assert!(original["session"].get("reportCorrections").is_none());
    let excerpts = original["reportEvidence"][report_id].as_array().unwrap();
    assert!(excerpts.contains(&rule));
    assert!(excerpts.contains(&label));
    assert_eq!(
        excerpts.len(),
        2,
        "不把仅发送过而未被此报告引用的材料算作报告依据"
    );
    // The host exposes literal, located source independently of both true and false explanations.
    assert_eq!(
        excerpts.iter().find(|e| e["id"] == rule_id).unwrap()["text"],
        source_text.trim_end_matches('\n')
    );
    assert_eq!(server.inputs.lock().unwrap().len(), 3);
    let task_before: ModelTask = get(
        &runtime.lock().unwrap().conn,
        "tasks",
        original["reports"][0]["taskId"].as_str().unwrap(),
    )
    .unwrap();
    assert!(
        task_before
            .versions
            .iter()
            .any(|v| v.kind == "evidence" && v.id == unused_id)
    );

    // Old archives contain no correction field and still expose the same report and fixed excerpts.
    let legacy_backup = crate::backup::export(&runtime.lock().unwrap(), false, false).unwrap();
    let legacy_root = tempfile::tempdir().unwrap();
    let mut legacy_store = Store::open(legacy_root.path()).unwrap();
    let prepared =
        crate::backup::prepare_path(&legacy_store, std::path::Path::new(&legacy_backup.path))
            .unwrap();
    let token = prepared.preview.token.clone();
    crate::backup::commit(&mut legacy_store, prepared, &token, true, false).unwrap();
    let legacy_dataset = legacy_store.dataset_id.clone();
    let legacy_runtime = Runtime::new(legacy_store, Arc::new(TestVault), Arc::new(|_| {}));
    let legacy_view = command(
        &host,
        &legacy_runtime,
        &legacy_dataset,
        json!({"kind":"get","sessionId":session_id}),
    )
    .unwrap();
    assert_eq!(legacy_view["reports"], original["reports"]);
    assert_eq!(legacy_view["reportEvidence"], original["reportEvidence"]);
    assert!(legacy_view["session"].get("reportCorrections").is_none());

    let correction = json!({"kind":"correct_report","sessionId":session_id,
        "expectedRevision":original["session"]["revision"],"operationId":id(),"reportId":report_id,
        "pointIndex":0,"text":"本片段含 revision 相等检查；所有调用点的覆盖仍待核查。",
        "evidenceIds":[rule_id],"confirmed":true});
    let other = create_session(&host, &runtime, &dataset, "practice", 1);
    for (field, value) in [
        ("confirmed", json!(false)),
        ("pointIndex", json!(99)),
        ("reportId", json!(id())),
        ("evidenceIds", json!([])),
        ("evidenceIds", json!([id()])),
        ("evidenceIds", json!([unused_id])),
        ("evidenceIds", json!([rule_id, rule_id])),
        ("expectedRevision", json!(0)),
    ] {
        let mut invalid = correction.clone();
        invalid[field] = value;
        assert!(
            command(&host, &runtime, &dataset, invalid).is_err(),
            "{field}"
        );
    }
    let mut cross_session = correction.clone();
    cross_session["sessionId"] = other["session"]["id"].clone();
    cross_session["expectedRevision"] = other["session"]["revision"].clone();
    assert!(command(&host, &runtime, &dataset, cross_session).is_err());

    // A valid excerpt from another imported version must not become evidence for this report.
    let unrelated_version = import_dir(&project, &runtime, &dataset, &sources);
    let unrelated = sources
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Search {
                version_id: unrelated_version.id,
                query: "accepts".into(),
                token: id(),
            },
        )
        .unwrap();
    let mut foreign = correction.clone();
    foreign["evidenceIds"] = json!([unrelated[0]["evidence"]["id"]]);
    assert_eq!(
        command(&host, &runtime, &dataset, foreign)
            .unwrap_err()
            .code,
        "EVIDENCE_INVALID"
    );

    // A failed write neither appends a correction nor consumes its idempotency key.
    runtime.lock().unwrap().conn.execute_batch("CREATE TEMP TRIGGER reject_correction BEFORE UPDATE ON interview_sessions BEGIN SELECT RAISE(ABORT, 'synthetic correction save failure'); END;").unwrap();
    assert!(command(&host, &runtime, &dataset, correction.clone()).is_err());
    runtime
        .lock()
        .unwrap()
        .conn
        .execute_batch("DROP TRIGGER reject_correction;")
        .unwrap();
    let unchanged = command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"get","sessionId":session_id}),
    )
    .unwrap();
    assert_eq!(unchanged, original);
    let corrected = command(&host, &runtime, &dataset, correction.clone()).unwrap();
    let repeated = command(&host, &runtime, &dataset, correction.clone()).unwrap();
    assert_eq!(repeated, corrected);
    assert_eq!(
        corrected["session"]["reportCorrections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        corrected["session"]["reportCorrections"][0]["evidenceIds"][0],
        rule_id
    );
    assert_eq!(corrected["reports"], original["reports"]);
    assert_eq!(corrected["session"]["turns"], original["session"]["turns"]);
    let task_after: ModelTask =
        get(&runtime.lock().unwrap().conn, "tasks", &task_before.id).unwrap();
    assert_eq!(
        serde_json::to_value(task_after).unwrap(),
        serde_json::to_value(task_before).unwrap()
    );
    let mut stale = correction.clone();
    stale["operationId"] = json!(id());
    assert_eq!(
        command(&host, &runtime, &dataset, stale).unwrap_err().code,
        "VERSION_CONFLICT"
    );
    let mut changed_replay = correction.clone();
    changed_replay["text"] = json!("同一操作不能替换成另一份更正");
    assert!(command(&host, &runtime, &dataset, changed_replay).is_err());

    // Corrections use saved history even after scope revocation and source-copy cleanup.
    sources
        .handle(
            &runtime,
            &dataset,
            SourceCommand::SetScope {
                version_id: granted.id.clone(),
                expected_scope_version: granted.scope_version,
                paths: vec![],
                confirmed: true,
            },
        )
        .unwrap();
    sources
        .handle(
            &runtime,
            &dataset,
            SourceCommand::Cleanup {
                version_id: granted.id,
                confirmed: true,
            },
        )
        .unwrap();
    let after_cleanup = command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"get","sessionId":session_id}),
    )
    .unwrap();
    assert_eq!(after_cleanup, corrected);
    let backup = crate::backup::export(&runtime.lock().unwrap(), false, false).unwrap();
    let restored_root = tempfile::tempdir().unwrap();
    let mut restored = Store::open(restored_root.path()).unwrap();
    let prepared =
        crate::backup::prepare_path(&restored, std::path::Path::new(&backup.path)).unwrap();
    let token = prepared.preview.token.clone();
    crate::backup::commit(&mut restored, prepared, &token, true, false).unwrap();
    crate::backup::validate_database(&restored.dir().join("data.sqlite")).unwrap();
    let restored_dataset = restored.dataset_id.clone();
    let restored_runtime = Runtime::new(restored, Arc::new(TestVault), Arc::new(|_| {}));
    let restored_view = command(
        &host,
        &restored_runtime,
        &restored_dataset,
        json!({"kind":"get","sessionId":session_id}),
    )
    .unwrap();
    assert_eq!(
        restored_view["session"]["reportCorrections"],
        corrected["session"]["reportCorrections"]
    );
    assert_eq!(
        restored_view["session"]["turns"],
        corrected["session"]["turns"]
    );
    assert_eq!(restored_view["reports"], original["reports"]);
    assert_eq!(restored_view["reportEvidence"], original["reportEvidence"]);
    let mut store = restored_runtime.lock().unwrap();
    let tx = store.conn.transaction().unwrap();
    tx.execute("UPDATE interview_sessions SET data=json_set(data,'$.reportCorrections[0].pointIndex',99) WHERE id=?1", [session_id]).unwrap();
    assert!(interview::validate_database(&tx).is_err());
    tx.rollback().unwrap();
    let tx = store.conn.transaction().unwrap();
    tx.execute("UPDATE interview_sessions SET data=json_set(data,'$.reportCorrections[0].evidenceIds[0]',?1) WHERE id=?2", rusqlite::params![id(),session_id]).unwrap();
    assert!(interview::validate_database(&tx).is_err());
    tx.rollback().unwrap();
    assert_eq!(
        server.inputs.lock().unwrap().len(),
        3,
        "更正、读取和备份不得发起模型调用"
    );
}

#[tokio::test]
async fn report_rejects_later_source_blame_and_orphan_weakness_but_accepts_teaching() {
    for mode in ["practice", "simulation"] {
        let (root, runtime, dataset) = fixture();
        let (version, shown, supplement) = report_materials(root.path(), &runtime, &dataset);
        let mut blame = report();
        blame["points"] = json!([{
            "category":"not_mentioned","basis":"source_fact","answerQuote":"",
            "observation":"回答未说明后来片段中的票据比较。","action":"请补充票据比较。",
            "evidenceIds":[supplement]
        }]);
        blame["weaknesses"][0]["evidenceIds"] = json!([supplement]);
        let mut orphan = report();
        orphan["weaknesses"][0]["evidenceIds"] = json!([supplement]);
        let mut teaching = report();
        teaching["points"] = json!([
            {"category":"not_mentioned","basis":"knowledge","answerQuote":"",
                "observation":"回答没有展开并发窗口，以下仅作理论练习。",
                "action":"讨论检查和写入之间状态变化的情况。","evidenceIds":[]},
            {"category":"material_gap","basis":"source_fact","answerQuote":"",
                "observation":"报告补充展示票据比较，原题未给它，不据此评价作答遗漏。",
                "action":"结合补充材料继续阅读。","evidenceIds":[supplement]},
            {"category":"strength","basis":"source_fact","answerQuote":"我会先保存状态",
                "observation":"先保存状态与后来片段中的 persist_state 调用吻合，不代表亲自实现。",
                "action":"保持对设计与个人贡献的区分。","evidenceIds":[supplement]}
        ]);
        teaching["weaknesses"][0] = json!({"title":"学习补充","practicePrompt":"阅读后来补充的比较实现。","evidenceIds":[supplement],"pointIndex":1});
        let server = Server::new(vec![
            Reply::Content(
                json!({"question":"当前只给出读取片段，请讨论如何保存状态；未给出票据比较实现。","evidenceIds":[shown]}),
            ),
            Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
            Reply::Content(blame.clone()),
            Reply::Content(orphan),
            Reply::Content(teaching.clone()),
        ]);
        configure(&runtime, &dataset, &server.endpoint);
        let host = InterviewHost::new();
        let created = report_session(&host, &runtime, &dataset, &version, mode, 1);
        let session_id = created["session"]["id"].as_str().unwrap();
        advance(&host, &runtime, &dataset, &created);
        let question = settled(&host, &runtime, &dataset, session_id).await;
        answer(&host, &runtime, &dataset, &question, &id(), "answer");
        let closed = settled(&host, &runtime, &dataset, session_id).await;
        let answer_before = closed["session"]["turns"].clone();
        advance(&host, &runtime, &dataset, &closed);
        let rejected = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(rejected["session"]["error"]["code"], "EVIDENCE_INVALID");
        assert!(
            rejected["session"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("作答时未提供")
        );
        assert!(rejected["reports"].as_array().unwrap().is_empty());
        assert_eq!(rejected["session"]["turns"], answer_before);
        assert_eq!(
            serde_json::from_str::<Value>(rejected["session"]["partial"].as_str().unwrap())
                .unwrap(),
            blame
        );
        assert_eq!(
            server.inputs.lock().unwrap().len(),
            3,
            "不能自动重试被拒绝的报告"
        );
        let failed_task_id = rejected["session"]["pending"]["taskId"]
            .as_str()
            .unwrap()
            .to_owned();
        advance(&host, &runtime, &dataset, &rejected);
        let orphan_rejected = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(
            orphan_rejected["session"]["error"]["code"],
            "EVIDENCE_INVALID"
        );
        assert!(
            orphan_rejected["session"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("复练建议")
        );
        assert!(orphan_rejected["reports"].as_array().unwrap().is_empty());
        advance(&host, &runtime, &dataset, &orphan_rejected);
        let accepted = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(
            accepted["session"]["status"],
            if mode == "practice" {
                "ready"
            } else {
                "completed"
            },
            "{}",
            accepted["session"]["error"]
        );
        assert_eq!(accepted["reports"][0]["content"], teaching);
        assert_eq!(accepted["session"]["turns"], answer_before);
        let requests = server.inputs.lock().unwrap();
        assert_eq!(requests.len(), 5);
        let context: Value =
            serde_json::from_str(requests[2].split_once("\n资料：").unwrap().1).unwrap();
        assert_eq!(context["turns"][0]["evidenceIds"], json!([shown]));
        assert!(
            context["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == supplement)
        );
        assert!(requests[2].contains("作答后补充片段"));
        drop(requests);

        // Simulate an untouched legacy archive: the same formerly accepted response must
        // remain readable and correctable, despite failing today's new-report admission.
        let legacy_id = id();
        let legacy = json!({"id":legacy_id,"sessionId":session_id,"createdAt":now(),
            "mainNumber":if mode=="practice" {json!(1)} else {Value::Null},"taskId":failed_task_id,
            "content":blame,"evidenceIds":[supplement]});
        {
            let mut store = runtime.lock().unwrap();
            let tx = store.conn.transaction().unwrap();
            tx.execute(
                "INSERT INTO interview_reports(id,session_id,data) VALUES(?1,?2,?3)",
                rusqlite::params![legacy_id, session_id, legacy.to_string()],
            )
            .unwrap();
            let mut session: InterviewSession = get(&tx, "interview_sessions", session_id).unwrap();
            session.report_ids.push(legacy_id.clone());
            crate::store::put(&tx, "interview_sessions", session_id, &session).unwrap();
            tx.commit().unwrap();
        }
        let historical = command(
            &host,
            &runtime,
            &dataset,
            json!({"kind":"get","sessionId":session_id}),
        )
        .unwrap();
        assert_eq!(historical["reports"][1], legacy);
        let corrected = command(&host,&runtime,&dataset,json!({"kind":"correct_report","sessionId":session_id,
            "expectedRevision":historical["session"]["revision"],"operationId":id(),"reportId":legacy_id,
            "pointIndex":0,"text":"此比较只在报告阶段补充，撤回将其当作原题遗漏的判断。",
            "evidenceIds":[supplement],"confirmed":true})).unwrap();
        assert_eq!(corrected["reports"][1], legacy);
        let store = runtime.lock().unwrap();
        let failed_task: ModelTask = get(&store.conn, "tasks", &failed_task_id).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&failed_task.content).unwrap(),
            blame
        );
        let backup = crate::backup::export(&store, false, false).unwrap();
        drop(store);
        let destination = tempfile::tempdir().unwrap();
        let mut restored = Store::open(destination.path()).unwrap();
        let prepared =
            crate::backup::prepare_path(&restored, std::path::Path::new(&backup.path)).unwrap();
        let token = prepared.preview.token.clone();
        crate::backup::commit(&mut restored, prepared, &token, true, false).unwrap();
        let restored_report: Value = get(&restored.conn, "interview_reports", &legacy_id).unwrap();
        assert_eq!(restored_report, legacy);
        let restored_session: InterviewSession =
            get(&restored.conn, "interview_sessions", session_id).unwrap();
        assert_eq!(restored_session.report_corrections.len(), 1);
        interview::validate_database(&restored.conn).unwrap();
    }
}

#[tokio::test]
async fn report_attribution_locates_each_answer_and_does_not_borrow_another_questions_sources() {
    for grouped in [true, false] {
        let (root, runtime, dataset) = fixture();
        let (version, shown, supplement) = report_materials(root.path(), &runtime, &dataset);
        let mut replies = vec![Reply::Content(
            json!({"question":"load_record 的读取部分如何设计？","evidenceIds":[shown]}),
        )];
        if grouped {
            replies.push(Reply::Content(json!({"question":"再看 validate_ticket 的比较部分？","decision":"needs_clarification","evidenceIds":[supplement]})));
        } else {
            replies.extend([
                Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
                Reply::Content(json!({"question":"validate_ticket 的比较部分如何设计？","evidenceIds":[supplement]})),
            ]);
        }
        replies.push(Reply::Content(
            json!({"question":null,"decision":"sufficient","evidenceIds":[]}),
        ));
        let wrong_source = supplement.clone();
        replies.push(Reply::FromContext(Box::new(move |context| {
            let mut value = report();
            value["points"][0] = json!({"category":"not_mentioned","basis":"inference",
                "turnId":context["turns"][0]["id"],"answerQuote":"",
                "observation":"第一题没有说第二题的源码细节。","action":"补充。","evidenceIds":[wrong_source]});
            value
        })));
        replies.push(Reply::FromContext(Box::new(|context| {
            let mut value = report();
            value["points"][0]["category"] = json!("incorrect");
            value["points"][0]["turnId"] = context["turns"][0]["id"].clone();
            value["points"][0]["answerQuote"] = json!("第二题只讨论票据");
            value
        })));
        let mut ambiguous_quote = report();
        ambiguous_quote["points"][0]["category"] = json!("incorrect");
        replies.push(Reply::Content(ambiguous_quote));
        let mut ambiguous_omission = report();
        ambiguous_omission["points"][0]["category"] = json!("not_mentioned");
        ambiguous_omission["points"][0]["answerQuote"] = json!("");
        replies.push(Reply::Content(ambiguous_omission));
        for explicit_index in [false, true] {
            let correct_source = supplement.clone();
            replies.push(Reply::FromContext(Box::new(move |context| {
                let mut value = report();
                value["points"] = json!([
                    {"category":"not_mentioned","basis":"source_fact","turnId":context["turns"][1]["id"],
                        "answerQuote":"","observation":"第二题未展开自己已拿到的比较片段。",
                        "action":"讨论票据比较。","evidenceIds":[correct_source]},
                    {"category":"material_gap","basis":"source_fact","answerQuote":"",
                        "observation":"补充材料只能说明此函数，完整调用链仍待核查。",
                        "action":"继续阅读。","evidenceIds":[correct_source]}
                ]);
                value["weaknesses"][0]["evidenceIds"] = json!([correct_source]);
                if explicit_index {
                    value["weaknesses"][0]["pointIndex"] = json!(0);
                }
                value
            })));
        }
        let server = Server::new(replies);
        configure(&runtime, &dataset, &server.endpoint);
        let host = InterviewHost::new();
        let created = report_session(
            &host,
            &runtime,
            &dataset,
            &version,
            if grouped { "practice" } else { "simulation" },
            if grouped { 1 } else { 2 },
        );
        let session_id = created["session"]["id"].as_str().unwrap();
        advance(&host, &runtime, &dataset, &created);
        let mut current = settled(&host, &runtime, &dataset, session_id).await;
        for text in [
            "我会先保存状态。第一题只讨论读取。",
            "我会先保存状态。第二题只讨论票据。",
        ] {
            command(&host,&runtime,&dataset,json!({"kind":"answer","sessionId":session_id,
                "expectedRevision":current["session"]["revision"],"operationId":id(),"text":text,"disposition":"answer"})).unwrap();
            current = settled(&host, &runtime, &dataset, session_id).await;
            if !grouped && current["session"]["turns"].as_array().unwrap().len() == 1 {
                advance(&host, &runtime, &dataset, &current);
                current = settled(&host, &runtime, &dataset, session_id).await;
            }
        }
        let turns_before = current["session"]["turns"].clone();
        for message in [
            "作答时未提供",
            "问题或回答引文",
            "唯一定位",
            "唯一定位",
            "复练建议",
        ] {
            advance(&host, &runtime, &dataset, &current);
            current = settled(&host, &runtime, &dataset, session_id).await;
            assert_eq!(current["session"]["status"], "paused");
            assert_eq!(current["session"]["error"]["code"], "EVIDENCE_INVALID");
            assert!(
                current["session"]["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(message),
                "{}",
                current["session"]["error"]
            );
            assert!(current["reports"].as_array().unwrap().is_empty());
            assert_eq!(current["session"]["turns"], turns_before);
        }
        advance(&host, &runtime, &dataset, &current);
        current = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(
            current["session"]["status"],
            if grouped { "ready" } else { "completed" },
            "{}",
            current["session"]["error"]
        );
        assert_eq!(current["reports"].as_array().unwrap().len(), 1);
        assert_eq!(
            current["reports"][0]["content"]["points"][0]["turnId"],
            turns_before[1]["id"]
        );
        assert_eq!(
            current["reports"][0]["content"]["weaknesses"][0]["pointIndex"],
            0
        );
        assert_eq!(current["session"]["turns"], turns_before);
        interview::validate_database(&runtime.lock().unwrap().conn).unwrap();

        // Optional attribution fields are also checked on reads and backup validation.
        let report_id = current["reports"][0]["id"].as_str().unwrap();
        let original = current["reports"][0].clone();
        let other = report_session(&host, &runtime, &dataset, &version, "practice", 1);
        let foreign_id = other["session"]["id"].as_str().unwrap();
        let foreign_turn = id();
        {
            let mut store = runtime.lock().unwrap();
            let tx = store.conn.transaction().unwrap();
            let mut foreign: InterviewSession = get(&tx, "interview_sessions", foreign_id).unwrap();
            let mut turn = turns_before[0].clone();
            turn["id"] = json!(foreign_turn);
            foreign.turns.push(serde_json::from_value(turn).unwrap());
            crate::store::put(&tx, "interview_sessions", foreign_id, &foreign).unwrap();
            tx.commit().unwrap();
        }
        for (path, value) in [
            ("/content/points/0/turnId", json!(foreign_turn)),
            ("/content/points/0/turnId", json!(id())),
            ("/content/points/0/answerQuote", json!("第一题只讨论读取")),
            ("/content/weaknesses/0/pointIndex", json!(99)),
            ("/content/weaknesses/0/evidenceIds", json!([shown])),
        ] {
            let mut corrupt = original.clone();
            *corrupt.pointer_mut(path).unwrap() = value;
            runtime
                .lock()
                .unwrap()
                .conn
                .execute(
                    "UPDATE interview_reports SET data=?1 WHERE id=?2",
                    rusqlite::params![corrupt.to_string(), report_id],
                )
                .unwrap();
            assert!(
                command(
                    &host,
                    &runtime,
                    &dataset,
                    json!({"kind":"get","sessionId":session_id})
                )
                .is_err()
            );
            assert!(interview::validate_database(&runtime.lock().unwrap().conn).is_err());
            assert!(crate::backup::export(&runtime.lock().unwrap(), false, false).is_err());
            runtime
                .lock()
                .unwrap()
                .conn
                .execute(
                    "UPDATE interview_reports SET data=?1 WHERE id=?2",
                    rusqlite::params![original.to_string(), report_id],
                )
                .unwrap();
        }
        let backup = crate::backup::export(&runtime.lock().unwrap(), false, false).unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mut restored = Store::open(destination.path()).unwrap();
        let prepared =
            crate::backup::prepare_path(&restored, std::path::Path::new(&backup.path)).unwrap();
        let token = prepared.preview.token.clone();
        crate::backup::commit(&mut restored, prepared, &token, true, false).unwrap();
        assert_eq!(
            get::<Value>(&restored.conn, "interview_reports", report_id).unwrap(),
            original
        );
        interview::validate_database(&restored.conn).unwrap();
    }
}

fn report_materials(
    root: &std::path::Path,
    runtime: &Arc<Runtime>,
    dataset: &str,
) -> (SourceVersion, String, String) {
    let project = root.join("report-materials");
    fs::create_dir_all(&project).unwrap();
    fs::write(
        project.join("visible.rs"),
        "pub fn load_record() {\n    read_record();\n}\n",
    )
    .unwrap();
    fs::write(
        project.join("supplement.rs"),
        "pub fn validate_ticket(ticket: u64, current: u64) -> bool {\n    persist_state();\n    ticket == current\n}\n",
    )
    .unwrap();
    let host = Arc::new(SourceHost::new());
    let imported = import_dir(&project, runtime, dataset, &host);
    let version: SourceVersion = serde_json::from_value(
        host.handle(
            runtime,
            dataset,
            SourceCommand::SetScope {
                version_id: imported.id.clone(),
                expected_scope_version: imported.scope_version,
                paths: vec!["*".into()],
                confirmed: true,
            },
        )
        .unwrap(),
    )
    .unwrap();
    let hits = host
        .handle(
            runtime,
            dataset,
            SourceCommand::Search {
                version_id: version.id.clone(),
                query: "load_record validate_ticket".into(),
                token: id(),
            },
        )
        .unwrap();
    let evidence = |path| {
        hits.as_array()
            .unwrap()
            .iter()
            .find(|h| h["evidence"]["path"] == path)
            .unwrap()["evidence"]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    (version, evidence("visible.rs"), evidence("supplement.rs"))
}

fn report_session(
    host: &InterviewHost,
    runtime: &Arc<Runtime>,
    dataset: &str,
    version: &SourceVersion,
    mode: &str,
    count: usize,
) -> Value {
    command(host,runtime,dataset,json!({"kind":"create","operationId":id(),"applicationId":null,
        "profileVersionId":null,"jobSnapshotId":null,"sources":[{"versionId":version.id,"scopeVersion":version.scope_version}],
        "contribution":"仅作公开源码阅读练习","role":"AI Agent","stage":"intern","focus":"load_record validate_ticket",
        "mode":mode,"questionCount":count,"repracticeOf":null})).unwrap()
}

#[tokio::test]
async fn not_mentioned_with_a_context_quote_is_rejected_and_manual_retry_preserves_answer() {
    let mut invalid = report();
    invalid["points"][0]["category"] = json!("not_mentioned");
    invalid["points"][0]["observation"] =
        json!("没有展开幂等条件，但不能把相关背景句当作遗漏内容的引文");
    let mut valid = invalid.clone();
    valid["points"][0]["answerQuote"] = json!("");
    let server = Server::new(vec![
        Reply::Content(json!({"question":"取消前如何保存状态？","evidenceIds":[]})),
        Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
        Reply::Content(invalid),
        Reply::Content(valid),
    ]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "practice", 1);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let question = settled(&host, &runtime, &dataset, session_id).await;
    answer(&host, &runtime, &dataset, &question, &id(), "answer");
    let closed = settled(&host, &runtime, &dataset, session_id).await;
    advance(&host, &runtime, &dataset, &closed);
    let rejected = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(rejected["session"]["error"]["code"], "EVIDENCE_INVALID");
    assert!(rejected["reports"].as_array().unwrap().is_empty());
    assert_eq!(
        rejected["session"]["turns"][0]["answer"]["text"],
        "我会先保存状态"
    );
    assert_eq!(server.inputs.lock().unwrap().len(), 3);
    advance(&host, &runtime, &dataset, &rejected);
    let recovered = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(
        recovered["reports"][0]["content"]["points"][0]["category"],
        "not_mentioned"
    );
    assert_eq!(
        recovered["reports"][0]["content"]["points"][0]["answerQuote"],
        ""
    );
    assert_eq!(recovered["session"]["turns"].as_array().unwrap().len(), 1);
    assert_eq!(server.inputs.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn feedback_cannot_quote_contribution_or_a_different_question_as_the_answer() {
    for prior_group in [false, true] {
        let mut replies = vec![Reply::Content(
            json!({"question":"说明取消边界？","evidenceIds":[]}),
        )];
        if prior_group {
            replies.extend([
                Reply::Content(json!({"question":null,"decision":"sufficient","evidenceIds":[]})),
                Reply::Content(report()),
                Reply::Content(json!({"question":"说明数据库的失败处理？","evidenceIds":[]})),
            ]);
        }
        let mut missing = report();
        missing["points"][0]["category"] = json!("material_gap");
        missing["points"][0]["answerQuote"] = json!("");
        missing["points"][0]["observation"] = json!("本题没有提交回答，不能判断为明确答错");
        replies.extend([Reply::Content(report()), Reply::Content(missing)]);
        let server = Server::new(replies);
        let (_root, runtime, dataset) = fixture();
        configure(&runtime, &dataset, &server.endpoint);
        let host = InterviewHost::new();
        let created = create_session(
            &host,
            &runtime,
            &dataset,
            "practice",
            if prior_group { 2 } else { 1 },
        );
        let session_id = created["session"]["id"].as_str().unwrap();
        advance(&host, &runtime, &dataset, &created);
        let mut current = settled(&host, &runtime, &dataset, session_id).await;
        if prior_group {
            answer(&host, &runtime, &dataset, &current, &id(), "answer");
            current = settled(&host, &runtime, &dataset, session_id).await;
            advance(&host, &runtime, &dataset, &current);
            current = settled(&host, &runtime, &dataset, session_id).await;
            assert_eq!(current["reports"].as_array().unwrap().len(), 1);
            advance(&host, &runtime, &dataset, &current);
            current = settled(&host, &runtime, &dataset, session_id).await;
        }
        command(&host, &runtime, &dataset, json!({"kind":"reveal","sessionId":session_id,"expectedRevision":current["session"]["revision"]})).unwrap();
        let rejected = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(rejected["session"]["error"]["code"], "EVIDENCE_INVALID");
        assert_eq!(
            rejected["reports"].as_array().unwrap().len(),
            usize::from(prior_group)
        );
        advance(&host, &runtime, &dataset, &rejected);
        let recovered = settled(&host, &runtime, &dataset, session_id).await;
        assert_eq!(recovered["session"]["status"], "ready");
        assert_eq!(
            recovered["reports"].as_array().unwrap().len(),
            usize::from(prior_group) + 1
        );
        interview::validate_database(&runtime.lock().unwrap().conn).unwrap();
    }
}

#[tokio::test]
async fn stopped_late_result_cannot_add_a_question_and_draft_survives() {
    let server = Server::new(vec![Reply::Delayed(
        json!({"question":"晚到问题","evidenceIds":[]}),
        Duration::from_millis(250),
    )]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "practice", 6);
    let session_id = created["session"]["id"].as_str().unwrap();
    let draft = command(&host, &runtime, &dataset, json!({"kind":"save_draft","sessionId":session_id,
        "expectedRevision":created["session"]["revision"],"operationId":id(),"text":"尚未发送的输入"})).unwrap();
    assert_eq!(draft["session"]["questionCount"], 6);
    advance(&host, &runtime, &dataset, &draft);
    command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"stop","sessionId":session_id}),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let value = command(
        &host,
        &runtime,
        &dataset,
        json!({"kind":"get","sessionId":session_id}),
    )
    .unwrap();
    assert_eq!(value["session"]["status"], "paused");
    assert_eq!(value["session"]["draft"], "尚未发送的输入");
    assert!(value["session"]["turns"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn fabricated_citation_is_rejected_and_answer_save_failure_makes_no_model_call() {
    let server = Server::new(vec![
        Reply::Content(json!({"question":"问题","evidenceIds":[]})),
        Reply::Content(
            json!({"question":"伪造来源","decision":"needs_clarification","evidenceIds":["not-provided"]}),
        ),
    ]);
    let (_root, runtime, dataset) = fixture();
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    let created = create_session(&host, &runtime, &dataset, "practice", 1);
    let session_id = created["session"]["id"].as_str().unwrap();
    advance(&host, &runtime, &dataset, &created);
    let first = settled(&host, &runtime, &dataset, session_id).await;
    runtime.lock().unwrap().conn.execute_batch("CREATE TRIGGER fail_answer BEFORE UPDATE ON interview_sessions BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(command(&host, &runtime, &dataset, json!({"kind":"answer","sessionId":session_id,"expectedRevision":first["session"]["revision"],
        "operationId":id(),"text":"我会先保存状态","disposition":"answer"})).is_err());
    assert_eq!(server.inputs.lock().unwrap().len(), 1);
    runtime
        .lock()
        .unwrap()
        .conn
        .execute_batch("DROP TRIGGER fail_answer")
        .unwrap();
    answer(&host, &runtime, &dataset, &first, &id(), "answer");
    let result = settled(&host, &runtime, &dataset, session_id).await;
    assert_eq!(result["session"]["error"]["code"], "EVIDENCE_INVALID");
    assert_eq!(result["session"]["turns"].as_array().unwrap().len(), 1);
    let saved: InterviewSession = get(
        &runtime.lock().unwrap().conn,
        "interview_sessions",
        session_id,
    )
    .unwrap();
    assert_eq!(
        saved.turns[0].answer.as_ref().unwrap().text,
        "我会先保存状态"
    );
}

#[test]
#[ignore = "仅在明确授权真实项目根目录后，通过环境变量启用；不运行被导入项目"]
fn representative_source_import() {
    let sample =
        std::env::var_os("SUPER_OFFER_SOURCE_SAMPLE_DIR").expect("需要明确提供被授权的样本根目录");
    let output =
        std::env::var_os("SUPER_OFFER_SOURCE_SAMPLE_REPORT").expect("需要明确提供本地证据报告路径");
    let expected: Vec<[String; 3]> = serde_json::from_str(
        &std::env::var("SUPER_OFFER_SOURCE_EXPECTATIONS")
            .expect("需要预先指定已知查询、相对文件及定义"),
    )
    .expect("已知位置须为包含三个字符串的数组列表");
    assert!(!expected.is_empty(), "至少提供一个已知定义");
    let sample = fs::canonicalize(sample).unwrap();
    let output = std::path::PathBuf::from(output);
    let parent = fs::canonicalize(output.parent().expect("报告须位于已有目录")).unwrap();
    assert!(!parent.starts_with(&sample), "不能向被分析项目写报告");
    let (_root, runtime, dataset) = fixture();
    let host = Arc::new(SourceHost::new());
    let start = Instant::now();
    let version = import_dir(&sample, &runtime, &dataset, &host);
    let import_ms = start.elapsed().as_millis();
    let files = source::files_for(&runtime.lock().unwrap().conn, &version.id).unwrap();
    let asset: FileAsset = get(&runtime.lock().unwrap().conn, "assets", &version.asset_id).unwrap();
    let mut searches = Vec::new();
    for [query, expected_path, declaration] in &expected {
        let began = Instant::now();
        let results = host
            .handle(
                &runtime,
                &dataset,
                SourceCommand::Search {
                    version_id: version.id.clone(),
                    query: query.into(),
                    token: id(),
                },
            )
            .unwrap();
        let hits = results.as_array().unwrap();
        let definition_first = hits.first().is_some_and(|hit| {
            hit["evidence"]["path"].as_str() == Some(expected_path.as_str())
                && hit["evidence"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(declaration))
        });
        searches.push(json!({"query":query,"expectedPath":expected_path,"expectedDeclaration":declaration,"definitionFirst":definition_first,
            "milliseconds":began.elapsed().as_millis(),"hits":hits.iter().map(|hit| json!({
                "path":hit["evidence"]["path"],"startLine":hit["evidence"]["startLine"],"endLine":hit["evidence"]["endLine"],
                "fileSha256":hit["evidence"]["fileSha256"],"evidenceSha256":hit["evidence"]["sha256"]
            })).collect::<Vec<_>>()}));
    }
    let passed = searches.iter().all(|s| s["definitionFirst"] == true);
    let mut excluded_reasons = std::collections::BTreeMap::<String, usize>::new();
    for file in files.iter().filter(|f| f.status == "excluded") {
        *excluded_reasons.entry(file.reason.clone()).or_default() += 1;
    }
    let report = json!({"task":"S3-01/S3-03","acceptance":["AC18","AC34项目","V03"],"platform":std::env::consts::OS,
        "sampleName":sample.file_name().map(|s|s.to_string_lossy()),"sourceVersionId":version.id,
        "readableFiles":version.readable_files,"manifestFiles":version.total_files,"sourceBytes":version.source_bytes,"archiveBytes":asset.bytes,
        "excludedFiles":files.iter().filter(|f|f.status=="excluded").count(),"failedFiles":files.iter().filter(|f|f.status=="failed").count(),
        "excludedReasons":excluded_reasons,"failedEntries":files.iter().filter(|f|f.status=="failed").map(|f|json!({"path":f.path,"reason":f.reason})).collect::<Vec<_>>(),
        "importMilliseconds":import_ms,"searches":searches,"knownEvidencePassed":passed,
        "externalCalls":0,"projectCodeExecuted":false,"scopeGranted":false,
        "limits":{"entries":source::MAX_FILES,"singleFileBytes":source::MAX_FILE_BYTES,"readBytes":source::MAX_SOURCE_BYTES}});
    let mut receipt = tempfile::NamedTempFile::new_in(&parent).unwrap();
    serde_json::to_writer_pretty(&mut receipt, &report).unwrap();
    receipt
        .persist(parent.join(output.file_name().unwrap()))
        .unwrap();
    assert!(passed, "已知源码定义未排在首位，详情见脱敏报告");
}

#[tokio::test]
async fn interview_selects_the_best_authorized_evidence_across_projects() {
    let (root, runtime, dataset) = fixture();
    let source_host = Arc::new(SourceHost::new());
    let mut sources = Vec::new();
    for n in 0..5 {
        let project = root.path().join(format!("project_{n}"));
        let allowed = project.join("allowed");
        fs::create_dir_all(&allowed).unwrap();
        for file in 0..7 {
            fs::write(allowed.join(format!("call_{file}.py")), "worker_checkpoint()").unwrap();
        }
        fs::write(
            project.join("private.py"),
            "def worker_checkpoint(): return 'withheld_marker'",
        ).unwrap();
        if n == 4 {
            fs::write(allowed.join("definition.py"), "def worker_checkpoint(): return 'exact_marker'").unwrap();
        }
        let version = import_dir(&project, &runtime, &dataset, &source_host);
        let grant = source_host.handle(&runtime, &dataset, SourceCommand::SetScope {
            version_id: version.id.clone(), expected_scope_version: version.scope_version,
            paths: vec!["allowed/".into()], confirmed: true,
        }).unwrap();
        sources.push(json!({"versionId": version.id, "scopeVersion": grant["scopeVersion"]}));
    }
    let question = json!({"question":"请解释代码中的检查点。","evidenceIds":[]});
    let server = Server::new(vec![Reply::Content(question.clone()), Reply::Content(question)]);
    configure(&runtime, &dataset, &server.endpoint);
    let host = InterviewHost::new();
    for _ in 0..2 {
        let created = command(&host, &runtime, &dataset, json!({
            "kind":"create","operationId":id(),"role":"AI Agent","stage":"intern","mode":"practice",
            "sources":sources,"focus":"worker_checkpoint","contribution":"","questionCount":1
        })).unwrap();
        advance(&host, &runtime, &dataset, &created);
        let ready = settled(&host, &runtime, &dataset, created["session"]["id"].as_str().unwrap()).await;
        assert_eq!(ready["session"]["status"], "waiting_answer", "{}", ready["session"]["error"]);
        sources.reverse();
    }
    let inputs = server.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 2);
    let mut selected = Vec::new();
    let mut found_definition = Vec::new();
    for input in inputs.iter() {
        let context: Value = serde_json::from_str(input.split_once("\n资料：").unwrap().1).unwrap();
        let evidence = context["evidence"].as_array().unwrap();
        assert_eq!(evidence.len(), 20);
        assert!(!input.contains("withheld_marker"));
        for source in &sources {
            assert!(evidence.iter().filter(|e| e["sourceVersionId"] == source["versionId"]).count() <= 6);
        }
        found_definition.push(evidence.iter().any(|e| {
            e["sourceVersionId"] == sources[4]["versionId"] && e["path"] == "allowed/definition.py"
                && e["text"] == "def worker_checkpoint(): return 'exact_marker'"
        }));
        let mut ids: Vec<_> = evidence.iter().map(|e| e["id"].as_str().unwrap().to_owned()).collect();
        ids.sort();
        selected.push(ids);
    }
    assert_eq!(found_definition, [true, true], "正序／倒序 HTTP 正文是否含已授权的确切源码定义");
    assert_eq!(selected[0], selected[1]);
}
