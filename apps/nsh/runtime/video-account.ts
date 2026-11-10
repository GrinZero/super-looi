import type { CameraAccountState, NativeCamera } from "./camera.js";

export type XiaomiVideoLoginStep = "credentials" | "captcha" | "two_factor" | "continuing";
export interface XiaomiVideoLoginState {
  step: XiaomiVideoLoginStep;
  attempt: number;
  account: string;
  region: string;
  error: string | null;
  busy: boolean;
  canResume: boolean;
  captchaImage: string;
  destination: string;
  smsCountdown: number;
}
export interface XiaomiVideoAuthState {
  authorized: boolean;
  account: string;
  cameraCount: number;
}

export function videoAccountError(error: string): string {
  const messages: Record<string, string> = {
    camera_host_unavailable: "视频服务尚未就绪，请稍后重试。",
    camera_login_network: "无法连接小米账号服务，请重试当前步骤。",
    camera_cloud_network: "无法读取米家摄像头，请重试当前步骤。",
    camera_captcha_rejected: "图形验证码不正确，请重新输入。",
    camera_password_rejected: "账号或密码不正确。",
    camera_verification_rejected: "验证码不正确，请重新输入。",
    camera_verification_send_failed: "小米未能发送验证码，请重试。",
    camera_verification_unsupported: "此账号要求的验证方式暂不支持。",
    camera_account_expired: "视频账号已过期，请重新登录。",
    camera_challenge_missing: "验证已失效，请返回重新登录。",
    camera_region_unsupported: "暂不支持此视频账号区域。",
  };
  return messages[error] ?? `视频连接失败：${error}`;
}

/** Owns one sign-in attempt. Only native discovery and credential commit authorize it. */
export class VideoAccount {
  login: XiaomiVideoLoginState = {
    step: "credentials", attempt: 0, account: "", region: "cn", error: null, busy: false, canResume: false,
    captchaImage: "", destination: "", smsCountdown: 0,
  };
  auth: XiaomiVideoAuthState = { authorized: false, account: "", cameraCount: 0 };
  private revision = 0;
  private sentAt = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    native: () => NativeCamera | undefined;
    onChange: () => void;
    onAuthorized: () => void;
  }) {}

  start(region: string) {
    this.cancel();
    this.login = { ...this.login, step: "credentials", attempt: this.login.attempt + 1, region, captchaImage: "", destination: "" };
    this.options.onChange();
  }

  cancel() {
    ++this.revision;
    this.options.native()?.cancelLogin();
    clearInterval(this.timer);
    this.timer = undefined;
    this.login = { ...this.login, busy: false, canResume: false, error: null, smsCountdown: 0 };
    this.options.onChange();
  }

  initialize() {
    this.login.canResume = true;
    return this.run(native => native.initialize(), false);
  }

  credentials(params: { account: string; password?: string; region?: string }) {
    if (this.login.busy) return Promise.resolve();
    this.login = { ...this.login, account: params.account.trim(), region: params.region ?? this.login.region };
    if (!this.login.account || !params.password) {
      this.login.error = !this.login.account ? "请输入米家账号" : "请输入密码";
      this.options.onChange();
      return Promise.resolve();
    }
    this.login.canResume = true;
    return this.run(native => native.login(this.login.account, params.password!, this.login.region));
  }

  answer(code: string) {
    if (!code.trim()) {
      this.login.error = "请输入验证码";
      this.options.onChange();
      return Promise.resolve();
    }
    return this.run(native => native.submit(code.trim()));
  }
  refreshCaptcha() { return this.run(native => native.refreshCaptcha()); }
  resend() {
    if (this.login.smsCountdown > 0) return Promise.resolve();
    return this.run(native => native.resendTicket());
  }
  resume() { return this.run(native => native.resumeLogin()); }
  async disconnect() {
    this.cancel();
    await this.run(async native => {
      await native.logout();
      return JSON.stringify({ state: "signed_out" });
    }, false);
  }

  private async run(operation: (native: NativeCamera) => Promise<string>, navigate = true) {
    if (this.login.busy) return;
    const native = this.options.native();
    if (!native) {
      this.login.error = videoAccountError("camera_host_unavailable");
      this.options.onChange();
      return;
    }
    const revision = this.revision;
    this.login = { ...this.login, busy: true, error: null };
    this.options.onChange();
    try {
      const reply = JSON.parse(await operation(native)) as CameraAccountState;
      if (revision !== this.revision) return;
      this.login = {
        ...this.login,
        step: reply.state === "captcha" ? "captcha" : reply.state === "verification" ? "two_factor" : reply.state === "continuing" ? "continuing" : "credentials",
        captchaImage: reply.image ?? "",
        destination: reply.destination ?? "",
        error: reply.error ? videoAccountError(reply.error) : null,
      };
      if (reply.state === "ready" && !reply.error) {
        this.auth = { authorized: true, account: this.login.account, cameraCount: reply.devices?.length ?? 0 };
        clearInterval(this.timer);
        this.login.smsCountdown = 0;
        if (navigate) this.options.onAuthorized();
      } else if (reply.state === "signed_out") {
        if (!reply.error) this.login.canResume = false;
        this.auth = { authorized: false, account: "", cameraCount: 0 };
      }
      if (reply.state === "verification" && reply.sentAt && reply.sentAt !== this.sentAt) {
        this.sentAt = reply.sentAt;
        clearInterval(this.timer);
        const tick = () => {
          this.login = { ...this.login, smsCountdown: Math.max(0, Math.ceil((this.sentAt + 60_000 - Date.now()) / 1000)) };
          if (!this.login.smsCountdown) clearInterval(this.timer);
          this.options.onChange();
        };
        tick();
        this.timer = setInterval(tick, 1000);
      }
    } catch (error) {
      if (revision === this.revision) this.login = { ...this.login, error: videoAccountError(error instanceof Error ? error.message : String(error)) };
    } finally {
      if (revision === this.revision) {
        this.login = { ...this.login, busy: false };
        this.options.onChange();
      }
    }
  }
}
