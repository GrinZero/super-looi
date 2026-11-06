import { useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable as NativePressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type PressableProps,
} from "react-native";
import { WebView } from "react-native-webview";
import type { MiotRegion } from "@super-looi/home-assistant";
import type { LocalControlCenter, HomeMode } from "../../runtime/local-control-center.js";
import type { CabinSpaceController } from "../cabin-space.js";
import { ConnectedHomeSpaceView } from "./ConnectedHomeSpaceView.js";
import { LooiIcon } from "../components/LooiIcon.js";
import { LOOI_PALETTE as P } from "../theme.js";

const regions: Array<[MiotRegion, string]> = [
  ["cn", "中国大陆"],
  ["sg", "新加坡"],
  ["de", "欧洲"],
  ["us", "美国"],
  ["i2", "印度"],
  ["ru", "俄罗斯"],
];

const modes: Array<[HomeMode, string, string]> = [
  ["direct_miot", "米家直连", "手机直接连接米家云"],
  ["external_ha", "Home Assistant", "连接自建家居服务"],
  ["simulation", "离线演示", "本地体验，不控真机"],
  ["hub", "桌面 Hub", "沿用桌面服务端连接"],
];

function Pressable({ style, ...props }: PressableProps): ReactElement {
  return (
    <NativePressable
      {...props}
      style={(state) => [
        typeof style === "function" ? style(state) : style,
        state.pressed && { opacity: 0.76, transform: [{ scale: 0.98 }] },
      ]}
    />
  );
}

