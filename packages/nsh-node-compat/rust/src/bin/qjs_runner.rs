mod http_host;
use rquickjs::{AsyncContext, AsyncRuntime, Module};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let bundle = args
        .first()
        .ok_or("usage: qjs_runner bundle.mjs data-root [timeout-ms]")?;
    let root = PathBuf::from(args.get(1).ok_or("data root required")?);
    let source = std::fs::read_to_string(bundle)?;
    let runtime = AsyncRuntime::new()?;
    runtime.set_memory_limit(192 * 1024 * 1024).await;
    runtime.set_max_stack_size(2 * 1024 * 1024).await;
    let deadline = Instant::now()
        + Duration::from_millis(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30000));
    runtime
        .set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)))
        .await;
    runtime
        .set_loader(quickjs_jit_stdlib::resolver(), quickjs_jit_stdlib::loader())
        .await;
    let context = AsyncContext::full(&runtime).await?;
    let result = context
        .async_with(async |ctx| {
            quickjs_jit_stdlib::init(&ctx)?;
            quickjs_jit_stdlib::abort::init(&ctx)?;
            quickjs_jit_stdlib::stream_web::init(&ctx)?;
            quickjs_jit_stdlib::timers::init(&ctx)?;
            nsh_node_compat::install(&ctx, &root)?;
            if let Ok(config_path) = std::env::var("NSH_COMPAT_LIVE_CONFIG") {
                let raw = std::fs::read_to_string(config_path).map_err(|e| {
                    rquickjs::Error::new_from_js_message("file", "live config", e.to_string())
                })?;
                let config: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                    rquickjs::Error::new_from_js_message("json", "live config", e.to_string())
                })?;
                http_host::install(&ctx, config["baseUrl"].as_str().unwrap_or(""))?;
                ctx.globals().set("__nsh_live_config", raw)?;
            }
            ctx.globals().set(
                "__nsh_print",
                rquickjs::Function::new(ctx.clone(), |s: String| println!("{s}"))?,
            )?;
            let result = match Module::evaluate(ctx.clone(), "compat-verification", source) {
                Ok(promise) => match tokio::time::timeout_at(
                    tokio::time::Instant::from_std(deadline),
                    promise.into_future::<()>(),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(rquickjs::Error::new_from_js_message(
                        "Promise",
                        "settled result",
                        "QuickJS wall-clock deadline exceeded",
                    )),
                },
                Err(e) => Err(e),
            };
            if result.is_err() {
                let exception = ctx.catch();
                eprintln!("QuickJS exception: {:?}", exception);
                if let Some(obj) = exception.as_object() {
                    if let Ok(stack) = obj.get::<_, String>("stack") {
                        eprintln!("{stack}");
                    }
                    if let Ok(message) = obj.get::<_, String>("message") {
                        eprintln!("{message}");
                    }
                }
            }
            result
        })
        .await;
    result?;
    Ok(())
}
