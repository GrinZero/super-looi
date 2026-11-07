import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Select } from "nsh/base";
import type { HomeConfiguration } from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

type HomeModeTab = "direct_miot" | "external_ha" | "simulation";

export function HomeSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  modeTab: HomeModeTab | (() => HomeModeTab);
}) {
  const activeModeTab = (): HomeModeTab =>
    typeof props.modeTab === "function" ? props.modeTab() : props.modeTab;
  const regions = [
    { value: "cn", title: "中国大陆" },
    { value: "de", title: "欧洲" },
    { value: "i2", title: "印度" },
    { value: "ru", title: "俄罗斯" },
    { value: "sg", title: "新加坡" },
    { value: "us", title: "美国" },
  ];

  const region = signal<HomeConfiguration["region"]>("cn");
  const haUrl = signal("");
  const haToken = signal("");
  const working = signal(false);
  const error = signal("");

  let lastSyncedHomeKey = "";
  effect(() => {
    const cfg = props.store.homeConfiguration();
    const readyFlag = typeof props.store.ready === "function" ? props.store.ready() : true;
    const key = `${readyFlag}:${cfg.mode}:${cfg.region}:${cfg.haUrl}`;
    if (key === lastSyncedHomeKey) return;
    lastSyncedHomeKey = key;
    haUrl.set(cfg.haUrl || "");
    region.set(cfg.region || "cn");
    haToken.set("");
    error.set("");
  });

  const savedMiotSelected = () =>
    props.store.homeConfiguration().hasMiotAccount &&
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

  const loginMiot = async (logout = false) => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      if (logout) {
        await props.store.logoutMiot();
      } else {
        await props.store.loginMiot(region());
      }
    } catch (cause) {
      error.set(
        cause instanceof Error && cause.message.startsWith("米家")
          ? cause.message
          : "米家连接未完成，请稍后重试。",
      );
    } finally {
      working.set(false);
    }
  };

  const refreshMiot = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      if (props.store.homeConfiguration().mode !== "direct_miot") {
        await props.store.configureHome({
          mode: "direct_miot",
          region: region(),
        });
      }
      await props.store.connectHome();
    } catch {
      error.set("暂时无法读取米家设备，请稍后重试。");
    } finally {
      working.set(false);
    }
  };

  const configureHa = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({
        mode: "external_ha",
        haUrl: haUrl().trim(),
        ...(haToken().trim() ? { haToken: haToken().trim() } : {}),
      });
      haToken.set("");
      await props.store.connectHome();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const configureSimulation = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({ mode: "simulation" });
      await props.store.connectHome();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const renderLeftCard = () => (
    <View class="gap-3.5">
      <If when={activeModeTab() === "direct_miot"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="flex-row items-center justify-between border-b border-border pb-2.5">
            <View class="gap-0.5">
              <Text class="text-foreground text-sm font-semibold">
                米家官方账号直连
              </Text>
              <Text class="text-muted-foreground text-xs font-mono">
                云端端对端同步 · 支持插座、灯具与温湿度传感器
              </Text>
            </View>
            <If when={props.store.homeConfiguration().hasMiotAccount}>
              <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
                <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                <Text class="text-verified text-xs font-medium">已登录</Text>
              </View>
            </If>
          </View>

          <Text class="text-muted-foreground text-xs">
            选择与米家 App 一致的服务区域，授权后可在语音或对话中安全控制智能设备。
          </Text>

          <View class="gap-2">
            <Text class="text-muted-foreground text-sm">米家服务区域</Text>
            <Select
              testID="home-miot-region"
              accessibilityLabel="米家服务区域"
              items={regions}
              value={region()}
              disabled={working() || props.store.busy()}
              onChange={(event) => {
                if (regions.some((item) => item.value === event.value)) {
                  region.set(event.value as HomeConfiguration["region"]);
                }
              }}
              popupClass="bg-card rounded-xl border border-border"
              itemClass="min-h-12 px-4 text-foreground selected:bg-muted"
              trigger={
                <View class="min-h-12 justify-center rounded-xl border border-input bg-background px-4">
                  <Text class="text-foreground text-base">
                    {regions.find((item) => item.value === region())?.title}
                  </Text>
                </View>
              }
            />
          </View>

          <View class="flex-row flex-wrap gap-2 pt-1">
            <ActionButton
              label={
                props.store.homeLoggingIn()
                  ? "等待米家授权…"
                  : savedMiotSelected()
                    ? "重新登录米家"
                    : "登录米家"
              }
              testID="home-miot-login"
              kind="primary"
              compact={true}
              disabled={working() || props.store.busy()}
              onPress={() => void loginMiot()}
            />
            <If when={props.store.homeLoggingIn()}>
              <ActionButton
                label="取消米家登录"
                testID="home-miot-cancel"
                compact={true}
                onPress={() => props.store.cancelHomeLogin()}
              />
            </If>
            <If when={savedMiotSelected()}>
              <ActionButton
                label={
                  props.store.homeConfiguration().mode === "direct_miot"
                    ? "刷新米家设备"
                    : "连接已保存的米家账号"
                }
                testID="home-miot-refresh"
                compact={true}
                disabled={working() || props.store.busy()}
                onPress={() => void refreshMiot()}
              />
            </If>
            <If
              when={
                props.store.homeConfiguration().mode === "direct_miot" &&
                savedMiotSelected()
              }
            >
              <ActionButton
                label="退出米家账号"
                testID="home-miot-logout"
                kind="danger"
                compact={true}
                disabled={working() || props.store.busy()}
                onPress={() => void loginMiot(true)}
              />
            </If>
          </View>
        </View>
      </If>

      <If when={activeModeTab() === "external_ha"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="border-b border-border pb-2.5">
            <Text class="text-foreground text-sm font-semibold">
              Home Assistant 实例直连
            </Text>
            <Text class="text-muted-foreground text-xs font-mono">
              本地局域网 / 远程 WebSocket API 直连
            </Text>
          </View>

          <TextField
            label="Home Assistant 服务地址"
            testID="home-url"
            value={haUrl()}
            onChange={(v) => haUrl.set(v)}
            placeholder="https://homeassistant.local:8123"
          />

          <TextField
            label="长期访问令牌 (Long-Lived Access Token)"
            testID="home-token"
            value={haToken()}
            onChange={(v) => haToken.set(v)}
            masked={true}
            placeholder={
              props.store.homeConfiguration().hasToken
                ? "已安全保存；相同地址可留空继续使用"
                : "输入访问令牌"
            }
            onSubmit={configureHa}
          />

          <View class="flex-row justify-end pt-1">
            <ActionButton
              label={working() ? "正在连接…" : "连接 Home Assistant"}
              testID="home-connect"
              kind="primary"
              compact={true}
              disabled={working() || !haUrl().trim()}
              onPress={configureHa}
            />
          </View>
        </View>
      </If>

      <If when={activeModeTab() === "simulation"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="border-b border-border pb-2.5">
            <Text class="text-foreground text-sm font-semibold">
              离线沙盒演示环境
            </Text>
            <Text class="text-muted-foreground text-xs font-mono">
              本地内存虚拟状态机 · 零物理风险
            </Text>
          </View>

          <Text class="text-muted-foreground text-xs">
            沙盒内置书房吸顶灯、台灯与温湿度传感器，提供完整的指令解析、状态回读与审计凭证流程，绝不控制任何物理硬件。
          </Text>

          <View class="flex-row justify-end pt-1">
            <ActionButton
              label="启用离线演示设备"
              testID="home-simulation"
              kind="primary"
              compact={true}
              disabled={working()}
              onPress={configureSimulation}
            />
          </View>
        </View>
      </If>

      <View class="rounded-xl border border-border bg-muted p-3">
        <Text class="text-muted-foreground text-xs">
          安全防线：所有物理设备控制动作均在执行前要求单次人工允许，并在动作后严格回读确认物理状态。
        </Text>
      </View>

      <If when={error() || props.store.homeConnection()?.error}>
        <View class="rounded-xl border border-destructive bg-muted p-3">
          <Text role="alert" class="text-destructive text-xs font-medium">
            {error() || props.store.homeConnection()?.error}
          </Text>
        </View>
      </If>
    </View>
  );

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between border-b border-border pb-2.5">
        <Text class="text-foreground text-sm font-semibold">
          连接回执与已发现设备 ({devices().length})
        </Text>
        <If
          when={props.store.homeConnection()?.healthy}
          else={
            <Text class="text-muted-foreground text-xs">未连接</Text>
          }
        >
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">服务正常</Text>
          </View>
        </If>
      </View>

      <If
        when={devices().length > 0}
        else={
          <View class="py-6 items-center justify-center">
            <Text class="text-muted-foreground text-xs">
              尚未发现设备。请连接米家账号、Home Assistant 或启用离线演示。
            </Text>
          </View>
        }
      >
        <View class="gap-2">
          <Each of={devices()} key={(d) => d.entity_id}>
            {(d) => (
              <View class="rounded-xl border border-border bg-muted p-3 flex-row items-center justify-between">
                <View class="gap-0.5" style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    class="text-foreground text-sm font-medium"
                    style={{ numberOfLines: 1 }}
                  >
                    {d().friendly_name}
                  </Text>
                  <Text
                    class="text-muted-foreground text-xs font-mono"
                    style={{ numberOfLines: 1 }}
                  >
                    {d().entity_id}
                  </Text>
                </View>
                <View class="px-2 py-0.5 rounded-md bg-secondary">
                  <Text class="text-foreground text-xs font-medium">
                    {d().snapshot?.state ?? "在线"}
                  </Text>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          {renderLeftCard()}
          {renderRightCard()}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3.5 min-h-0">
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
