import { randomUUID } from "node:crypto";
import type {
  EffectScope,
  LanHttpRequest,
  LanHttpResponse,
  LanRoomSession,
  NativeLanRoomInfo,
  NativeLanRoomPort,
  PluginLanRoomCapability,
  PluginManifest,
} from "./plugins/contracts.js";
import { extractPluginFailure, PluginKernelError } from "./plugins/errors.js";

export type {
  LanHttpRequest,
  LanHttpResponse,
  LanRoomSession,
  NativeLanRoomInfo,
  NativeLanRoomPort,
};

interface ActiveRoomRecord {
  readonly roomId: string;
  readonly pluginId?: string;
  readonly onRequest: (req: LanHttpRequest) => Promise<LanHttpResponse> | LanHttpResponse;
  port: number;
  lanIpv4: string | null;
  baseUrl: string;
  closed: boolean;
  suspendedByBackground: boolean;
  lastRevision: number;
  reopenPromise?: Promise<void>;
  readonly detachScope?: () => void;
}

function normalizeLanIpv4(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseStringRecordJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function isTerminalLanLoopError(error: unknown): boolean {
  const text =
    error && typeof error === "object" && "code" in error
      ? `${String((error as { code?: unknown }).code)} ${String(error)}`
      : String(error);
  return (
    text.includes("ERR_LAN_ROOM_CLOSED") ||
    text.includes("ERR_LAN_ROOM_MISSING") ||
    text.includes("ERR_LAN_ROOM_BACKGROUNDED")
  );
}

/**
 * Mediates foreground-bound local Wi-Fi HTTP companion rooms (`LanRoomHost`) for tabletop plugins.
 * Automatically tears down open sockets on `EffectScope` disposal, app backgrounding, or runtime close.
 */
export class LanRoomBroker {
  private port: NativeLanRoomPort | null = null;
  private foregroundActive = true;
  private closed = false;
  private readonly rooms = new Map<string, ActiveRoomRecord>();

  attachNativePort(port: NativeLanRoomPort | null): void {
    if (this.closed) {
      try {
        port?.stopAll();
        port?.dispose?.();
      } catch {}
      return;
    }
    if (this.port && this.port !== port) {
      const prev = this.port;
      this.teardownAllRooms();
      try {
        prev.stopAll();
        prev.dispose?.();
      } catch {}
    }
    this.port = port;
    if (this.port) {
      try {
        this.port.setForeground(this.foregroundActive);
      } catch {}
    }
  }

  setForegroundActive(active: boolean): void {
    if (this.foregroundActive === active) return;
    this.foregroundActive = active;
    if (!active) {
      for (const record of this.rooms.values()) {
        if (!record.closed) {
          record.suspendedByBackground = true;
          try {
            this.port?.closeRoom(record.roomId);
          } catch {}
        }
      }
      try {
        this.port?.setForeground(false);
        this.port?.stopAll();
      } catch {}
      return;
    }
    if (!this.closed && this.port) {
      try {
        this.port.setForeground(true);
      } catch {}
      for (const record of this.rooms.values()) {
        if (!record.closed && record.suspendedByBackground) {
          void this.rebindRecord(record).catch(() => {});
        }
      }
    }
  }

  async openRoom(options: {
    pluginId?: string;
    scope?: EffectScope;
    preferredPort?: number;
    onRequest: (req: LanHttpRequest) => Promise<LanHttpResponse> | LanHttpResponse;
  }): Promise<LanRoomSession> {
    const stage = options.pluginId
      ? `plugin:${options.pluginId}:lan.openRoom`
      : "lan.openRoom";

    if (this.closed || !this.port) {
      throw new PluginKernelError({
        stage,
        code: "ERR_LAN_ROOM_UNAVAILABLE",
        pluginId: options.pluginId,
        reason: "Native LanRoomHost is not attached",
      });
    }
    if (!this.foregroundActive) {
      throw new PluginKernelError({
        stage,
        code: "ERR_LAN_ROOM_BACKGROUNDED",
        pluginId: options.pluginId,
        reason: "Cannot open LAN companion room while app is in background",
      });
    }
    if (options.scope && !options.scope.active) {
      throw new PluginKernelError({
        stage,
        code: "ERR_PLUGIN_SCOPE_DISPOSED",
        pluginId: options.pluginId,
        reason: "Cannot open LAN companion room on a disposed EffectScope",
      });
    }

    const requestedId = `lan_${randomUUID()}`;
    let info: NativeLanRoomInfo;
    try {
      info = await this.port.openRoom(requestedId, options.preferredPort);
    } catch (error) {
      const failure = extractPluginFailure(error, stage, "ERR_LAN_ROOM_OPEN_FAILED");
      throw new PluginKernelError({
        stage: failure.stage,
        code: failure.code !== undefined ? String(failure.code) : "ERR_LAN_ROOM_OPEN_FAILED",
        pluginId: options.pluginId,
        reason: failure.reason,
        cause: error,
      });
    }

    if (this.closed || !this.foregroundActive || (options.scope && !options.scope.active)) {
      try {
        this.port?.closeRoom(info.roomId);
      } catch {}
      throw new PluginKernelError({
        stage,
        code: !this.foregroundActive ? "ERR_LAN_ROOM_BACKGROUNDED" : "ERR_LAN_ROOM_CLOSED",
        pluginId: options.pluginId,
        reason: "LAN room lifecycle ended while binding socket",
      });
    }

    let detachScope: (() => void) | undefined;
    const record: ActiveRoomRecord = {
      roomId: info.roomId,
      pluginId: options.pluginId,
      onRequest: options.onRequest,
      port: info.port,
      lanIpv4: normalizeLanIpv4(info.lanIpv4),
      baseUrl: info.baseUrl,
      closed: false,
      suspendedByBackground: false,
      lastRevision: 0,
    };

    const closeRoomInternal = (): void => {
      if (record.closed) return;
      record.closed = true;
      record.suspendedByBackground = false;
      this.rooms.delete(record.roomId);
      detachScope?.();
      detachScope = undefined;
      try {
        this.port?.closeRoom(record.roomId);
      } catch {}
    };

    if (options.scope) {
      detachScope = options.scope.onDispose(closeRoomInternal);
    }

    this.rooms.set(record.roomId, record);
    void this.runRequestLoop(record);

    const broker = this;
    return {
      get roomId() {
        return record.roomId;
      },
      get port() {
        return record.port;
      },
      get baseUrl() {
        return record.baseUrl;
      },
      get lanIpv4() {
        return record.lanIpv4;
      },
      notifyRevision(revision: number): void {
        if (record.closed || broker.closed) return;
        const safeRev = Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
        record.lastRevision = safeRev;
        if (!broker.port || record.suspendedByBackground || !broker.foregroundActive) return;
        try {
          broker.port.notifyRevision(record.roomId, safeRev);
        } catch {}
      },
      refreshAddresses(): { readonly lanIpv4: string | null; readonly baseUrl: string } {
        if (record.closed || broker.closed || !broker.port) {
          return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl };
        }
        if (record.suspendedByBackground && broker.foregroundActive) {
          void broker.rebindRecord(record).catch(() => {});
          return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl };
        }
        try {
          const updated = broker.port.refreshAddresses(record.roomId);
          record.lanIpv4 = normalizeLanIpv4(updated.lanIpv4);
          record.baseUrl = updated.baseUrl;
          if (updated.port > 0) {
            record.port = updated.port;
          }
        } catch {}
        return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl };
      },
      async refreshAddressesAsync(): Promise<{
        readonly lanIpv4: string | null;
        readonly baseUrl: string;
        readonly port: number;
      }> {
        if (record.closed || broker.closed || !broker.port) {
          return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl, port: record.port };
        }
        if (record.suspendedByBackground && broker.foregroundActive) {
          await broker.rebindRecord(record);
          return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl, port: record.port };
        }
        const stage = record.pluginId
          ? `plugin:${record.pluginId}:lan.refreshAddresses`
          : "lan.refreshAddresses";
        try {
          const updated = broker.port.refreshAddresses(record.roomId);
          record.lanIpv4 = normalizeLanIpv4(updated.lanIpv4);
          record.baseUrl = updated.baseUrl;
          if (updated.port > 0) {
            record.port = updated.port;
          }
          return { lanIpv4: record.lanIpv4, baseUrl: record.baseUrl, port: record.port };
        } catch (error) {
          const failure = extractPluginFailure(error, stage, "ERR_LAN_ROOM_REFRESH_FAILED");
          throw new PluginKernelError({
            stage: failure.stage,
            code: failure.code !== undefined ? String(failure.code) : "ERR_LAN_ROOM_REFRESH_FAILED",
            pluginId: record.pluginId,
            reason: failure.reason,
            cause: error,
          });
        }
      },
      async close(): Promise<void> {
        closeRoomInternal();
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownAllRooms();
    if (this.port) {
      try {
        this.port.stopAll();
        this.port.dispose?.();
      } catch {}
      this.port = null;
    }
  }

  private teardownAllRooms(): void {
    for (const record of [...this.rooms.values()]) {
      record.closed = true;
      record.suspendedByBackground = false;
      this.rooms.delete(record.roomId);
      try {
        this.port?.closeRoom(record.roomId);
      } catch {}
    }
  }

  private async rebindRecord(record: ActiveRoomRecord): Promise<void> {
    if (
      this.closed ||
      !this.foregroundActive ||
      record.closed ||
      !record.suspendedByBackground ||
      !this.port
    ) {
      return;
    }
    if (record.reopenPromise) {
      return record.reopenPromise;
    }
    const task = (async () => {
      try {
        const preferredPort = record.port > 0 ? record.port : undefined;
        const info = await this.port!.openRoom(record.roomId, preferredPort);
        if (this.closed || !this.foregroundActive || record.closed) {
          try {
            this.port?.closeRoom(info.roomId);
          } catch {}
          return;
        }
        record.port = info.port;
        record.lanIpv4 = normalizeLanIpv4(info.lanIpv4);
        record.baseUrl = info.baseUrl;
        record.suspendedByBackground = false;
        try {
          this.port?.notifyRevision(record.roomId, record.lastRevision);
        } catch {}
        void this.runRequestLoop(record);
      } catch (error) {
        // Keep suspended logical record intact so subsequent foreground/refresh can retry.
        const stage = record.pluginId
          ? `plugin:${record.pluginId}:lan.rebind`
          : "lan.rebind";
        const failure = extractPluginFailure(error, stage, "ERR_LAN_ROOM_REBIND_FAILED");
        throw new PluginKernelError({
          stage: failure.stage,
          code: failure.code !== undefined ? String(failure.code) : "ERR_LAN_ROOM_REBIND_FAILED",
          pluginId: record.pluginId,
          reason: failure.reason,
          cause: error,
        });
      } finally {
        record.reopenPromise = undefined;
      }
    })();
    record.reopenPromise = task;
    return task;
  }

  private async runRequestLoop(record: ActiveRoomRecord): Promise<void> {
    while (!this.closed && this.foregroundActive && !record.closed && this.port) {
      const port = this.port;
      let rawReq;
      try {
        rawReq = await port.nextRequest(record.roomId);
      } catch (error) {
        if (record.closed || this.closed || !this.foregroundActive || isTerminalLanLoopError(error)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }

      if (record.closed || this.closed || !this.foregroundActive) {
        break;
      }

      void (async () => {
        const method: "GET" | "POST" = rawReq.method.toUpperCase() === "POST" ? "POST" : "GET";
        const req: LanHttpRequest = {
          method,
          path: rawReq.path || "/",
          query: parseStringRecordJson(rawReq.queryJson),
          headers: parseStringRecordJson(rawReq.headersJson),
          bodyText: rawReq.bodyText ?? "",
          remoteAddr: rawReq.remoteAddr ?? "",
        };
        try {
          const res = await record.onRequest(req);
          if (record.closed || this.closed) return;
          port.respondRequest(
            record.roomId,
            rawReq.requestId,
            Number.isInteger(res.status) ? res.status : 200,
            res.contentType || "application/json; charset=utf-8",
            res.cacheControl ?? "no-store",
            res.body ?? "",
          );
        } catch (error) {
          if (record.closed || this.closed) return;
          const failure = extractPluginFailure(
            error,
            record.pluginId ? `plugin:${record.pluginId}:lan.onRequest` : "lan.onRequest",
            "ERR_LAN_HANDLER_FAILED",
          );
          port.respondRequest(
            record.roomId,
            rawReq.requestId,
            500,
            "application/json; charset=utf-8",
            "no-store",
            JSON.stringify({
              ok: false,
              error: {
                stage: failure.stage,
                code: failure.code ?? "ERR_LAN_HANDLER_FAILED",
                reason: failure.reason,
              },
            }),
          );
        }
      })();
    }
  }
}

export function createLanRoomCapability(
  manifest: PluginManifest,
  pluginScope: EffectScope,
  broker: LanRoomBroker,
): PluginLanRoomCapability | undefined {
  if (!manifest.permissions.includes("network.lan_room")) {
    return undefined;
  }
  return {
    openRoom: (options) =>
      broker.openRoom({
        pluginId: manifest.id,
        scope: options.scope ?? pluginScope,
        preferredPort: options.preferredPort,
        onRequest: options.onRequest,
      }),
  };
}
