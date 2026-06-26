import * as Battery from "expo-battery";
import { CameraMode } from "../perceivers/camera-perceiver";

/**
 * Decide camera mode based on device state
 */
export async function decideCameraMode(): Promise<CameraMode> {
  try {
    const batteryState = await Battery.getBatteryStateAsync();
    const isCharging =
      batteryState === Battery.BatteryState.CHARGING ||
      batteryState === Battery.BatteryState.FULL;

    // In Phase 1, streaming requires charging + stable network
    // For simplicity, just check charging state
    if (isCharging) {
      return "streaming";
    }

    return "smart_capture";
  } catch {
    return "smart_capture";
  }
}

/**
 * Subscribe to battery state changes and update camera mode
 */
export function subscribeToBatteryChanges(
  onModeChange: (mode: CameraMode) => void
): () => void {
  const subscription = Battery.addBatteryStateListener(async ({ batteryState }) => {
    const isCharging =
      batteryState === Battery.BatteryState.CHARGING ||
      batteryState === Battery.BatteryState.FULL;

    onModeChange(isCharging ? "streaming" : "smart_capture");
  });

  return () => subscription.remove();
}
