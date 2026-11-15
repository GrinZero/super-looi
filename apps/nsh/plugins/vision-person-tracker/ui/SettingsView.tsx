import {
  Canvas,
  cleanup,
  computed,
  createMotion,
  effect,
  Image,
  lifecycle,
  reduceMotion,
  Scroll,
  Text,
  token,
  View,
  windowSize,
} from "nsh";
import { Button } from "nsh/base";
import { ActionButton, SwitchRow } from "../../../ui/Controls";
import { DeviceCameraPreview } from "../../../ui/DeviceCameraPreview";
import { PluginVectorIcon } from "../../../ui/plugins/PluginVectorIcon";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import type {
  CompanionActuatorMode,
  CompanionTrackingStatus,
  SmoothedPersonTarget,
  VisionPersonTrackerCommand,
  VisionPersonTrackerState,
} from "../contracts";

interface PresetOption {
  readonly value: number;
  readonly id: string;
  readonly zhLabel: string;
  readonly enLabel: string;
}

const ALPHA_PRESETS: ReadonlyArray<PresetOption> = [
  { value: 0.25, id: "vision-alpha-025", zhLabel: "0.25 稳重", enLabel: "0.25 Steady" },
  { value: 0.45, id: "vision-alpha-045", zhLabel: "0.45 均衡", enLabel: "0.45 Balanced" },
  { value: 0.75, id: "vision-alpha-075", zhLabel: "0.75 灵敏", enLabel: "0.75 Fast" },
];

const FPS_PRESETS: ReadonlyArray<PresetOption> = [
  { value: 4, id: "vision-fps-4", zhLabel: "4 FPS 省电", enLabel: "4 FPS Eco" },
  { value: 6, id: "vision-fps-6", zhLabel: "6 FPS 标准", enLabel: "6 FPS Normal" },
  { value: 10, id: "vision-fps-10", zhLabel: "10 FPS 高刷", enLabel: "10 FPS Smooth" },
];

const unmountCloseTokens = new WeakMap<object, number>();

