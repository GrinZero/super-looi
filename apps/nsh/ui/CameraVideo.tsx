import { nativeComponent } from "nsh";

export interface CameraVideoState {
  sessionId: string;
  frames: number;
  width: number;
  height: number;
  timestampMs: number;
  error: number;
  displayed: boolean | null;
  closed: boolean;
  failure: string | null;
}

/** Displays an existing native session; mounting never opens a camera connection. */
export const CameraVideo = nativeComponent<
  { sessionId: string },
  { state: CameraVideoState }
>("looi.CameraVideo", { props: ["sessionId"], events: ["state"] });
