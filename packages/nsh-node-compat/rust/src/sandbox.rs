use cap_std::{ambient_authority, fs::Dir};
use std::{
    io,
    path::{Component, Path, PathBuf},
};

/// All untrusted paths are opened relative to this directory capability. cap-std
/// also checks symlinks at open time, avoiding canonicalize-then-open races.
pub struct Sandbox {
    pub dir: Dir,
    root: PathBuf,
}
impl Sandbox {
    pub fn new(root: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(root)?;
        let dir = Dir::open_ambient_dir(root, ambient_authority())?;
        dir.create_dir_all("tmp")?;
        dir.create_dir_all("home")?;
        dir.create_dir_all("workspace")?;
        Ok(Self {
            dir,
            root: std::fs::canonicalize(root)?,
        })
    }
    /// Interpret links using guest /workspace, retaining capability-based opens.
    pub fn resolve(&self, input: &str, follow_final: bool) -> io::Result<PathBuf> {
        use std::collections::VecDeque;
        let owned = if input == "~" {
            "/home".to_owned()
        } else if let Some(rest) = input.strip_prefix("~/") {
            format!("/home/{rest}")
        } else {
            input.to_owned()
        };
        // Validate syntax without using the lexically collapsed path for resolution.
        self.path(&owned)?;
        let components = |path: &Path| -> VecDeque<std::ffi::OsString> {
            path.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_owned()),
                    Component::ParentDir => Some("..".into()),
                    _ => None,
                })
                .collect()
        };
        let mut pending = components(Path::new(&owned));
        let workspace = pending.front().is_some_and(|p| p == "workspace");
        let mut resolved = PathBuf::new();
        let mut links = 0;
        while let Some(part) = pending.pop_front() {
            if part == ".." {
                if !resolved.pop() || (workspace && !resolved.starts_with("workspace")) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "path leaves workspace",
                    ));
                }
                continue;
            }
            resolved.push(part);
            if pending.is_empty() && !follow_final {
                break;
            }
            let meta = match self.dir.symlink_metadata(&resolved) {
                Ok(meta) => meta,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if !meta.is_symlink() {
                continue;
            }
            links += 1;
            if links > 40 {
                return Err(io::Error::other("ELOOP: too many symbolic links"));
            }
            let target = self.dir.read_link_contents(&resolved)?;
            resolved.pop();
            let translated = if target.is_absolute() {
                let internal = target
                    .strip_prefix(self.root.join("workspace"))
                    .ok()
                    .filter(|relative| {
                        relative
                            .file_name()
                            .is_some_and(|name| name.to_string_lossy().starts_with(".l2s."))
                    });
                resolved.clear();
                if let Some(relative) = internal {
                    PathBuf::from("workspace").join(relative)
                } else if target.starts_with("/workspace") {
                    target
                } else {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "link leaves guest workspace",
                    ));
                }
            } else {
                target
            };
            let mut expansion = components(&translated);
            expansion.append(&mut pending);
            pending = expansion;
        }
        if resolved.as_os_str().is_empty() {
            resolved.push(".");
        }
        Ok(resolved)
    }
    pub fn path(&self, input: &str) -> io::Result<PathBuf> {
        if input.contains('\0') || input.contains('\\') {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid sandbox path",
            ));
        }
        let mut path = PathBuf::new();
        let owned = if input == "~" {
            "/home".into()
        } else if let Some(s) = input.strip_prefix("~/") {
            format!("/home/{s}")
        } else {
            input.to_owned()
        };
        for component in Path::new(&owned).components() {
            match component {
                Component::RootDir | Component::CurDir => (),
                Component::Normal(s) => path.push(s),
                Component::ParentDir => {
                    if !path.pop() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "path escapes sandbox",
                        ));
                    }
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "unsupported path",
                    ));
                }
            }
        }
        if path.as_os_str().is_empty() {
            path.push(".");
        }
        Ok(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn guest_links_and_proot_hardlinks_share_workspace_capability() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let s = Sandbox::new(temp.path()).unwrap();
        s.dir.write("workspace/original", b"a").unwrap();
        symlink(
            "/workspace/original",
            temp.path().join("workspace/absolute"),
        )
        .unwrap();
        symlink("absolute", temp.path().join("workspace/relative")).unwrap();
        symlink("/workspace", temp.path().join("workspace/directory")).unwrap();
        for path in [
            "/workspace/absolute",
            "/workspace/relative",
            "/workspace/directory/absolute",
        ] {
            s.dir
                .write(s.resolve(path, true).unwrap(), b"updated")
                .unwrap();
            assert_eq!(s.dir.read("workspace/original").unwrap(), b"updated");
        }
        s.dir.create_dir_all("workspace/sub/nested").unwrap();
        symlink(
            "/workspace/sub/nested",
            temp.path().join("workspace/nested"),
        )
        .unwrap();
        assert_eq!(
            s.resolve("/workspace/nested/../target", true).unwrap(),
            PathBuf::from("workspace/sub/target")
        );
        symlink("/usr/bin/python3", temp.path().join("workspace/external")).unwrap();
        symlink("../home/agent", temp.path().join("workspace/ledger")).unwrap();
        assert!(s.resolve("/workspace/external", true).is_err());
        assert!(s.resolve("/workspace/ledger", true).is_err());
        assert_eq!(
            s.resolve("/workspace/external", false).unwrap(),
            PathBuf::from("workspace/external")
        );
        s.dir.write("workspace/.l2s.actual", b"hardlink").unwrap();
        symlink(
            s.root.join("workspace/.l2s.actual"),
            temp.path().join("workspace/hardlink"),
        )
        .unwrap();
        assert_eq!(
            s.dir
                .read(s.resolve("/workspace/hardlink", true).unwrap())
                .unwrap(),
            b"hardlink"
        );
        symlink(
            temp.path().join("home/.l2s.outside"),
            temp.path().join("workspace/forged"),
        )
        .unwrap();
        assert!(s.resolve("/workspace/forged", true).is_err());
    }
    #[test]
    fn paths_and_symlinks_stay_inside() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let s = Sandbox::new(temp.path()).unwrap();
        assert!(s.path("/../../secret").is_err());
        assert!(s.path("a/../../../secret").is_err());
        assert_eq!(s.path("~/x").unwrap(), PathBuf::from("home/x"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), temp.path().join("escape")).unwrap();
            assert!(s.dir.write(s.path("escape/pwn").unwrap(), b"no").is_err());
        }
    }
}
