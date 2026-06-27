import { useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  FlatList,
  Text,
  useColorScheme,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useConversationStore, ChatMessage } from "@/src/store/conversation";
import { useUserStore } from "@/src/store/user";
import { VoiceButton } from "@/src/ui/VoiceButton";
import { ChatBubble } from "@/src/ui/ChatBubble";
import { CameraFrameFeeder } from "@/src/ui/CameraFrameFeeder";

export default function ChatScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const messages = useConversationStore((s) => s.messages);
  const isProcessing = useConversationStore((s) => s.isProcessing);
  const isListening = useConversationStore((s) => s.isListening);
  const voiceState = useUserStore((s) => s.voiceState);
  const flatListRef = useRef<FlatList>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messages.length > 0) {
      const timer = setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      return () => clearTimeout(timer);
    }
  }, [messages.length]);

  const renderMessage = ({ item }: { item: ChatMessage }) => (
    <ChatBubble message={item} isDark={isDark} />
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? "#111827" : "#F9FAFB" }]}>
      <CameraFrameFeeder />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Status indicator */}
        <View style={styles.statusBar}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: voiceState === "sleeping" ? "#10B981" : "#F59E0B" },
            ]}
          />
          <Text style={[styles.statusText, { color: isDark ? "#9CA3AF" : "#6B7280" }]}>
            {voiceState === "sleeping" && "待命中"}
            {voiceState === "listening" && "聆听中..."}
            {voiceState === "processing" && "思考中..."}
            {voiceState === "speaking" && "播报中..."}
            {voiceState === "verifying" && "验证中..."}
          </Text>
        </View>

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: isDark ? "#F9FAFB" : "#111827" }]}>
                👋 嗨，我是 LOOI
              </Text>
              <Text style={[styles.emptySubtitle, { color: isDark ? "#9CA3AF" : "#6B7280" }]}>
                按住下方按钮说话，我会帮你记住事情
              </Text>
            </View>
          }
        />

        {/* Voice button */}
        <View style={styles.voiceArea}>
          <VoiceButton />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: { fontSize: 13 },
  messageList: { flex: 1 },
  messageListContent: { paddingHorizontal: 16, paddingBottom: 16 },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 120,
  },
  emptyTitle: { fontSize: 24, fontWeight: "bold", marginBottom: 8 },
  emptySubtitle: { fontSize: 15, textAlign: "center", paddingHorizontal: 32 },
  voiceArea: {
    paddingVertical: 20,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5E7EB",
  },
});
