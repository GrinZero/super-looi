import { effect, signal, Text, View, windowSize } from "nsh";
import type { createAppStore } from "../store";
import { ActionButton, Panel, TextField } from "./Controls";

export function HomePanel(props: {
  open: boolean;
  store: ReturnType<typeof createAppStore>;
  onClose: () => void;
}) {
  const url = signal(""),
    token = signal(""),
    working = signal(false),
    error = signal("");
  effect(() => {
    if (props.open) {
      url.set(props.store.homeConfiguration().haUrl);
      token.set("");
      error.set("");
    } else token.set("");
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
          <Text class="text-muted-foreground text-sm">
            控制设备前会请你允许一次，并回读设备状态。连接失败不会切换到演示设备。
          </Text>
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
