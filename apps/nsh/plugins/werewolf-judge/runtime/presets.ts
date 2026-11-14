import {
  GOD_FACTION_ROLES,
  WEREWOLF_ROLES,
  WOLF_FACTION_ROLES,
  type WerewolfMotionMode,
  type WerewolfPresetId,
  type WerewolfRole,
  type WerewolfRulesConfig,
  type WerewolfSurfaceMode,
} from "../contracts.js";

function makeRoleCounts(
  partial: Partial<Record<WerewolfRole, number>>,
): Record<WerewolfRole, number> {
  return {
    werewolf: partial.werewolf ?? 0,
    white_wolf_king: partial.white_wolf_king ?? 0,
    seer: partial.seer ?? 0,
    witch: partial.witch ?? 0,
    hunter: partial.hunter ?? 0,
    guard: partial.guard ?? 0,
    idiot: partial.idiot ?? 0,
    villager: partial.villager ?? 0,
  };
}

export function sumRoleCounts(
  counts: Readonly<Record<WerewolfRole, number>>,
): number {
  let total = 0;
  for (const role of WEREWOLF_ROLES) {
    total += Math.max(0, Math.trunc(counts[role] ?? 0));
  }
  return total;
}

export function buildPresetRules(
  presetId: Exclude<WerewolfPresetId, "custom">,
  preserve?: {
    surfaceMode?: WerewolfSurfaceMode;
    motionMode?: WerewolfMotionMode;
  },
): WerewolfRulesConfig {
  const surfaceMode = preserve?.surfaceMode ?? "on_device";
  const motionMode = preserve?.motionMode ?? "embodied_patrol";

  switch (presetId) {
    case "6p_joy":
      return {
        presetId: "6p_joy",
        playerCount: 6,
        roleCounts: makeRoleCounts({
          werewolf: 2,
          seer: 1,
          witch: 1,
          villager: 2,
        }),
        winMode: "slaughter_all",
        hasSheriff: false,
        witchSelfSaveMode: "first_night_only",
        sameGuardSameSaveDies: true,
        speechSeconds: 60,
        surfaceMode,
        motionMode,
      };

    case "9p_standard":
      return {
        presetId: "9p_standard",
        playerCount: 9,
        roleCounts: makeRoleCounts({
          werewolf: 3,
          seer: 1,
          witch: 1,
          hunter: 1,
          villager: 3,
        }),
        winMode: "slaughter_side",
        hasSheriff: false,
        witchSelfSaveMode: "first_night_only",
        sameGuardSameSaveDies: true,
        speechSeconds: 60,
        surfaceMode,
        motionMode,
      };

    case "12p_guard":
      return {
        presetId: "12p_guard",
        playerCount: 12,
        roleCounts: makeRoleCounts({
          werewolf: 3,
          white_wolf_king: 1,
          seer: 1,
          witch: 1,
          hunter: 1,
          guard: 1,
          villager: 4,
        }),
        winMode: "slaughter_side",
        hasSheriff: true,
        witchSelfSaveMode: "first_night_only",
        sameGuardSameSaveDies: true,
        speechSeconds: 90,
        surfaceMode,
        motionMode,
      };

    case "12p_idiot":
      return {
        presetId: "12p_idiot",
        playerCount: 12,
        roleCounts: makeRoleCounts({
          werewolf: 4,
          seer: 1,
          witch: 1,
          hunter: 1,
          idiot: 1,
          villager: 4,
        }),
        winMode: "slaughter_side",
        hasSheriff: true,
        witchSelfSaveMode: "first_night_only",
        sameGuardSameSaveDies: true,
        speechSeconds: 90,
        surfaceMode,
        motionMode,
      };
  }
}

export type RulesValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly stage: "validate_rules";
      readonly code: string;
      readonly reason: string;
    };

const SINGLETON_ROLES: readonly WerewolfRole[] = [
  "white_wolf_king",
  "seer",
  "witch",
  "hunter",
  "guard",
  "idiot",
];

