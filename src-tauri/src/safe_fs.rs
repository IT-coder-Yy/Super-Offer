use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::{ambient_authority, fs::Dir};
use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata},
    io,
    path::{Component, Path, PathBuf},
};

pub struct SafeDir(Dir);

pub enum Entry {
    Directory(SafeDir),
    File(File),
}

fn rejected(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn child_name(name: &OsStr) -> io::Result<()> {
    let value = name
        .to_str()
        .ok_or_else(|| rejected("文件名编码不受支持。"))?;
    let mut parts = Path::new(name).components();
    if value.is_empty()
        || !matches!(parts.next(), Some(Component::Normal(_)))
        || parts.next().is_some()
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || value.ends_with(['.', ' '])
    {
        return Err(rejected("只允许当前目录中的普通文件名。"));
    }
    let stem = value.split('.').next().unwrap_or_default().to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|tail| {
            matches!(
                tail,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    {
        return Err(rejected("不读取系统设备名。"));
    }
    Ok(())
}

fn read_options() -> cap_std::fs::OpenOptions {
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // 非阻塞打开后再检查句柄类型，避免 FIFO 在类型检查前阻塞。
        options.custom_flags(libc::O_NONBLOCK);
    }
    options
}

fn ordinary(metadata: &Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(rejected("不读取链接、junction或其它重解析点。"));
        }
    }
    if metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err(rejected("不读取链接或特殊文件。"));
    }
    Ok(())
}

