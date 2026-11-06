import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import type { FaceExpression } from "../../shell/presence-state.js";
import { LOOI_PALETTE as palette } from "../theme.js";
import { LooiBrandMark, LooiWaveOrnament } from "./LooiIcon.js";

type VisualExpression = FaceExpression | "happy" | "skeptical";
export interface RobotFaceViewProps {
  mode: "fullscreen" | "avatar";
  expression: VisualExpression;
  /** Controller coordinates: -1 is left/down, +1 is right/up. */
  gaze: { x: number; y: number };
  /** Zero is fully open and one is fully closed. */
  blinkProgress: number;
  /** Normalized real microphone/TTS amplitudes. No synthetic audio is generated. */
  waveformBars: number[];
  /** Logical-pixel OLED offset, clamped independently to [-6, 6]. */
  microShift: { dx: number; dy: number };
  drawerOpen?: boolean;
  onPress?: () => void;
}

const FACE_WIDTH = 620;
const FACE_HEIGHT = 340;
const EYE_LEFT = [38, 398] as const;
const TEXTURE_COLUMNS = 39;
const TEXTURE_ROWS = 21;
const TEXTURE_DOTS = Array.from({ length: TEXTURE_COLUMNS * TEXTURE_ROWS }, (_, index) => index);
const EXPRESSION_LABEL: Record<VisualExpression, string> = {
  neutral: "安静陪伴", listening: "正在聆听", thinking: "正在思考", speaking: "正在说话",
  curious: "好奇观察", sleeping: "隐私休眠", alarmed: "警示状态", happy: "开心陪伴", skeptical: "有些疑惑",
};

interface EyePosture {
  scale: number;
  dx: number;
  dy: number;
  browAngle?: number;
  browLift?: number;
}

/** Pure-circle kinematics: expressions vary circle radius, posture, and outer brow arcs without elliptical squash. */
function getEyePosture(expression: VisualExpression, index: number): EyePosture {
  switch (expression) {
    case "listening":
      return { scale: 1.06, dx: 0, dy: -4, browAngle: index === 0 ? -4 : 4, browLift: -4 };
    case "speaking":
      return { scale: 1.03, dx: 0, dy: -2 };
    case "curious":
      return index === 0
        ? { scale: 0.86, dx: 4, dy: 4, browAngle: -4, browLift: 2 }
        : { scale: 1.08, dx: -2, dy: -6, browAngle: 8, browLift: -8 };
    case "thinking":
      return index === 0
        ? { scale: 0.9, dx: -6, dy: -7, browAngle: -10, browLift: -3 }
        : { scale: 0.94, dx: -6, dy: -10, browAngle: 4, browLift: -7 };
    case "happy":
      return { scale: 1.05, dx: 0, dy: -5, browAngle: index === 0 ? -5 : 5, browLift: -6 };
    case "skeptical":
      return index === 0
        ? { scale: 0.84, dx: 3, dy: 5, browAngle: -12, browLift: 3 }
        : { scale: 1.05, dx: -2, dy: -5, browAngle: 7, browLift: -7 };
    case "alarmed":
      return { scale: 0.95, dx: 0, dy: -3, browAngle: index === 0 ? 15 : -15, browLift: -5 };
    case "sleeping":
    case "neutral":
    default:
      return { scale: 1, dx: 0, dy: 0 };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : 0;
}

function resonanceLevels(bars: number[]): number[] {
  if (bars.length === 0) return Array<number>(7).fill(0);
  return Array.from({ length: 7 }, (_, index) => {
    const position = index / 6 * (bars.length - 1);
    const lower = Math.floor(position);
    const weight = position - lower;
    const first = clamp(bars[lower] ?? 0, 0, 1);
    return first + (clamp(bars[Math.min(lower + 1, bars.length - 1)] ?? 0, 0, 1) - first) * weight;
  });
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduced(enabled);
    }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return reduced;
}

function useBreathingLight(active: boolean, reduced: boolean): Animated.Value {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || !active) { progress.setValue(0); return; }
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 3100, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
      Animated.timing(progress, { toValue: 0, duration: 3100, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start();
    return () => { animation.stop(); progress.stopAnimation(); };
  }, [active, progress, reduced]);
  return progress;
}

