import { Image } from "expo-image";
import { View, Text, StyleSheet } from "react-native";
import { ChatMessage } from "../store/conversation";

interface ChatBubbleProps {
  message: ChatMessage;
  isDark: boolean;
}

export function ChatBubble({ message, isDark }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      <View
        style={[
          styles.bubble,
          isUser
            ? { backgroundColor: isDark ? "#6D28D9" : "#7C3AED" }
            : { backgroundColor: isDark ? "#1F2937" : "#FFFFFF" },
        ]}
      >
        <Text
          style={[
            styles.text,
            { color: isUser ? "#FFFFFF" : isDark ? "#F9FAFB" : "#111827" },
          ]}
        >
          {message.content}
        </Text>
        {message.evidenceUri && (
          <Image source={{ uri: message.evidenceUri }} style={styles.evidenceImage} />
        )}
      </View>
      <Text style={[styles.timestamp, { color: isDark ? "#6B7280" : "#9CA3AF" }]}>
        {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 4 },
  userContainer: { alignItems: "flex-end" },
  assistantContainer: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  },
  text: { fontSize: 15, lineHeight: 22 },
  evidenceImage: {
    width: 220,
    height: 140,
    borderRadius: 8,
    marginTop: 8,
    backgroundColor: "#E5E7EB",
  },
  timestamp: { fontSize: 11, marginTop: 4, paddingHorizontal: 4 },
});
