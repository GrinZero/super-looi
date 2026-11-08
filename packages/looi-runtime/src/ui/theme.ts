import type { ActionReceiptStatus, ClaimStatus } from "@super-looi/contracts";

/**
 * Super-LOOI Visual Spec and Palette Palette Rules (Presence v0.2)
 * Pure dark background #0C1418, Cyan reserved for eyes & speech, Amber for uncertainty,
 * Green for verified/confirmed, Coral for stop/fault/pause.
 */
const paletteTokens = {
  bgPure: "#0C1418",
  bgSurface: "#121C22",
  bgElevated: "#18252C",
  borderSubtle: "#263742",
  textPrimary: "#FFFFFF",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",

  // Presence Cyan: strictly reserved for eyes, voice waveform, active listening
  presenceCyan: "#28D5FF",
  presenceCyanSoft: "#B6F4D6",

  // Warm Amber: reminders and uncertainty (inferred, candidate, unverified)
  amberWarning: "#F3C56B",
  amberSoft: "#FFE7B3",

  // Confirm Green: strictly for confirmed memories and verified receipts
  confirmGreen: "#4ADE80",
  confirmGreenSoft: "#86EFAC",

  // Alert Coral: emergency stop, fault, privacy pause
  alertCoral: "#FA8E86",
  alertCoralSoft: "#FECDD3",

  // Presence v2.1 device surfaces; preserve the original palette for existing clients.
  emergencyCoral: "#FA8E86",
  cautionAmber: "#F3C56B",
  bgDeep: "#03070D",
  bgRaised: "#07111D",
  surfaceGlass: "rgba(10, 22, 36, 0.78)",
  surfaceElevated: "rgba(16, 34, 54, 0.88)",
  surfaceRail: "rgba(5, 13, 24, 0.86)",
  lineSubtle: "rgba(84, 167, 255, 0.22)",
  lineActive: "rgba(40, 213, 255, 0.75)",
  electricBlue: "#1F7CFF",
  eyeRimBlue: "#0066FF",
  eyeHaloGlow: "rgba(40, 213, 255, 0.22)",
};

// Freeze at runtime without narrowing colors to literals: consumers may derive
// mutable status colors from a palette entry and then select another entry.
export const LOOI_PALETTE = Object.freeze(paletteTokens);

/** Legible type sizes at a docked viewing distance of 50-80 cm. */
export const LOOI_TYPE = Object.freeze({
  title: 28,
  heading: 24,
  cardTitle: 18,
  body: 15,
  description: 14,
  badge: 13,
  timestamp: 12,
});

export function getColorForReceiptStatus(status: ActionReceiptStatus): string {
  switch (status) {
    case "verified":
      return LOOI_PALETTE.confirmGreen;
    case "accepted":
    case "sent":
    case "observed":
      return LOOI_PALETTE.presenceCyan;
    case "unverified":
    case "unknown":
      return LOOI_PALETTE.amberWarning;
    case "rejected":
    case "failed":
      return LOOI_PALETTE.alertCoral;
    default:
      return LOOI_PALETTE.textMuted;
  }
}

export function getColorForClaimStatus(status: ClaimStatus): string {
  switch (status) {
    case "confirmed":
      return LOOI_PALETTE.confirmGreen;
    case "observed":
      return LOOI_PALETTE.presenceCyan;
    case "candidate":
    case "inferred":
      return LOOI_PALETTE.amberWarning;
    case "retracted":
    case "superseded":
      return LOOI_PALETTE.textMuted;
    default:
      return LOOI_PALETTE.textMuted;
  }
}
