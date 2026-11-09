use nsh_core::prelude::*;

/// Node-compatible capabilities confined to this NSH surface's data directory.
#[class]
pub struct NodeCompat {
    bridge: nsh_node_compat::Bridge,
}

#[class]
impl NodeCompat {
    /// Open the host-chosen app directory. JavaScript never supplies a host path.
    pub fn new(sys: System) -> Result<Self, String> {
        let data = sys
            .data_dir
            .as_ref()
            .ok_or("ERR_ACCESS_DENIED: host has no app data directory")?;
        sys.access
            .authorize_file_with_paths(data, data, &sys.paths, true)
            .map_err(|e| format!("ERR_ACCESS_DENIED: {e:?}"))?;
        sys.access
            .authorize_file_with_paths(data, data, &sys.paths, false)
            .map_err(|e| format!("ERR_ACCESS_DENIED: {e:?}"))?;
        let data = data.join("node-compat");
        #[cfg(all(any(target_os = "android", target_os = "ios"), target_arch = "aarch64"))]
        let runner = Some(
            std::sync::Arc::new(crate::linux_shell::LinuxShell::new(&data)?)
                as std::sync::Arc<dyn nsh_node_compat::shell_runner::ShellRunner>,
        );
        #[cfg(not(all(any(target_os = "android", target_os = "ios"), target_arch = "aarch64")))]
        let runner = None;
        Ok(Self {
            bridge: nsh_node_compat::Bridge::with_shell_runner(&data, runner)?,
        })
    }
    /// Execute a bounded synchronous filesystem, database or utility request.
    pub fn request(&self, request: String) -> String {
        self.bridge.request(&request)
    }
    /// Reserve a native operation before the engine creates an async task.
    pub fn begin(&self, kind: String, request: String) -> Result<String, String> {
        self.bridge.begin(&kind, request)
    }
    /// Await a single-use task ticket on NSH's engine executor.
    pub async fn wait(this: Instance<Self>, ticket: String) -> String {
        let task = this.with(|host| host.bridge.wait(&ticket));
        task.await
    }
    /// Cancel actors and close file, watch and database handles for app teardown.
    pub fn close(&self) {
        self.bridge.close();
    }
}
