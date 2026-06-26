import { View, Text, StyleSheet } from "react-native";
import { MemoryResult } from "../core/context-service";

interface MemoryCardProps {
  memory: MemoryResult;
  isDark: boolean;
}

export function MemoryCard({ memory, isDark }: MemoryCardProps) {
  const categoryLabel = getCategoryLabel(memory.metadata?.category);
  const timeStr = memory.metadata?.timestamp
    ? new Date(memory.metadata.timestamp).toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <View style={[styles.card, { backgroundColor: isDark ? "#1F2937" : "#FFFFFF" }]}>
      <View style={styles.header}>
        <View style={[styles.categoryBadge, { backgroundColor: getCategoryColor(memory.metadata?.category) }]}>
          <Text style={styles.categoryText}>{categoryLabel}</Text>
        </View>
        <Text style={[styles.time, { color: isDark ? "#6B7280" : "#9CA3AF" }]}>{timeStr}</Text>
      </View>
      <Text style={[styles.content, { color: isDark ? "#F9FAFB" : "#111827" }]}>
        {memory.memory}
      </Text>
      {memory.metadata?.evidenceUri && (
        <View style={styles.evidenceTag}>
          <Text style={styles.evidenceText}>📷 有证据图片</Text>
        </View>
      )}
    </View>
  );
}

function getCategoryLabel(category?: string): string {
  switch (category) {
    case "placement":
      return "📍 物品";
    case "preference":
      return "❤️ 偏好";
    case "reminder":
      return "⏰ 提醒";
    case "scene":
      return "👁️ 场景";
    case "calendar":
      return "📅 日程";
    default:
      return "📝 笔记";
  }
}

function getCategoryColor(category?: string): string {
  switch (category) {
    case "placement":
      return "#DBEAFE";
    case "preference":
      return "#FCE7F3";
    case "reminder":
      return "#FEF3C7";
    case "scene":
      return "#D1FAE5";
    case "calendar":
      return "#EDE9FE";
    default:
      return "#F3F4F6";
  }
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 14,
    marginVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  categoryBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  categoryText: { fontSize: 12 },
  time: { fontSize: 12 },
  content: { fontSize: 14, lineHeight: 20 },
  evidenceTag: { marginTop: 8 },
  evidenceText: { fontSize: 12, color: "#6D28D9" },
});