export function LocalHomeSpaceView({
  center,
  hubOrigin,
  controller,
  onNotify,
}: {
  center: LocalControlCenter;
  hubOrigin: string;
  controller: CabinSpaceController;
  onNotify: (text: string) => void;
}) {
  const [settings, setSettings] = useState(false);
  const [mode, setMode] = useState(center.preferences.mode);
  const [region, setRegion] = useState(center.preferences.region);
  const [haUrl, setHaUrl] = useState(center.preferences.haUrl);
  const [haToken, setHaToken] = useState("");
  const [voiceKey, setVoiceKey] = useState("");
  const [voiceMode, setVoiceMode] = useState(center.preferences.voiceMode);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const handled = useRef<string | null>(null);
  const formGeneration = useRef(0);
  const { width, height } = useWindowDimensions();
  const twoColumn = width >= 640;
  const shortLandscape = width > height && height < 480;

  function openSettings() {
    ++formGeneration.current;
    setMode(center.preferences.mode);
    setRegion(center.preferences.region);
    setHaUrl(center.preferences.haUrl);
    setVoiceMode(center.preferences.voiceMode);
    setError(null);
    setSettings(true);
  }

  function closeSettings() {
    ++formGeneration.current;
    center.cancelMiotLogin();
    setSettings(false);
    setHaToken("");
    setVoiceKey("");
  }

  function cancelLogin() {
    center.cancelMiotLogin();
    setAuthUrl(null);
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      setRevision((value) => value + 1);
    } catch {
      setError("操作未完成，请检查登录信息与网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  function intercept(url: string): boolean {
    if (handled.current === url) return false;
    const result = center.interceptMiotCallback(url);
    if (result.intercepted) {
      handled.current = url;
      if ("code" in result) {
        void run(async () => {
          try {
            await center.finishMiotLogin(result.code);
            setAuthUrl(null);
            setSettings(false);
          } catch {
            cancelLogin();
            throw new Error("登录未完成");
          }
        });
      } else {
        cancelLogin();
        setError("登录已取消或校验失效，请重新登录。");
      }
      return false;
    }
    return url.startsWith("https://");
  }

  async function saveAllSettings() {
    await run(async () => {
      await center.configure(
        { mode, region, haUrl, voiceMode },
        {
          haToken: haToken.trim() || undefined,
          voiceKey: voiceKey.trim() || undefined,
        },
      );
      setHaToken("");
      setVoiceKey("");
      await center.getConnection();
      if (!center.error) {
        setSettings(false);
      }
    });
  }

  return (
    <View style={s.root}>
      <ConnectedHomeSpaceView
        key={`${center.revision}-${revision}`}
        hubOrigin={hubOrigin}
        client={center}
        controller={controller}
        onNotify={onNotify}
        modeSubtitle={center.preferences.voiceMode === "local" ? "本机语音" : "Hub 语音"}
        onOpenSettings={openSettings}
      />

      <Modal
        supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]}
        visible={settings}
        transparent
        animationType="fade"
        onRequestClose={() => (authUrl ? cancelLogin() : closeSettings())}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.scrim}>
          <NativePressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="关闭连接设置遮罩"
            onPress={() => (authUrl ? cancelLogin() : closeSettings())}
          />
          {authUrl ? (
            <View style={s.auth}>
              <View style={s.heading}>
                <Text style={s.choiceTitle}>小米账号安全登录</Text>
                <Pressable accessibilityRole="button" style={s.closeBtn} onPress={cancelLogin}>
                  <LooiIcon name="close" size={16} color={P.textSecondary} />
                  <Text style={s.closeText}>取消登录</Text>
                </Pressable>
              </View>
              <WebView
                source={{ uri: authUrl }}
                incognito
                sharedCookiesEnabled={false}
                cacheEnabled={false}
                originWhitelist={["https://*", "http://homeassistant.local:8123"]}
                onShouldStartLoadWithRequest={(request) => intercept(request.url)}
                onNavigationStateChange={(navigation) => {
                  if (navigation.url.startsWith("http://homeassistant.local:8123/")) intercept(navigation.url);
                }}
                onError={() => {
                  cancelLogin();
                  setError("登录页面无法打开，请检查网络。");
                }}
                style={s.root}
              />
            </View>
          ) : (
            <View style={[s.sheet, shortLandscape && s.shortSheet]}>
              <View style={[s.heading, shortLandscape && s.shortHeading]}>
                <View style={s.headingCopy}>
                  <Text style={[s.title, shortLandscape && s.shortTitle]}>连接你的家</Text>
                  <Text style={s.caption}>账号凭据与密钥仅保存在这台设备的系统安全存储中</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭连接设置"
                  style={s.closeBtn}
                  onPress={closeSettings}
                >
                  <LooiIcon name="close" size={16} color={P.textSecondary} />
                  <Text style={s.closeText}>关闭</Text>
                </Pressable>
              </View>

              <ScrollView
                contentContainerStyle={[s.form, shortLandscape && s.shortForm]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={[s.columns, twoColumn && s.columnsWide]}>
                  {/* Left Column: Home Connection Mode & Details */}
                  <View style={[s.panel, twoColumn && s.panelLeft]}>
                    <Text style={s.sectionTitle}>1. 家居设备连接方式</Text>
                    <View style={s.modeGrid}>
                      {modes.map(([id, title, description]) => {
                        const active = mode === id;
                        return (
                          <Pressable
                            key={id}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: active }}
                            style={[s.choice, active && s.selected]}
                            onPress={() => setMode(id)}
                          >
                            <View style={s.choiceHeader}>
                              <View style={[s.radioDot, active && s.radioDotActive]} />
                              <Text style={[s.choiceTitle, active && s.choiceTitleActive]}>{title}</Text>
                            </View>
                            <Text numberOfLines={1} style={s.choiceCaption}>{description}</Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {mode === "direct_miot" && (
                      <View style={s.configBox}>
                        <Text style={s.label}>选择米家账号地区</Text>
                        <View style={s.regions}>
                          {regions.map(([id, name]) => {
                            const active = region === id;
                            return (
                              <Pressable
                                key={id}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: active }}
                                style={[s.pill, active && s.selected]}
                                onPress={() => setRegion(id)}
                              >
                                <Text style={[s.pillText, active && s.choiceTitleActive]}>{name}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        <View style={s.miotActions}>
                          <Pressable
                            disabled={busy}
                            accessibilityRole="button"
                            style={[s.miotLoginBtn, busy && s.disabled]}
                            onPress={() =>
                              void run(async () => {
                                const generation = formGeneration.current;
                                handled.current = null;
                                const session = await center.beginMiotLogin(region);
                                if (generation !== formGeneration.current) {
                                  center.cancelMiotLogin();
                                  return;
                                }
                                setAuthUrl(session.authorizationUrl);
                              })
                            }
                          >
                            <Text style={s.primaryText}>登录米家并连接设备</Text>
                          </Pressable>
                          <Pressable
                            disabled={busy}
                            accessibilityRole="button"
                            style={[s.logoutBtn, busy && s.disabled]}
                            onPress={() =>
                              void run(async () => {
                                await center.logoutMiot();
                              })
                            }
                          >
                            <Text style={s.danger}>退出米家账号</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}

                    {mode === "external_ha" && (
                      <View style={s.configBox}>
                        <Text style={s.label}>Home Assistant 实例地址与令牌</Text>
                        <TextInput
                          value={haUrl}
                          onChangeText={setHaUrl}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          placeholder="http://192.168.1.10:8123"
                          placeholderTextColor={P.textMuted}
                          accessibilityLabel="Home Assistant 地址"
                          style={s.input}
                        />
                        <TextInput
                          value={haToken}
                          onChangeText={setHaToken}
                          secureTextEntry
                          autoCapitalize="none"
                          autoCorrect={false}
                          placeholder="长期访问令牌；已保存时可留空"
                          placeholderTextColor={P.textMuted}
                          accessibilityLabel="Home Assistant 访问令牌"
                          style={s.input}
                        />
                      </View>
                    )}

                    {mode === "simulation" && (
                      <View style={s.infoBox}>
                        <Text style={s.caption}>
                          独立运行本地书房吸顶灯、台灯、风扇与温湿度传感器演示，不向任何真实设备发送指令。
                        </Text>
                      </View>
                    )}

                    {mode === "hub" && (
                      <View style={s.infoBox}>
                        <Text style={s.caption}>
                          沿用桌面 Hub 服务配置的家居网关与白名单设备。
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Right Column: Voice & Personal Memory Runtime */}
                  <View style={[s.panel, twoColumn && s.panelRight]}>
                    <Text style={s.sectionTitle}>2. 语音与个人记忆运行位置</Text>
                    <View style={s.regions}>
                      {(["local", "hub"] as const).map((value) => {
                        const active = voiceMode === value;
                        return (
                          <Pressable
                            key={value}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: active }}
                            style={[s.voiceChoice, active && s.selected]}
                            onPress={() => setVoiceMode(value)}
                          >
                            <View style={s.choiceHeader}>
                              <View style={[s.radioDot, active && s.radioDotActive]} />
                              <Text style={[s.choiceTitle, active && s.choiceTitleActive]}>
                                {value === "local" ? "在这台手机运行" : "通过桌面 Hub"}
                              </Text>
                            </View>
                            <Text style={s.choiceCaption}>
                              {value === "local" ? "本机直连豆包与本地记忆" : "共享桌面主机语音与任务"}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {voiceMode === "local" && (
                      <View style={s.configBox}>
                        <Text style={s.label}>豆包语音 API Key</Text>
                        <TextInput
                          value={voiceKey}
                          onChangeText={setVoiceKey}
                          secureTextEntry
                          autoCapitalize="none"
                          autoCorrect={false}
                          accessibilityLabel="豆包 API Key"
                          placeholder="豆包 API Key；已保存时可留空"
                          placeholderTextColor={P.textMuted}
                          style={s.input}
                        />
                      </View>
                    )}

                    {(error || center.error) && (
                      <Text accessibilityRole="alert" style={s.error}>
                        {error ?? center.error}
                      </Text>
                    )}

                    <View style={s.footerActions}>
                      {busy && <ActivityIndicator color={P.presenceCyan} accessibilityLabel="正在连接" />}
                      <Pressable
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel="保存并应用连接设置"
                        style={[s.primary, busy && s.disabled]}
                        onPress={() => void saveAllSettings()}
                      >
                        <Text style={s.primaryText}>
                          {mode === "simulation" ? "启用离线演示并保存" : "保存并连接"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </ScrollView>
            </View>
          )}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3, 7, 13, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 14,
  },
  sheet: {
    width: "100%",
    maxWidth: 780,
    maxHeight: "94%",
    backgroundColor: "rgba(9, 20, 34, 0.97)",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    overflow: "hidden",
    boxShadow: "0 16px 38px rgba(0, 0, 0, 0.55)",
  },
  shortSheet: {
    maxHeight: "96%",
    borderRadius: 20,
  },
  heading: {
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(14, 28, 46, 0.75)",
  },
  shortHeading: {
    minHeight: 46,
    paddingVertical: 7,
  },
  headingCopy: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: P.textPrimary,
    fontSize: 18,
    fontWeight: "700",
  },
  shortTitle: {
    fontSize: 16,
  },
  caption: {
    color: P.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
  },
  closeBtn: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.22)",
    backgroundColor: "rgba(15, 28, 44, 0.75)",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  closeText: {
    color: P.textSecondary,
    fontSize: 12.5,
    fontWeight: "600",
  },
  form: {
    padding: 16,
    gap: 12,
  },
  shortForm: {
    padding: 12,
    gap: 10,
  },
  columns: {
    gap: 12,
  },
  columnsWide: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  panel: {
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(12, 24, 38, 0.65)",
    gap: 10,
  },
  panelLeft: {
    flex: 1.25,
  },
  panelRight: {
    flex: 1,
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: P.textPrimary,
    fontSize: 13.5,
    fontWeight: "700",
  },
  modeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  choice: {
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: 135,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: P.borderSubtle,
    backgroundColor: "rgba(9, 18, 30, 0.78)",
    gap: 3,
  },
  voiceChoice: {
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: 130,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: P.borderSubtle,
    backgroundColor: "rgba(9, 18, 30, 0.78)",
    gap: 3,
  },
  choiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  radioDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: P.textMuted,
  },
  radioDotActive: {
    backgroundColor: P.presenceCyan,
    boxShadow: "0 0 6px rgba(40, 213, 255, 0.75)",
  },
  selected: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.12)",
  },
  choiceTitle: {
    color: P.textPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
  choiceTitleActive: {
    color: P.presenceCyan,
    fontWeight: "700",
  },
  choiceCaption: {
    color: P.textSecondary,
    fontSize: 11,
  },
  configBox: {
    gap: 8,
    paddingTop: 2,
  },
  infoBox: {
    padding: 10,
    borderRadius: 11,
    backgroundColor: "rgba(8, 18, 30, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.12)",
  },
  label: {
    color: P.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  regions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  pill: {
    minHeight: 34,
    paddingHorizontal: 11,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: P.borderSubtle,
    borderRadius: 10,
    backgroundColor: "rgba(9, 18, 30, 0.78)",
  },
  pillText: {
    color: P.textPrimary,
    fontSize: 12,
    fontWeight: "500",
  },
  input: {
    minHeight: 40,
    color: P.textPrimary,
    borderWidth: 1,
    borderColor: P.borderSubtle,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 13,
    backgroundColor: "rgba(7, 15, 25, 0.85)",
  },
  miotActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  miotLoginBtn: {
    flex: 1,
    minWidth: 150,
    minHeight: 40,
    backgroundColor: P.presenceCyanSoft,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  logoutBtn: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(250, 142, 134, 0.3)",
    backgroundColor: "rgba(250, 142, 134, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  primary: {
    flex: 1,
    minHeight: 42,
    backgroundColor: P.presenceCyanSoft,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryText: {
    color: P.bgPure,
    fontSize: 14,
    fontWeight: "700",
  },
  danger: {
    color: P.alertCoral,
    fontSize: 12.5,
    fontWeight: "600",
  },
  error: {
    color: P.amberWarning,
    fontSize: 12,
    lineHeight: 17,
  },
  auth: {
    flex: 1,
    width: "100%",
    maxWidth: 900,
    backgroundColor: P.bgSurface,
    borderRadius: 24,
    overflow: "hidden",
  },
  disabled: {
    opacity: 0.45,
  },
});
