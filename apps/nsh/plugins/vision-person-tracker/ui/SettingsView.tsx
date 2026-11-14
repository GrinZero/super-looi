import {
  Canvas,
  cleanup,
  createMotion,
  effect,
  lifecycle,
  reduceMotion,
  Scroll,
  Text,
  token,
  View,
  windowSize,
} from "nsh";
import { Button } from "nsh/base";
import { ActionButton } from "../../../ui/Controls";
import { DeviceCameraPreview } from "../../../ui/DeviceCameraPreview";
import { PluginVectorIcon } from "../../../ui/plugins/PluginVectorIcon";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import type {
  SmoothedPersonTarget,
  VisionPersonTrackerCommand,
  VisionPersonTrackerState,
} from "../contracts";

const ALPHA_PRESETS: ReadonlyArray<{
  readonly value: number;
  readonly id: string;
  readonly zhLabel: string;
  readonly enLabel: string;
}> = [
  { value: 0.25, id: "vision-alpha-025", zhLabel: "0.25 稳重", enLabel: "0.25 Steady" },
  { value: 0.45, id: "vision-alpha-045", zhLabel: "0.45 均衡", enLabel: "0.45 Balanced" },
  { value: 0.75, id: "vision-alpha-075", zhLabel: "0.75 灵敏", enLabel: "0.75 Fast" },
];

const FPS_PRESETS: ReadonlyArray<{
  readonly value: number;
  readonly id: string;
  readonly zhLabel: string;
  readonly enLabel: string;
}> = [
  { value: 4, id: "vision-fps-4", zhLabel: "4 FPS 省电", enLabel: "4 FPS Eco" },
  { value: 6, id: "vision-fps-6", zhLabel: "6 FPS 标准", enLabel: "6 FPS Normal" },
  { value: 10, id: "vision-fps-10", zhLabel: "10 FPS 高刷", enLabel: "10 FPS Smooth" },
];

