import { nativeComponent } from "nsh";

export interface DeviceCameraPreviewState {
  sessionId: string;
  facing: "front" | "back";
  frames: number;
  width: number;
  height: number;
  capturedAtMs: number;
  error: number;
  displayed: boolean | null;
  closed: boolean;
  failure: string | null;
}

/**
 * Displays an active phone front/back camera session (`previewSessionId` from `ctx.vision.subscribeFrames`).
 * Mounting this component never opens hardware on its own; hardware lifecycle stays strictly governed by `EffectScope`.
 */
export const DeviceCameraPreview = nativeComponent<
  { sessionId: string },
  { state: DeviceCameraPreviewState }
>("looi.DeviceCameraPreview", { props: ["sessionId"], events: ["state"] });
