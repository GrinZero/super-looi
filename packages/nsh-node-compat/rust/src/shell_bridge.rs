//! Deno's parser with a capability-based evaluator. We deliberately do NOT link
//! its default shell executor: its redirects and unknown-command fallback use
//! ambient files/processes. Every command and redirect below uses Sandbox.
use crate::{fs_bridge, sandbox::Sandbox};
use deno_task_shell::parser::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
const MAX_OUTPUT: usize = 1024 * 1024;
struct Shell<'a> {
    fs: &'a Sandbox,
    cwd: String,
    env: HashMap<String, String>,
    deadline: Instant,
    steps: usize,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct Output {
    status: i32,
    stdout: String,
    stderr: String,
}
impl Output {
    fn ok(s: String) -> Self {
        Self {
            stdout: s,
            ..Default::default()
        }
    }
}
impl Shell<'_> {
    fn check(&mut self) -> Result<(), String> {
        self.steps += 1;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err("ABORT_ERR: shell cancelled".into());
        }
        if self.steps > 10000 || Instant::now() > self.deadline {
            return Err("ETIMEDOUT: shell budget exceeded".into());
        }
        Ok(())
    }
    fn path(&self, p: &str) -> Result<String, String> {
        let p = if p.starts_with('/') {
            p.to_owned()
        } else {
            format!("{}/{p}", self.cwd)
        };
        let rel = self.fs.path(&p).map_err(|e| e.to_string())?;
        Ok(format!("/{}", rel.display()))
    }
    fn fs(&self, op: &str, path: &str, args: Value) -> Result<Value, String> {
        let mut args = args;
        args["path"] = json!(self.path(path)?);
        fs_bridge::call(self.fs, op, &args)
    }
    fn read(&self, p: &str) -> Result<String, String> {
        let bytes: Vec<u8> =
            serde_json::from_value(self.fs("read", p, json!({}))?).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
    fn word(&mut self, w: &Word) -> Result<String, String> {
        self.parts(w.parts())
    }
    fn parts(&mut self, parts: &[WordPart]) -> Result<String, String> {
        let mut result = String::new();
        for part in parts {
            self.check()?;
            result.push_str(&match part {
                WordPart::Text(t) => t.clone(),
                WordPart::Variable(n) => self.env.get(n).cloned().unwrap_or_default(),
                WordPart::Tilde => "/home".into(),
                WordPart::Quoted(p) => self.parts(p)?,
                WordPart::Command(list) => {
                    self.list(list)?.stdout.trim_end_matches('\n').to_owned()
                }
                _ => return Err("ERR_NOT_SUPPORTED: brace expansion".into()),
            });
            if result.len() > MAX_OUTPUT {
                return Err("ENOBUFS: shell word limit".into());
            }
        }
        Ok(result)
    }
    fn list(&mut self, list: &SequentialList) -> Result<Output, String> {
        let mut out = Output::default();
        for item in &list.items {
            self.check()?;
            if item.is_async {
                return Err("ERR_NOT_SUPPORTED: background jobs".into());
            }
            let r = self.seq(&item.sequence)?;
            out.status = r.status;
            out.stdout += &r.stdout;
            out.stderr += &r.stderr;
            if out.stdout.len() + out.stderr.len() > MAX_OUTPUT {
                return Err("ENOBUFS: shell output limit".into());
            }
        }
        Ok(out)
    }
    fn seq(&mut self, s: &Sequence) -> Result<Output, String> {
        self.check()?;
        match s {
            Sequence::ShellVar(v) => {
                let value = self.word(&v.value)?;
                self.env.insert(v.name.clone(), value);
                Ok(Output::default())
            }
            Sequence::Pipeline(p) => {
                let mut out = self.pipe(&p.inner, String::new())?;
                if p.negated {
                    out.status = if out.status == 0 { 1 } else { 0 };
                }
                Ok(out)
            }
            Sequence::BooleanList(b) => {
                let mut out = self.seq(&b.current)?;
                if b.op.moves_next_for_exit_code(out.status) {
                    let r = self.seq(&b.next)?;
                    out.status = r.status;
                    out.stdout += &r.stdout;
                    out.stderr += &r.stderr;
                }
                Ok(out)
            }
        }
    }
    fn pipe(&mut self, p: &PipelineInner, input: String) -> Result<Output, String> {
        match p {
            PipelineInner::Command(c) => self.command(c, input),
            PipelineInner::PipeSequence(p) => {
                let first = self.command(&p.current, input)?;
                let mut input = first.stdout;
                if p.op == PipeSequenceOperator::StdoutStderr {
                    input += &first.stderr;
                }
                let mut next = self.pipe(&p.next, input)?;
                if p.op == PipeSequenceOperator::Stdout {
                    next.stderr = first.stderr + &next.stderr;
                }
                Ok(next)
            }
        }
    }
    fn command(&mut self, c: &Command, mut input: String) -> Result<Output, String> {
        self.check()?;
        let target = if let Some(r) = &c.redirect {
            match &r.io_file {
                IoFile::Word(w) => Some(self.word(w)?),
                _ => return Err("ERR_NOT_SUPPORTED: fd redirect".into()),
            }
        } else {
            None
        };
        if let (Some(r), Some(t)) = (&c.redirect, &target) {
            if matches!(r.op, RedirectOp::Input(_)) {
                input = self.read(t)?;
            }
        }
        let mut out = match &c.inner {
            CommandInner::Subshell(l) => {
                let cwd = self.cwd.clone();
                let env = self.env.clone();
                let out = self.list(l);
                self.cwd = cwd;
                self.env = env;
                out?
            }
            CommandInner::Simple(s) => {
                let env = self.env.clone();
                for v in &s.env_vars {
                    let value = self.word(&v.value)?;
                    self.env.insert(v.name.clone(), value);
                }
                let args = s
                    .args
                    .iter()
                    .map(|w| self.word(w))
                    .collect::<Result<Vec<_>, _>>()?;
                let out = self.builtin(&args, input);
                self.env = env;
                match out {
                    Ok(o) => o,
                    Err(e)
                        if e.starts_with("ABORT_ERR")
                            || e.starts_with("ETIMEDOUT")
                            || e.starts_with("ENOBUFS") =>
                    {
                        return Err(e);
                    }
                    Err(e) => Output {
                        status: 1,
                        stdout: String::new(),
                        stderr: format!("{e}\n"),
                    },
                }
            }
        };
        if let (Some(r), Some(t)) = (&c.redirect, target) {
            if let RedirectOp::Output(ref op) = r.op {
                let op = if *op == RedirectOpOutput::Append {
                    "append"
                } else {
                    "write"
                };
                self.fs(op, &t, json!({"data":out.stdout.as_bytes()}))?;
                out.stdout.clear();
            }
        }
        Ok(out)
    }
    fn walk(&mut self, p: &str, out: &mut Vec<String>) -> Result<(), String> {
        self.check()?;
        if out.len() > 10000 {
            return Err("ENOBUFS: directory limit".into());
        }
        let entries = self.fs("readdir", p, json!({}))?;
        for e in entries.as_array().ok_or("invalid directory")? {
            let name = e["name"].as_str().ok_or("invalid name")?;
            let child = format!("{}/{name}", p.trim_end_matches('/'));
            out.push(child.clone());
            if e["directory"] == true {
                self.walk(&child, out)?;
            }
        }
        Ok(())
    }
    fn ignored(&self, path: &str, directory: bool) -> Result<bool, String> {
        if path.split('/').any(|part| part == ".git") {
            return Ok(true);
        }
        let mut dirs = vec![];
        let mut parent = std::path::Path::new(path).parent();
        while let Some(dir) = parent {
            dirs.push(dir.to_string_lossy().to_string());
            // A nested repository starts its own ignore scope.
            if self
                .fs("lstat", &format!("{}/.git", dir.display()), json!({}))
                .is_ok()
            {
                break;
            }
            parent = dir.parent();
        }
        dirs.reverse();
        let mut builder = ignore::gitignore::GitignoreBuilder::new("/");
        for dir in dirs {
            let file = format!("{}/.gitignore", dir.trim_end_matches('/'));
            if let Ok(rules) = self.read(&file) {
                for line in rules.lines() {
                    builder
                        .add_line(Some(std::path::PathBuf::from(&file)), line)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(builder
            .build()
            .map_err(|e| e.to_string())?
            .matched_path_or_any_parents(path, directory)
            .is_ignore())
    }
    fn fd(
        &mut self,
        files: &[String],
        options: &HashMap<String, Option<String>>,
    ) -> Result<Output, String> {
        if files.len() != 2 || !options.contains_key("--glob") {
            return Err("fd requires --glob, pattern and search root".into());
        }
        let root = self.path(&files[1])?;
        let glob = globset::GlobBuilder::new(&files[0])
            .literal_separator(true)
            .build()
            .map_err(|e| e.to_string())?
            .compile_matcher();
        let limit = options
            .get("--max-results")
            .and_then(|v| v.as_deref())
            .map(|v| v.parse::<usize>().map_err(|_| "invalid fd result limit"))
            .transpose()?
            .unwrap_or(1000);
        if limit == 0 || limit > 10000 {
            return Err("invalid fd result limit (1..10000)".into());
        }
        let mut paths = vec![];
        self.walk(&root, &mut paths)?;
        paths.sort();
        let mut output = String::new();
        let mut found = 0;
        for path in paths {
            self.check()?;
            let meta = self.fs("lstat", &path, json!({}))?;
            if self.ignored(&path, meta["directory"] == true)? {
                continue;
            }
            let candidate = if options.contains_key("--full-path") {
                path.as_str()
            } else {
                path.rsplit('/').next().unwrap_or(&path)
            };
            if glob.is_match(candidate) {
                output.push_str(&path);
                output.push('\n');
                found += 1;
                if output.len() > MAX_OUTPUT {
                    return Err("ENOBUFS: fd output limit".into());
                }
                if found >= limit {
                    break;
                }
            }
        }
        Ok(Output::ok(output))
    }
    fn rg(&mut self, args: &[String]) -> Result<Output, String> {
        let split = args
            .iter()
            .position(|s| s == "--")
            .ok_or("rg requires -- before pattern")?;
        let pattern = args.get(split + 1).ok_or("missing rg pattern")?;
        let target = args.get(split + 2).map(String::as_str).unwrap_or(".");
        let root = self.path(target)?;
        let fixed = args[..split].iter().any(|s| s == "--fixed-strings");
        let pattern = if fixed {
            regex::escape(pattern)
        } else {
            pattern.clone()
        };
        let regex = regex::RegexBuilder::new(&pattern)
            .case_insensitive(args[..split].iter().any(|s| s == "--ignore-case"))
            .build()
            .map_err(|e| e.to_string())?;
        let glob = args[..split]
            .windows(2)
            .find(|w| w[0] == "--glob")
            .map(|w| globset::Glob::new(&w[1]).map(|g| g.compile_matcher()))
            .transpose()
            .map_err(|e| e.to_string())?;
        let mut files = vec![];
        if self.fs("stat", &root, json!({}))?["directory"] == true {
            self.walk(&root, &mut files)?;
        } else {
            files.push(root.clone());
        }
        let mut stdout = String::new();
        for path in files {
            self.check()?;
            if path.split('/').any(|p| p == ".git") {
                continue;
            }
            let meta = self.fs("lstat", &path, json!({}))?;
            if meta["file"] != true && !(path == root && self.fs("stat", &path, json!({}))?["file"] == true) {
                continue;
            }
            let relative = path.strip_prefix(&format!("{root}/")).unwrap_or(&path);
            if let Some(glob) = &glob {
                if !glob.is_match(relative)
                    && !glob.is_match(path.rsplit('/').next().unwrap_or(&path))
                {
                    continue;
                }
            }
            if self.ignored(&path, false)? {
                continue;
            }
            let data = self.read(&path)?;
            if data.contains('\0') {
                continue;
            }
            for (i, line) in data.lines().enumerate() {
                self.check()?;
                if regex.is_match(line) {
                    stdout += &format!(
                        "{}\n",
                        json!({"type":"match","data":{"path":{"text":path},"lines":{"text":format!("{line}\n")},"line_number":i+1}})
                    );
                    if stdout.len() > MAX_OUTPUT {
                        return Err("ENOBUFS: search output limit".into());
                    }
                }
            }
        }
        Ok(Output {
            status: if stdout.is_empty() { 1 } else { 0 },
            stdout,
            stderr: String::new(),
        })
    }
    fn builtin(&mut self, args: &[String], input: String) -> Result<Output, String> {
        let Some(cmd) = args.first().map(String::as_str) else {
            return Ok(Output::default());
        };
        let a = &args[1..];
        let allowed: &[&str] = match cmd {
            "echo" => &["-n"],
            "ls" => &["-1", "-a", "-A"],
            "mkdir" => &["-p"],
            "rm" => &["-r", "-f", "-rf", "-fr"],
            "head" | "tail" => &["-n"],
            "find" => &["-name"],
            "fd" => &[
                "--glob",
                "--color=never",
                "--hidden",
                "--no-require-git",
                "--max-results",
                "--full-path",
            ],
            "wc" => &["-l", "-w", "-c"],
            "grep" => &["-i", "-n"],
            "rg" => &[
                "-i",
                "-n",
                "--no-config",
                "--json",
                "--line-number",
                "--color=never",
                "--hidden",
                "--ignore-case",
                "--fixed-strings",
                "--glob",
            ],
            _ => &[],
        };
        let mut files = Vec::new();
        let mut ended = false;
        let mut pending: Option<String> = None;
        let mut options: HashMap<String, Option<String>> = HashMap::new();
        for arg in a {
            if let Some(key) = pending.take() {
                options.insert(key, Some(arg.clone()));
                continue;
            }
            if ended {
                files.push(arg.clone());
                continue;
            }
            if arg == "--" {
                ended = true;
                continue;
            }
            if arg.starts_with('-') {
                if !allowed.contains(&arg.as_str()) {
                    return Err(format!("ERR_NOT_SUPPORTED: {cmd} option {arg}"));
                }
                options.insert(arg.clone(), None);
                if (arg == "-n" && ["head", "tail"].contains(&cmd))
                    || (arg == "--glob" && cmd == "rg")
                    || (arg == "-name" && cmd == "find")
                    || (arg == "--max-results" && cmd == "fd")
                {
                    pending = Some(arg.clone());
                }
            } else {
                files.push(arg.clone());
            }
        }
        if pending.is_some() {
            return Err("missing option value".into());
        }
        if ["pwd", "env", "true", "false"].contains(&cmd) && !a.is_empty() {
            return Err("unexpected command arguments".into());
        }
        if ["ls", "cd", "head", "tail", "wc"].contains(&cmd) && files.len() > 1 {
            return Err("only one file operand is supported".into());
        }
        if cmd == "wc" && options.len() > 1 {
            return Err("only one wc output mode is supported".into());
        }
        let result = match cmd {
            "echo" => Output::ok(format!(
                "{}{}",
                files.join(" "),
                if options.contains_key("-n") { "" } else { "\n" }
            )),
            "pwd" => Output::ok(format!("{}\n", self.cwd)),
            "true" => Output::default(),
            "false" => Output {
                status: 1,
                ..Default::default()
            },
            "cd" => {
                let p = self.path(files.first().map(String::as_str).unwrap_or("/home"))?;
                if self.fs("stat", &p, json!({}))?["directory"] != true {
                    return Err("ENOTDIR".into());
                }
                self.cwd = p;
                Output::default()
            }
            "env" => Output::ok(self.env.iter().map(|(k, v)| format!("{k}={v}\n")).collect()),
            "cat" => {
                let mut data = String::new();
                if files.is_empty() {
                    data = input;
                } else {
                    for p in &files {
                        data += &self.read(p)?;
                    }
                }
                Output::ok(data)
            }
            "ls" => {
                let entries = self.fs(
                    "readdir",
                    files.first().map(String::as_str).unwrap_or("."),
                    json!({}),
                )?;
                Output::ok(
                    entries
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|e| {
                            options.contains_key("-a")
                                || options.contains_key("-A")
                                || !e["name"].as_str().unwrap_or("").starts_with('.')
                        })
                        .map(|e| format!("{}\n", e["name"].as_str().unwrap_or("")))
                        .collect(),
                )
            }
            "mkdir" => {
                for p in &files {
                    self.fs("mkdir", p, json!({"recursive":options.contains_key("-p")}))?;
                }
                Output::default()
            }
            "rm" => {
                for p in &files {
                    self.fs("rm",p,json!({"recursive":options.keys().any(|s|s.contains('r')),"force":options.keys().any(|s|s.contains('f'))}))?;
                }
                Output::default()
            }
            "cp" | "mv" => {
                if files.len() != 2 {
                    return Err("expected source and destination".into());
                }
                self.fs(
                    if cmd == "cp" { "copy" } else { "rename" },
                    &files[0],
                    json!({"dest":self.path(&files[1])?}),
                )?;
                Output::default()
            }
            "head" | "tail" => {
                let n = options
                    .get("-n")
                    .and_then(|s| s.as_ref())
                    .map(|s| s.parse::<usize>())
                    .transpose()
                    .map_err(|_| "invalid line count")?
                    .unwrap_or(10);
                let data = if let Some(p) = files.first() {
                    self.read(p)?
                } else {
                    input
                };
                let lines = data.lines().collect::<Vec<_>>();
                let lines = if cmd == "head" {
                    &lines[..n.min(lines.len())]
                } else {
                    &lines[lines.len().saturating_sub(n)..]
                };
                Output::ok(if lines.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", lines.join("\n"))
                })
            }
            "wc" => {
                let data = if let Some(p) = files.first() {
                    self.read(p)?
                } else {
                    input
                };
                Output::ok(format!(
                    "{}\n",
                    if options.contains_key("-c") {
                        data.len()
                    } else if options.contains_key("-w") {
                        data.split_whitespace().count()
                    } else {
                        data.bytes().filter(|b| *b == b'\n').count()
                    }
                ))
            }
            "rg" if options.contains_key("--json") => self.rg(a)?,
            "fd" => self.fd(&files, &options)?,
            "grep" | "rg" => {
                let pattern = files.first().ok_or("missing grep pattern")?;
                let regex = regex::RegexBuilder::new(pattern)
                    .case_insensitive(options.contains_key("-i"))
                    .build()
                    .map_err(|e| e.to_string())?;
                let data = if let Some(p) = files.get(1) {
                    self.read(p)?
                } else {
                    input
                };
                let numbered = options.contains_key("-n");
                let mut found = String::new();
                for (i, line) in data.lines().enumerate() {
                    self.check()?;
                    if regex.is_match(line) {
                        found += &if numbered {
                            format!("{}:{line}\n", i + 1)
                        } else {
                            format!("{line}\n")
                        };
                    }
                }
                Output {
                    status: if found.is_empty() { 1 } else { 0 },
                    stdout: found,
                    stderr: String::new(),
                }
            }
            "find" => {
                let root = files.first().map(String::as_str).unwrap_or(".");
                let mut paths = vec![];
                self.walk(root, &mut paths)?;
                let re = options
                    .get("-name")
                    .and_then(|s| s.as_ref())
                    .map(|p| globset::Glob::new(p).map(|g| g.compile_matcher()))
                    .transpose()
                    .map_err(|e| e.to_string())?;
                Output::ok(
                    paths
                        .into_iter()
                        .filter(|p| {
                            re.as_ref()
                                .is_none_or(|r| r.is_match(p.rsplit('/').next().unwrap_or(p)))
                        })
                        .map(|p| format!("{p}\n"))
                        .collect(),
                )
            }
            _ => Output {
                status: 127,
                stdout: String::new(),
                stderr: format!("{cmd}: command unavailable in sandbox\n"),
            },
        };
        if result.stdout.len() + result.stderr.len() > MAX_OUTPUT {
            return Err("ENOBUFS: shell output limit".into());
        }
        Ok(result)
    }
}
pub fn execute(fs: &Sandbox, v: &Value) -> Result<Value, String> {
    execute_cancelable(fs, v, Arc::new(AtomicBool::new(false)))
}
pub fn execute_cancelable(
    fs: &Sandbox,
    v: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let command = v["command"].as_str().ok_or("missing command")?;
    if command.len() > 65536 {
        return Err("ENOBUFS: command limit".into());
    }
    // Deno's parser and AST are recursive. Reject excessive structural syntax
    // before entering them, including quoted syntax (conservative by design).
    let mut openings = 0usize;
    let mut operators = 0usize;
    for ch in command.chars() {
        match ch {
            '(' | '{' => {
                openings += 1;
                if openings > 32 {
                    return Err("ENOBUFS: shell nesting budget".into());
                }
            }
            ')' | '}' => (),
            '|' | '&' | '`' => {
                operators += 1;
                if operators > 128 {
                    return Err("ENOBUFS: shell operator budget".into());
                }
            }
            _ => (),
        }
    }
    let ast = parse(command).map_err(|e| e.to_string())?;
    let timeout = v["timeout"].as_u64().unwrap_or(1000).clamp(1, 30000);
    let mut env = HashMap::from([("HOME".into(), "/home".into())]);
    if let Some(vars) = v["env"].as_object() {
        for (k, v) in vars {
            if let Some(v) = v.as_str() {
                env.insert(k.clone(), v.into());
            }
        }
    }
    let mut sh = Shell {
        fs,
        cwd: v["cwd"].as_str().unwrap_or("/workspace").into(),
        env,
        deadline: Instant::now() + Duration::from_millis(timeout),
        steps: 0,
        cancelled,
    };
    let o = sh.list(&ast)?;
    Ok(json!({"status":o.status,"stdout":o.stdout,"stderr":o.stderr}))
}
