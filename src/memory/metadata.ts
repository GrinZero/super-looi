import { MemoryCategory, ObservationSource } from "../core/observation";

export interface MemoryMetadata {
  category: MemoryCategory;
  timestamp: string;
  source: ObservationSource;
  evidenceUri?: string;
}

/**
 * Classify the content into a memory category based on keywords
 */
export function classifyCategory(content: string): MemoryCategory {
  const lower = content.toLowerCase();

  // Placement indicators
  const placementKeywords = ["放", "搁", "在", "桌", "柜", "抽屉", "架", "放这", "放那"];
  if (placementKeywords.some((kw) => lower.includes(kw))) {
    return "placement";
  }

  // Preference indicators
  const preferenceKeywords = ["喜欢", "讨厌", "偏好", "习惯", "爱吃", "不爱"];
  if (preferenceKeywords.some((kw) => lower.includes(kw))) {
    return "preference";
  }

  // Reminder indicators
  const reminderKeywords = ["提醒", "别忘", "记得", "到时候", "下次"];
  if (reminderKeywords.some((kw) => lower.includes(kw))) {
    return "reminder";
  }

  // Calendar indicators
  const calendarKeywords = ["会议", "开会", "约", "预约", "日程"];
  if (calendarKeywords.some((kw) => lower.includes(kw))) {
    return "calendar";
  }

  return "note";
}

/**
 * Detect if content contains spatial reference words (指示词)
 * that should trigger camera capture
 */
export function hasVisualReference(content: string): boolean {
  const visualKeywords = ["这个", "这里", "这", "那个", "那里", "这边", "那边", "放这了", "放那了", "看看"];
  return visualKeywords.some((kw) => content.includes(kw));
}

/**
 * Build metadata for a new memory entry
 */
export function buildMemoryMetadata(
  content: string,
  source: ObservationSource,
  evidenceUri?: string
): MemoryMetadata {
  return {
    category: classifyCategory(content),
    timestamp: new Date().toISOString(),
    source,
    evidenceUri,
  };
}
