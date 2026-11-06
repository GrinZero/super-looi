mod bridge;
mod codemode_bridge;
mod fs_bridge;
pub mod sandbox;
mod segment_bridge;
mod shell_bridge;
mod sqlite_bridge;
pub use bridge::{Bridge, Task};
use rquickjs::{Ctx, Function};
use std::{path::Path, rc::Rc};

/// Install into a same-version QuickJS context. NSH classes may instead expose
/// Bridge::request/begin/wait and install the three JS adapter functions.
pub fn install(ctx: &Ctx<'_>, data_root: &Path) -> rquickjs::Result<()> {
    let host = Rc::new(
        Bridge::new(data_root)
            .map_err(|e| rquickjs::Error::new_from_js_message("io", "compatibility host", e))?,
    );
    for (name, kind) in [
        ("__nsh_shell_wait", "shell"),
        ("__nsh_codemode_step", "codemode"),
    ] {
        let host = host.clone();
        ctx.globals().set(
            name,
            Function::new(
                ctx.clone(),
                rquickjs::prelude::Async(move |request: String| {
                    let task = host.begin(kind, request).map(|ticket| host.wait(&ticket));
                    async move {
                        match task {
                            Ok(task) => task.await,
                            Err(error) => bridge::response(Err(error)),
                        }
                    }
                }),
            )?,
        )?;
    }
    ctx.globals().set(
        "__nsh_compat",
        Function::new(ctx.clone(), move |request: String| host.request(&request))?,
    )?;
    Ok(())
}
