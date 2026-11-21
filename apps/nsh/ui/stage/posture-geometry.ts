import type {
  FaceStagePosture,
  StageDrawerDetent,
} from "../../runtime/plugins/shared-types";

export interface StageViewport {
  readonly width: number;
  readonly height: number;
}

export interface StageSafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface StageLayoutInput {
  readonly viewport: StageViewport;
  readonly insets: StageSafeInsets;
  readonly posture: FaceStagePosture;
  readonly drawerDetent: StageDrawerDetent;
  readonly hasDrawer: boolean;
  readonly hasCapsule?: boolean;
  readonly capsulePlacement?: "below_top" | "top_bar";
  readonly hasCompanion?: boolean;
}

export interface StageFaceGeometry {
  readonly translateX: number;
  readonly translateY: number;
  readonly scale: number;
  readonly pillTranslateX: number;
  readonly pillTranslateY: number;
  readonly pillScale: number;
  readonly pillOpacity: number;
  readonly targetCenterX: number;
  readonly targetCenterY: number;
}

export interface StageBoxInset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface StageCapsuleGeometry {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

export interface StageDrawerGeometry {
  readonly maxHeight: number;
  readonly peekHeight: number;
  readonly mediumHeight: number;
  readonly largeHeight: number;
  readonly visibleHeight: number;
}

export interface StageLayoutMetrics {
  readonly topBarHeight: number;
  readonly isSplitLeft: boolean;
  readonly splitLeftBoundaryX: number;
  readonly face: StageFaceGeometry;
  readonly canvas: StageBoxInset;
  readonly leftCompanion: StageBoxInset | null;
  readonly canvasOccludedByDrawer: boolean;
  readonly topBarCapsuleMaxWidth: number | null;
  readonly capsule: StageCapsuleGeometry;
  readonly drawer: StageDrawerGeometry;
}

export const STAGE_BASE_PILL_WIDTH = 588;
export const STAGE_BASE_PILL_HEIGHT = 250;
export const STAGE_TOP_BAR_HEIGHT = 56;
const STAGE_CAPSULE_ESTIMATED_HEIGHT = 34;
const STAGE_TOP_RIGHT_CONTROLS_RESERVED_WIDTH = 296;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function computeStageLayout(input: StageLayoutInput): StageLayoutMetrics {
  const width = Math.max(320, input.viewport.width);
  const height = Math.max(240, input.viewport.height);
  const safeLeft = clamp(input.insets.left, 0, width * 0.25);
  const safeRight = clamp(input.insets.right, 0, width * 0.25);
  const safeTop = clamp(input.insets.top, 0, height * 0.25);
  const safeBottom = clamp(input.insets.bottom, 0, height * 0.25);

  const safeWidth = Math.max(200, width - safeLeft - safeRight);
  const safeHeight = Math.max(160, height - safeTop - safeBottom);
  const naturalFaceCenterX = safeLeft + safeWidth / 2;
  const naturalFaceCenterY = safeTop + safeHeight / 2;

  // Matches RobotFace.tsx logical 620x340 base scale formula
  const baseFaceScale = Math.max(
    0.01,
    Math.min(1.08, (safeWidth - 32) / 620, (safeHeight - 80) / 340),
  );

  // Base top-bar-safe drawer ceiling; refined below once top floating pill clearance is known
  const unclampedMaxDrawerHeight = Math.max(
    160,
    Math.round(height - safeTop - STAGE_TOP_BAR_HEIGHT - 8),
  );
  const basePeekHeight = Math.min(
    safeBottom + 96,
    Math.max(
      safeBottom + 86,
      safeBottom + Math.round(unclampedMaxDrawerHeight * 0.28),
    ),
  );

  const effectiveDetent: StageDrawerDetent = input.hasDrawer
    ? input.drawerDetent
    : "closed";
  const capsulePlacement = input.capsulePlacement ?? "below_top";

  let targetScale = 1;
  let targetCenterX = naturalFaceCenterX;
  let targetCenterY = naturalFaceCenterY;
  let pillOpacity = 0;
  let isSplitLeft = false;
  let splitLeftBoundaryX = safeLeft;

  const posture = input.posture;
  switch (posture.kind) {
    case "full": {
      targetScale = 1;
      targetCenterX = naturalFaceCenterX;
      targetCenterY =
        effectiveDetent === "peek"
          ? Math.round(
              safeTop +
                STAGE_TOP_BAR_HEIGHT +
                (height - safeTop - STAGE_TOP_BAR_HEIGHT - basePeekHeight) *
                  0.48,
            )
          : naturalFaceCenterY;
      pillOpacity = 0;
      break;
    }
    case "floating_top": {
      const isFrameless = (posture.chrome ?? "pill") === "frameless";
      targetScale = clamp(
        posture.scale ?? (isFrameless ? 0.18 : 0.32),
        isFrameless ? 0.16 : 0.22,
        0.36,
      );
      const faceVisualSpanW = isFrameless ? 540 : STAGE_BASE_PILL_WIDTH;
      const faceVisualSpanH = isFrameless ? 220 : STAGE_BASE_PILL_HEIGHT;
      const pillVisualHalfW = (faceVisualSpanW * baseFaceScale * targetScale) / 2;
      const pillVisualHalfH = (faceVisualSpanH * baseFaceScale * targetScale) / 2;
      const rightControlsLeftX = width - safeRight - STAGE_TOP_RIGHT_CONTROLS_RESERVED_WIDTH;
      const minLeftCenterX = safeLeft + 16 + pillVisualHalfW;
      const maxClearCenterX = rightControlsLeftX - 8 - pillVisualHalfW;
      if (isFrameless) {
        if (naturalFaceCenterX + pillVisualHalfW <= rightControlsLeftX - 8) {
          targetCenterX = naturalFaceCenterX;
          targetCenterY = safeTop + Math.round(STAGE_TOP_BAR_HEIGHT * 0.6);
        } else if (maxClearCenterX >= minLeftCenterX) {
          targetCenterX = maxClearCenterX;
          targetCenterY = safeTop + Math.round(STAGE_TOP_BAR_HEIGHT * 0.6);
        } else {
          targetCenterX = naturalFaceCenterX;
          targetCenterY = safeTop + STAGE_TOP_BAR_HEIGHT + 6 + Math.round(pillVisualHalfH);
        }
        pillOpacity = 0;
      } else {
        if (naturalFaceCenterX + pillVisualHalfW <= rightControlsLeftX - 8) {
          targetCenterX = naturalFaceCenterX;
          targetCenterY = safeTop + Math.max(30, Math.round(pillVisualHalfH + 6));
        } else if (maxClearCenterX >= minLeftCenterX) {
          targetCenterX = maxClearCenterX;
          targetCenterY = safeTop + Math.max(30, Math.round(pillVisualHalfH + 6));
        } else {
          targetCenterX = naturalFaceCenterX;
          targetCenterY = safeTop + STAGE_TOP_BAR_HEIGHT + 6 + Math.round(pillVisualHalfH);
        }
        pillOpacity = 1;
      }
      break;
    }
    case "docked_corner": {
      targetScale = clamp(posture.scale ?? 0.28, 0.2, 0.42);
      const pillVisualHalfW = (STAGE_BASE_PILL_WIDTH * baseFaceScale * targetScale) / 2;
      const pillVisualHalfH = (STAGE_BASE_PILL_HEIGHT * baseFaceScale * targetScale) / 2;
      targetCenterX =
        posture.corner === "top_left"
          ? safeLeft + 16 + pillVisualHalfW
          : width - safeRight - 16 - pillVisualHalfW;
      // Sits strictly below the top host safety bar so top-right controls stay clear
      targetCenterY = safeTop + STAGE_TOP_BAR_HEIGHT + 8 + pillVisualHalfH;
      pillOpacity = 1;
      break;
    }
    case "split_left": {
      isSplitLeft = true;
      const ratio = clamp(posture.widthRatio ?? 0.38, 0.28, 0.52);
      const leftPaneWidth = Math.round(safeWidth * ratio);
      splitLeftBoundaryX = safeLeft + leftPaneWidth;
      const maxFitScale =
        (leftPaneWidth - 28) / Math.max(240, 600 * baseFaceScale);
      targetScale = clamp(maxFitScale, 0.32, 0.64);
      const availableBottom =
        height -
        Math.max(safeBottom, effectiveDetent !== "closed" ? basePeekHeight : 0);
      const verticalTop = safeTop + STAGE_TOP_BAR_HEIGHT;
      targetCenterX = safeLeft + leftPaneWidth / 2;
      const verticalFraction = input.hasCompanion ? 0.4 : 0.48;
      targetCenterY =
        verticalTop + Math.max(48, (availableBottom - verticalTop) * verticalFraction);
      pillOpacity = 0;
      break;
    }
    case "minimized_pill": {
      targetScale = 0.22;
      const pillVisualHalfH = (STAGE_BASE_PILL_HEIGHT * baseFaceScale * targetScale) / 2;
      targetCenterX = naturalFaceCenterX;
      targetCenterY = safeTop + Math.max(26, Math.round(pillVisualHalfH + 6));
      pillOpacity = 1;
      break;
    }
  }

  const viewportHalfW = width / 2;
  const viewportHalfH = height / 2;
  // Exact affine solution for transform: [{ translateX }, { translateY }, { scale }] around viewport center:
  // P' = C + T + scale * (P - C) => T = target - C - scale * (naturalFaceCenter - C)
  const translateX =
    targetCenterX - viewportHalfW - targetScale * (naturalFaceCenterX - viewportHalfW);
  const translateY =
    targetCenterY - viewportHalfH - targetScale * (naturalFaceCenterY - viewportHalfH);

  const pillScale = baseFaceScale * targetScale;
  const pillTranslateX = targetCenterX - viewportHalfW;
  const pillTranslateY = targetCenterY - viewportHalfH;
  const isFramelessFloating =
    posture.kind === "floating_top" && (posture.chrome ?? "pill") === "frameless";
  const pillBottomY = Math.round(
    targetCenterY + ((isFramelessFloating ? 220 : STAGE_BASE_PILL_HEIGHT) * pillScale) / 2,
  );

  // 4-detent bottom drawer geometry: never intrudes into the top host safety bar OR top floating face pill
  const maxDrawerHeight =
    posture.kind === "floating_top" || posture.kind === "minimized_pill"
      ? Math.max(
          160,
          Math.min(unclampedMaxDrawerHeight, height - (pillBottomY + 6)),
        )
      : unclampedMaxDrawerHeight;
  const peekHeight = Math.min(
    safeBottom + 96,
    Math.max(
      safeBottom + 86,
      safeBottom + Math.round(maxDrawerHeight * 0.28),
    ),
  );
  const mediumHeight = Math.max(
    peekHeight + 48,
    Math.round(maxDrawerHeight * 0.6),
  );
  const largeHeight = maxDrawerHeight;

  const visibleDrawerHeight =
    effectiveDetent === "large"
      ? largeHeight
      : effectiveDetent === "medium"
        ? mediumHeight
        : effectiveDetent === "peek"
          ? peekHeight
          : 0;

  const capsuleTop =
    posture.kind === "floating_top" || posture.kind === "minimized_pill"
      ? pillBottomY + 8
      : safeTop + STAGE_TOP_BAR_HEIGHT + 6;
  const capsuleLeft = isSplitLeft ? splitLeftBoundaryX + 8 : safeLeft + 12;
  const capsuleRight = safeRight + 12;

  const baseCanvasTop = safeTop + STAGE_TOP_BAR_HEIGHT + 4;
  const topFaceClearance =
    posture.kind === "floating_top" || posture.kind === "minimized_pill"
      ? isFramelessFloating && targetCenterY <= safeTop + STAGE_TOP_BAR_HEIGHT
        ? baseCanvasTop
        : pillBottomY + 8
      : baseCanvasTop;
  const topCapsuleClearance =
    input.hasCapsule && capsulePlacement !== "top_bar"
      ? capsuleTop + STAGE_CAPSULE_ESTIMATED_HEIGHT + 6
      : baseCanvasTop;
  const canvasTop = Math.min(
    Math.round(height * 0.48),
    Math.max(baseCanvasTop, topFaceClearance, topCapsuleClearance),
  );
  const canvasLeft = isSplitLeft ? splitLeftBoundaryX + 8 : safeLeft + 12;
  const canvasRight = safeRight + 12;
  const canvasBottom =
    effectiveDetent === "closed"
      ? safeBottom + 10
      : Math.min(height - canvasTop - 40, visibleDrawerHeight + 8);
  const canvasOccludedByDrawer =
    effectiveDetent !== "closed" &&
    (effectiveDetent === "large" || height - canvasTop - visibleDrawerHeight < 72);

  const leftCompanion: StageBoxInset | null =
    isSplitLeft && input.hasCompanion
      ? {
          top: Math.min(
            height - safeBottom - 56,
            Math.round(targetCenterY + 146 * baseFaceScale * targetScale),
          ),
          left: safeLeft + 8,
          right: Math.max(safeRight + 8, width - splitLeftBoundaryX + 8),
          bottom: Math.max(safeBottom + 12, visibleDrawerHeight + 8),
        }
      : null;

  let topBarCapsuleMaxWidth: number | null = null;
  if (capsulePlacement === "top_bar" && input.hasCapsule) {
    const leftStart = safeLeft + 16;
    const rightLimit = width - safeRight - STAGE_TOP_RIGHT_CONTROLS_RESERVED_WIDTH;
    if (
      (posture.kind === "floating_top" || posture.kind === "minimized_pill") &&
      targetCenterY <= safeTop + STAGE_TOP_BAR_HEIGHT
    ) {
      const halfW =
        posture.kind === "floating_top" && (posture.chrome ?? "pill") === "frameless"
          ? (600 * baseFaceScale * targetScale) / 2
          : (STAGE_BASE_PILL_WIDTH * baseFaceScale * targetScale) / 2;
      topBarCapsuleMaxWidth = Math.max(
        140,
        Math.floor(targetCenterX - halfW - leftStart - 14),
      );
    } else {
      topBarCapsuleMaxWidth = Math.max(180, Math.floor(rightLimit - leftStart - 8));
    }
  }

  return {
    topBarHeight: STAGE_TOP_BAR_HEIGHT,
    isSplitLeft,
    splitLeftBoundaryX,
    face: {
      translateX,
      translateY,
      scale: targetScale,
      pillTranslateX,
      pillTranslateY,
      pillScale,
      pillOpacity,
      targetCenterX,
      targetCenterY,
    },
    canvas: {
      top: canvasTop,
      right: canvasRight,
      bottom: Math.max(safeBottom + 8, canvasBottom),
      left: canvasLeft,
    },
    leftCompanion,
    canvasOccludedByDrawer,
    topBarCapsuleMaxWidth,
    capsule: {
      top: capsuleTop,
      left: capsuleLeft,
      right: capsuleRight,
    },
    drawer: {
      maxHeight: maxDrawerHeight,
      peekHeight,
      mediumHeight,
      largeHeight,
      visibleHeight: visibleDrawerHeight,
    },
  };
}

export function nextCycledDrawerDetent(
  current: StageDrawerDetent,
  allowUserSwipeCollapse: boolean,
): StageDrawerDetent {
  switch (current) {
    case "closed":
      return "peek";
    case "peek":
      return "medium";
    case "medium":
      return "large";
    case "large":
      return allowUserSwipeCollapse ? "peek" : "medium";
  }
}

export function resolveSnapDrawerDetent(input: {
  readonly startDetent: StageDrawerDetent;
  readonly translationY: number;
  readonly velocityY: number;
  readonly drawer: StageDrawerGeometry;
  readonly allowUserSwipeCollapse: boolean;
}): StageDrawerDetent {
  const startHeight =
    input.startDetent === "large"
      ? input.drawer.largeHeight
      : input.startDetent === "medium"
        ? input.drawer.mediumHeight
        : input.startDetent === "peek"
          ? input.drawer.peekHeight
          : 0;

  // Downward drag has positive translationY/velocityY -> decreases sheet height
  const projectedHeight =
    startHeight - (input.translationY + input.velocityY * 0.14);

  const candidates: Array<{ detent: StageDrawerDetent; height: number }> = [
    { detent: "large", height: input.drawer.largeHeight },
    { detent: "medium", height: input.drawer.mediumHeight },
    { detent: "peek", height: input.drawer.peekHeight },
  ];
  if (input.allowUserSwipeCollapse) {
    candidates.push({ detent: "closed", height: 0 });
  }

  let best = candidates[0]!;
  let bestDistance = Math.abs(projectedHeight - best.height);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const dist = Math.abs(projectedHeight - candidate.height);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }
  return best.detent;
}
