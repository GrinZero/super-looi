import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { BrightnessGesture } from "../brightness-gesture.js";
import { LOOI_PALETTE as P } from "../theme.js";

interface BrightnessSliderBarProps {
  value: number;
  compact?: boolean;
  disabled?: boolean;
  inactive?: boolean;
  label: string;
  onChange: (brightness: number) => void;
  onDragStateChange?: (dragging: boolean) => void;
}

const quickSteps = [20, 40, 60, 80, 100] as const;
const clamp = (value: number) => Math.max(1, Math.min(255, Math.round(value)));

/** A tap commits once; horizontal drags preview, while vertical gestures remain scrolls. */
export function BrightnessSliderBar({ value, disabled = false, inactive = false, label, onChange, onDragStateChange, compact = false }: BrightnessSliderBarProps): ReactElement {
  const [dragPct, setDragPct] = useState<number | null>(null);
  const trackWidth = useRef(1);
  const session = useRef(new BrightnessGesture());
  const dragging = useRef(false);
  const latest = useRef({ disabled, onChange, onDragStateChange });
  useEffect(() => {
    latest.current = { disabled, onChange, onDragStateChange };
  }, [disabled, onChange, onDragStateChange]);
  const shown = dragPct ?? value;
  const percent = Math.max(1, Math.round(shown / 255 * 100));
  const dimmed = inactive && dragPct === null;

  function setDragging(next: boolean) {
    if (dragging.current === next) return;
    dragging.current = next;
    latest.current.onDragStateChange?.(next);
  }
  function cancelDrag() {
    session.current.cancel();
    setDragPct(null);
    setDragging(false);
  }
  function release(event: GestureResponderEvent) {
    const target = session.current.release(event.nativeEvent.pageX, event.nativeEvent.pageY, trackWidth.current);
    setDragPct(null);
    setDragging(false);
    if (!latest.current.disabled && target !== null) latest.current.onChange(target);
  }

  useEffect(() => { if (disabled) cancelDrag(); }, [disabled]);
  useEffect(() => () => {
    session.current.cancel();
    if (dragging.current) latest.current.onDragStateChange?.(false);
  }, []);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => !latest.current.disabled && session.current.canClaim(gesture.dx, gesture.dy),
    onMoveShouldSetPanResponderCapture: (_, gesture) => !latest.current.disabled && session.current.canClaim(gesture.dx, gesture.dy),
    onPanResponderGrant: (event) => {
      if (latest.current.disabled) { cancelDrag(); return; }
      session.current.claim();
      if (!session.current.isHorizontalDrag) return;
      setDragging(true);
      setDragPct(session.current.targetAt(event.nativeEvent.pageX, trackWidth.current));
    },
    onPanResponderMove: (event) => {
      session.current.move(event.nativeEvent.pageX, event.nativeEvent.pageY);
      if (latest.current.disabled || session.current.cancelled) { cancelDrag(); return; }
      setDragPct(session.current.targetAt(event.nativeEvent.pageX, trackWidth.current));
    },
    onPanResponderRelease: release,
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: cancelDrag,
  }), []);

  return <View style={[styles.control, compact && styles.compactControl, dimmed && styles.dimmed, disabled && styles.disabled]}>
    {!compact && <View style={styles.heading}><Text style={styles.label}>亮度{dragPct !== null ? " · 调节目标" : dimmed ? " · 开启后生效" : ""}</Text><Text style={[styles.value, dimmed && styles.valueDimmed]}>{percent}%<Text style={styles.raw}> · {shown}/255</Text></Text></View>}
    <View style={compact && styles.compactSliderRow}>
      <View
        {...panResponder.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 1, max: 255, now: shown, text: `${percent}%` }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: "increment", label: "提高亮度" }, { name: "decrement", label: "降低亮度" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (!disabled && (nativeEvent.actionName === "increment" || nativeEvent.actionName === "decrement")) onChange(clamp(value + (nativeEvent.actionName === "increment" ? 51 : -51)));
        }}
        onLayout={({ nativeEvent }) => { trackWidth.current = Math.max(1, nativeEvent.layout.width); }}
        onTouchStart={(event) => {
          if (latest.current.disabled || event.nativeEvent.touches.length > 1) { cancelDrag(); return; }
          session.current.start(event.nativeEvent.pageX, event.nativeEvent.pageY, event.nativeEvent.locationX);
        }}
        onTouchMove={(event) => {
          session.current.move(event.nativeEvent.pageX, event.nativeEvent.pageY);
          if (session.current.cancelled || event.nativeEvent.touches.length > 1) cancelDrag();
        }}
        onTouchEnd={(event) => {
          // The responder owns drag release; this path handles only stationary taps.
          if (!session.current.isHorizontalDrag) release(event);
        }}
        onTouchCancel={cancelDrag}
        style={[styles.touchTrack, compact && styles.compactTouchTrack]}
      >
        <View pointerEvents="none" style={[styles.track, compact && styles.compactTrack]}>
          <View style={[styles.fill, dimmed && styles.fillDimmed, { width: `${Math.max(1, percent)}%` }]} />
          <View style={[styles.thumb, compact && styles.compactThumb, dimmed && styles.thumbDimmed, dragPct !== null && styles.thumbDragging, { left: `${Math.min(97, Math.max(3, percent))}%` }]} />
        </View>
      </View>
      {compact && <Text pointerEvents="none" style={[styles.value, styles.compactValue]}>{percent}%</Text>}
    </View>
    <View style={[styles.steps, compact && styles.compactSteps]}>{quickSteps.map((step) => {
      const active = !dimmed && Math.abs(percent - step) <= 2;
      return <Pressable
        key={step}
        hitSlop={compact ? { top: 6, bottom: 6 } : undefined}
        accessibilityRole="button"
        accessibilityLabel={`${label}设为 ${step}%`}
        accessibilityState={{ selected: active, disabled }}
        disabled={disabled}
        onPress={() => onChange(Math.round(step / 100 * 255))}
        style={({ pressed }) => [styles.step, compact && styles.compactStep, active && styles.stepActive, pressed && styles.pressed]}
      ><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.stepText, compact && styles.compactStepText, active && styles.stepTextActive]}>{step}%</Text></Pressable>;
    })}</View>
  </View>;
}