function formatSignedOffset(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

export function VisionPersonTrackerSettingsView(props: {
  ctx: PluginViewContext<VisionPersonTrackerState, VisionPersonTrackerCommand>;
}) {
  const previewReveal = createMotion();

  const wide = () => windowSize().width >= 600;
  const zh = () => props.ctx.locale() === "zh-CN";
  const enabled = () => props.ctx.enabled();
  const busy = () => props.ctx.busy();
  const st = () => props.ctx.state();

  const permission = () => st()?.permission ?? "undetermined";
  const streaming = () => Boolean(st()?.streaming);
  const subscribers = () => st()?.activeSubscribers ?? 0;
  const previewSessionId = () => st()?.previewSessionId ?? null;
  const calibrationOpen = () => Boolean(st()?.calibrationPreviewOpen);
  const smoothingAlpha = () => st()?.smoothingAlpha ?? 0.45;
  const maxFps = () => st()?.maxFps ?? 6;
  const faceCount = () => st()?.faceCount ?? 0;
  const primaryTarget = (): SmoothedPersonTarget | null => st()?.primaryTarget ?? null;

  const errorText = () => {
    const uiErr = props.ctx.uiError();
    if (uiErr) return uiErr;
    const stateErr = st()?.lastError;
    if (stateErr) return stateErr;
    const hostErr = props.ctx.lastError();
    if (hostErr) {
      const code = hostErr.code !== undefined ? ` code=${String(hostErr.code)}` : "";
      return `[stage=${hostErr.stage}${code}] ${hostErr.reason}`;
    }
    return "";
  };

  effect(() => {
    const active = Boolean(previewSessionId());
    if (active && lifecycle() === "active" && !reduceMotion()) {
      void previewReveal.play("fadeIn");
    } else {
      previewReveal.reset();
    }
    return () => previewReveal.stop();
  });

  cleanup(() => {
    if (props.ctx.state()?.calibrationPreviewOpen) {
      void props.ctx.sendCommand({ type: "set_calibration_preview", open: false });
    }
  });

  const permissionDotClass = () => {
    if (!enabled()) return "w-2 h-2 rounded-full bg-subtle-text";
    const p = permission();
    if (p === "granted") return "w-2 h-2 rounded-full bg-verified";
    if (p === "undetermined") return "w-2 h-2 rounded-full bg-warning";
    return "w-2 h-2 rounded-full bg-destructive";
  };

  const permissionLabel = () => {
    const p = permission();
    if (zh()) {
      if (p === "granted") return "系统前摄已授权";
      if (p === "undetermined") return "待授权前置摄像头";
      if (p === "denied") return "前摄权限已被系统拒绝";
      return "当前宿主前摄不可用";
    }
    if (p === "granted") return "Front camera granted";
    if (p === "undetermined") return "Permission undetermined";
    if (p === "denied") return "Camera permission denied";
    return "Front camera unavailable";
  };

  const streamBadgeText = () => {
    if (!enabled()) return zh() ? "已停用" : "Disabled";
    if (!streaming()) return zh() ? "按需待机 · 相机已熄灯" : "Standby · Camera off";
    const subCount = subscribers();
    return zh()
      ? `实时采集中 · ${subCount} 路订阅`
      : `Streaming · ${subCount} consumer${subCount === 1 ? "" : "s"}`;
  };

  const alignmentHint = () => {
    const target = primaryTarget();
    if (!target) return zh() ? "未锁定人脸" : "No face locked";
    if (Math.abs(target.offsetX) <= 0.12) {
      return zh() ? "水平已居中" : "Centered";
    }
    return target.offsetX < 0
      ? zh()
        ? "偏左 · 建议左转对准"
        : "Left of center"
      : zh()
        ? "偏右 · 建议右转对准"
        : "Right of center";
  };

  return (
    <View
      testID="vision-person-tracker-settings"
      class={wide() ? "flex-1 min-h-0 flex-row gap-3.5" : "flex-1 min-h-0 gap-3"}
    >
      {/* Left Column: Permission + Landscape Calibration Viewport */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-foreground text-sm font-bold" role="header">
              {zh() ? "前置相机与取景校准" : "Front Camera & Calibration"}
            </Text>
            <View class="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border">
              <View
                class={
                  streaming()
                    ? "w-2 h-2 rounded-full bg-verified"
                    : "w-2 h-2 rounded-full bg-subtle-text"
                }
              />
              <Text testID="vision-stream-status" class="text-muted-foreground text-xs font-medium">
                {streamBadgeText()}
              </Text>
            </View>
          </View>

          <View class="flex-row items-center justify-between gap-2.5 rounded-xl bg-muted border border-border p-2.5">
            <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
              <View class="w-10 h-10 rounded-xl bg-card border border-border items-center justify-center shrink-0">
                <PluginVectorIcon name="eye" tone="foreground" size={18} />
              </View>
              <View class="flex-1 min-w-0 gap-0.5">
                <Text class="text-foreground text-xs font-semibold" style={{ numberOfLines: 1 }}>
                  {zh() ? "系统相机 ISP 人脸元数据" : "OS Camera ISP Face Metadata"}
                </Text>
                <View class="flex-row items-center gap-1.5">
                  <View class={permissionDotClass()} />
                  <Text
                    testID="vision-permission-state"
                    class="text-muted-foreground text-xs"
                    style={{ numberOfLines: 1 }}
                  >
                    {permissionLabel()}
                  </Text>
                </View>
              </View>
            </View>

            <If when={permission() !== "granted"}>
              <ActionButton
                testID="vision-request-permission"
                compact
                kind="primary"
                label={zh() ? "授权相机" : "Grant"}
                disabled={!enabled() || busy()}
                onPress={() => {
                  void props.ctx.sendCommand({ type: "request_permission" });
                }}
              />
            </If>
          </View>

          <View
            class="w-full rounded-xl overflow-hidden border border-border bg-secondary items-center justify-center relative"
            style={{ aspectRatio: "16 / 9", minHeight: 132, maxHeight: 172 }}
          >
            <Each
              of={previewSessionId() ? [previewSessionId()!] : []}
              key={(id) => id}
            >
              {(id) => (
                <View class="absolute inset-0" style={previewReveal.style}>
                  <DeviceCameraPreview
                    testID="vision-camera-preview"
                    sessionId={id()}
                    class="absolute inset-0"
                  />
                </View>
              )}
            </Each>

            <Canvas
              class="absolute inset-0"
              style={{ pointerEvents: "none" }}
              draw={(cx, size) => {
                cx.clearRect(0, 0, size.width, size.height);
                const midX = size.width / 2;
                const midY = size.height / 2;

                cx.strokeStyle = token("border");
                cx.lineWidth = 1;
                cx.beginPath();
                cx.moveTo(midX - 14, midY);
                cx.lineTo(midX + 14, midY);
                cx.moveTo(midX, midY - 14);
                cx.lineTo(midX, midY + 14);
                cx.stroke();

                const target = primaryTarget();
                if (!target || !streaming()) return;

                const cxPos = midX + target.offsetX * (size.width / 2);
                const cyPos = midY + target.offsetY * (size.height / 2);
                const boxW = Math.max(28, target.width * size.width);
                const boxH = Math.max(28, target.height * size.height);
                const aligned = Math.abs(target.offsetX) <= 0.12;

                cx.strokeStyle = token(aligned ? "verified" : "warning");
                cx.lineWidth = 2;
                cx.strokeRect(cxPos - boxW / 2, cyPos - boxH / 2, boxW, boxH);

                cx.fillStyle = token(aligned ? "verified" : "warning");
                cx.beginPath();
                cx.arc(cxPos, cyPos, 3.5, 0, Math.PI * 2);
                cx.fill();
              }}
            />

            <If when={!previewSessionId()}>
              <View class="items-center gap-1.5 px-4">
                <PluginVectorIcon name="eye" tone="muted" size={22} />
                <Text class="text-muted-foreground text-xs font-medium">
                  {zh()
                    ? "引用计数为 0 时自动关流熄灯，仅在被桌游/伴随调用或校准时开启"
                    : "Camera stays powered off until acquired by a plugin or calibration"}
                </Text>
              </View>
            </If>
          </View>

          <View class="flex-row items-center justify-between gap-2">
            <ActionButton
              testID="vision-toggle-calibration"
              compact
              kind={calibrationOpen() ? "quiet" : "primary"}
              label={
                calibrationOpen()
                  ? zh()
                    ? "关闭实时取景校准"
                    : "Stop Calibration"
                  : zh()
                    ? "开启实时取景校准"
                    : "Start Calibration"
              }
              disabled={!enabled() || busy()}
              onPress={() => {
                void props.ctx.sendCommand({
                  type: "set_calibration_preview",
                  open: !calibrationOpen(),
                });
              }}
            />
            <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
              {alignmentHint()}
            </Text>
          </View>
        </Scroll>
      </View>

      {/* Right Column: Live ISP Coordinates + EMA / FPS Tuning */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3.5">
          <View class="gap-2">
            <Text class="text-foreground text-sm font-bold" role="header">
              {zh() ? "主目标平滑读数" : "Primary Target Telemetry"}
            </Text>
            <View class="flex-row gap-2">
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "画面人数" : "Faces"}
                </Text>
                <Text testID="vision-face-count" class="text-foreground text-base font-bold font-mono">
                  {String(faceCount())}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "水平偏移 X" : "Offset X"}
                </Text>
                <Text testID="vision-offset-x" class="text-foreground text-base font-bold font-mono">
                  {formatSignedOffset(primaryTarget()?.offsetX)}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "垂直偏移 Y" : "Offset Y"}
                </Text>
                <Text testID="vision-offset-y" class="text-foreground text-base font-bold font-mono">
                  {formatSignedOffset(primaryTarget()?.offsetY)}
                </Text>
              </View>
            </View>
          </View>

          <View class="gap-2">
            <View class="gap-0.5">
              <Text class="text-foreground text-xs font-semibold" role="header">
                {zh() ? "指数移动平均平滑系数 (EMA α)" : "EMA Smoothing Factor (α)"}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {zh()
                  ? "数值越小底座转向越平顺抗抖，数值越大跟脸响应越快"
                  : "Lower values smooth servo jitter; higher values track faster"}
              </Text>
            </View>
            <View class="flex-row gap-2">
              <Each of={ALPHA_PRESETS} key={(item) => item.id}>
                {(item) => {
                  const selected = () => Math.abs(smoothingAlpha() - item().value) < 0.05;
                  return (
                    <Button
                      testID={item().id}
                      accessibilityLabel={zh() ? item().zhLabel : item().enLabel}
                      disabled={!enabled() || busy()}
                      onPress={() => {
                        void props.ctx.sendCommand({
                          type: "update_settings",
                          smoothingAlpha: item().value,
                        });
                      }}
                      class={
                        selected()
                          ? "flex-1 min-h-11 rounded-xl bg-primary border border-transparent px-2.5 items-center justify-center active:opacity-75 focus:border-ring disabled:opacity-35 transition-colors duration-150"
                          : "flex-1 min-h-11 rounded-xl bg-muted border border-border px-2.5 items-center justify-center active:bg-secondary focus:border-ring disabled:opacity-35 transition-colors duration-150"
                      }
                    >
                      <Text
                        class={
                          selected()
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {zh() ? item().zhLabel : item().enLabel}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </View>

          <View class="gap-2">
            <Text class="text-foreground text-xs font-semibold" role="header">
              {zh() ? "默认追踪采样帧率" : "Default Tracking Frame Rate"}
            </Text>
            <View class="flex-row gap-2">
              <Each of={FPS_PRESETS} key={(item) => item.id}>
                {(item) => {
                  const selected = () => maxFps() === item().value;
                  return (
                    <Button
                      testID={item().id}
                      accessibilityLabel={zh() ? item().zhLabel : item().enLabel}
                      disabled={!enabled() || busy()}
                      onPress={() => {
                        void props.ctx.sendCommand({
                          type: "update_settings",
                          maxFps: item().value,
                        });
                      }}
                      class={
                        selected()
                          ? "flex-1 min-h-11 rounded-xl bg-primary border border-transparent px-2.5 items-center justify-center active:opacity-75 focus:border-ring disabled:opacity-35 transition-colors duration-150"
                          : "flex-1 min-h-11 rounded-xl bg-muted border border-border px-2.5 items-center justify-center active:bg-secondary focus:border-ring disabled:opacity-35 transition-colors duration-150"
                      }
                    >
                      <Text
                        class={
                          selected()
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {zh() ? item().zhLabel : item().enLabel}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </View>

          <If when={Boolean(errorText())}>
            <View
              testID="vision-error-banner"
              class="rounded-xl border border-destructive bg-muted p-2.5 gap-1"
            >
              <Text class="text-destructive text-xs font-semibold">
                {zh() ? "最近执行异常" : "Last Error"}
              </Text>
              <Text class="text-destructive text-xs font-mono">{errorText()}</Text>
            </View>
          </If>
        </Scroll>
      </View>
    </View>
  );
}