export function validateRulesConfig(
  rules: WerewolfRulesConfig,
): RulesValidationResult {
  const total = sumRoleCounts(rules.roleCounts);
  if (rules.playerCount < 6 || rules.playerCount > 12) {
    return {
      valid: false,
      stage: "validate_rules",
      code: "ERR_WEREWOLF_PLAYER_COUNT_RANGE",
      reason: `人数必须在 6–12 人之间（当前 ${rules.playerCount} 人）`,
    };
  }
  if (total !== rules.playerCount) {
    return {
      valid: false,
      stage: "validate_rules",
      code: "ERR_WEREWOLF_ROLE_SUM_MISMATCH",
      reason: `角色总数（${total}）与房间人数（${rules.playerCount}）不一致`,
    };
  }
  for (const role of WEREWOLF_ROLES) {
    const count = rules.roleCounts[role] ?? 0;
    if (!Number.isInteger(count) || count < 0) {
      return {
        valid: false,
        stage: "validate_rules",
        code: "ERR_WEREWOLF_NEGATIVE_ROLE_COUNT",
        reason: `角色 ${role} 数量非法（${String(count)}）`,
      };
    }
  }
  for (const singleton of SINGLETON_ROLES) {
    if ((rules.roleCounts[singleton] ?? 0) > 1) {
      return {
        valid: false,
        stage: "validate_rules",
        code: "ERR_WEREWOLF_DUPLICATE_SINGLETON_ROLE",
        reason: `神职或特殊狼王角色 ${singleton} 最多配置 1 张`,
      };
    }
  }

  const wolfCount = WOLF_FACTION_ROLES.reduce(
    (acc, r) => acc + (rules.roleCounts[r] ?? 0),
    0,
  );
  const godCount = GOD_FACTION_ROLES.reduce(
    (acc, r) => acc + (rules.roleCounts[r] ?? 0),
    0,
  );
  const villagerCount = rules.roleCounts.villager ?? 0;
  const goodCount = godCount + villagerCount;

  if (wolfCount < 1) {
    return {
      valid: false,
      stage: "validate_rules",
      code: "ERR_WEREWOLF_NO_WOLVES",
      reason: "至少需要配置 1 名狼人阵营角色",
    };
  }
  if (goodCount <= wolfCount) {
    return {
      valid: false,
      stage: "validate_rules",
      code: "ERR_WEREWOLF_WOLF_MAJORITY_AT_START",
      reason: `开局好人数量（${goodCount}）必须多于狼人数量（${wolfCount}）`,
    };
  }
  if (rules.winMode === "slaughter_side") {
    if (godCount < 1 || villagerCount < 1) {
      return {
        valid: false,
        stage: "validate_rules",
        code: "ERR_WEREWOLF_SLAUGHTER_SIDE_REQUIRES_BOTH_SIDES",
        reason: "屠边模式下神职阵营与平民阵营各至少需要 1 人（否则请切换为屠城模式）",
      };
    }
  }
  if (rules.speechSeconds < 15 || rules.speechSeconds > 300) {
    return {
      valid: false,
      stage: "validate_rules",
      code: "ERR_WEREWOLF_SPEECH_SECONDS_RANGE",
      reason: `单人发言时长需在 15–300 秒之间（当前 ${rules.speechSeconds} 秒）`,
    };
  }
  return { valid: true };
}

export function applyCustomRoleCount(
  current: WerewolfRulesConfig,
  role: WerewolfRole,
  rawCount: number,
): WerewolfRulesConfig {
  const maxForRole = SINGLETON_ROLES.includes(role) ? 1 : 8;
  const clamped = Math.max(0, Math.min(maxForRole, Math.trunc(rawCount)));
  const nextCounts: Record<WerewolfRole, number> = {
    ...current.roleCounts,
    [role]: clamped,
  };
  let nextTotal = sumRoleCounts(nextCounts);

  // When adjusting a role would push total outside [6, 12], rebalance villagers first if possible.
  if (role !== "villager") {
    if (nextTotal > 12) {
      const excess = nextTotal - 12;
      nextCounts.villager = Math.max(0, nextCounts.villager - excess);
      nextTotal = sumRoleCounts(nextCounts);
    } else if (nextTotal < 6) {
      const deficit = 6 - nextTotal;
      nextCounts.villager += deficit;
      nextTotal = sumRoleCounts(nextCounts);
    }
  }

  const boundedPlayerCount = Math.max(6, Math.min(12, nextTotal));
  const godCount = GOD_FACTION_ROLES.reduce((s, r) => s + nextCounts[r], 0);
  const nextWinMode =
    current.winMode === "slaughter_side" && (godCount === 0 || nextCounts.villager === 0)
      ? "slaughter_all"
      : current.winMode;

  return {
    ...current,
    presetId: "custom",
    playerCount: boundedPlayerCount,
    roleCounts: nextCounts,
    winMode: nextWinMode,
  };
}

export function expandDeckFromRoleCounts(
  roleCounts: Readonly<Record<WerewolfRole, number>>,
): WerewolfRole[] {
  const deck: WerewolfRole[] = [];
  for (const role of WEREWOLF_ROLES) {
    const count = Math.max(0, Math.trunc(roleCounts[role] ?? 0));
    for (let i = 0; i < count; i += 1) {
      deck.push(role);
    }
  }
  return deck;
}

export type RandomIntFn = (maxExclusive: number) => number;

export function defaultCsprngInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  while (true) {
    globalThis.crypto.getRandomValues(buf);
    const val = buf[0]!;
    if (val < limit) {
      return val % maxExclusive;
    }
  }
}

export function shuffleRolesCsprng(
  deck: readonly WerewolfRole[],
  randomInt: RandomIntFn = defaultCsprngInt,
): WerewolfRole[] {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function randomTokenHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
