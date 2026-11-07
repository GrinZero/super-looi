import { effect, signal, Text, View, windowSize } from "nsh";
import { Select } from "nsh/base";
import type { HomeConfiguration } from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, Panel, TextField } from "./Controls";

export function HomePanel(props: {
  open: boolean;
  store: ReturnType<typeof createAppStore>;
  onClose: () => void;
}) {
  const regions = [
    { value: "cn", title: "中国大陆" }, { value: "de", title: "欧洲" },
    { value: "i2", title: "印度" }, { value: "ru", title: "俄罗斯" },
    { value: "sg", title: "新加坡" }, { value: "us", title: "美国" },
  ];
  const region = signal<HomeConfiguration["region"]>("cn");
  const url = signal(""),
    token = signal(""),
    working = signal(false),
    error = signal("");
  let wasOpen = false;
  effect(() => {
    if (props.open && !wasOpen) {
      url.set(props.store.homeConfiguration().haUrl);
      region.set(props.store.homeConfiguration().region);
      token.set("");
      error.set("");
    }
    if (!props.open) {
      token.set("");
      if (wasOpen) props.store.cancelHomeLogin();
    }
    wasOpen = props.open;
  });
  const configure = async (mode: "disabled" | "simulation" | "external_ha") => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({
        mode,
        ...(mode === "external_ha"
          ? { haUrl: url(), ...(token().trim() ? { haToken: token() } : {}) }
          : {}),
      });
      token.set("");
      if (mode !== "disabled") await props.store.connectHome();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };
  const login = async (logout = false) => {
    if (working()) return;
    working.set(true); error.set("");
    try {
      if (logout) await props.store.logoutMiot();
      else await props.store.loginMiot(region());
    } catch (cause) {
      error.set(cause instanceof Error && cause.message.startsWith("米家")
        ? cause.message : "米家连接未完成，请稍后重试。");
    } finally { working.set(false); }
  };
  const refreshMiot = async () => {
    if (working()) return;
    working.set(true); error.set("");
    try {
      if (props.store.homeConfiguration().mode !== "direct_miot")
        await props.store.configureHome({ mode: "direct_miot", region: region() });
      await props.store.connectHome();
    }
    catch { error.set("暂时无法读取米家设备，请稍后重试。"); }
    finally { working.set(false); }
  };
  const savedMiotSelected = () => props.store.homeConfiguration().hasMiotAccount &&
    region() === props.store.homeConfiguration().region;
  const devices = () => {
    const value = props.store.homeDevices().devices;
    return Array.isArray(value)
      ? (value as Array<{
          entity_id: string;
          friendly_name: string;
          snapshot?: { state?: string };
        }>)
      : [];
  };
  return (
    <Panel
      open={props.open}
      title="家居连接"
      height={560}
      wide={true}
      dismissible={!working()}
      onClose={props.onClose}
    >
      <View
        style={{
          flexDirection: windowSize().width >= 680 ? "row" : "column",
          gap: 24,
        }}
      >
        <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
          <TextField
            label="Home Assistant 地址"
            testID="home-url"
            value={url()}
            onChange={(value) => url.set(value)}
            placeholder="https://…"
          />
          <TextField
            label="长期访问令牌"
            testID="home-token"
            value={token()}
            onChange={(value) => token.set(value)}
            masked={true}
            placeholder={
              props.store.homeConfiguration().hasToken
                ? "已安全保存；相同地址可留空"
                : "输入令牌"
            }
          />
          <ActionButton
            label={working() ? "正在连接…" : "连接 Home Assistant"}
            testID="home-connect"
            kind="primary"
            disabled={working() || props.store.busy() || !url().trim()}
            onPress={() => {
              void configure("external_ha");
            }}
          />
        </View>
        <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
          <Text class="text-foreground text-base">
            {props.store.homeConfiguration().mode === "simulation"
              ? "离线演示 · 不控制真实设备"
              : props.store.homeConnection()?.healthy
                ? "已连接家居服务"
                : "家居尚未连接"}
          </Text>
          <View class="gap-1">
            <Text class="text-muted-foreground text-sm">控制前需允许一次，并回读设备状态。</Text>
            <Text class="text-muted-foreground text-sm">连接失败不会改用演示设备。</Text>
          </View>
          <View class="flex-row gap-2">
            <ActionButton
              label="离线演示"
              testID="home-simulation"
              disabled={working() || props.store.busy()}
              onPress={() => {
                void configure("simulation");
              }}
            />
            <ActionButton
              label="关闭家居"
              disabled={working() || props.store.busy()}
              onPress={() => {
                void configure("disabled");
              }}
            />
          </View>
          <View class="gap-3 border-t border-border pt-3">
            <Text class="text-foreground text-base">米家账号</Text>
            <Text class="text-muted-foreground text-sm">选择与米家 App 相同的服务区域。</Text>
            <Select
              testID="home-miot-region"
              accessibilityLabel="米家服务区域"
              items={regions}
              value={region()}
              disabled={working() || props.store.busy()}
              onChange={(event) => {
                if (regions.some((item) => item.value === event.value)) region.set(event.value as HomeConfiguration["region"]);
              }}
              popupClass="bg-card rounded-xl border border-border"
              itemClass="min-h-12 px-4 text-foreground selected:bg-muted"
              trigger={<View class="min-h-12 justify-center rounded-xl border border-input bg-background px-4"><Text class="text-foreground text-base">{regions.find((item) => item.value === region())?.title}</Text></View>}
            />
            <ActionButton
              label={props.store.homeLoggingIn() ? "等待米家授权…" : savedMiotSelected() ? "重新登录米家" : "登录米家"}
              testID="home-miot-login"
              disabled={working() || props.store.busy()}
              onPress={() => { void login(); }}
            />
            <If when={props.store.homeLoggingIn()}>
              <ActionButton label="取消米家登录" testID="home-miot-cancel" onPress={() => props.store.cancelHomeLogin()} />
            </If>
            <If when={savedMiotSelected()}>
              <ActionButton label={props.store.homeConfiguration().mode === "direct_miot" ? "刷新米家设备" : "连接已保存的米家账号"} testID="home-miot-refresh" disabled={working() || props.store.busy()} onPress={() => { void refreshMiot(); }} />
            </If>
            <If when={props.store.homeConfiguration().mode === "direct_miot" && savedMiotSelected()}>
              <ActionButton label="退出米家账号" testID="home-miot-logout" disabled={working() || props.store.busy()} onPress={() => { void login(true); }} />
            </If>
          </View>
          <If when={error() || props.store.homeConnection()?.error}>
            <Text role="alert" class="text-destructive text-sm">
              {error() || props.store.homeConnection()?.error}
            </Text>
          </If>
          <If when={devices().length}>
            <Text class="text-muted-foreground text-sm">
              设备预览 · 可在对话中查询更多设备或提出控制请求
            </Text>
            <Each of={devices()} key={(item) => item.entity_id}>
              {(item) => (
                <View class="gap-1 border-b border-border pb-2">
                  <Text class="text-foreground text-base">
                    {item().friendly_name}
                  </Text>
                  <Text class="text-muted-foreground text-sm">
                    {item().entity_id} · {item().snapshot?.state ?? "状态未知"}
                  </Text>
                </View>
              )}
            </Each>
          </If>
        </View>
      </View>
    </Panel>
  );
}
