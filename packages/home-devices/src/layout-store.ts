import type {
  ApplianceArchetype,
  ApplianceIconKind,
  HomeApplianceLayoutItem,
  HomeLayoutPreferences,
  TileSpan,
} from "./types.js";

export const HOME_LAYOUT_VAULT_KEY = "home.layout.v1";

const VALID_SPANS = new Set<TileSpan>(["1x1", "2x1", "2x2"]);

export function createEmptyLayoutPreferences(): HomeLayoutPreferences {
  return { version: 1, appliances: {} };
}

export function parseLayoutPreferences(raw: string | null | undefined): HomeLayoutPreferences {
  if (!raw || !raw.trim()) return createEmptyLayoutPreferences();
  try {
    const parsed = JSON.parse(raw) as Partial<HomeLayoutPreferences>;
    if (!parsed || typeof parsed !== "object" || !parsed.appliances || typeof parsed.appliances !== "object") {
      return createEmptyLayoutPreferences();
    }
    const appliances: Record<string, HomeApplianceLayoutItem> = {};
    for (const [key, item] of Object.entries(parsed.appliances)) {
      if (!item || typeof item !== "object") continue;
      const validSpan = item.span && VALID_SPANS.has(item.span) ? item.span : undefined;
      const validOrder = typeof item.order === "number" && Number.isFinite(item.order) ? item.order : undefined;
      if (validSpan || validOrder !== undefined) {
        appliances[key] = {
          ...(validSpan ? { span: validSpan } : {}),
          ...(validOrder !== undefined ? { order: validOrder } : {}),
        };
      }
    }
    return { version: 1, appliances };
  } catch {
    return createEmptyLayoutPreferences();
  }
}

export function serializeLayoutPreferences(prefs: HomeLayoutPreferences): string {
  return JSON.stringify(prefs);
}

export function updateApplianceSpan(
  prefs: HomeLayoutPreferences,
  applianceId: string,
  span: TileSpan,
): HomeLayoutPreferences {
  const existing = prefs.appliances[applianceId] ?? {};
  return {
    version: 1,
    appliances: {
      ...prefs.appliances,
      [applianceId]: {
        ...existing,
        span,
      },
    },
  };
}

export function updateApplianceOrder(
  prefs: HomeLayoutPreferences,
  applianceId: string,
  order: number,
): HomeLayoutPreferences {
  const existing = prefs.appliances[applianceId] ?? {};
  return {
    version: 1,
    appliances: {
      ...prefs.appliances,
      [applianceId]: {
        ...existing,
        order,
      },
    },
  };
}

export function cycleTileSpan(current: TileSpan): TileSpan {
  if (current === "1x1") return "2x1";
  if (current === "2x1") return "2x2";
  return "1x1";
}

/**
 * Smart default card sizes based on appliance archetype and icon kind:
 * - Security cameras default to `2x2` so the 16:9 viewport is never squashed.
 * - Complex cycle appliances (rice cooker, washer, dishwasher, microwave, vacuum) and primary AC default to `2x1` wide.
 * - All other switches, lights, plugs, feeders, and sensors default to `1x1` compact.
 */
export function resolveDefaultTileSpan(archetype: ApplianceArchetype, icon: ApplianceIconKind): TileSpan {
  if (icon === "camera") return "2x2";
  if (archetype === "cycle_appliance") return "2x1";
  if (archetype === "climate" && (icon === "ac" || icon === "kettle")) return "2x1";
  return "1x1";
}

export function getArchetypeDefaultOrder(archetype: ApplianceArchetype, icon: ApplianceIconKind): number {
  if (icon === "camera") return 10;
  if (archetype === "cycle_appliance") return 20;
  if (archetype === "climate") return 30;
  if (archetype === "lighting_power") return 40;
  if (archetype === "media") return 50;
  if (icon === "feeder" || icon === "waterer") return 55;
  if (icon === "lock" || icon === "bell") return 60;
  return 80;
}
