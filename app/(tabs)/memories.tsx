import { useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  FlatList,
  Text,
  useColorScheme,
  SafeAreaView,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { memoryService } from "@/src/server-api/client";
import { MemoryResult } from "@/src/core/context-service";
import { MemoryCard } from "@/src/ui/MemoryCard";
import { MemoryCategory } from "@/src/core/observation";

const CATEGORIES: { label: string; value: MemoryCategory | "all" }[] = [
  { label: "全部", value: "all" },
  { label: "物品", value: "placement" },
  { label: "偏好", value: "preference" },
  { label: "提醒", value: "reminder" },
  { label: "笔记", value: "note" },
  { label: "日程", value: "calendar" },
];

export default function MemoriesScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const [memories, setMemories] = useState<MemoryResult[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<MemoryCategory | "all">("all");
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadMemories = async () => {
    try {
      const filters =
        selectedCategory === "all" ? undefined : { category: selectedCategory };
      const results = await memoryService.getAll(filters);
      setMemories(results);
    } catch (error) {
      console.error("[Memories] Failed to load:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, [selectedCategory]);

  const onRefresh = () => {
    setRefreshing(true);
    loadMemories();
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? "#111827" : "#F9FAFB" }]}>
      {/* Category filter chips */}
      <View style={styles.filterRow}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.value}
            style={[
              styles.chip,
              {
                backgroundColor:
                  selectedCategory === cat.value
                    ? isDark
                      ? "#7C3AED"
                      : "#6D28D9"
                    : isDark
                    ? "#374151"
                    : "#E5E7EB",
              },
            ]}
            onPress={() => setSelectedCategory(cat.value)}
          >
            <Text
              style={[
                styles.chipText,
                {
                  color:
                    selectedCategory === cat.value ? "#FFFFFF" : isDark ? "#D1D5DB" : "#4B5563",
                },
              ]}
            >
              {cat.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Memory list */}
      <FlatList
        data={memories}
        renderItem={({ item }) => <MemoryCard memory={item} isDark={isDark} />}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: isDark ? "#9CA3AF" : "#6B7280" }]}>
              {loading ? "加载中..." : "还没有记忆，跟我说点什么吧 ☺️"}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 },
  emptyContainer: { paddingTop: 80, alignItems: "center" },
  emptyText: { fontSize: 15 },
});
