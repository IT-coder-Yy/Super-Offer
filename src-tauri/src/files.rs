use crate::{
    domain::*,
    store::{Store, atomic_write, bump, digest, get, put},
};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read},
    path::PathBuf,
};

pub const MAX_RESUME_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_EXPANDED_DOCX_BYTES: u64 = 50 * 1024 * 1024;

pub fn validate_resume(name: &str, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_RESUME_BYTES {
        return Err(AppError::invalid("简历须为非空文件，最大 10 MB。"));
    }
    match name.rsplit('.').next().map(str::to_lowercase).as_deref() {
        Some("pdf") if bytes.starts_with(b"%PDF-") => Ok(()),
        Some("docx") => {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            if archive.len() > 2000 {
                return Err(AppError::invalid("DOCX 内文件过多。"));
            }
            let mut total = 0u64;
            let mut names = HashSet::new();
            for i in 0..archive.len() {
                let mut file = archive.by_index(i)?;
                let name = file.name()?.into_owned();
                if file.is_symlink()
                    || file.encrypted()
                    || file.enclosed_name().is_none()
                    || !names.insert(name)
                {
                    return Err(AppError::invalid("DOCX 含有不安全或重复的文件条目。"));
                }
                total = total
                    .checked_add(file.size())
                    .ok_or_else(|| AppError::invalid("DOCX 展开大小不正确。"))?;
                if total > MAX_EXPANDED_DOCX_BYTES {
                    return Err(AppError::invalid("DOCX 展开后超过 50 MB。"));
                }
                let expected = file.size();
                let actual =
                    std::io::copy(&mut file.by_ref().take(expected + 1), &mut std::io::sink())?;
                if actual != expected {
                    return Err(AppError::invalid("DOCX 内容长度不一致。"));
                }
            }
            if !names.contains("word/document.xml") || !names.contains("[Content_Types].xml") {
                return Err(AppError::invalid("此文件不是有效 DOCX。"));
            }
            Ok(())
        }
        _ => Err(AppError::invalid(
            "仅支持文字版 PDF 与 DOCX，不支持 DOC 或扫描件 OCR。",
        )),
    }
}
impl Store {
    pub fn import_asset(
        &mut self,
        expected_dataset: &str,
        name: &str,
        bytes: &[u8],
        kind: AssetKind,
    ) -> Result<FileAsset> {
        if self.dataset_id != expected_dataset {
            return Err(AppError::new(
                "STALE_TASK",
                "导入期间数据已恢复，请重新选择文件。",
            ));
        }
        text(name, "文件名", true, 240)?;
        if name.contains(['/', '\\']) {
            return Err(AppError::invalid("文件名不能包含目录。"));
        }
        match kind {
            AssetKind::Resume => validate_resume(name, bytes)?,
            AssetKind::Audio => {
                if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES {
                    return Err(AppError::invalid("测试音频须为非空文件，最大 50 MB。"));
                }
                let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                if !["wav", "mp3", "m4a"].contains(&ext.as_str()) {
                    return Err(AppError::invalid("音频仅支持 MP3、WAV 或 M4A。"));
                }
            }
            AssetKind::Source => return Err(AppError::invalid("源码导入将在 S3 开放。")),
        }
        let asset = FileAsset {
            id: id(),
            kind,
            name: name.into(),
            sha256: digest(bytes),
            bytes: bytes.len() as u64,
            status: AssetStatus::Available,
            created_at: now(),
        };
        let path = self.dir().join("assets").join(&asset.id);
        atomic_write(&path, bytes)?;
        let result = (|| {
            let tx = self.conn.transaction()?;
            put(&tx, "assets", &asset.id, &asset)?;
            bump(&tx)?;
            tx.commit()?;
            Ok::<_, AppError>(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(asset)
    }
    pub fn asset_path(&self, asset: &FileAsset) -> Result<PathBuf> {
        uuid::Uuid::parse_str(&asset.id).map_err(|_| AppError::invalid("材料标识不正确。"))?;
        if asset.status != AssetStatus::Available {
            return Err(AppError::new(
                "MATERIAL_MISSING",
                "应用中的材料副本不可用，请重新导入。",
            ));
        }
        let path = self.dir().join("assets").join(&asset.id);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| AppError::new("MATERIAL_MISSING", "材料副本已缺失，请重新导入。"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AppError::invalid("材料副本不能是链接或目录。"));
        }
        Ok(path)
    }
    pub fn read_asset(&self, asset_id: &str) -> Result<(FileAsset, Vec<u8>)> {
        let asset: FileAsset = get(&self.conn, "assets", asset_id)?;
        let path = self.asset_path(&asset)?;
        if fs::metadata(&path)?.len() != asset.bytes {
            return Err(AppError::new(
                "MATERIAL_CHANGED",
                "材料副本已改变，请重新导入。",
            ));
        }
        let bytes = fs::read(path)?;
        if digest(&bytes) != asset.sha256 {
            return Err(AppError::new(
                "MATERIAL_CHANGED",
                "材料哈希不匹配，请重新导入。",
            ));
        }
        Ok((asset, bytes))
    }
}
