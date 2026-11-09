//! App-private Linux guest. The compatibility crate owns only the process contract.
use nsh_node_compat::shell_runner::{
    ShellOutcome, ShellOutput, ShellRequest, ShellRunner, ShellStream,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, atomic::Ordering},
    time::Duration,
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;

pub struct LinuxShell {
    root: PathBuf,
    workspace: PathBuf,
    installation: Arc<Installation>,
}
#[derive(Default)]
struct Installation {
    started: std::sync::atomic::AtomicBool,
    result: Mutex<Option<Result<(), String>>>,
}
type Installations = Mutex<HashMap<PathBuf, Arc<Installation>>>;
static INSTALLATIONS: OnceLock<Installations> = OnceLock::new();

impl LinuxShell {
    pub fn new(data: &Path) -> Result<Self, String> {
        let root = data.join("linux");
        let workspace = data.join("files/workspace");
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let workspace = std::fs::canonicalize(workspace).map_err(|e| e.to_string())?;
        let installation = {
            let mut installs = INSTALLATIONS.get_or_init(Default::default).lock().unwrap();
            installs.entry(root.clone()).or_default().clone()
        };
        Ok(Self {
            root,
            workspace,
            installation,
        })
    }
}
impl ShellRunner for LinuxShell {
    fn run(&self, mut request: ShellRequest, output: ShellOutput) -> Result<ShellOutcome, String> {
        let start = std::time::Instant::now();
        if !self.installation.started.swap(true, Ordering::AcqRel) {
            let state = self.installation.clone();
            let root = self.root.clone();
            std::thread::spawn(move || {
                *state.result.lock().unwrap() = Some(install(&root));
            });
        }
        let mut announced = false;
        loop {
            if request.cancelled.load(Ordering::Relaxed) {
                return Ok(ShellOutcome {
                    status: 143,
                    timed_out: false,
                    cancelled: true,
                });
            }
            if start.elapsed() >= request.timeout {
                return Ok(ShellOutcome {
                    status: 124,
                    timed_out: true,
                    cancelled: false,
                });
            }
            if let Some(result) = self.installation.result.lock().unwrap().clone() {
                result?;
                break;
            }
            if !announced {
                output(ShellStream::Status, "@looi:linuxShellInstalling".into());
                announced = true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        request.timeout = request.timeout.saturating_sub(start.elapsed());
        if announced {
            output(ShellStream::Status, "@looi:linuxShellReady".into());
        }
        #[cfg(target_os = "android")]
        return android::run(&self.root, &self.workspace, request, output);
        #[cfg(target_os = "ios")]
        return ios::run(&self.root, &self.workspace, request, output);
    }
}

fn install(root: &Path) -> Result<(), String> {
    let stage = root.with_extension("installing");
    if stage.exists() {
        std::fs::remove_dir_all(&stage).map_err(|e| e.to_string())?;
    }
    // An installed guest survives app upgrades, including packages added with apk.
    if !root.join(".installed").is_file() {
        std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        let archive = android::archive(&stage)?;
        #[cfg(target_os = "ios")]
        let archive = ios::archive()?;
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        tar::Archive::new(flate2::read::GzDecoder::new(file))
            .unpack(&stage)
            .map_err(|e| format!("Alpine extraction failed: {e}"))?;
        #[cfg(target_os = "android")]
        std::fs::remove_file(archive).map_err(|e| e.to_string())?;
        std::fs::write(stage.join(".installed"), "alpine-3.21.3-aarch64\n")
            .map_err(|e| e.to_string())?;
        std::fs::rename(&stage, root).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "android")]
    let apk_lock = root.join("lib/apk/db/lock");
    #[cfg(target_os = "ios")]
    let apk_lock = root.join("data/lib/apk/db/lock");
    if apk_lock.exists() {
        std::fs::remove_file(apk_lock).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn read_pipe<R: std::io::Read + std::os::fd::AsRawFd + Send + 'static>(
    mut pipe: R,
    stream: ShellStream,
    output: ShellOutput,
    halt: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<Result<(), String>> {
    std::thread::spawn(move || {
        use nsh_node_compat::shell_runner::Utf8Output;
        let fd = pipe.as_raw_fd();
        unsafe {
            libc::fcntl(
                fd,
                libc::F_SETFL,
                libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
            );
        }
        let mut decoder = Utf8Output::default();
        let mut bytes = [0; 8192];
        loop {
            match pipe.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.push(&bytes[..n]);
                    if !text.is_empty() {
                        output(stream, text);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if halt.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let text = decoder.finish();
        if !text.is_empty() {
            output(stream, text);
        }
        Ok(())
    })
}
