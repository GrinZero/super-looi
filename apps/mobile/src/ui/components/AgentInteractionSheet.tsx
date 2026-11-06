import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { LiveAgentInteraction, LiveAgentAnswer } from "../../runtime/live-voice-client.js";

export function AgentInteractionSheet({ interaction, onAnswer }: { interaction: LiveAgentInteraction; onAnswer: (answer: LiveAgentAnswer) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const questions = interaction.kind === "question" ? interaction.details.questions ?? [] : [];
  const canSubmit = interaction.kind === "approval" || (questions.length > 0 && questions.every(question => (selected[question.id]?.length ?? 0) > 0 || !!custom[question.id]?.trim()));
  const dismiss = () => onAnswer(interaction.kind === "approval" ? { outcome: "rejected" } : { cancelled: true });
  return <Modal transparent animationType="fade" onRequestClose={dismiss}>
    <View style={styles.backdrop}><View style={styles.card} accessibilityViewIsModal>
      <Text style={styles.title}>{interaction.kind === "approval" ? "这一步需要你确认" : "LOOI 想确认一下"}</Text>
      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
        {interaction.kind === "approval" ? <View style={styles.question}><Text selectable style={styles.body}>{String(interaction.details.command ?? interaction.details.toolName ?? "请求的操作")}</Text>{typeof interaction.details.reason === "string" ? <Text style={styles.detail}>{interaction.details.reason}</Text> : null}</View> : questions.map(question => <View key={question.id} style={styles.question}>
          <Text style={styles.body}>{question.question}</Text>
          {question.detail ? <Text style={styles.detail}>{question.detail}</Text> : null}
          {question.options?.map(option => <Pressable key={option.label} accessibilityRole="checkbox" accessibilityState={{ checked: selected[question.id]?.includes(option.label) ?? false }} style={[styles.option, selected[question.id]?.includes(option.label) && styles.selected]} onPress={() => setSelected(previous => ({ ...previous, [question.id]: question.multiSelect ? (previous[question.id]?.includes(option.label) ? previous[question.id].filter(value => value !== option.label) : [...(previous[question.id] ?? []), option.label]) : [option.label] }))}>
            <Text style={styles.body}>{option.label}</Text>
            {option.description ? <Text style={styles.detail}>{option.description}</Text> : null}
          </Pressable>)}
          {!question.intent || question.intent.kind !== "approval" ? <TextInput accessibilityLabel={`${question.question}，补充回答`} style={styles.input} placeholder="补充回答" placeholderTextColor="#8894A8" value={custom[question.id] ?? ""} onChangeText={text => setCustom(previous => ({ ...previous, [question.id]: text }))} /> : null}
        </View>)}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" style={styles.option} onPress={dismiss}><Text style={styles.body}>{interaction.kind === "approval" ? "拒绝" : "取消"}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={!canSubmit} style={[styles.option, styles.primary, !canSubmit && { opacity: 0.4 }]} onPress={() => onAnswer(interaction.kind === "approval" ? { outcome: "allowed-once" } : { answers: questions.map(question => ({ id: question.id, selected: selected[question.id] ?? [], ...(custom[question.id]?.trim() ? { custom: custom[question.id].trim() } : {}) })) })}><Text style={styles.body}>{interaction.kind === "approval" ? "仅允许这一次" : "提交回答"}</Text></Pressable>
      </View>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 },
  card: { width: "100%", maxWidth: 520, maxHeight: "90%", backgroundColor: "#101B2D", borderRadius: 24, padding: 24, borderWidth: 1, borderColor: "#2B4160", gap: 16 },
  title: { color: "#F0F6FF", fontSize: 19, fontWeight: "600" },
  content: { flexShrink: 1 }, question: { gap: 10, marginBottom: 20 },
  body: { color: "#F0F6FF", fontSize: 14, lineHeight: 21 }, detail: { color: "#A3B0C5", fontSize: 12, lineHeight: 18 },
  option: { minHeight: 44, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#3B4C64", justifyContent: "center" },
  selected: { borderColor: "#5DA4FF", backgroundColor: "#1A3757" }, primary: { backgroundColor: "#1F64B5", borderColor: "#398AE4" },
  input: { minHeight: 44, borderWidth: 1, borderColor: "#3B4C64", borderRadius: 12, paddingHorizontal: 12, color: "#F0F6FF" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
});
