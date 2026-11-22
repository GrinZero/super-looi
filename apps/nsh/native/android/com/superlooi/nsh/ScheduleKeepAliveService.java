package com.superlooi.nsh;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * On-demand Android 15+ compliant {@code dataSync} foreground service for short-window (&lt;= 30 min)
 * scheduled execution and in-flight checks. Enforces 5h/24h daily cap, 60min per-background cap,
 * check-scoped partial WakeLock, and mandatory {@code onTimeout} immediate stop.
 */
public final class ScheduleKeepAliveService extends Service {
    public static final long DAILY_CAP_MS = 18_000_000L; // 5h conservative cap below Android 15's 6h limit
    public static final long SESSION_CAP_MS = 3_600_000L; // 60min per background session cap

    private static final String ACTION_UPDATE = "com.superlooi.nsh.ACTION_KEEPALIVE_UPDATE";
    private static final String EXTRA_HAS_RUNNING_CHECK = "hasRunningCheck";
    private static final String EXTRA_NEXT_TRIGGER_AT_MS = "nextTriggerAtMs";
    private static final int FOREGROUND_NOTIFICATION_ID = 7503;
    private static final long WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private static final long WATCHDOG_INTERVAL_MS = 15_000L;

    private static final Object STATE_LOCK = new Object();
    private static volatile boolean desiredActive;
    private static volatile boolean desiredHasRunningCheck;
    private static volatile boolean serviceRunning;
    private static volatile boolean currentHasRunningCheck;
    private static volatile long activeSpanStartMs;
    private static volatile long backgroundSessionUsedMs;
    private static volatile long backgroundEnteredAtMs;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (!serviceRunning) return;
            if (!enforceBudgetsAndFlush(ScheduleKeepAliveService.this)) {
                return;
            }
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS);
        }
    };

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public void onCreate() {
        super.onCreate();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "com.superlooi.nsh:schedule_check");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        ScheduleBridge.ensureChannels(this);
        boolean initialHasRunningCheck;
        synchronized (STATE_LOCK) {
            initialHasRunningCheck = desiredActive && desiredHasRunningCheck;
        }
        // Always promote to foreground before inspecting desiredActive so Android never throws
        // ForegroundServiceDidNotStartInTimeException when stopService races with startup.
        startForegroundCompat(buildForegroundNotification(initialHasRunningCheck));

        long now = System.currentTimeMillis();
        final boolean shouldRun;
        final boolean effectiveHasRunningCheck;
        synchronized (STATE_LOCK) {
            shouldRun = desiredActive;
            if (!shouldRun) {
                serviceRunning = false;
                currentHasRunningCheck = false;
                activeSpanStartMs = 0L;
                effectiveHasRunningCheck = false;
            } else {
                effectiveHasRunningCheck = desiredHasRunningCheck;
                if (!serviceRunning) {
                    serviceRunning = true;
                    activeSpanStartMs = now;
                    if (!ScheduleBridge.isForegroundActive() && backgroundEnteredAtMs == 0L) {
                        backgroundEnteredAtMs = now;
                    }
                }
                currentHasRunningCheck = effectiveHasRunningCheck;
            }
        }

        if (!shouldRun) {
            stopCleanly(startId, false);
            return START_NOT_STICKY;
        }

        if (effectiveHasRunningCheck != initialHasRunningCheck) {
            startForegroundCompat(buildForegroundNotification(effectiveHasRunningCheck));
        }

        if (!enforceBudgetsAndFlush(this)) {
            return START_NOT_STICKY;
        }

        updateWakeLock(effectiveHasRunningCheck);
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS);
        return START_NOT_STICKY;
    }

    @Override public void onTimeout(int startId, int fgsType) {
        handleSystemTimeout(startId, fgsType);
    }

    @Override public void onTimeout(int startId) {
        handleSystemTimeout(startId, 0);
    }

    private void handleSystemTimeout(int startId, int fgsType) {
        releaseWakeLock();
        handler.removeCallbacks(watchdog);
        long now = System.currentTimeMillis();
        flushUsageLocked(this, now);
        synchronized (STATE_LOCK) {
            desiredActive = false;
            desiredHasRunningCheck = false;
            serviceRunning = false;
            currentHasRunningCheck = false;
            activeSpanStartMs = 0L;
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("startId", startId);
            payload.put("fgsType", fgsType);
        } catch (JSONException ignored) {}
        ScheduleBridge.enqueueEvent("keepalive_timeout", "", "", "", payload.toString());
        stopForegroundCompat();
        stopSelf(startId);
        stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(watchdog);
        releaseWakeLock();
        flushUsageLocked(this, System.currentTimeMillis());
        synchronized (STATE_LOCK) {
            serviceRunning = false;
            currentHasRunningCheck = false;
            activeSpanStartMs = 0L;
        }
        stopForegroundCompat();
        super.onDestroy();
    }

    private Notification buildForegroundNotification(boolean hasRunningCheck) {
        String title = hasRunningCheck ? "LOOI 正在执行定时检查" : "LOOI 定时调度待命中";
        String body = hasRunningCheck
                ? "正在后台完成只读状态检查"
                : "短窗口定时任务即将触发";
        PendingIntent tapIntent = ScheduleBridge.buildTapPendingIntent(this, "", "looi.sched.keepalive", "", "", "keepalive");
        return ScheduleBridge.buildNotification(this, ScheduleBridge.CHANNEL_SILENT, title, body, true, tapIntent);
    }

    @SuppressWarnings("deprecation")
    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification);
        }
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void updateWakeLock(boolean hasRunningCheck) {
        if (wakeLock == null) return;
        try {
            if (hasRunningCheck) {
                wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
            } else {
                releaseWakeLock();
            }
        } catch (RuntimeException ignored) {}
    }

    private void releaseWakeLock() {
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) {
                    wakeLock.release();
                }
            } catch (RuntimeException ignored) {}
        }
    }

    private void stopCleanly(int startId, boolean clearDesired) {
        releaseWakeLock();
        handler.removeCallbacks(watchdog);
        synchronized (STATE_LOCK) {
            if (clearDesired) {
                desiredActive = false;
                desiredHasRunningCheck = false;
            }
            serviceRunning = false;
            currentHasRunningCheck = false;
            activeSpanStartMs = 0L;
        }
        stopForegroundCompat();
        if (startId > 0) {
            stopSelf(startId);
        } else {
            stopSelf();
        }
    }

    private static boolean enforceBudgetsAndFlush(ScheduleKeepAliveService service) {
        long now = System.currentTimeMillis();
        flushUsageLocked(service, now);
        long dailyUsed = ScheduleBridge.getRolling24hUsedMs(service, now);
        long sessionUsed = currentSessionUsedMs(now);
        if (dailyUsed >= DAILY_CAP_MS) {
            ScheduleBridge.enqueueEvent(
                    "keepalive_timeout",
                    "",
                    "",
                    "",
                    "{\"reason\":\"daily_cap_reached\"}");
            service.stopCleanly(-1, true);
            return false;
        }
        if (!ScheduleBridge.isForegroundActive() && sessionUsed >= SESSION_CAP_MS) {
            ScheduleBridge.enqueueEvent(
                    "keepalive_timeout",
                    "",
                    "",
                    "",
                    "{\"reason\":\"session_cap_reached\"}");
            service.stopCleanly(-1, true);
            return false;
        }
        return true;
    }

    private static void flushUsageLocked(Context context, long nowMs) {
        long start;
        long bgStart;
        synchronized (STATE_LOCK) {
            start = activeSpanStartMs;
            if (start > 0L && nowMs > start) {
                activeSpanStartMs = nowMs;
            }
            bgStart = backgroundEnteredAtMs;
            if (serviceRunning && !ScheduleBridge.isForegroundActive() && bgStart > 0L && nowMs > bgStart) {
                backgroundSessionUsedMs += (nowMs - bgStart);
                backgroundEnteredAtMs = nowMs;
            }
        }
        if (start > 0L && nowMs > start) {
            ScheduleBridge.recordKeepAliveSpan(context, start, nowMs);
        }
    }

    private static long currentSessionUsedMs(long nowMs) {
        synchronized (STATE_LOCK) {
            long used = backgroundSessionUsedMs;
            if (serviceRunning && !ScheduleBridge.isForegroundActive() && backgroundEnteredAtMs > 0L && nowMs > backgroundEnteredAtMs) {
                used += (nowMs - backgroundEnteredAtMs);
            }
            return used;
        }
    }

    static void onAppForegroundChanged(Context context, boolean foreground) {
        long now = System.currentTimeMillis();
        flushUsageLocked(context, now);
        synchronized (STATE_LOCK) {
            if (foreground) {
                backgroundSessionUsedMs = 0L;
                backgroundEnteredAtMs = 0L;
            } else if (serviceRunning && backgroundEnteredAtMs == 0L) {
                backgroundEnteredAtMs = now;
            }
        }
    }

    static String configure(Context context, boolean active, boolean hasRunningCheck, long nextTriggerAtMs) {
        long now = System.currentTimeMillis();
        flushUsageLocked(context, now);

        if (!active) {
            synchronized (STATE_LOCK) {
                desiredActive = false;
                desiredHasRunningCheck = false;
                serviceRunning = false;
                currentHasRunningCheck = false;
                activeSpanStartMs = 0L;
            }
            try {
                context.stopService(new Intent(context, ScheduleKeepAliveService.class));
            } catch (RuntimeException ignored) {}
            return stateJson(context, false, false, false, "", now);
        }

        long dailyUsed = ScheduleBridge.getRolling24hUsedMs(context, now);
        if (dailyUsed >= DAILY_CAP_MS) {
            synchronized (STATE_LOCK) {
                desiredActive = false;
                desiredHasRunningCheck = false;
                serviceRunning = false;
                currentHasRunningCheck = false;
                activeSpanStartMs = 0L;
            }
            try {
                context.stopService(new Intent(context, ScheduleKeepAliveService.class));
            } catch (RuntimeException ignored) {}
            return stateJson(context, false, false, true, "24h dataSync keepalive cap (5h) reached", now);
        }

        long sessionUsed = currentSessionUsedMs(now);
        if (!ScheduleBridge.isForegroundActive() && sessionUsed >= SESSION_CAP_MS) {
            synchronized (STATE_LOCK) {
                desiredActive = false;
                desiredHasRunningCheck = false;
                serviceRunning = false;
                currentHasRunningCheck = false;
                activeSpanStartMs = 0L;
            }
            try {
                context.stopService(new Intent(context, ScheduleKeepAliveService.class));
            } catch (RuntimeException ignored) {}
            return stateJson(context, false, false, true, "60min per-background keepalive cap reached", now);
        }

        synchronized (STATE_LOCK) {
            desiredActive = true;
            desiredHasRunningCheck = hasRunningCheck;
        }

        Intent svc = new Intent(context, ScheduleKeepAliveService.class);
        svc.setAction(ACTION_UPDATE);
        svc.putExtra(EXTRA_HAS_RUNNING_CHECK, hasRunningCheck);
        svc.putExtra(EXTRA_NEXT_TRIGGER_AT_MS, nextTriggerAtMs);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (RuntimeException error) {
            synchronized (STATE_LOCK) {
                desiredActive = false;
                desiredHasRunningCheck = false;
                serviceRunning = false;
                currentHasRunningCheck = false;
                activeSpanStartMs = 0L;
            }
            throw new IllegalStateException("ERR_KEEPALIVE_START_NOT_ALLOWED: " + error.getMessage(), error);
        }

        final boolean effectiveActive;
        final boolean effectiveCheck;
        synchronized (STATE_LOCK) {
            effectiveActive = desiredActive;
            effectiveCheck = desiredActive && desiredHasRunningCheck;
            if (desiredActive) {
                serviceRunning = true;
                currentHasRunningCheck = effectiveCheck;
                if (activeSpanStartMs == 0L) activeSpanStartMs = now;
                if (!ScheduleBridge.isForegroundActive() && backgroundEnteredAtMs == 0L) {
                    backgroundEnteredAtMs = now;
                }
            }
        }
        return stateJson(context, effectiveActive, effectiveCheck, false, "", now);
    }

    private static String stateJson(
            Context context,
            boolean active,
            boolean hasRunningCheck,
            boolean quotaExhausted,
            String reason,
            long nowMs) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("active", active);
            obj.put("hasRunningCheck", hasRunningCheck);
            obj.put("quotaExhausted", quotaExhausted);
            obj.put("dailyUsedMs", (double) ScheduleBridge.getRolling24hUsedMs(context, nowMs));
            obj.put("dailyCapMs", (double) DAILY_CAP_MS);
            obj.put("sessionUsedMs", (double) currentSessionUsedMs(nowMs));
            obj.put("sessionCapMs", (double) SESSION_CAP_MS);
            obj.put("reason", reason != null ? reason : "");
            return obj.toString();
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_KEEPALIVE_STATE_JSON: " + error.getMessage(), error);
        }
    }
}
