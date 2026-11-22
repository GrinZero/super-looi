import type {
  NativeNotificationPermissionStatus,
  NativePermissionStatusResult,
  NativeScheduleEvent,
  NativeSchedulePort,
  NativeUpcomingAlarm,
  NativeQuietHoursSnapshot,
  NativeScheduleNotification,
} from "@super-looi/runtime/schedule";

export interface NativeScheduleExactAlarmStatus {
  mode: string;
  degraded: boolean;
  canOpenSettings: boolean;
  reason: string;
}

export interface NativeScheduleAlarmSyncResult {
  syncedCount: number;
  cancelledCount: number;
  exactAlarmDegraded: boolean;
  exactAlarmMode: string;
}

export interface NativeScheduleKeepAliveState {
  active: boolean;
  hasRunningCheck: boolean;
  quotaExhausted: boolean;
  dailyUsedMs: number;
  dailyCapMs: number;
  sessionUsedMs: number;
  sessionCapMs: number;
  reason: string;
}

export interface RawScheduleNativeEvent {
  kind: string;
  ruleId: string;
  notificationId: string;
  handle: string;
  payloadJson: string;
  occurredAtMs: number;
}

/** Structural contract matching `ScheduleHost` from `"super-looi/native"`. */
export interface NativeScheduleHost {
  permissionStatus(): string;
  requestPermission(): Promise<string>;
  exactAlarmStatus(): NativeScheduleExactAlarmStatus;
  openExactAlarmSettings(): boolean;
  syncUpcomingAlarms(alarmsJson: string): NativeScheduleAlarmSyncResult;
  cancelAlarm(ruleId: string): boolean;
  syncQuietHours(quietSnapshotJson: string): void;
  postNotification(payloadJson: string): string;
  setAndroidKeepAlive(
    active: boolean,
    hasRunningCheck: boolean,
    nextTriggerAtMs?: number | null,
  ): NativeScheduleKeepAliveState;
  beginIosBackgroundGrace(label: string): string;
  endIosBackgroundGrace(handle: string): void;
  drainEvents(): RawScheduleNativeEvent[];
  setForeground(active: boolean): void;
  dispose?(): void;
}

function normalizePermissionStatus(raw: string): NativeNotificationPermissionStatus {
  if (raw === "granted" || raw === "denied" || raw === "undetermined") {
    return raw;
  }
  return "unavailable";
}

function buildPermissionResult(
  notificationRaw: string,
  exact?: NativeScheduleExactAlarmStatus,
): NativePermissionStatusResult {
  return {
    notification: normalizePermissionStatus(notificationRaw),
    ...(exact
      ? {
          exactAlarmAllowed: !exact.degraded && exact.mode === "exact",
          exactAlarmDegraded: exact.degraded,
        }
      : {}),
  };
}

function mapRawNativeEvent(raw: RawScheduleNativeEvent): NativeScheduleEvent | undefined {
  let sessionId: string | undefined;
  if (raw.payloadJson) {
    try {
      const parsed = JSON.parse(raw.payloadJson) as { sessionId?: unknown };
      if (typeof parsed?.sessionId === "string" && parsed.sessionId.trim()) {
        sessionId = parsed.sessionId.trim();
      }
    } catch {
      // Ignore malformed optional metadata JSON; preserve core event fields.
    }
  }
  const timestampMs =
    typeof raw.occurredAtMs === "number" && Number.isFinite(raw.occurredAtMs) && raw.occurredAtMs > 0
      ? raw.occurredAtMs
      : undefined;

  switch (raw.kind) {
    case "notification_tapped":
      return {
        kind: "notification_tapped",
        ruleId: raw.ruleId,
        ...(raw.handle ? { runId: raw.handle } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      };
    case "alarm_fired":
      return {
        kind: "alarm_fired",
        ruleId: raw.ruleId,
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      };
    case "ios_grace_expiring":
      return {
        kind: "ios_grace_expiring",
        ...(raw.handle ? { handle: raw.handle } : {}),
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      };
    case "keepalive_timeout":
      return {
        kind: "keepalive_timeout",
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      };
    default:
      return undefined;
  }
}

export function isNativeScheduleHost(
  candidate: NativeSchedulePort | NativeScheduleHost | null | undefined,
): candidate is NativeScheduleHost {
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      typeof (candidate as NativeScheduleHost).exactAlarmStatus === "function" &&
      typeof (candidate as NativeScheduleHost).setForeground === "function",
  );
}

/**
 * Adapts the Rust `ScheduleHost` bridge (`super-looi/native`) to `@super-looi/runtime/schedule`'s `NativeSchedulePort`.
 */
export function createScheduleNativePort(host: NativeScheduleHost): NativeSchedulePort {
  return {
    permissionStatus() {
      return buildPermissionResult(host.permissionStatus(), host.exactAlarmStatus());
    },
    async requestPermission() {
      const permission = await host.requestPermission();
      return buildPermissionResult(permission, host.exactAlarmStatus());
    },
    syncUpcomingAlarms(alarms: readonly NativeUpcomingAlarm[]) {
      host.syncUpcomingAlarms(JSON.stringify(alarms));
    },
    cancelAlarm(ruleId: string) {
      host.cancelAlarm(ruleId);
    },
    syncQuietHours(snapshot: NativeQuietHoursSnapshot) {
      host.syncQuietHours(JSON.stringify(snapshot));
    },
    postNotification(notification: NativeScheduleNotification) {
      host.postNotification(JSON.stringify(notification));
    },
    setAndroidKeepAlive(input) {
      host.setAndroidKeepAlive(
        input.active,
        input.hasRunningCheck,
        input.nextTriggerAtMs ?? null,
      );
    },
    beginIosBackgroundGrace(label: string) {
      return host.beginIosBackgroundGrace(label) || null;
    },
    endIosBackgroundGrace(handle: string) {
      host.endIosBackgroundGrace(handle);
    },
    drainEvents() {
      const mapped: NativeScheduleEvent[] = [];
      for (const raw of host.drainEvents()) {
        const event = mapRawNativeEvent(raw);
        if (event) mapped.push(event);
      }
      return mapped;
    },
    openExactAlarmSettings() {
      host.openExactAlarmSettings();
    },
  };
}
