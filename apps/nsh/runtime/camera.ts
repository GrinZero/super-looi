/** App-owned native camera port. Media bytes cross JS only on an explicit capture. */
export interface CameraFrame {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  receivedAt: string;
}
export interface CameraAccountState {
  state: "initializing" | "unavailable" | "signed_out" | "captcha" | "verification" | "continuing" | "ready";
  image?: string;
  destination?: string;
  error?: string;
  sentAt?: number;
  devices?: Array<{ did: string; name: string; model: string; host: string; online: boolean }>;
}
export interface NativeCamera {
  initialize(): Promise<string>;
  login(username: string, password: string, region: string): Promise<string>;
  submit(answer: string): Promise<string>;
  resumeLogin(): Promise<string>;
  refreshCaptcha(): Promise<string>;
  resendTicket(): Promise<string>;
  cancelLogin(): void;
  logout(): Promise<void>;
  openPreview(did: string): Promise<string>;
  closePreview(sessionId: string): void;
  beginCapture(did: string): string;
  cancelCapture(requestId: string): void;
  captureDevice(requestId: string): Promise<CameraFrame>;
  stopAll(): void;
}
