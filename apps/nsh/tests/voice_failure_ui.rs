use nsh_core::{Points, geometry::size};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::{path::Path, time::Duration};

#[test]
fn voice_failure_stays_visible_in_standby_and_permission_keeps_its_instruction()
-> Result<(), String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let data = tempfile::tempdir().map_err(|error| error.to_string())?;
    let entry = data.path().join("Probe.tsx");
    std::fs::write(&entry, format!(r#"
import {{ mount, signal, Text, View }} from "nsh";
import {{ Button }} from "nsh/base";
import {{ VoiceSpaceView }} from {};
function Probe() {{
  const state = signal({{ phase: "standby", muted: false, wakeEnabled: true,
    transcript: "", error: "moss websocket.connect: HTTP_403 permission denied" }});
  const store = {{ voiceState: state, voiceProviderLabel: () => "MOSS-Live",
    voiceProviderId: () => "moss", voiceConfigured: () => true,
    isVoiceProviderConfigured: () => true, voiceId: () => "", voiceKeyHint: () => "••••1234",
    voiceAudioLevel: () => 0, ready: () => true,
    startVoice: async () => {{}}, previewVoice: async () => {{}}, stopVoice: () => {{}},
    setWakeEnabled: () => {{}} }};
  return <View class="flex-1">
    <Button testID="permission" class="min-h-10" onPress={{() => state.set({{ ...state(), phase: "permission", error: "请允许麦克风权限" }})}}><Text>Permission</Text></Button>
    <VoiceSpaceView store={{store as any}} />
  </View>;
}}
mount(Probe);
"#, serde_json::to_string(&root.join("ui/VoiceSpaceView.tsx").to_string_lossy()).unwrap()))
        .map_err(|error| error.to_string())?;
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(&entry, &sets)?;
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    config.viewport = size(Points(844.0), Points(390.0));
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.wait_for_within("MOSS-Live · 暂不可用", Duration::from_secs(5))?;
    app.wait_for("语音暂不可用")?;
    app.wait_for("voice-session-error")?;
    assert!(!app.shows("MOSS-Live · 唤醒待机"));
    app.press("permission")?;
    app.wait_for("MOSS-Live · 等待麦克风授权")?;
    app.wait_for("允许麦克风访问后即可开始对话")?;
    assert!(!app.shows("voice-session-error"));
    assert!(!app.shows("语音暂不可用"));
    Ok(())
}
