const ROOM_ORDER_WEIGHTS: Array<[RegExp, number]> = [
  [/^(大厅|客厅|起居室|living)/i, 10],
  [/^(书房|工作室|办公|study|office)/i, 20],
  [/^(主卧|卧室|次卧|儿童房|bedroom)/i, 30],
  [/^(餐厅|厨房|kitchen|dining)/i, 40],
  [/^(天台|阳台|露台|balcony|terrace)/i, 50],
  [/^(玄关|走廊|过道|门口|hallway|entry)/i, 60],
  [/^(卫生间|浴室|洗手间|bathroom)/i, 70],
  [/^(杂物间|储物间|storage)/i, 80],
  [/^(未分区|默认|其他|other)/i, 999],
];

const ROOM_HINT_PATTERNS: Array<[RegExp, string]> = [
  [/大厅/, "大厅"],
  [/客厅/, "客厅"],
  [/书房/, "书房"],
  [/主卧|卧室/, "卧室"],
  [/天台/, "天台"],
  [/阳台/, "阳台"],
  [/厨房/, "厨房"],
  [/杂物间/, "杂物间"],
  [/门口|玄关/, "大厅"],
];

export interface NormalizedRoomInfo {
  homeName?: string;
  room: string;
}

/**
 * Strips redundant household prefix from Xiaomi Home / Home Assistant area names.
 * Example: "源心锁的家 大厅" -> { homeName: "源心锁的家", room: "大厅" }
 */
export function normalizeRoomName(rawRoom?: string, fallbackDeviceName?: string, lang: "zh-CN" | "en-US" = "zh-CN"): NormalizedRoomInfo {
  const trimmed = (rawRoom ?? "").trim().replace(/\s+/g, " ");
  if (trimmed) {
    const spaceParts = trimmed.split(" ");
    if (spaceParts.length >= 2 && (spaceParts[0].endsWith("的家") || spaceParts[0].endsWith("家庭") || spaceParts[0].length >= 3)) {
      const homeName = spaceParts[0];
      const roomPart = spaceParts.slice(1).join(" ").trim();
      if (roomPart) {
        return { homeName, room: roomPart };
      }
    }
    return { room: trimmed };
  }

  const hintSource = (fallbackDeviceName ?? "").trim();
  for (const [pattern, inferred] of ROOM_HINT_PATTERNS) {
    if (pattern.test(hintSource)) {
      return { room: inferred };
    }
  }

  return { room: lang === "en-US" ? "Unassigned" : "未分区" };
}

export function cleanApplianceDisplayName(rawName: string, room: string, homeName?: string): string {
  let cleaned = rawName.trim();
  if (!cleaned) return rawName;

  if (homeName && cleaned.startsWith(homeName)) {
    cleaned = cleaned.slice(homeName.length).trim();
  }

  // Strip trailing service/property suffixes like " · Light", " · 开关", etc.
  cleaned = cleaned.replace(/\s*·\s*(Light|Switch|Fan|Sensor|Outlet|开关|指示灯|设备状态|电源)$/i, "").trim();

  // Strip redundant middle room token in HA entity names like "电饭煲 大厅 煮饭" when used on device fallback
  if (room && cleaned.startsWith(`${room}的`) && cleaned.length > room.length + 2) {
    cleaned = cleaned.slice(room.length + 1).trim();
  }

  return cleaned || rawName.trim();
}

export function getRoomSortWeight(roomName: string): number {
  for (const [pattern, weight] of ROOM_ORDER_WEIGHTS) {
    if (pattern.test(roomName.trim())) return weight;
  }
  return 100;
}