function Smile({ compact = false, wide = false, color, offsetX = 0, offsetY = 0 }: {
  compact?: boolean; wide?: boolean; color: string; offsetX?: number; offsetY?: number;
}) {
  return <View style={[styles.smileClip, compact ? styles.smileClipCompact : wide ? styles.smileClipWide : null,
    { transform: [{ translateX: offsetX }, { translateY: offsetY }] }]}>
    <View style={{ width: compact ? 48 : wide ? 124 : 112, height: compact ? 48 : wide ? 124 : 112,
      borderRadius: compact ? 24 : wide ? 62 : 56, borderWidth: compact ? 2.8 : 5, borderColor: color, flexShrink: 0 }} />
  </View>;
}

function FaceTexture() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    {TEXTURE_DOTS.map((index) => <View key={index} style={[styles.textureDot, {
      left: `${((index % TEXTURE_COLUMNS) + 0.5) * (100 / TEXTURE_COLUMNS)}%`,
      top: `${(Math.floor(index / TEXTURE_COLUMNS) + 0.5) * (100 / TEXTURE_ROWS)}%`,
    }]} />)}
  </View>;
}

function Eye({ closed, blink, color, expression, gazeX, gazeY, index, reduced }: {
  closed: boolean; blink: number; color: string; expression: VisualExpression;
  gazeX: number; gazeY: number; index: number; reduced: boolean;
}) {
  const posture = getEyePosture(expression, index);
  const scaleAnim = useRef(new Animated.Value(posture.scale)).current;
  const shiftAnim = useRef(new Animated.ValueXY({ x: posture.dx, y: posture.dy })).current;
  useEffect(() => {
    if (reduced) {
      scaleAnim.setValue(posture.scale);
      shiftAnim.setValue({ x: posture.dx, y: posture.dy });
      return;
    }
    const animation = Animated.parallel([
      Animated.spring(scaleAnim, { toValue: posture.scale, friction: 7, tension: 70, useNativeDriver: true, isInteraction: false }),
      Animated.timing(shiftAnim, { toValue: { x: posture.dx, y: posture.dy }, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true, isInteraction: false }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [posture.dx, posture.dy, posture.scale, reduced, scaleAnim, shiftAnim]);

  if (closed) return <View style={[styles.closedEye, { backgroundColor: color }]} />;
  // Uniform circular scale preserves a 1:1 circle at every blink and expression frame.
  const blinkScale = 1 - blink * 0.08;
  const blinkOpacity = 1 - blink * 0.32;
  return <Animated.View style={[styles.eyePostureWrap, {
    opacity: blinkOpacity,
    transform: [...shiftAnim.getTranslateTransform(), { scale: Animated.multiply(scaleAnim, blinkScale) }],
  }]}>
    {posture.browAngle !== undefined && <View style={[styles.browArc, {
      borderColor: color,
      transform: [{ translateY: posture.browLift ?? 0 }, { rotate: `${posture.browAngle}deg` }],
    }]} />}
    <View style={[styles.eyeOrb, expression === "alarmed" && styles.alarmedEye]}>
      <View style={[styles.eyeSpecular, { transform: [{ translateX: gazeX * 6 }, { translateY: gazeY * 5 }] }]} />
      {(expression === "happy" || expression === "curious" || expression === "listening") && (
        <View style={[styles.eyeSparkle, { transform: [{ translateX: gazeX * 4 }, { translateY: gazeY * 4 }] }]} />
      )}
    </View>
  </Animated.View>;
}

/** Native gradient and shadow rendering requires the prebuilt RN New Architecture. */
export function RobotFaceView({ mode, expression, gaze, blinkProgress, waveformBars, microShift,
  drawerOpen = false, onPress }: RobotFaceViewProps) {
  const { width, height } = useWindowDimensions();
  const sleeping = expression === "sleeping";
  const alarmed = expression === "alarmed";
  const blink = clamp(blinkProgress, 0, 1);
  const closed = sleeping || blink >= 0.98;
  const color = alarmed ? palette.emergencyCoral : palette.presenceCyan;
  const gazeX = clamp(gaze.x, -1, 1);
  const gazeY = -clamp(gaze.y, -1, 1);
  const shift = { transform: [{ translateX: clamp(microShift.dx, -6, 6) }, { translateY: clamp(microShift.dy, -6, 6) }] };
  const reduced = useReducedMotion();
  const avatarGaze = useRef(new Animated.ValueXY({ x: gazeX * 4, y: gazeY * 3 })).current;
  useEffect(() => {
    if (mode !== "avatar") return;
    const target = { x: gazeX * 4, y: gazeY * 3 };
    if (reduced) { avatarGaze.setValue(target); return; }
    const animation = Animated.timing(avatarGaze, {
      toValue: target, duration: 180, easing: Easing.out(Easing.cubic),
      useNativeDriver: true, isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [avatarGaze, gazeX, gazeY, mode, reduced]);
  const breathing = useBreathingLight(mode === "fullscreen" && !sleeping && !alarmed, reduced);
  const drawer = useRef(new Animated.Value(drawerOpen ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { drawer.setValue(drawerOpen ? 1 : 0); return; }
    const animation = Animated.timing(drawer, { toValue: drawerOpen ? 1 : 0, duration: 320,
      easing: Easing.inOut(Easing.cubic), useNativeDriver: true, isInteraction: false });
    animation.start();
    return () => animation.stop();
  }, [drawer, drawerOpen, reduced]);
  const levels = resonanceLevels(waveformBars);
  const showWaveform = (expression === "listening" || expression === "speaking") && levels.some((level) => level > 0.06);
  const scale = Math.min(1.08, Math.max(0.58, Math.min((width - 32) / 620, (height - 80) / 340)));

  if (mode === "avatar") return <Pressable accessibilityRole={onPress ? "button" : "image"}
    accessibilityLabel={`LOOI，${EXPRESSION_LABEL[expression]}${onPress ? "，返回大脸" : ""}`}
    onPress={onPress} disabled={!onPress}
    style={({ pressed }) => [styles.avatar, { opacity: pressed ? 0.78 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
    <View pointerEvents="none" accessible={false} style={[styles.avatarGeometry, shift]}>
      <View style={[styles.earPod, styles.earPodLeft]} /><View style={[styles.earPod, styles.earPodRight]} />
      <View style={styles.helmet} /><View style={styles.visor} />
      <View style={[styles.sideLamp, styles.sideLampLeft, { backgroundColor: color }]} />
      <View style={[styles.sideLamp, styles.sideLampRight, { backgroundColor: color }]} />
      <View style={styles.topModule}>
        <LooiWaveOrnament bars={7} size={4} color={color} />
        <LooiBrandMark size={11} color={color} />
        <LooiWaveOrnament bars={7} size={4} color={color} />
      </View>
      <Animated.View style={[styles.avatarFace, { transform: avatarGaze.getTranslateTransform() }]}>
        {[0, 1].map((index) => {
          const miniPosture = getEyePosture(expression, index);
          return closed ? (
            <View key={index} style={[styles.closedMiniEye, { left: index === 0 ? 1 : 53, backgroundColor: color }]} />
          ) : (
            <View key={index} style={[styles.miniEye, {
              left: index === 0 ? 0 : 52, backgroundColor: color, opacity: 1 - blink * 0.3,
              transform: [{ translateY: miniPosture.dy * 0.25 }, { scale: miniPosture.scale * (1 - blink * 0.08) }],
            }, alarmed && styles.alarmedMiniEye]} />
          );
        })}
        <View style={styles.miniMouth}><Smile compact color={color} /></View>
      </Animated.View>
    </View>
  </Pressable>;

  return <Pressable accessibilityRole={onPress ? "button" : "image"}
    accessibilityLabel={`LOOI，${EXPRESSION_LABEL[expression]}${onPress ? "，轻触打开快捷功能" : ""}`}
    onPress={onPress} disabled={!onPress} style={styles.fullscreen}>
    <FaceTexture />
    <View pointerEvents="none" accessible={false} style={shift}>
      <Animated.View style={{ transform: [
        { translateY: drawer.interpolate({ inputRange: [0, 1], outputRange: [0, height < 430 ? -112 : height < 480 ? -90 : -46] }) },
        { scale: drawer.interpolate({ inputRange: [0, 1], outputRange: [scale, scale * (height < 480 ? 0.56 : 0.72)] }) },
      ] }}>
        <View style={styles.faceCanvas}>
          <Animated.View style={[styles.atmosphere, alarmed && styles.alarmedAtmosphere, {
            opacity: sleeping ? 0.12 : breathing.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
          }]} />
          {EYE_LEFT.map((left, index) => <View key={left} style={[styles.eyeAssembly, { left,
            transform: [{ translateX: gazeX * 10 }, { translateY: gazeY * 9 }],
          }]}><Eye closed={closed} blink={blink} color={color} expression={expression} gazeX={gazeX} gazeY={gazeY} index={index} reduced={reduced} /></View>)}
          <View style={[styles.mouth, { transform: [{ translateX: gazeX * 4 }, { translateY: gazeY * 3 }] }]}>
            {showWaveform ? <View style={styles.waveform}>
              {levels.map((level, index) => <View key={index} style={[styles.waveBar, { height: 4 + level * 32, backgroundColor: color }]} />)}
            </View> : expression === "thinking" || sleeping ? <View style={[styles.thinkingMouth, { backgroundColor: color, opacity: sleeping ? 0.28 : 0.9 }]} />
              : alarmed ? <View style={[styles.alarmedMouth, { borderColor: color }]} />
              : <Smile color={color} wide={expression === "happy"} offsetX={expression === "curious" ? 3 : 0} offsetY={expression === "curious" ? -1 : 0} />}
          </View>
        </View>
      </Animated.View>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  fullscreen: { flex: 1, width: "100%", minHeight: 180, alignItems: "center", justifyContent: "center", overflow: "hidden", backgroundColor: "#02050A" },
  faceCanvas: { width: FACE_WIDTH, height: FACE_HEIGHT },
  textureDot: { position: "absolute", width: 1.5, height: 1.5, borderRadius: 1, backgroundColor: palette.presenceCyan, opacity: 0.055 },
  atmosphere: { position: "absolute", left: -100, top: -70, width: 820, height: 460,
    experimental_backgroundImage: "radial-gradient(ellipse at 28% 45%, rgba(0, 96, 255, 0.2) 0%, rgba(0, 74, 220, 0.07) 32%, transparent 62%), radial-gradient(ellipse at 72% 45%, rgba(0, 96, 255, 0.2) 0%, rgba(0, 74, 220, 0.07) 32%, transparent 62%)" },
  alarmedAtmosphere: { experimental_backgroundImage: "radial-gradient(ellipse at 50% 45%, rgba(255, 100, 90, 0.16) 0%, transparent 65%)" },
  eyeAssembly: { position: "absolute", top: 66, width: 184, height: 184, justifyContent: "center", alignItems: "center" },
  eyePostureWrap: { width: 184, height: 184, justifyContent: "center", alignItems: "center" },
  browArc: { position: "absolute", top: -22, width: 96, height: 18, borderTopWidth: 4, borderRadius: 48, opacity: 0.68 },
  eyeOrb: { width: 184, height: 184, borderRadius: 92, overflow: "hidden", backgroundColor: "#1DC4FF",
    experimental_backgroundImage: "radial-gradient(circle at 50% 38%, #48E5FF 0%, #29D0FF 68%, #0E84FF 92%, #0051FF 100%)",
    boxShadow: "0 0 58px 14px rgba(40, 213, 255, 0.42), inset 0 -5px 0 0 #0051FF, inset 0 -12px 16px rgba(0, 88, 255, 0.45)" },
  alarmedEye: { backgroundColor: palette.emergencyCoral,
    experimental_backgroundImage: "linear-gradient(180deg, #FFB094 0%, #FF786B 78%, #D33641 100%)",
    boxShadow: "0 0 58px 14px rgba(255, 120, 107, 0.36), inset 0 -10px 0 0 #D33641" },
  eyeSpecular: { position: "absolute", left: 40, top: 26, width: 38, height: 38, borderRadius: 19,
    experimental_backgroundImage: "radial-gradient(circle, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0) 72%)" },
  eyeSparkle: { position: "absolute", right: 44, bottom: 38, width: 16, height: 16, borderRadius: 8,
    experimental_backgroundImage: "radial-gradient(circle, rgba(255, 255, 255, 0.28) 0%, rgba(255, 255, 255, 0) 75%)" },
  closedEye: { width: 156, height: 4, borderRadius: 3, opacity: 0.4, boxShadow: "0 0 12px 0 rgba(40, 213, 255, 0.35)" },
  mouth: { position: "absolute", left: 262, top: 242, width: 96, height: 42, alignItems: "center", justifyContent: "center" },
  smileClip: { width: 68, height: 20, overflow: "hidden", alignItems: "center", justifyContent: "flex-end" },
  smileClipWide: { width: 78, height: 24 },
  smileClipCompact: { width: 28, height: 10 },
  thinkingMouth: { width: 34, height: 4, borderRadius: 3 },
  alarmedMouth: { width: 24, height: 24, borderWidth: 4, borderRadius: 12 },
  waveform: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  waveBar: { width: 3, borderRadius: 3, boxShadow: "0 0 7px 0 rgba(40, 213, 255, 0.4)" },
  avatar: { width: 148, height: 82, alignItems: "center", justifyContent: "center" },
  avatarGeometry: { width: 148, height: 82 },
  helmet: { position: "absolute", left: 6, top: 5, width: 136, height: 75, borderRadius: 34,
    borderWidth: 1, borderColor: "#35506B", backgroundColor: "#132030",
    experimental_backgroundImage: "linear-gradient(155deg, #36516D 0%, #132030 24%, #08101A 68%, #1B2A3D 100%)",
    boxShadow: "0 0 18px 0 rgba(0, 100, 255, 0.22), inset 0 1px 1px 0 rgba(143, 193, 235, 0.35), inset 0 -4px 6px 0 #03080E" },
  visor: { position: "absolute", left: 17, top: 17, width: 114, height: 55, borderRadius: 26,
    backgroundColor: "#02050A", borderWidth: 1.5, borderColor: "#263A4B",
    boxShadow: "0 1px 1px 0 rgba(110, 164, 199, 0.16), inset 0 4px 8px 2px #000000" },
  earPod: { position: "absolute", top: 29, width: 13, height: 34, borderRadius: 10, backgroundColor: "#08101A", borderWidth: 1, borderColor: "#1D344D",
    experimental_backgroundImage: "linear-gradient(90deg, #02050A, #1A2D41, #040910)" },
  earPodLeft: { left: 0 }, earPodRight: { right: 0 },
  sideLamp: { position: "absolute", top: 37, width: 2, height: 19, borderRadius: 2, boxShadow: "0 0 8px 1px #009DFF" },
  sideLampLeft: { left: 4 }, sideLampRight: { right: 4 },
  topModule: { position: "absolute", top: 2, left: 48, width: 52, height: 13, borderRadius: 7,
    borderWidth: 1, borderColor: "#31465D", backgroundColor: "#030910", flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center",
    boxShadow: "0 2px 3px 0 #000000, inset 0 1px 1px 0 #253B50" },
  avatarFace: { position: "absolute", left: 36, top: 34, width: 76, height: 32 },
  miniEye: { position: "absolute", top: 0, width: 24, height: 24, borderRadius: 12,
    experimental_backgroundImage: "linear-gradient(180deg, #3BE2FF, #1DC4FF 80%, #0058FF)",
    boxShadow: "0 0 10px 2px rgba(0, 162, 255, 0.35), inset 0 -1px 0 0 #004CFF" },
  closedMiniEye: { position: "absolute", top: 10, width: 22, height: 3, borderRadius: 2, opacity: 0.45 },
  alarmedMiniEye: { experimental_backgroundImage: "linear-gradient(180deg, #FFB094, #FF786B)", boxShadow: "0 0 10px 2px rgba(255, 120, 107, 0.35)" },
  miniMouth: { position: "absolute", left: 31, top: 22, width: 14, height: 7, alignItems: "center", justifyContent: "center" },
});