function PresetButtonRow(props: {
  options: ReadonlyArray<PresetOption>;
  zh: () => boolean;
  disabled: () => boolean;
  isSelected: (value: number) => boolean;
  onSelect: (value: number) => void;
}) {
  return (
    <View class="flex-row gap-2">
      <Each of={props.options} key={(item) => item.id}>
        {(item) => {
          const selected = () => props.isSelected(item().value);
          return (
            <Button
              testID={item().id}
              selected={selected()}
              accessibilityLabel={props.zh() ? item().zhLabel : item().enLabel}
              disabled={props.disabled()}
              onPress={() => props.onSelect(item().value)}
              class={
                selected()
                  ? "flex-1 min-h-11 rounded-xl bg-primary border border-transparent px-2.5 items-center justify-center active:opacity-75 focus:border-ring disabled:opacity-35 transition-colors duration-150 motion-reduce:transition-none"
                  : "flex-1 min-h-11 rounded-xl bg-muted border border-border px-2.5 items-center justify-center active:bg-secondary focus:border-ring disabled:opacity-35 transition-colors duration-150 motion-reduce:transition-none"
              }
            >
              <Text
                class={
                  selected()
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs font-medium"
                }
              >
                {props.zh() ? item().zhLabel : item().enLabel}
              </Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

function formatSignedOffset(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function formatActuatorMode(mode: CompanionActuatorMode | undefined, zh: boolean): string {
  switch (mode) {
    case "servo_and_gaze":
      return zh ? "眼神+底座" : "Gaze+Servo";
    case "gaze_only":
      return zh ? "纯眼神跟随" : "Gaze Only";
    case "yielded_to_consumer":
      return zh ? "已让渡上层" : "Yielded";
    case "preempted":
      return zh ? "抢占暂停" : "Preempted";
    default:
      return zh ? "待机" : "Idle";
  }
}

function formatTrackingStatus(
  status: CompanionTrackingStatus | undefined,
  zh: boolean,
): string {
  switch (status) {
    case "searching":
      return zh ? "搜寻人脸" : "Searching";
    case "centered":
      return zh ? "居中锁定" : "Centered";
    case "turning_left":
      return zh ? "左转对准" : "Turn Left";
    case "turning_right":
      return zh ? "右转对准" : "Turn Right";
    case "yielded_to_consumer":
      return zh ? "上层接管中" : "External Ctrl";
    case "preempted":
      return zh ? "手动抢占" : "Preempted";
    default:
      return zh ? "已停止" : "Stopped";
  }
}

export function VisionPersonTrackerSettingsView(props: {
  ctx: PluginViewContext<VisionPersonTrackerState, VisionPersonTrackerCommand>;
}) {
  const previewReveal = createMotion();
  const viewMountToken = (unmountCloseTokens.get(props.ctx) ?? 0) + 1;
  unmountCloseTokens.set(props.ctx, viewMountToken);

  const wide = () => windowSize().width >= 600;
  const zh = () => props.ctx.locale() === "zh-CN";
  const enabled = () => props.ctx.enabled();
  const busy = () => props.ctx.busy();
  const st = () => props.ctx.state();

  const permission = () => st()?.permission ?? "undetermined";
  const streaming = () => Boolean(st()?.streaming);
  const subscribers = () => st()?.activeSubscribers ?? 0;
  const calibrationOpen = () => Boolean(st()?.calibrationPreviewOpen);
  const previewSessionId = computed(() =>
    calibrationOpen() ? (st()?.previewSessionId ?? null) : null,
  );
  const previewSessionIds = computed(() => {
    const id = previewSessionId();
    return id ? [id] : [];
  });
  const companionFollowEnabled = () => Boolean(st()?.companionFollowEnabled);
  const trackingStatus = () => st()?.trackingStatus ?? "idle";
  const actuatorMode = () => st()?.actuatorMode ?? "idle";
  const commandedTurn = () => st()?.commandedTurn ?? 0;
  const commandedPitchDegrees = () => st()?.commandedPitchDegrees ?? null;
  const lastPortrait = () => st()?.lastPortrait ?? null;
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

  let revealedSessionId: string | null = null;
  effect(() => {
    const sessionId = previewSessionId();
    if (!sessionId) {
      revealedSessionId = null;
      previewReveal.stop();
      previewReveal.reset();
      return;
    }
    if (revealedSessionId !== sessionId) {
      revealedSessionId = sessionId;
      if (lifecycle() === "active" && !reduceMotion()) {
        void previewReveal.play("fadeIn");
      } else {
        previewReveal.reset();
      }
    }
  });

  cleanup(() => {
    previewReveal.stop();
    const current = props.ctx.state();
    if (!props.ctx.enabled() || !current?.calibrationPreviewOpen) return;
    if (!props.ctx.busy()) {
      void props.ctx.sendCommand({ type: "set_calibration_preview", open: false });
      return;
    }
    setTimeout(() => {
      if (
        unmountCloseTokens.get(props.ctx) === viewMountToken &&
        props.ctx.enabled() &&
        props.ctx.state()?.calibrationPreviewOpen
      ) {
        void props.ctx.sendCommand({ type: "set_calibration_preview", open: false });
      }
    }, 60);
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
    if (!streaming()) return zh() ? "按需待机 · 已熄灯" : "Standby · Off";
    const subCount = subscribers();
    if (subCount > 0) {
      return zh()
        ? `实时采集中 · ${subCount} 路订阅`
        : `Streaming · ${subCount} consumer${subCount === 1 ? "" : "s"}`;
    }
    return zh() ? "本地跟脸采集中" : "Companion Streaming";
  };

  const alignmentHint = () => {
    const target = primaryTarget();
    if (!target) return zh() ? "未锁定人脸" : "No face";
    if (Math.abs(target.offsetX) <= 0.12) {
      return zh() ? "水平已居中" : "Centered";
    }
    return target.offsetX < 0
      ? zh()
        ? "偏左 · 左转"
        : "Left"
      : zh()
        ? "偏右 · 右转"
        : "Right";
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
            <Text
              class="text-foreground text-sm font-bold flex-1 min-w-0"
              role="header"
              style={{ numberOfLines: 1 }}
            >
              {zh() ? "前置相机与取景校准" : "Front Camera & Calibration"}
            </Text>
            <View class="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border shrink-0">
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

          <View class="flex-row items-center justify-between gap-2.5 rounded-xl bg-muted border border-border px-2.5 py-1.5">
            <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
              <View class="w-8 h-8 rounded-xl bg-card border border-border items-center justify-center shrink-0">
                <PluginVectorIcon name="eye" tone="foreground" size={16} />
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
            class="w-full h-32 rounded-xl overflow-hidden border border-border bg-secondary items-center justify-center relative"
          >
            <Each of={previewSessionIds()} key={(id) => id}>
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

            <If when={!previewSessionId() && !streaming()}>
              <View class="items-center gap-1.5 px-4">
                <PluginVectorIcon name="eye" tone="muted" size={22} />
                <Text class="text-muted-foreground text-xs font-medium text-center">
                  {zh()
                    ? "引用计数为 0 时自动关流熄灯，仅在被桌游/伴随调用或校准时开启"
                    : "Camera stays powered off until acquired by a plugin or calibration"}
                </Text>
              </View>
            </If>
            <If when={!previewSessionId() && streaming()}>
              <View
                class="absolute top-2 left-2.5 px-2 py-0.5 rounded-md bg-card/85 border border-border"
                style={{ pointerEvents: "none" }}
              >
                <Text class="text-muted-foreground text-[11px]">
                  {zh()
                    ? "后台采集中（取景预览未开启）"
                    : "Background capture (preview hidden)"}
                </Text>
              </View>
            </If>
          </View>

          <View class="flex-row items-center justify-between gap-2 flex-wrap">
            <View class="flex-row items-center gap-2 shrink-0">
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
              <ActionButton
                testID="vision-capture-portrait"
                compact
                kind="quiet"
                label={zh() ? "抓拍头像" : "Capture"}
                disabled={!enabled() || busy()}
                onPress={() => {
                  void props.ctx.sendCommand({ type: "capture_portrait" });
                }}
              />
            </View>
            <Text
              testID="vision-alignment-hint"
              class="text-muted-foreground text-xs shrink-0"
              style={{ numberOfLines: 1 }}
            >
              {alignmentHint()}
            </Text>
          </View>
        </Scroll>
      </View>

      {/* Right Column: Companion Follow + Live Telemetry + EMA / FPS Tuning */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          <View class="gap-2">
            <SwitchRow
              testID="vision-companion-follow"
              label={zh() ? "常驻跟脸伴随" : "Companion Face Follow"}
              checked={companionFollowEnabled()}
              disabled={!enabled() || busy()}
              onChange={(next) => {
                void props.ctx.sendCommand({
                  type: "set_companion_follow",
                  enabled: next,
                });
              }}
            />

            <View class="flex-row gap-2">
              <View class="flex-1 rounded-xl bg-muted border border-border px-2.5 py-2 gap-0.5">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "执行模式" : "Actuator"}
                </Text>
                <Text
                  testID="vision-actuator-mode"
                  class="text-foreground text-xs font-semibold"
                  style={{ numberOfLines: 1 }}
                >
                  {formatActuatorMode(actuatorMode(), zh())}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border px-2.5 py-2 gap-0.5">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "伴随动作" : "Motion"}
                </Text>
                <Text
                  testID="vision-tracking-status"
                  class="text-foreground text-xs font-semibold"
                  style={{ numberOfLines: 1 }}
                >
                  {formatTrackingStatus(trackingStatus(), zh())}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border px-2.5 py-2 gap-0.5">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "转向 / 俯仰" : "Turn / Pitch"}
                </Text>
                <View class="flex-row items-center gap-1">
                  <Text
                    testID="vision-commanded-turn"
                    class="text-foreground text-xs font-bold font-mono tabular-nums"
                  >
                    {commandedTurn() > 0 ? `+${commandedTurn()}` : String(commandedTurn())}
                  </Text>
                  <Text class="text-muted-foreground text-xs">/</Text>
                  <Text
                    testID="vision-commanded-pitch"
                    class="text-foreground text-xs font-bold font-mono tabular-nums"
                  >
                    {commandedPitchDegrees() !== null
                      ? `${commandedPitchDegrees()}°`
                      : "—"}
                  </Text>
                </View>
              </View>
            </View>

            <If when={Boolean(lastPortrait())}>
              <View class="flex-row items-center gap-2.5 rounded-xl bg-muted border border-border p-2">
                <Image
                  testID="vision-captured-portrait"
                  accessibilityLabel={
                    zh() ? "最近抓拍座位头像缩略图" : "Captured seat portrait thumbnail"
                  }
                  src={lastPortrait()?.dataUri ?? ""}
                  class="w-16 h-9 rounded-lg border border-border bg-secondary shrink-0"
                />
                <View class="flex-1 min-w-0 gap-0.5">
                  <Text class="text-foreground text-xs font-semibold" style={{ numberOfLines: 1 }}>
                    {zh() ? "最近抓拍座位头像（内存态）" : "Captured Seat Portrait (Memory)"}
                  </Text>
                  <Text class="text-muted-foreground text-xs font-mono" style={{ numberOfLines: 1 }}>
                    {`${lastPortrait()?.width ?? 0}×${lastPortrait()?.height ?? 0} · ${
                      lastPortrait()?.primaryTarget
                        ? zh()
                          ? "已锁定主目标"
                          : "Target locked"
                        : zh()
                          ? "未检测到人脸"
                          : "No face"
                    }`}
                  </Text>
                </View>
              </View>
            </If>
          </View>

          <View class="gap-2">
            <Text class="text-foreground text-sm font-bold" role="header">
              {zh() ? "主目标平滑读数" : "Primary Target Telemetry"}
            </Text>
            <View class="flex-row gap-2">
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "画面人数" : "Faces"}
                </Text>
                <Text
                  testID="vision-face-count"
                  class="text-foreground text-base font-bold font-mono tabular-nums"
                >
                  {String(faceCount())}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "水平偏移 X" : "Offset X"}
                </Text>
                <Text
                  testID="vision-offset-x"
                  class="text-foreground text-base font-bold font-mono tabular-nums"
                >
                  {formatSignedOffset(primaryTarget()?.offsetX)}
                </Text>
              </View>
              <View class="flex-1 rounded-xl bg-muted border border-border p-2.5 gap-1">
                <Text class="text-muted-foreground text-xs">
                  {zh() ? "垂直偏移 Y" : "Offset Y"}
                </Text>
                <Text
                  testID="vision-offset-y"
                  class="text-foreground text-base font-bold font-mono tabular-nums"
                >
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
            <PresetButtonRow
              options={ALPHA_PRESETS}
              zh={zh}
              disabled={() => !enabled() || busy()}
              isSelected={(value) => Math.abs(smoothingAlpha() - value) < 0.05}
              onSelect={(value) => {
                void props.ctx.sendCommand({
                  type: "update_settings",
                  smoothingAlpha: value,
                });
              }}
            />
          </View>

          <View class="gap-2">
            <Text class="text-foreground text-xs font-semibold" role="header">
              {zh() ? "默认追踪采样帧率" : "Default Tracking Frame Rate"}
            </Text>
            <PresetButtonRow
              options={FPS_PRESETS}
              zh={zh}
              disabled={() => !enabled() || busy()}
              isSelected={(value) => maxFps() === value}
              onSelect={(value) => {
                void props.ctx.sendCommand({
                  type: "update_settings",
                  maxFps: value,
                });
              }}
            />
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
