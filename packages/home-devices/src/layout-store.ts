import type {
  ApplianceArchetype,
  ApplianceIconKind,
  HomeApplianceLayoutItem,
  HomeLayoutPreferences,
  TileSpan,
} from "./types.js";

export const HOME_LAYOUT_VAULT_KEY = "home.layout.v1";

const VALID_SPANS = new Set<TileSpan>(["1x1", "2x1", "1x2", "2x2"]);

export function parseTileSpanDimensions(span: TileSpan): { cols: 1 | 2; rows: 1 | 2 } {
  if (span === "2x2") return { cols: 2, rows: 2 };
  if (span === "2x1") return { cols: 2, rows: 1 };
  if (span === "1x2") return { cols: 1, rows: 2 };
  return { cols: 1, rows: 1 };
}

export function formatTileSpanDimensions(cols: 1 | 2, rows: 1 | 2): TileSpan {
  return `${cols}x${rows}` as TileSpan;
}

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

/**
 * Swap or place two appliances within a room's ordered list, assigning normalized
 * sequential order indices (`10, 20, 30, ...`) so free layout editing is deterministic.
 */
export function swapApplianceOrderInList(
  prefs: HomeLayoutPreferences,
  orderedApplianceIds: string[],
  sourceId: string,
  targetId: string,
): HomeLayoutPreferences {
  const idxA = orderedApplianceIds.indexOf(sourceId);
  const idxB = orderedApplianceIds.indexOf(targetId);
  if (idxA < 0 || idxB < 0 || idxA === idxB) return prefs;
  const nextIds = [...orderedApplianceIds];
  const temp = nextIds[idxA]!;
  nextIds[idxA] = nextIds[idxB]!;
  nextIds[idxB] = temp;
  const nextAppliances = { ...prefs.appliances };
  nextIds.forEach((id, idx) => {
    const existing = nextAppliances[id] ?? {};
    nextAppliances[id] = {
      ...existing,
      order: (idx + 1) * 10,
    };
  });
  return {
    version: 1,
    appliances: nextAppliances,
  };
}

export function moveApplianceToIndexInList(
  prefs: HomeLayoutPreferences,
  orderedApplianceIds: string[],
  sourceId: string,
  targetIndex: number,
): HomeLayoutPreferences {
  const fromIdx = orderedApplianceIds.indexOf(sourceId);
  if (fromIdx < 0) return prefs;
  const clampedTarget = Math.max(0, Math.min(orderedApplianceIds.length - 1, targetIndex));
  if (fromIdx === clampedTarget) return prefs;
  const nextIds = [...orderedApplianceIds];
  const [moved] = nextIds.splice(fromIdx, 1);
  if (!moved) return prefs;
  nextIds.splice(clampedTarget, 0, moved);
  const nextAppliances = { ...prefs.appliances };
  nextIds.forEach((id, idx) => {
    const existing = nextAppliances[id] ?? {};
    nextAppliances[id] = {
      ...existing,
      order: (idx + 1) * 10,
    };
  });
  return {
    version: 1,
    appliances: nextAppliances,
  };
}

export function cycleTileSpan(current: TileSpan): TileSpan {
  if (current === "1x1") return "2x1";
  if (current === "2x1" || current === "1x2") return "2x2";
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

export interface PackedBentoTile {
  id: string;
  colStart: number;
  colSpan: 1 | 2;
  rowStart: number;
  rowSpan: 1 | 2;
}

/**
 * Deterministic 2D occupancy-grid packer for Bento room tiles.
 * Places each appliance in the earliest `(row, col)` slot where its `(colSpan, rowSpan)`
 * fits without overlap, allowing `1x1` tiles to backfill empty right-hand columns beside
 * `2x2` and `2x1` tiles when column count changes (e.g. collapsing the room sidebar `2 -> 3` cols).
 */
export function packBentoTiles(
  items: ReadonlyArray<{ id: string; span: TileSpan }>,
  columns: number,
): PackedBentoTile[] {
  const safeCols = Math.max(1, Math.floor(columns));
  const occupied = new Set<string>();
  const cellKey = (r: number, c: number) => `${r}:${c}`;
  const placements: PackedBentoTile[] = [];

  for (const item of items) {
    const raw = parseTileSpanDimensions(item.span);
    const colSpan = (safeCols === 1 ? 1 : Math.min(raw.cols, safeCols)) as 1 | 2;
    const rowSpan = raw.rows;

    let placed = false;
    for (let row = 1; !placed; row++) {
      for (let col = 1; col <= safeCols - colSpan + 1; col++) {
        let fits = true;
        for (let dr = 0; dr < rowSpan && fits; dr++) {
          for (let dc = 0; dc < colSpan; dc++) {
            if (occupied.has(cellKey(row + dr, col + dc))) {
              fits = false;
              break;
            }
          }
        }
        if (fits) {
          for (let dr = 0; dr < rowSpan; dr++) {
            for (let dc = 0; dc < colSpan; dc++) {
              occupied.add(cellKey(row + dr, col + dc));
            }
          }
          placements.push({
            id: item.id,
            colStart: col,
            colSpan,
            rowStart: row,
            rowSpan,
          });
          placed = true;
          break;
        }
      }
    }
  }

  return placements;
}
