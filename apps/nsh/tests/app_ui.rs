use nsh_core::platform::Locale;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, MemoryStorage, compile_tsx};
use std::{path::Path, sync::Arc, time::Duration};

fn open_app(
    data_dir: &Path,
    storage: Arc<MemoryStorage>,
    locale: &str,
) -> Result<Headless, String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.app-ui-test")));
    config.ui_sets = sets;
    config.data_dir = Some(data_dir.to_owned());
    config.storage = Some(storage);
    config.environment.locale = Locale::parse(locale).ok_or("Invalid test locale")?;
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.wait_until("app ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    Ok(app)
}

#[test]
fn face_and_management_spaces_work_with_private_app_storage() -> Result<(), String> {
    let data = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut app = open_app(data.path(), MemoryStorage::new([]), "zh-CN")?;
    app.wait_for("陪伴待机")?;
    assert!(!app.shows("LIVE 对话"));

    app.press("connection-settings")?;
    for label in [
        "OpenAI / ChatGPT",
        "Kimi",
        "MiniMax",
        "小米 MiMo",
        "智谱 / Z.AI",
        "+ 兼容 API",
        "模型",
        "语音",
        "底座",
        "家居",
        "任务",
        "设置",
    ] {
        app.wait_for(label)?;
    }
    app.wait_for("连接成功后加载可用模型")?;
    for hidden in ["gpt-5.4", "外观: 自动", "EN"] {
        assert!(!app.shows(hidden), "unexpected model-page text: {hidden}");
    }
    app.press("brand-zai")?;
    app.wait_for("标准 API (国内 BigModel)")?;
    app.press("Coding Plan 专属 (国内)")?;
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("api/coding/paas/v4"))
    );
    app.press("brand-custom")?;
    for label in [
        "OpenAI Completions",
        "OpenAI Responses",
        "Anthropic Messages",
    ] {
        app.wait_for(label)?;
    }

    app.press("nav-voice")?;
    app.wait_for("豆包实时语音凭证")?;
    app.wait_for("豆包输出音色")?;
    for hidden in [
        "当前状态",
        "待机监听唤醒词（本地离线 KWS）",
        "待机（未占用麦克风）",
    ] {
        assert!(!app.shows(hidden), "unexpected voice-page text: {hidden}");
    }
    app.press("wake-toggle")?;
    app.wait_for("开启 Hey LOOI 自动唤醒")?;
    app.press("wake-toggle")?;
    app.wait_for("关闭 Hey LOOI 自动唤醒")?;

    app.press("nav-body")?;
    for label in [
        "蓝牙底座",
        "模拟体验",
        "扫描附近底座",
        "扫描后选择要连接的底座",
        "启动时连接上次底座",
        "方向轮盘",
        "抬头",
        "低头",
        "55°",
        "补光灯 · 已关闭",
    ] {
        app.wait_for(label)?;
    }
    app.press("body-mode-sim")?;
    app.wait_for("已吸合就绪")?;
    app.wait_for("LOOI 桌面底座")?;
    app.wait_for("其他可用底座")?;
    app.wait_for("卧室的 LOOI")?;
    app.press("body-sim-dock-switch")?;
    app.wait_for("已连接 · 未吸合")?;
    app.press("body-head-up")?;
    app.wait_for("85°")?;
    app.press("body-sim-dock-switch")?;
    app.press("body-head-down")?;
    app.wait_for("25°")?;
    app.press("body-light-toggle")?;
    app.wait_for("补光灯 · 已开启")?;
    app.press("body-wheel-forward")?;
    app.long_press("body-wheel-left")?;
    app.press("body-wheel-stop")?;

    app.press("nav-home")?;
    app.wait_for("米家直连")?;
    app.press("home-miot-region")?;
    app.press("新加坡")?;
    app.wait_for("新加坡")?;
    app.press("nav-tasks")?;
    app.wait_for("任务与审计记录")?;
    app.press("nav-settings")?;
    app.wait_for("通用设置")?;
    app.press("appearance-light")?;
    app.wait_for("当前生效：浅色")?;
    app.press("appearance-dark")?;
    app.wait_for("当前生效：深色")?;
    app.press("appearance-system")?;
    app.wait_for("当前生效：浅色")?;
    app.press("back-to-face")?;
    app.press("compose")?;
    app.type_text("message-input", "查看当前目录")?;
    app.wait_for("发送")?;
    app.press("compose")?;
    app.wait_for_gone("发送", Duration::from_secs(5))?;
    Ok(())
}

#[test]
fn language_and_appearance_preferences_survive_reopening() -> Result<(), String> {
    let data = tempfile::tempdir().map_err(|error| error.to_string())?;
    let storage = MemoryStorage::new([]);
    let mut app = open_app(data.path(), storage.clone(), "en-GB")?;
    app.wait_for("Standing by")?;
    app.press("connection-settings")?;
    app.wait_for("OpenAI / ChatGPT")?;
    app.press("nav-settings")?;
    app.wait_for("General settings")?;
    app.press("appearance-dark")?;
    app.wait_for("Active: Dark")?;
    app.press("language-select")?;
    app.press("简体中文")?;
    app.wait_for("当前生效：简体中文")?;
    app.wait_until("preferences saved", Duration::from_secs(5), |_| {
        let entries = storage.entries();
        entries.get("language-preference").map(String::as_str) == Some("zh-CN")
            && entries.get("appearance-preference").map(String::as_str) == Some("dark")
    })?;
    drop(app);

    let mut restored = open_app(data.path(), storage, "en-US")?;
    restored.wait_for("陪伴待机")?;
    restored.press("connection-settings")?;
    restored.wait_for("OpenAI / ChatGPT")?;
    restored.press("nav-settings")?;
    restored.wait_for("当前生效：深色")?;
    restored.press("language-select")?;
    restored.press("跟随系统")?;
    restored.wait_for("General settings")?;
    restored.press("nav-voice")?;
    restored.wait_for("Doubao live voice credentials")?;
    restored.press("nav-home")?;
    restored.wait_for("Connect your Xiaomi Home account")?;
    restored.press("nav-tasks")?;
    restored.wait_for("Tasks")?;
    Ok(())
}
