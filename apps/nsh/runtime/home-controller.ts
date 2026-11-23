import type { DatabaseSync } from "node:sqlite";
import type { UserActionRef } from "@super-looi/contracts";
import type { TileSpan } from "@super-looi/home-devices";
import type { NativeCamera } from "./camera.js";
import { createHomeCache } from "./home-cache.js";
import { HomeRuntime, type HomeSettings } from "./home.js";
import type { UiActionGuard, Vault } from "./vault.js";
import type { VoiceHome } from "./voice/tools/home.js";

/**
 * Mobile smart-home controller: wraps `HomeRuntime` together with the
 * domain-scoped MIoT OAuth login state machine and UI action authorization.
 */
export class HomeController {
  readonly raw: HomeRuntime;
  private loginPending = false;
  private loginAttempt = 0;
  private closed = false;

  constructor(
    private readonly options: {
      vault: Vault;
      database: DatabaseSync;
      assertUiAction: UiActionGuard;
      isClosed: () => boolean;
    },
  ) {
    this.raw = new HomeRuntime({
      vault: options.vault,
      cache: createHomeCache(options.database),
    });
  }

  private isClosed(): boolean {
    return this.closed || this.options.isClosed();
  }

  get isLoginPending(): boolean {
    return this.loginPending;
  }

  configuration() {
    return this.raw.configuration();
  }

  connection() {
    return this.raw.connection();
  }

  voiceHome(): VoiceHome | undefined {
    return this.raw.configuration().mode === "disabled" ? undefined : this.raw;
  }

  async configure(input: HomeSettings, action: UserActionRef) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    return this.raw.configure(input);
  }

  async connect() {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    return this.raw.connect();
  }

  async beginMiotLogin(
    region: NonNullable<HomeSettings["region"]>,
    action: UserActionRef,
  ) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    const attempt = ++this.loginAttempt;
    this.loginPending = true;
    try {
      const session = await this.raw.beginMiotLogin(region);
      if (attempt !== this.loginAttempt || this.isClosed()) {
        throw new Error("@looi:runtimeXiaomiSigninCancelled");
      }
      return { ...session, attempt };
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    }
  }

  async finishMiotLogin(
    attempt: number,
    callback: string,
    isCurrent: () => boolean,
  ) {
    if (!this.loginPending || attempt !== this.loginAttempt || this.isClosed()) {
      throw new Error("@looi:runtimeXiaomiSigninCancelled");
    }
    try {
      const result = this.raw.interceptMiotCallback(callback);
      if (!result.intercepted || "error" in result) {
        throw new Error("@looi:runtimeXiaomiCallbackIsInvalidOrExpired");
      }
      return await this.raw.finishMiotLogin(
        result.code,
        () =>
          this.loginPending &&
          attempt === this.loginAttempt &&
          !this.isClosed() &&
          isCurrent(),
      );
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    } finally {
      if (attempt === this.loginAttempt) this.loginPending = false;
    }
  }

  cancelMiotLogin(): void {
    ++this.loginAttempt;
    if (!this.loginPending) return;
    this.loginPending = false;
    // Invalidate the pending OAuth exchange and abort its native network request.
    this.raw.suspend();
  }

  async logoutMiot(action: UserActionRef): Promise<void> {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    await this.raw.logoutMiot();
  }

  async list(query = "", offset = 0) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    return this.raw.list(query, offset);
  }

  async dashboard(lang: "zh-CN" | "en-US" = "zh-CN") {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    return this.raw.dashboard(lang);
  }

  cachedDashboard(lang: "zh-CN" | "en-US" = "zh-CN") {
    return this.raw.cachedDashboard(lang);
  }

  async setSourceEnabled(
    source: "direct_miot" | "external_ha" | "simulation",
    enabled: boolean,
    action: UserActionRef,
  ) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    return this.raw.setSourceEnabled(source, enabled);
  }

  setApplianceLayout(
    applianceId: string,
    patch: { span?: TileSpan; order?: number },
  ) {
    if (this.isClosed()) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
    return this.raw.setApplianceLayout(applianceId, patch);
  }

  attachCamera(camera: NativeCamera): void {
    this.raw.attachCamera(camera);
  }

  startCamera(did: string) {
    return this.raw.startCamera(did);
  }

  stopCamera() {
    return this.raw.stopCamera();
  }

  async panTiltCamera(
    did: string,
    direction: "left" | "right" | "up" | "down",
    action: UserActionRef,
  ) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    return this.raw.panTiltCamera(did, direction);
  }

  async controlAppliance(
    command: {
      entity_id: string;
      domain: string;
      service: string;
      service_data?: Record<string, unknown>;
      timeout_ms?: number;
    },
    action: UserActionRef,
  ) {
    if (this.isClosed() || this.loginPending) {
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    }
    this.options.assertUiAction(action);
    let conn = this.raw.connection();
    if (!conn.connectionId && this.raw.configuration().mode !== "disabled") {
      conn = await this.raw.connect();
    }
    if (!conn.connectionId) {
      throw new Error("home_not_configured");
    }
    return this.raw.control(
      {
        entity_id: command.entity_id,
        domain: command.domain,
        service: command.service,
        service_data: (command.service_data ?? {}) as Record<
          string,
          string | number | boolean | null
        >,
        timeout_ms: command.timeout_ms ?? 1500,
      },
      {
        connectionId: conn.connectionId,
        requestId: action.event_id,
      },
    );
  }

  suspend(): void {
    this.raw.suspend();
  }

  close(): void {
    this.closed = true;
    this.cancelMiotLogin();
    this.raw.close();
  }
}