const styles = StyleSheet.create({
  compactControl: { gap: 4 },
  compactSliderRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  compactTouchTrack: { flex: 1, minWidth: 120, minHeight: 32, justifyContent: "center" },
  compactValue: { fontSize: 13, lineHeight: 16, minWidth: 36, textAlign: "right", fontWeight: "700" },
  compactTrack: { height: 12, borderRadius: 6 },
  compactThumb: { width: 18, height: 18, marginLeft: -9, borderRadius: 9 },
  compactSteps: { flexDirection: "row", gap: 6, minHeight: 32, paddingVertical: 2 },
  compactStep: { flex: 1, minHeight: 28, minWidth: 44, borderRadius: 8 },
  compactStepText: { fontSize: 10.5, fontWeight: "600" },
  control: { gap: 4 },
  dimmed: { opacity: 0.68 },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  label: { color: P.textSecondary, fontSize: 12 },
  value: { color: P.presenceCyan, fontSize: 18, fontWeight: "600", fontVariant: ["tabular-nums"] },
  valueDimmed: { color: P.textSecondary },
  raw: { color: P.textMuted, fontSize: 12, fontWeight: "400" },
  touchTrack: { minHeight: 44, justifyContent: "center" },
  track: { height: 16, borderRadius: 8, backgroundColor: "#081420", borderWidth: 1, borderColor: "rgba(40,213,255,0.18)", justifyContent: "center" },
  fill: { position: "absolute", height: "100%", borderRadius: 7, experimental_backgroundImage: "linear-gradient(90deg, #0E5A94 0%, #28D5FF 100%)", boxShadow: "0 0 12px 0 rgba(40,213,255,0.3)" },
  fillDimmed: { experimental_backgroundImage: "linear-gradient(90deg, rgba(30, 58, 82, 0.55) 0%, rgba(72, 118, 148, 0.65) 100%)", boxShadow: "none" },
  thumb: { position: "absolute", width: 20, height: 20, marginLeft: -10, borderRadius: 10, backgroundColor: "#E4FAFF", borderWidth: 2, borderColor: P.presenceCyan, boxShadow: "0 0 10px 0 rgba(40,213,255,0.65)" },
  thumbDimmed: { backgroundColor: "#94A3B8", borderColor: "rgba(148, 163, 184, 0.55)", boxShadow: "none" },
  thumbDragging: { transform: [{ scale: 1.15 }] },
  steps: { flexDirection: "row", gap: 6 },
  step: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, borderColor: "rgba(122,170,191,0.16)", backgroundColor: "rgba(12, 26, 40, 0.65)" },
  stepActive: { borderColor: P.presenceCyan, backgroundColor: "rgba(40,213,255,0.16)", boxShadow: "inset 0 0 8px rgba(40,213,255,0.12)" },
  stepText: { color: P.textSecondary, fontSize: 11, fontVariant: ["tabular-nums"] },
  stepTextActive: { color: P.presenceCyan, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
});
