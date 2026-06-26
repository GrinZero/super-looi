import { Tabs } from "expo-router";
import { useColorScheme } from "@/components/useColorScheme";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: isDark ? "#7C3AED" : "#6D28D9",
        tabBarInactiveTintColor: isDark ? "#9CA3AF" : "#6B7280",
        tabBarStyle: {
          backgroundColor: isDark ? "#1F2937" : "#FFFFFF",
          borderTopColor: isDark ? "#374151" : "#E5E7EB",
        },
        headerStyle: {
          backgroundColor: isDark ? "#1F2937" : "#FFFFFF",
        },
        headerTintColor: isDark ? "#F9FAFB" : "#111827",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "对话",
          tabBarLabel: "对话",
          headerTitle: "LOOI",
        }}
      />
      <Tabs.Screen
        name="memories"
        options={{
          title: "记忆",
          tabBarLabel: "记忆",
          headerTitle: "记忆库",
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "设置",
          tabBarLabel: "设置",
          headerTitle: "设置",
        }}
      />
    </Tabs>
  );
}
