/**
 * Light motion detector — basic frame difference algorithm
 * Phase 1: Simple frame differencing for motion detection
 * Phase 1.5: Add YOLO-Nano for object detection
 */

/**
 * Compare two frames (base64) for significant differences
 * Returns a score between 0-1 indicating how much changed
 *
 * Note: In a real implementation, this would use pixel-level comparison.
 * In Phase 1, we simplify by checking frame size differences as a proxy,
 * since actual pixel comparison requires native canvas or vision processing.
 */
export function detectMotion(prevFrame: string | null, currentFrame: string): number {
  if (!prevFrame) return 1.0; // First frame always counts as "changed"

  // Simple heuristic: compare base64 string lengths as a rough proxy
  // Real implementation would decode and compare pixels
  const lenDiff = Math.abs(prevFrame.length - currentFrame.length);
  const maxLen = Math.max(prevFrame.length, currentFrame.length);

  if (maxLen === 0) return 0;

  // Normalize to 0-1 range
  const changeRatio = Math.min(lenDiff / (maxLen * 0.1), 1.0);
  return changeRatio;
}

/**
 * Motion detection threshold
 * Above this value, we consider the scene has changed significantly
 */
export const MOTION_THRESHOLD = 0.3;

/**
 * Check if a scene change is significant enough to trigger capture
 */
export function isSignificantChange(score: number): boolean {
  return score >= MOTION_THRESHOLD;
}