impl SafeDir {
    /// 仅供宿主接入用户通过原生对话框选择的目录，不向网页暴露路径参数。
    pub fn open_root(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(rejected("请选择绝对路径的本地目录。"));
        }
        // 去掉尾分隔符，避免操作系统把最终链接当作中间路径组件。
        let path: PathBuf = path.components().collect();
        let file =
            cap_std::fs::File::open_ambient_with(path, &read_options(), ambient_authority())?
                .into_std();
        let metadata = file.metadata()?;
        ordinary(&metadata)?;
        if !metadata.is_dir() {
            return Err(rejected("所选对象不是目录。"));
        }
        Ok(Self(Dir::from_std_file(file)))
    }

    /// 返回最多 limit 个名字；调用方可多请求一项，记录超出范围而不丢弃已读部分。
    pub fn names(&self, limit: usize) -> io::Result<Vec<OsString>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.0
            .entries()?
            .take(limit)
            .map(|entry| Ok(entry?.file_name()))
            .collect()
    }

    pub fn open_child(&self, name: &OsStr) -> io::Result<Entry> {
        child_name(name)?;
        let file = self.0.open_with(name, &read_options())?.into_std();
        // 不调用 cap 的路径/DirEntry 元数据，避开 #427 的有符号 st_rdev 转换。
        let metadata = file.metadata()?;
        ordinary(&metadata)?;
        if metadata.is_dir() {
            Ok(Entry::Directory(Self(Dir::from_std_file(file))))
        } else {
            Ok(Entry::File(file))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read};

    fn read(entry: Entry) -> String {
        let Entry::File(mut file) = entry else {
            panic!("expected file")
        };
        let mut value = String::new();
        file.read_to_string(&mut value).unwrap();
        value
    }

    #[test]
    fn reads_unicode_files_through_directory_handles_without_writing() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("源码")).unwrap();
        fs::write(root.path().join("源码/用户.rs"), "原始内容").unwrap();
        let dir = SafeDir::open_root(root.path()).unwrap();
        assert_eq!(dir.names(5).unwrap(), vec![OsString::from("源码")]);
        let Entry::Directory(child) = dir.open_child(OsStr::new("源码")).unwrap() else {
            panic!()
        };
        assert_eq!(
            read(child.open_child(OsStr::new("用户.rs")).unwrap()),
            "原始内容"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("源码/用户.rs")).unwrap(),
            "原始内容"
        );
    }

    #[test]
    fn rejects_path_syntax_and_device_names_before_open() {
        let root = tempfile::tempdir().unwrap();
        let dir = SafeDir::open_root(root.path()).unwrap();
        for name in [
            "",
            ".",
            "..",
            "../secret",
            "a/b",
            "a\\b",
            "/etc",
            "C:\\secret",
            "C:secret",
            "\\\\server\\share",
            "file:stream",
            "trailing/",
            "file.",
            "file ",
            "a\0b",
            "NUL",
            "con.txt",
            "COM1.rs",
            "LPT²",
        ] {
            assert!(
                dir.open_child(OsStr::new(name)).is_err(),
                "accepted {name:?}"
            );
        }
        assert!(SafeDir::open_root(Path::new("relative")).is_err());
        fs::write(root.path().join("file"), "text").unwrap();
        assert!(SafeDir::open_root(&root.path().join("file")).is_err());
    }

    #[test]
    fn returns_bounded_names_and_surfaces_disappeared_entries() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..8 {
            fs::write(root.path().join(format!("{i}.rs")), "x").unwrap();
        }
        let dir = SafeDir::open_root(root.path()).unwrap();
        assert!(dir.names(0).unwrap().is_empty());
        assert_eq!(dir.names(3).unwrap().len(), 3);
        assert_eq!(dir.names(20).unwrap().len(), 8);
        fs::remove_file(root.path().join("0.rs")).unwrap();
        assert!(dir.open_child(OsStr::new("0.rs")).is_err());
    }

    #[test]
    fn pinned_root_cannot_be_redirected_by_an_ancestor_rename() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        let selected = parent.join("selected");
        fs::create_dir_all(&selected).unwrap();
        fs::write(selected.join("inside.rs"), "inside").unwrap();
        let root = SafeDir::open_root(&selected).unwrap();
        let renamed = temp.path().join("renamed");
        let result = fs::rename(&parent, &renamed);
        #[cfg(windows)]
        assert!(
            result.is_err(),
            "Windows enumeration requires the no-delete directory handle"
        );
        #[cfg(unix)]
        {
            result.unwrap();
            fs::create_dir_all(&selected).unwrap();
            fs::write(selected.join("outside.rs"), "outside").unwrap();
        }
        assert_eq!(root.names(5).unwrap(), vec![OsString::from("inside.rs")]);
        assert_eq!(
            read(root.open_child(OsStr::new("inside.rs")).unwrap()),
            "inside"
        );
        assert!(root.open_child(OsStr::new("outside.rs")).is_err());
    }

    #[cfg(unix)]
    fn directory_link(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(windows)]
    fn directory_link(target: &Path, link: &Path) {
        use std::{os::windows::process::CommandExt, process::Command};
        let quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let script = format!(
            "New-Item -ItemType Junction -Path '{}' -Target '{}' -ErrorAction Stop | Out-Null",
            quote(link),
            quote(target)
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn refuses_links_and_a_directory_replaced_after_enumeration() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside secret").unwrap();
        fs::create_dir(root.path().join("slot")).unwrap();
        let dir = SafeDir::open_root(root.path()).unwrap();
        assert!(dir.names(10).unwrap().contains(&OsString::from("slot")));
        fs::remove_dir(root.path().join("slot")).unwrap();
        directory_link(outside.path(), &root.path().join("slot"));
        for _ in 0..32 {
            assert!(dir.open_child(OsStr::new("slot")).is_err());
        }
        assert!(SafeDir::open_root(&root.path().join("slot")).is_err());
        let trailing = PathBuf::from(format!(
            "{}{sep}",
            root.path().join("slot").display(),
            sep = std::path::MAIN_SEPARATOR
        ));
        assert!(SafeDir::open_root(&trailing).is_err());
        fs::remove_dir(root.path().join("slot"))
            .or_else(|_| fs::remove_file(root.path().join("slot")))
            .unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "outside secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_symlinks_sockets_and_fifo_without_blocking() {
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::symlink, net::UnixListener},
        };
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "outside").unwrap();
        symlink(outside.path().join("secret"), root.path().join("link")).unwrap();
        let fifo = root.path().join("fifo");
        let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let _socket = UnixListener::bind(root.path().join("socket")).unwrap();
        let dir = SafeDir::open_root(root.path()).unwrap();
        for name in ["link", "fifo", "socket"] {
            assert!(dir.open_child(OsStr::new(name)).is_err());
        }
    }
}
