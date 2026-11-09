//! Host-owned Linux execution. Platform dependencies stay in the application.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub struct ShellRequest {
    pub command: String,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub cancelled: Arc<AtomicBool>,
}

impl ShellRequest {
    pub(crate) fn parse(value: &Value, cancelled: Arc<AtomicBool>) -> Result<Self, String> {
        let command = value["command"].as_str().ok_or("missing command")?;
        let mut env = BTreeMap::from([
            (
                "PATH".into(),
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
            ),
            ("HOME".into(), "/root".into()),
            ("TMPDIR".into(), "/tmp".into()),
            ("LANG".into(), "C.UTF-8".into()),
        ]);
        if let Some(overrides) = value["env"].as_object() {
            for (key, value) in overrides {
                if let Some(value) = value.as_str() {
                    env.insert(key.clone(), value.into());
                }
            }
        }
        Ok(Self {
            command: command.into(),
            cwd: value["cwd"].as_str().unwrap_or("/workspace").into(),
            env,
            timeout: Duration::from_millis(value["timeout"].as_u64().unwrap_or(300_000).max(1)),
            cancelled,
        })
    }
}

#[derive(Clone, Copy)]
pub enum ShellStream {
    Stdout,
    Stderr,
    Status,
}
impl ShellStream {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::Status => "status",
        }
    }
}

/// A sink accepts complete UTF-8 strings. Native pipe readers use Utf8Output.
pub type ShellOutput = Arc<dyn Fn(ShellStream, String) + Send + Sync>;

pub struct ShellOutcome {
    pub status: i32,
    pub timed_out: bool,
    pub cancelled: bool,
}
impl ShellOutcome {
    pub(crate) fn value(self) -> Value {
        json!({"status":self.status,"timedOut":self.timed_out,"cancelled":self.cancelled})
    }
}

/// Returns only after command descendants are reaped and both pipes drained.
/// Initialization, environment, mounts and process ownership belong to the host.
pub trait ShellRunner: Send + Sync {
    fn run(&self, request: ShellRequest, output: ShellOutput) -> Result<ShellOutcome, String>;
}

/// Preserves a code point split across native read() boundaries.
#[derive(Default)]
pub struct Utf8Output {
    pending: Vec<u8>,
}
impl Utf8Output {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    if let Some(length) = error.error_len() {
                        text.push('\u{fffd}');
                        self.pending.drain(..valid + length);
                    } else {
                        self.pending.drain(..valid);
                        break;
                    }
                }
            }
        }
        text
    }
    pub fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multibyte_output_and_environment() {
        let bytes = "中文🌍".as_bytes();
        let mut decoder = Utf8Output::default();
        let text: String = bytes.iter().map(|b| decoder.push(&[*b])).collect();
        assert_eq!(text, "中文🌍");
        assert_eq!(decoder.finish(), "");
        let req = ShellRequest::parse(
            &json!({"command":"env", "env":{"HOME":"/custom","ABC":"hi"}}),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(req.env["HOME"], "/custom");
        assert!(req.env["PATH"].contains("/usr/bin"));
        assert_eq!(req.env["ABC"], "hi");
    }
}
