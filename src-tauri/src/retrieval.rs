use crate::{
    domain::*,
    source::{Evidence, SourceFile, SourceVersion, allows, decode, files_for},
    store::{Store, digest, encode, get},
};
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub evidence: Evidence,
    pub score: usize,
    pub allowed: bool,
}
pub struct SearchSource {
    pub version: SourceVersion,
    pub files: Vec<SourceFile>,
    path: PathBuf,
    sha256: String,
    bytes: u64,
}
pub fn prepare(store: &Store, version_id: &str) -> Result<SearchSource> {
    let version: SourceVersion = get(&store.conn, "source_versions", version_id)?;
    let asset: FileAsset = get(&store.conn, "assets", &version.asset_id)?;
    Ok(SearchSource {
        files: files_for(&store.conn, version_id)?,
        path: store.asset_path(&asset)?,
        version,
        sha256: asset.sha256,
        bytes: asset.bytes,
    })
}
fn cancelled(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::SeqCst) {
        Err(AppError::new("CANCELLED", "本地检索已停止。"))
    } else {
        Ok(())
    }
}
fn literal_matches(text: &str, lower: &str, term: &str) -> bool {
    if term.len() > 2 || !term.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return lower.contains(term);
    }
    let bytes = text.as_bytes();
    bytes.windows(term.len()).enumerate().any(|(start, part)| {
        if !part.eq_ignore_ascii_case(term.as_bytes()) {
            return false;
        }
        let end = start + part.len();
        let before = start == 0
            || !bytes[start - 1].is_ascii_alphanumeric()
            || (bytes[start - 1].is_ascii_lowercase() && bytes[start].is_ascii_uppercase());
        let after = end == bytes.len()
            || !bytes[end].is_ascii_alphanumeric()
            || (bytes[end - 1].is_ascii_lowercase() && bytes[end].is_ascii_uppercase())
            || (bytes[end - 1].is_ascii_uppercase()
                && bytes[end].is_ascii_uppercase()
                && bytes.get(end + 1).is_some_and(u8::is_ascii_lowercase));
        before && after
    })
}
pub fn scan(
    input: &SearchSource,
    query: &str,
    limit: usize,
    external: bool,
    cancel: &AtomicBool,
) -> Result<Vec<SearchHit>> {
    text(query, "检索关键词", true, 2000)?;
    let terms = query
        .split(|c: char| {
            c.is_whitespace() || ['，', ',', '；', ';', '/', '\\', ':', '：'].contains(&c)
        })
        .filter(|s| !s.is_empty())
        .take(24)
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err(AppError::invalid("请提供文字或标识符作为检索关键词。"));
    }
    let mut file = File::open(&input.path)?;
    if file.metadata()?.len() != input.bytes {
        return Err(AppError::new("MATERIAL_CHANGED", "项目副本大小已改变。"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        cancelled(cancel)?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != input.sha256 {
        return Err(AppError::new(
            "MATERIAL_CHANGED",
            "项目副本校验失败，未读取检索内容。",
        ));
    }
    file.seek(SeekFrom::Start(0))?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut hits = Vec::new();
    for entry in input.files.iter().filter(|f| f.status == "readable") {
        cancelled(cancel)?;
        let allowed = allows(&input.version, &entry.path);
        if external && !allowed {
            continue;
        }
        let mut archived = archive.by_name(&entry.path)?;
        if archived.size() != entry.bytes || archived.size() > crate::source::MAX_FILE_BYTES {
            return Err(AppError::new(
                "MATERIAL_CHANGED",
                "项目文件清单与副本不一致。",
            ));
        }
        let mut bytes = Vec::new();
        archived
            .by_ref()
            .take(crate::source::MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if digest(&bytes) != entry.sha256 {
            return Err(AppError::new("MATERIAL_CHANGED", "项目文件哈希校验失败。"));
        }
        let content = decode(&bytes)?;
        let lines = content.lines().collect::<Vec<_>>();
        let path_lower = entry.path.to_lowercase();
        let source_file = path_lower.rsplit_once('.').is_some_and(|(_, extension)| {
            [
                "rs", "py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "go", "c", "h",
                "cpp", "hpp", "cs", "swift", "kt", "rb", "php", "scala",
            ]
            .contains(&extension)
        });
        let source_score = if source_file { 100 } else { 0 };
        let path_score = terms
            .iter()
            .filter(|t| literal_matches(&entry.path, &path_lower, t))
            .count()
            * 5;
        let mut positions = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if index.is_multiple_of(128) {
                cancelled(cancel)?;
            }
            let lower = line.to_lowercase();
            let score = terms
                .iter()
                .filter(|t| literal_matches(line, &lower, t))
                .count();
            if score > 0 {
                // shortcut: keyword declarations outrank calls; this is a literal search, not an AST index.
                let tokens = lower
                    .split(|c: char| !c.is_alphanumeric() && c != '_')
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                let definition = source_file
                    && tokens.windows(2).any(|pair| {
                        [
                            "fn",
                            "def",
                            "class",
                            "function",
                            "struct",
                            "enum",
                            "trait",
                            "interface",
                            "type",
                            "const",
                            "let",
                            "var",
                        ]
                        .contains(&pair[0])
                            && terms.iter().any(|term| term == pair[1])
                    });
                positions.push((
                    index,
                    score + path_score + source_score + if definition { 1000 } else { 0 },
                ));
            }
        }
        if positions.is_empty() && path_score > 0 && !lines.is_empty() {
            positions.push((0, path_score + source_score));
        }
        positions.sort_by_key(|x| std::cmp::Reverse(x.1));
        let mut ranges = Vec::new();
        for (line, score) in positions {
            if ranges.len() == 3 {
                break;
            }
            let start = line.saturating_sub(3);
            let end = (line + 7).min(lines.len());
            if ranges.iter().any(|(a, b)| start < *b && end > *a) {
                continue;
            }
            let excerpt = lines[start..end].join("\n");
            if excerpt.len() > 32_000 {
                continue;
            }
            ranges.push((start, end));
            let evidence_hash = digest(excerpt.as_bytes());
            let evidence_id = digest(
                encode(&(
                    input.version.id.as_str(),
                    entry.path.as_str(),
                    start + 1,
                    end,
                    &evidence_hash,
                ))?
                .as_bytes(),
            );
            hits.push(SearchHit {
                evidence: Evidence {
                    id: evidence_id,
                    source_version_id: input.version.id.clone(),
                    path: entry.path.clone(),
                    file_sha256: entry.sha256.clone(),
                    start_line: start + 1,
                    end_line: end,
                    text: excerpt,
                    sha256: evidence_hash,
                },
                score,
                allowed,
            });
        }
    }
    keep_best(&mut hits, limit.min(40));
    Ok(hits)
}

pub(crate) fn keep_best(hits: &mut Vec<SearchHit>, limit: usize) {
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.evidence.path.cmp(&b.evidence.path))
            .then(a.evidence.start_line.cmp(&b.evidence.start_line))
            .then_with(|| a.evidence.source_version_id.cmp(&b.evidence.source_version_id))
    });
    hits.truncate(limit);
}
pub fn persist(conn: &Connection, hits: &[SearchHit]) -> Result<()> {
    for hit in hits {
        crate::source::validate_evidence(conn, &hit.evidence)?;
        conn.execute("INSERT INTO evidence(id,source_version_id,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![hit.evidence.id, hit.evidence.source_version_id, encode(&hit.evidence)?])?;
    }
    Ok(())
}
pub fn search(
    store: &Store,
    version_id: &str,
    query: &str,
    limit: usize,
    external: bool,
) -> Result<Vec<SearchHit>> {
    let input = prepare(store, version_id)?;
    let results = scan(&input, query, limit, external, &AtomicBool::new(false))?;
    persist(&store.conn, &results)?;
    Ok(results)
}
