import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useConversationStore } from "@/src/store/conversation";
import { looiTheme } from "@/src/ui/looi-theme";

const IDLE_HIDE_DELAY_MS = 3000;

export function ConversationOverlay() {
  const currentTranscript = useConversationStore((state) => state.currentTranscript);
  const streamingText = useConversationStore((state) => state.streamingText);
  const overlayVisible = useConversationStore((state) => state.overlayVisible);
  const isListening = useConversationStore((state) => state.isListening);
  const isProcessing = useConversationStore((state) => state.isProcessing);
  const isSpeaking = useConversationStore((state) => state.isSpeaking);
  const setOverlayVisible = useConversationStore((state) => state.setOverlayVisible);
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(18);

  const shouldShow =
    overlayVisible ||
    isListening ||
    isProcessing ||
    isSpeaking;

  useEffect(() => {
    opacity.value = withTiming(shouldShow ? 1 : 0, { duration: shouldShow ? 180 : 260 });
    translateY.value = withTiming(shouldShow ? 0 : 18, { duration: shouldShow ? 180 : 260 });
  }, [opacity, shouldShow, translateY]);

  useEffect(() => {
    if (isListening || isProcessing || isSpeaking || !shouldShow) {
      return;
    }

    const timer = setTimeout(() => setOverlayVisible(false), IDLE_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isListening, isProcessing, isSpeaking, setOverlayVisible, shouldShow]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const status = getStatusLabel({ isListening, isProcessing, isSpeaking });
  const assistantText = streamingText || getFallbackAssistantText({ isListening, isProcessing });

  return (
    <Animated.View pointerEvents="none" style={[styles.overlay, animatedStyle]}>
      <View style={styles.panel}>
        <View style={styles.statusRow}>
          <View style={styles.liveDot} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
        {currentTranscript ? (
          <Text numberOfLines={2} style={styles.userText}>
            {currentTranscript}
          </Text>
        ) : null}
        <Text numberOfLines={4} style={styles.assistantText}>
          {assistantText}
        </Text>
      </View>
    </Animated.View>
  );
}

function getStatusLabel({
  isListening,
  isProcessing,
  isSpeaking,
}: {
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
}): string {
  if (isListening) return "正在聆听";
  if (isProcessing) return "正在理解";
  if (isSpeaking) return "LOOI";
  return "对话";
}

function getFallbackAssistantText({
  isListening,
  isProcessing,
}: {
  isListening: boolean;
  isProcessing: boolean;
}): string {
  if (isListening) return "说吧，我在听。";
  if (isProcessing) return "我在整理刚才的信息。";
  return "";
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 42,
    alignItems: "center",
  },
  panel: {
    width: "100%",
    maxWidth: 680,
    minHeight: 112,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(2, 8, 14, 0.86)",
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: "center",
    boxShadow: "0 0 26px rgba(40, 213, 255, 0.18)",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: looiTheme.cyan,
  },
  statusText: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "800",
  },
  userText: {
    color: "rgba(237, 247, 255, 0.66)",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  assistantText: {
    minHeight: 32,
    color: looiTheme.text,
    fontSize: 23,
    lineHeight: 32,
    fontWeight: "700",
    textAlign: "center",
  },
});
