use cap_std::{ambient_authority, fs::Dir};
use std::{
    io,
    path::{Component, Path, PathBuf},
};

/// All untrusted paths are opened relative to this directory capability. cap-std
/// also checks symlinks at open time, avoiding canonicalize-then-open races.
pub struct Sandbox {
    pub dir: Dir,
}
impl Sandbox {
    pub fn new(root: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(root)?;
        let dir = Dir::open_ambient_dir(root, ambient_authority())?;
        dir.create_dir_all("tmp")?;
        dir.create_dir_all("home")?;
        dir.create_dir_all("workspace")?;
        Ok(Self { dir })
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
