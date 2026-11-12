use super::*;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    os::fd::{FromRawFd, IntoRawFd},
    os::unix::fs::PermissionsExt,
    sync::atomic::AtomicBool,
    time::Instant,
};

unsafe extern "C" {
    fn looi_ish_archive() -> *const c_char;
    fn looi_ish_codex_directory() -> *const c_char;
    fn looi_ish_boot(root: *const c_char, workspace: *const c_char, dns: *const c_char, codex: *const c_char, failed_stage: *mut *const c_char) -> i32;
    fn looi_ish_start(
        command: *const c_char,
        cwd: *const c_char,
        env: *const c_char,
        env_len: usize,
        out: i32,
        err: i32,
    ) -> *mut c_void;
    fn looi_ish_poll(job: *mut c_void, status: *mut i32) -> i32;
    fn looi_ish_signal(job: *mut c_void, signal: i32) -> i32;
    fn looi_ish_release(job: *mut c_void);
}
static KERNEL: OnceLock<Result<PathBuf, String>> = OnceLock::new();

pub fn archive() -> Result<PathBuf, String> {
    let path = unsafe { looi_ish_archive() };
    if path.is_null() {
        return Err("Bundled Alpine fakefs archive is missing".into());
    }
    Ok(PathBuf::from(
        unsafe { CStr::from_ptr(path) }
            .to_string_lossy()
            .into_owned(),
    ))
}
fn cstr(value: impl AsRef<str>) -> Result<CString, String> {
    CString::new(value.as_ref()).map_err(|e| e.to_string())
}
fn pipe() -> Result<(std::fs::File, std::fs::File), String> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(unsafe {
        (
            std::fs::File::from_raw_fd(fds[0]),
            std::fs::File::from_raw_fd(fds[1]),
        )
    })
}

/// iOS installs non-Mach-O bundle resources without execute bits. Install the
/// bundled Linux ELF into this app's private data before exposing it to iSH.
fn install_codex(root: &Path) -> Result<PathBuf, String> {
    let path = unsafe { looi_ish_codex_directory() };
    if path.is_null() {
        return Err("Bundled Codex CLI directory is missing (stage=linux.codex.resource)".into());
    }
    let source = PathBuf::from(unsafe { CStr::from_ptr(path) }.to_string_lossy().as_ref());
    let failure = |error: std::io::Error| format!("Codex CLI installation failed (stage=linux.codex.install): {error}");
    let version = std::fs::read_to_string(source.join("version")).map_err(failure)?;
    let destination = root.parent().unwrap().join("linux-tools");
    let installed = match std::fs::read_to_string(destination.join("version")) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(failure(error)),
    };
    if installed.as_deref() != Some(version.as_str()) {
        std::fs::create_dir_all(&destination).map_err(failure)?;
        for name in ["codex", "codex-code-mode-host"] {
            let failure = |error: std::io::Error| format!("Codex executable {name} installation failed (stage=linux.codex.install): {error}");
            let staging = destination.join(format!("{name}.installing"));
            std::fs::copy(source.join(name), &staging).map_err(failure)?;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o555)).map_err(failure)?;
            std::fs::rename(staging, destination.join(name)).map_err(failure)?;
        }
        std::fs::write(destination.join("version"), version).map_err(failure)?;
    }
    Ok(destination)
}
pub fn run(
    root: &Path,
    workspace: &Path,
    request: ShellRequest,
    output: ShellOutput,
) -> Result<ShellOutcome, String> {
    let booted = KERNEL
        .get_or_init(|| {
            let dns = root.parent().unwrap().join("linux-resolv.conf");
            std::fs::write(&dns, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
                .map_err(|e| e.to_string())?;
            let root_data = cstr(root.join("data").to_string_lossy())?;
            let work = cstr(workspace.to_string_lossy())?;
            let dns = cstr(dns.to_string_lossy())?;
            let codex = install_codex(root)?;
            let codex_path = cstr(codex.to_string_lossy())?;
            let mut failed_stage = std::ptr::null();
            let result = unsafe { looi_ish_boot(root_data.as_ptr(), work.as_ptr(), dns.as_ptr(), codex_path.as_ptr(), &mut failed_stage) };
            if result != 0 {
                let stage = unsafe { CStr::from_ptr(failed_stage) }.to_string_lossy();
                return Err(format!("Alpine iSH initialization failed (stage={stage}, code={result})"));
            }
            Ok(root.to_path_buf())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    if booted != root {
        return Err("iSH is already mounted for another application directory".into());
    }
    let (out, out_write) = pipe()?;
    let (err, err_write) = pipe()?;
    let command = cstr(&request.command)?;
    let cwd = cstr(&request.cwd)?;
    let mut env = Vec::new();
    for (key, value) in &request.env {
        let entry = cstr(format!("{key}={value}"))?;
        env.extend_from_slice(entry.as_bytes_with_nul());
    }
    env.push(0);
    let job = unsafe {
        looi_ish_start(
            command.as_ptr(),
            cwd.as_ptr(),
            env.as_ptr().cast(),
            env.len(),
            out_write.into_raw_fd(),
            err_write.into_raw_fd(),
        )
    };
    let halt = Arc::new(AtomicBool::new(false));
    let stdout = super::read_pipe(out, ShellStream::Stdout, output.clone(), halt.clone());
    let stderr = super::read_pipe(err, ShellStream::Stderr, output, halt.clone());
    let start = Instant::now();
    let mut status = 1;
    let mut cancelled;
    let mut timed_out;
    let mut failure = None;
    loop {
        let ready = unsafe { looi_ish_poll(job, &mut status) };
        cancelled = ready == 0 && request.cancelled.load(Ordering::Relaxed);
        timed_out = ready == 0 && !cancelled && start.elapsed() >= request.timeout;
        if ready < 0 {
            failure = Some(format!("Alpine iSH launch failed: {ready}"));
            break;
        }
        if ready > 0 || cancelled || timed_out {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        looi_ish_signal(job, 15);
    }
    let stop = Instant::now();
    loop {
        let live = unsafe {
            looi_ish_signal(
                job,
                if stop.elapsed() >= Duration::from_millis(200) {
                    9
                } else {
                    0
                },
            )
        };
        if live == 0 {
            break;
        }
        if stop.elapsed() >= Duration::from_millis(2500) {
            failure = Some("ERR_SHELL_CLEANUP: Alpine iSH process cleanup was not confirmed".into());
            halt.store(true, Ordering::Relaxed);
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for reader in [stdout, stderr] {
        reader
            .join()
            .map_err(|_| "Alpine iSH output reader failed")??;
    }
    unsafe {
        looi_ish_release(job);
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(ShellOutcome {
        status: if timed_out {
            124
        } else if cancelled {
            143
        } else {
            status
        },
        timed_out,
        cancelled,
    })
}
