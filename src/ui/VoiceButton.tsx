import { useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Animated,
  useColorScheme,
} from "react-native";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";
import { voicePerceiver } from "../perceivers/voice-perceiver";

export function VoiceButton() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isListening = useConversationStore((s) => s.isListening);
  const isProcessing = useConversationStore((s) => s.isProcessing);
  const voiceState = useUserStore((s) => s.voiceState);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const isActive = isListening || isProcessing;
  const disabled = isProcessing || voiceState === "speaking";

  const handlePressIn = () => {
    if (disabled) return;

    Animated.spring(scaleAnim, {
      toValue: 0.9,
      useNativeDriver: true,
    }).start();

    // Trigger voice perceiver
    voicePerceiver.trigger();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
    }).start();

    if (isListening) {
      // Stop listening and process
      voicePerceiver.finishListening();
    }
  };

  const getButtonColor = () => {
    if (isListening) return "#EF4444"; // Red when recording
    if (isProcessing) return "#F59E0B"; // Amber when processing
    return isDark ? "#7C3AED" : "#6D28D9"; // Purple default
  };

  const getLabel = () => {
    if (isListening) return "松开结束";
    if (isProcessing) return "处理中...";
    if (voiceState === "speaking") return "播报中...";
    return "按住说话";
  };

  return (
    <View style={styles.container}>
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={disabled}
          style={[styles.button, { backgroundColor: getButtonColor(), opacity: disabled ? 0.6 : 1 }]}
        >
          <Text style={styles.buttonIcon}>{isListening ? "🎙️" : "🎤"}</Text>
        </Pressable>
      </Animated.View>
      <Text style={[styles.label, { color: isDark ? "#9CA3AF" : "#6B7280" }]}>
        {getLabel()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", gap: 8 },
  button: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#6D28D9",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  buttonIcon: { fontSize: 28 },
  label: { fontSize: 13 },
});
