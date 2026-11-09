use super::*;
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
};
use std::{
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    sync::atomic::AtomicBool,
    time::Instant,
};

struct AndroidHost {
    vm: JavaVM,
    class: GlobalRef,
    libraries: PathBuf,
}
static HOST: OnceLock<AndroidHost> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_SuperLooiApplication_registerShellVm(
    mut env: JNIEnv<'_>,
    class: JClass<'_>,
    libraries: JString<'_>,
) {
    if let (Ok(vm), Ok(class), Ok(path)) = (
        env.get_java_vm(),
        env.new_global_ref(class),
        env.get_string(&libraries),
    ) {
        let _ = HOST.set(AndroidHost {
            vm,
            class,
            libraries: PathBuf::from(String::from(path)),
        });
    }
}

pub fn archive(stage: &Path) -> Result<PathBuf, String> {
    let host = HOST
        .get()
        .ok_or("Android Linux Shell plugin is not initialized")?;
    let path = stage.join(".rootfs.tar.gz");
    let mut env = host.vm.attach_current_thread().map_err(|e| e.to_string())?;
    let destination = env
        .new_string(path.to_string_lossy())
        .map_err(|e| e.to_string())?;
    env.call_static_method(
        &host.class,
        "copyLinuxArchive",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&destination)],
    )
    .map_err(|e| {
        let _ = env.exception_clear();
        format!("Cannot read bundled Alpine archive: {e}")
    })?;
    Ok(path)
}

pub fn run(
    root: &Path,
    workspace: &Path,
    request: ShellRequest,
    output: ShellOutput,
) -> Result<ShellOutcome, String> {
    let host = HOST
        .get()
        .ok_or("Android Linux Shell plugin is not initialized")?;
    let temporary = root.parent().unwrap().join("linux-tmp");
    std::fs::create_dir_all(&temporary).map_err(|e| e.to_string())?;
    let dns = temporary.join("resolv.conf");
    std::fs::write(&dns, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n").map_err(|e| e.to_string())?;
    let id = format!(
        "nsh-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let started = root.join("tmp").join(format!("{id}.started"));
    let receipt = root.join("tmp").join(format!("{id}.exit"));
    let wrapper = format!(
        "printf ready > /tmp/{id}.started; /bin/sh -c {}; r=$?; printf '%s\\n' \"$r\" > /tmp/{id}.exit; exit \"$r\"",
        super::quote(&request.command)
    );
    let mut process = Command::new(host.libraries.join("libproot.so"));
    process
        .args(["-0", "--link2symlink", "-v", "-1", "-r"])
        .arg(root)
        .args(["-b", "/dev", "-b", "/proc", "-b", "/sys", "-b"])
        .arg(format!("{}:/workspace", workspace.display()))
        .arg("-b")
        .arg(format!("{}:/etc/resolv.conf", dns.display()))
        .arg("-w")
        .arg(&request.cwd)
        .args(["/bin/sh", "-c", &wrapper])
        .env_clear()
        .envs(&request.env)
        .env("PROOT_TMP_DIR", &temporary)
        .env("PROOT_LOADER", host.libraries.join("libproot-loader.so"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        process.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGPIPE);
            libc::sigaddset(&mut mask, libc::SIGQUIT);
            if libc::pthread_sigmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut child = process
        .spawn()
        .map_err(|e| format!("Alpine PRoot launch failed: {e}"))?;
    let halt = Arc::new(AtomicBool::new(false));
    let stdout = super::read_pipe(
        child.stdout.take().unwrap(),
        ShellStream::Stdout,
        output.clone(),
        halt.clone(),
    );
    let stderr = super::read_pipe(
        child.stderr.take().unwrap(),
        ShellStream::Stderr,
        output,
        halt.clone(),
    );
    let clock = Instant::now();
    let mut stopping = None;
    let mut status = None;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut failure = None;
    let mut stop_requested = None;
    loop {
        if status.is_none() {
            status = std::fs::read_to_string(&receipt).ok().and_then(|s| {
                s.ends_with('\n')
                    .then(|| s.trim().parse::<i32>().ok())
                    .flatten()
            });
        }
        if stopping.is_none() {
            if status.is_none() {
                cancelled = request.cancelled.load(Ordering::Relaxed);
                timed_out = !cancelled && clock.elapsed() >= request.timeout;
                if cancelled || timed_out {
                    stop_requested.get_or_insert_with(Instant::now);
                }
            }
            if status.is_some() || ((cancelled || timed_out) && started.is_file()) {
                // PRoot's handler kills every tracee, including setsid descendants.
                unsafe {
                    libc::kill(child.id() as i32, libc::SIGQUIT);
                }
                stopping = Some(Instant::now());
            }
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                if status.is_none() {
                    status = std::fs::read_to_string(&receipt).ok()
                        .and_then(|s| s.ends_with('\n').then(|| s.trim().parse::<i32>().ok()).flatten());
                }
                if status.is_none() && !cancelled && !timed_out {
                    failure = Some(format!("Alpine command exited without a receipt: {exit}"));
                }
                break;
            }
            Err(e) => {
                failure = Some(e.to_string());
                break;
            }
            _ => (),
        }
        if stopping.is_some_and(|t| t.elapsed() >= Duration::from_millis(2500))
            || (stopping.is_none()
                && (cancelled || timed_out)
                && stop_requested.is_some_and(|t| t.elapsed() >= Duration::from_millis(2500)))
        {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            failure = Some("ERR_SHELL_CLEANUP: Alpine process cleanup was not confirmed".into());
            halt.store(true, Ordering::Relaxed);
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let reads = [stdout.join(), stderr.join()];
    for read in reads {
        read.map_err(|_| "Alpine output reader failed")??;
    }
    let _ = std::fs::remove_file(started);
    let _ = std::fs::remove_file(receipt);
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(ShellOutcome {
        status: if timed_out {
            124
        } else if cancelled {
            143
        } else {
            status.unwrap_or(1)
        },
        timed_out,
        cancelled,
    })
}
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
