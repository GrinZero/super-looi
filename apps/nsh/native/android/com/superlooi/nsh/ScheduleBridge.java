package com.superlooi.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.Fragment;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** App-owned Android bridge for schedule alarms, notifications, quiet-hours snapshot, and dataSync keepalive. */
public final class ScheduleBridge {
    static native void registerVm();

    public static final String CHANNEL_ALERTS = "looi_schedule_alerts";
    public static final String CHANNEL_SILENT = "looi_schedule_silent";

    public static final String EXTRA_RULE_ID = "com.superlooi.nsh.SCHEDULE_RULE_ID";
    public static final String EXTRA_NOTIFICATION_ID = "com.superlooi.nsh.SCHEDULE_NOTIFICATION_ID";
    public static final String EXTRA_RUN_ID = "com.superlooi.nsh.SCHEDULE_RUN_ID";
    public static final String EXTRA_SESSION_ID = "com.superlooi.nsh.SCHEDULE_SESSION_ID";
    public static final String EXTRA_SOURCE = "com.superlooi.nsh.SCHEDULE_SOURCE";

    private static final String ACTION_ALARM = "com.superlooi.nsh.SCHEDULE_ALARM";
    private static final String PREFS_NAME = "com.superlooi.nsh.schedule";
    private static final String PREF_PERMISSION_ASKED = "permission_asked";
    private static final String PREF_QUIET_SNAPSHOT = "quiet_snapshot_json";
    private static final String PREF_SYNCED_RULE_IDS = "synced_rule_ids";
    private static final String PREF_KEEPALIVE_SPANS = "keepalive_spans_json";

    private static final int NOTIFICATION_ID_POST = 7501;
    private static final int PERMISSION_REQUEST_CODE = 7403;
    private static final int MAX_EVENTS = 256;
    private static final int MAX_ALARMS = 32;
    private static final long ROLLING_WINDOW_MS = 86_400_000L;

    private static final Object EVENT_LOCK = new Object();
    private static final ArrayDeque<JSONObject> EVENT_QUEUE = new ArrayDeque<>();
    private static final Object PREFS_LOCK = new Object();

    private static volatile boolean permissionPending;
    private static volatile boolean permissionCancelled;
    private static volatile boolean foregroundActive = true;

    private ScheduleBridge() {}

    public static boolean isPermissionRequestPending() {
        return permissionPending;
    }

    public static boolean isForegroundActive() {
        return foregroundActive;
    }

    public static void foreground(boolean active) {
        foregroundActive = active;
        Context app = SuperLooiApplication.appContext();
        if (app != null) {
            ScheduleKeepAliveService.onAppForegroundChanged(app, active);
        }
    }

    public static void captureIntent(Intent intent) {
        if (intent == null) return;
        String ruleId = intent.getStringExtra(EXTRA_RULE_ID);
        if (ruleId == null || ruleId.trim().isEmpty()) {
            return;
        }
        String notificationId = intent.getStringExtra(EXTRA_NOTIFICATION_ID);
        String runId = intent.getStringExtra(EXTRA_RUN_ID);
        String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
        String source = intent.getStringExtra(EXTRA_SOURCE);
        intent.removeExtra(EXTRA_RULE_ID);
        intent.removeExtra(EXTRA_NOTIFICATION_ID);
        intent.removeExtra(EXTRA_RUN_ID);
        intent.removeExtra(EXTRA_SESSION_ID);
        intent.removeExtra(EXTRA_SOURCE);

        JSONObject meta = new JSONObject();
        try {
            meta.put("source", source != null ? source : "notification");
            if (sessionId != null && !sessionId.isEmpty()) {
                meta.put("sessionId", sessionId);
            }
        } catch (JSONException ignored) {}

        enqueueEvent(
                "notification_tapped",
                ruleId.trim(),
                notificationId != null ? notificationId : "",
                runId != null ? runId : "",
                meta.toString());
    }

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static void ensureChannels(Context context) {
        if (context == null || Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (nm.getNotificationChannel(CHANNEL_ALERTS) == null) {
            NotificationChannel alerts = new NotificationChannel(
                    CHANNEL_ALERTS,
                    "Scheduled Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT);
            alerts.setDescription("Scheduled rule results and alarm reminders");
            alerts.setShowBadge(true);
            nm.createNotificationChannel(alerts);
        }

        if (nm.getNotificationChannel(CHANNEL_SILENT) == null) {
            NotificationChannel silent = new NotificationChannel(
                    CHANNEL_SILENT,
                    "Quiet & Keep-Alive",
                    NotificationManager.IMPORTANCE_LOW);
            silent.setDescription("Quiet-hours notifications and short-window schedule keepalive");
            silent.setSound(null, null);
            silent.enableVibration(false);
            silent.setShowBadge(false);
            nm.createNotificationChannel(silent);
        }
    }

    public static String permission() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) return "unavailable";
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return "unavailable";
        if (Build.VERSION.SDK_INT >= 33) {
            if (app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                if (permissionPending) return "undetermined";
                if (permissionCancelled) return "denied";
                return prefs(app).getBoolean(PREF_PERMISSION_ASKED, false) ? "denied" : "undetermined";
            }
        }
        return nm.areNotificationsEnabled() ? "granted" : "denied";
    }

    public static String requestPermission() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) return "unavailable";
        String state = permission();
        if ("granted".equals(state) || "unavailable".equals(state)) return state;
        if (Build.VERSION.SDK_INT < 33) return state;
        if (app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return state;
        }
        final Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null) return "unavailable";
        if (!permissionPending) {
            permissionCancelled = false;
            permissionPending = true;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (SuperLooiApplication.foregroundActivity() != owner || owner.isFinishing()) {
                    permissionPending = false;
                    return;
                }
                try {
                    owner.getFragmentManager()
                            .beginTransaction()
                            .add(new SchedulePermissionFragment(), "looi-schedule-permission")
                            .commit();
                } catch (RuntimeException error) {
                    permissionPending = false;
                }
            });
        }
        return "undetermined";
    }

    @SuppressWarnings("deprecation")
    public static final class SchedulePermissionFragment extends Fragment {
        private boolean requested;

        @Override public void onResume() {
            super.onResume();
            if (!requested && Build.VERSION.SDK_INT >= 33) {
                requested = true;
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST_CODE);
            }
        }

        @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code == PERMISSION_REQUEST_CODE) {
                SuperLooiApplication app = SuperLooiApplication.appContext();
                permissionCancelled = results.length == 0;
                if (!permissionCancelled && app != null) {
                    prefs(app).edit().putBoolean(PREF_PERMISSION_ASKED, true).apply();
                }
                permissionPending = false;
                if (getFragmentManager() != null) {
                    getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
                }
            }
        }
    }

    public static boolean canScheduleExactAlarms(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    public static String exactAlarmStatusJson() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        JSONObject obj = new JSONObject();
        try {
            if (app == null) {
                obj.put("mode", "unavailable");
                obj.put("degraded", true);
                obj.put("canOpenSettings", false);
                obj.put("reason", "Application context unavailable");
                return obj.toString();
            }
            boolean canOpen = Build.VERSION.SDK_INT >= 31;
            boolean exact = canScheduleExactAlarms(app);
            obj.put("mode", exact ? "exact" : "inexact");
            obj.put("degraded", !exact);
            obj.put("canOpenSettings", canOpen);
            obj.put("reason", exact ? "" : "SCHEDULE_EXACT_ALARM permission not granted; falling back to setAndAllowWhileIdle");
            return obj.toString();
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_EXACT_ALARM_JSON: " + error.getMessage(), error);
        }
    }

    public static boolean openExactAlarmSettings() {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_EXACT_ALARM_UNAVAILABLE: Application context unavailable");
        }
        if (Build.VERSION.SDK_INT < 31) {
            return false;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + app.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            app.startActivity(intent);
            return true;
        } catch (ActivityNotFoundException | SecurityException error) {
            throw new IllegalStateException("ERR_EXACT_ALARM_SETTINGS_OPEN: " + error.getMessage(), error);
        }
    }

    public static void syncQuietHours(String quietSnapshotJson) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_SCHEDULE_ANDROID_UNAVAILABLE: Application context unavailable");
        }
        try {
            JSONObject parsed = new JSONObject(quietSnapshotJson != null ? quietSnapshotJson : "{}");
            JSONObject compact = new JSONObject();
            compact.put("quietHoursEnabled", parsed.optBoolean("quietHoursEnabled", false));
            JSONArray rawWindows = parsed.optJSONArray("windows");
            if (rawWindows == null) {
                rawWindows = parsed.optJSONArray("quietHours");
            }
            compact.put("windows", rawWindows != null ? rawWindows : new JSONArray());
            synchronized (PREFS_LOCK) {
                prefs(app).edit().putString(PREF_QUIET_SNAPSHOT, compact.toString()).commit();
            }
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_INVALID_QUIET_SNAPSHOT: " + error.getMessage(), error);
        }
    }

    public static boolean isQuietAt(Context context, long wallClockMs) {
        if (context == null) return false;
        String raw;
        synchronized (PREFS_LOCK) {
            raw = prefs(context).getString(PREF_QUIET_SNAPSHOT, "");
        }
        if (raw == null || raw.isEmpty()) return false;
        try {
            JSONObject snapshot = new JSONObject(raw);
            if (!snapshot.optBoolean("quietHoursEnabled", false)) {
                return false;
            }
            JSONArray windows = snapshot.optJSONArray("windows");
            if (windows == null || windows.length() == 0) {
                return false;
            }
            Calendar cal = Calendar.getInstance();
            cal.setTimeInMillis(wallClockMs);
            int nowMinute = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
            int todayDow = (cal.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY + 7) % 7;
            int yesterdayDow = (todayDow + 6) % 7;

            for (int i = 0; i < windows.length(); i++) {
                JSONObject w = windows.optJSONObject(i);
                if (w == null || !w.optBoolean("enabled", true)) continue;
                int start = w.optInt("startMinute", -1);
                int end = w.optInt("endMinute", -1);
                if (start < 0 || start > 1439 || end < 0 || end > 1439 || start == end) {
                    continue;
                }
                JSONArray days = w.optJSONArray("daysOfWeek");
                if (start < end) {
                    if (nowMinute >= start && nowMinute < end && matchesWeekday(days, todayDow)) {
                        return true;
                    }
                } else {
                    // Cross-midnight window: [start..1440) belongs to today; [0..end) belongs to yesterday's weekday.
                    if (nowMinute >= start && matchesWeekday(days, todayDow)) {
                        return true;
                    }
                    if (nowMinute < end && matchesWeekday(days, yesterdayDow)) {
                        return true;
                    }
                }
            }
            return false;
        } catch (JSONException ignored) {
            return false;
        }
    }

    private static boolean matchesWeekday(JSONArray days, int dow) {
        if (days == null || days.length() == 0) return true;
        for (int i = 0; i < days.length(); i++) {
            int val = days.optInt(i, -1);
            if (val == 7) val = 0;
            if (val == dow) return true;
        }
        return false;
    }

    private static PendingIntent buildAlarmPendingIntent(
            Context context,
            String ruleId,
            String title,
            String body,
            boolean silent,
            long triggerAtMs,
            boolean create) {
        Intent intent = new Intent(context, ScheduleAlarmReceiver.class);
        intent.setAction(ACTION_ALARM);
        intent.setData(Uri.parse("looi-sched://alarm/" + Uri.encode(ruleId)));
        intent.putExtra(EXTRA_RULE_ID, ruleId);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        intent.putExtra("silent", silent);
        intent.putExtra("triggerAtMs", triggerAtMs);
        int flags = create
                ? PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_NO_CREATE;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, 0, intent, flags);
    }

    public static String syncUpcomingAlarms(String alarmsJson) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_SCHEDULE_ANDROID_UNAVAILABLE: Application context unavailable");
        }
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            throw new IllegalStateException("ERR_ALARM_MANAGER_UNAVAILABLE: Android AlarmManager unavailable");
        }
        ensureChannels(app);

        final JSONArray incoming;
        try {
            incoming = new JSONArray(alarmsJson != null ? alarmsJson : "[]");
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_INVALID_ALARMS_JSON: " + error.getMessage(), error);
        }

        Set<String> previousIds = readSyncedRuleIds(app);
        Set<String> nextIds = new HashSet<>();
        List<JSONObject> normalized = new ArrayList<>();
        for (int i = 0; i < incoming.length() && normalized.size() < MAX_ALARMS; i++) {
            JSONObject item = incoming.optJSONObject(i);
            if (item == null) continue;
            String ruleId = item.optString("ruleId", "").trim();
            String title = item.optString("title", "").trim();
            long triggerAtMs = (long) item.optDouble("triggerAtMs", 0.0);
            if (ruleId.isEmpty() || title.isEmpty() || triggerAtMs <= 0L) continue;
            if (nextIds.add(ruleId)) {
                normalized.add(item);
            }
        }

        int cancelledCount = 0;
        for (String oldId : previousIds) {
            if (!nextIds.contains(oldId)) {
                PendingIntent existing = buildAlarmPendingIntent(app, oldId, "", "", false, 0L, false);
                if (existing != null) {
                    am.cancel(existing);
                    existing.cancel();
                }
                cancelledCount++;
            }
        }

        boolean exactAllowed = canScheduleExactAlarms(app);
        boolean degraded = !exactAllowed;

        for (JSONObject item : normalized) {
            String ruleId = item.optString("ruleId", "").trim();
            String title = item.optString("title", "").trim();
            String body = item.optString("body", "");
            boolean silent = item.optBoolean("silent", false);
            long triggerAtMs = (long) item.optDouble("triggerAtMs", 0.0);

            PendingIntent pi = buildAlarmPendingIntent(app, ruleId, title, body, silent, triggerAtMs, true);
            try {
                if (exactAllowed) {
                    if (Build.VERSION.SDK_INT >= 23) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    } else {
                        am.setExact(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    }
                } else {
                    if (Build.VERSION.SDK_INT >= 23) {
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    } else {
                        am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    }
                }
            } catch (SecurityException securityError) {
                degraded = true;
                try {
                    if (Build.VERSION.SDK_INT >= 23) {
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    } else {
                        am.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    }
                } catch (RuntimeException fallbackErr) {
                    throw new IllegalStateException("ERR_ALARM_SCHEDULE_FAILED: " + fallbackErr.getMessage(), fallbackErr);
                }
            }
        }

        writeSyncedRuleIds(app, nextIds);
        JSONObject res = new JSONObject();
        try {
            res.put("syncedCount", normalized.size());
            res.put("cancelledCount", cancelledCount);
            res.put("exactAlarmDegraded", degraded);
            res.put("exactAlarmMode", degraded ? "inexact" : "exact");
            return res.toString();
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_SYNC_RESULT_JSON: " + error.getMessage(), error);
        }
    }

    public static boolean cancelAlarm(String ruleId) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null || ruleId == null || ruleId.trim().isEmpty()) return false;
        String cleanId = ruleId.trim();
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        PendingIntent existing = buildAlarmPendingIntent(app, cleanId, "", "", false, 0L, false);
        boolean hadPending = existing != null;
        if (existing != null && am != null) {
            am.cancel(existing);
            existing.cancel();
        }
        Set<String> ids = readSyncedRuleIds(app);
        boolean removed = ids.remove(cleanId);
        if (removed) {
            writeSyncedRuleIds(app, ids);
        }
        return hadPending || removed;
    }

    private static Set<String> readSyncedRuleIds(Context context) {
        Set<String> ids = new HashSet<>();
        String raw;
        synchronized (PREFS_LOCK) {
            raw = prefs(context).getString(PREF_SYNCED_RULE_IDS, "[]");
        }
        try {
            JSONArray arr = new JSONArray(raw != null ? raw : "[]");
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, "").trim();
                if (!id.isEmpty()) ids.add(id);
            }
        } catch (JSONException ignored) {}
        return ids;
    }

    private static void writeSyncedRuleIds(Context context, Set<String> ids) {
        JSONArray arr = new JSONArray();
        for (String id : ids) arr.put(id);
        synchronized (PREFS_LOCK) {
            prefs(context).edit().putString(PREF_SYNCED_RULE_IDS, arr.toString()).commit();
        }
    }

    static PendingIntent buildTapPendingIntent(
            Context context,
            String ruleId,
            String notificationId,
            String runId,
            String sessionId,
            String source) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) {
            return null;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra(EXTRA_RULE_ID, ruleId != null ? ruleId : "");
        launch.putExtra(EXTRA_NOTIFICATION_ID, notificationId != null ? notificationId : "");
        launch.putExtra(EXTRA_RUN_ID, runId != null ? runId : "");
        launch.putExtra(EXTRA_SESSION_ID, sessionId != null ? sessionId : "");
        launch.putExtra(EXTRA_SOURCE, source != null ? source : "notification");
        int requestCode = (String.valueOf(ruleId) + ":" + String.valueOf(notificationId)).hashCode();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(context, requestCode, launch, flags);
    }

    @SuppressWarnings("deprecation")
    static Notification buildNotification(
            Context context,
            String channelId,
            String title,
            String body,
            boolean silent,
            PendingIntent tapIntent) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, channelId)
                : new Notification.Builder(context);
        int icon = context.getApplicationInfo().icon;
        builder.setSmallIcon(icon != 0 ? icon : android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setShowWhen(true);
        if (body != null && !body.isEmpty()) {
            builder.setContentText(body);
            builder.setStyle(new Notification.BigTextStyle().bigText(body));
        }
        if (tapIntent != null) {
            builder.setContentIntent(tapIntent);
        }
        if (Build.VERSION.SDK_INT < 26) {
            if (silent) {
                builder.setPriority(Notification.PRIORITY_LOW);
                builder.setDefaults(0);
                builder.setSound(null);
            } else {
                builder.setPriority(Notification.PRIORITY_DEFAULT);
                builder.setDefaults(Notification.DEFAULT_ALL);
            }
        }
        return builder.build();
    }

    public static String postNotification(String payloadJson) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_SCHEDULE_ANDROID_UNAVAILABLE: Application context unavailable");
        }
        String perm = permission();
        if (!"granted".equals(perm)) {
            throw new IllegalStateException("ERR_NOTIFICATION_PERMISSION_DENIED: Android notification permission is " + perm);
        }
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            throw new IllegalStateException("ERR_NOTIFICATION_MANAGER_UNAVAILABLE: Android NotificationManager unavailable");
        }
        ensureChannels(app);
        try {
            JSONObject obj = new JSONObject(payloadJson != null ? payloadJson : "{}");
            String rawId = obj.optString("id", "").trim();
            String ruleId = obj.optString("ruleId", "").trim();
            String runId = obj.optString("runId", "").trim();
            String sessionId = obj.optString("sessionId", "").trim();
            String title = obj.optString("title", "").trim();
            String body = obj.optString("body", "");
            boolean silent = obj.optBoolean("silent", false);
            if (title.isEmpty()) {
                throw new IllegalStateException("ERR_INVALID_NOTIFICATION_PAYLOAD: title cannot be empty");
            }
            String notifId = rawId.startsWith("looi.sched.post.")
                    ? rawId
                    : "looi.sched.post." + (rawId.isEmpty() ? String.valueOf(System.currentTimeMillis()) : rawId);
            String channel = silent ? CHANNEL_SILENT : CHANNEL_ALERTS;
            PendingIntent tapIntent = buildTapPendingIntent(app, ruleId, notifId, runId, sessionId, "notification");
            Notification notification = buildNotification(app, channel, title, body, silent, tapIntent);
            nm.notify(notifId, NOTIFICATION_ID_POST, notification);
            return notifId;
        } catch (JSONException error) {
            throw new IllegalStateException("ERR_INVALID_NOTIFICATION_PAYLOAD: " + error.getMessage(), error);
        } catch (SecurityException error) {
            throw new IllegalStateException("ERR_NOTIFICATION_PERMISSION_DENIED: " + error.getMessage(), error);
        } catch (RuntimeException error) {
            if (error instanceof IllegalStateException && error.getMessage() != null
                    && error.getMessage().startsWith("ERR_")) {
                throw error;
            }
            throw new IllegalStateException("ERR_ANDROID_NOTIFICATION_POST_FAILED: " + error.getMessage(), error);
        }
    }

    public static String setKeepAlive(boolean active, boolean hasRunningCheck, double nextTriggerAtMs) {
        SuperLooiApplication app = SuperLooiApplication.appContext();
        if (app == null) {
            throw new IllegalStateException("ERR_SCHEDULE_ANDROID_UNAVAILABLE: Application context unavailable");
        }
        return ScheduleKeepAliveService.configure(app, active, hasRunningCheck, (long) nextTriggerAtMs);
    }

    static void recordKeepAliveSpan(Context context, long startMs, long endMs) {
        if (context == null || endMs <= startMs) return;
        long now = System.currentTimeMillis();
        long cutoff = now - ROLLING_WINDOW_MS;
        synchronized (PREFS_LOCK) {
            JSONArray retained = pruneSpansLocked(context, cutoff);
            JSONArray entry = new JSONArray();
            entry.put(Math.max(startMs, cutoff));
            entry.put(endMs);
            retained.put(entry);
            prefs(context).edit().putString(PREF_KEEPALIVE_SPANS, retained.toString()).commit();
        }
    }

    static long getRolling24hUsedMs(Context context, long nowMs) {
        if (context == null) return 0L;
        long cutoff = nowMs - ROLLING_WINDOW_MS;
        synchronized (PREFS_LOCK) {
            JSONArray spans = pruneSpansLocked(context, cutoff);
            long total = 0L;
            for (int i = 0; i < spans.length(); i++) {
                JSONArray span = spans.optJSONArray(i);
                if (span == null || span.length() < 2) continue;
                long s = Math.max(span.optLong(0, 0L), cutoff);
                long e = Math.min(span.optLong(1, 0L), nowMs);
                if (e > s) total += (e - s);
            }
            return total;
        }
    }

    private static JSONArray pruneSpansLocked(Context context, long cutoffMs) {
        String raw = prefs(context).getString(PREF_KEEPALIVE_SPANS, "[]");
        JSONArray out = new JSONArray();
        try {
            JSONArray arr = new JSONArray(raw != null ? raw : "[]");
            for (int i = 0; i < arr.length(); i++) {
                JSONArray span = arr.optJSONArray(i);
                if (span == null || span.length() < 2) continue;
                long s = span.optLong(0, 0L);
                long e = span.optLong(1, 0L);
                if (e > cutoffMs && e > s) {
                    JSONArray kept = new JSONArray();
                    kept.put(Math.max(s, cutoffMs));
                    kept.put(e);
                    out.put(kept);
                }
            }
        } catch (JSONException ignored) {}
        return out;
    }

    public static void enqueueEvent(
            String kind,
            String ruleId,
            String notificationId,
            String handle,
            String payloadJson) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("kind", kind != null ? kind : "");
            ev.put("ruleId", ruleId != null ? ruleId : "");
            ev.put("notificationId", notificationId != null ? notificationId : "");
            ev.put("handle", handle != null ? handle : "");
            ev.put("payloadJson", payloadJson != null && !payloadJson.isEmpty() ? payloadJson : "{}");
            ev.put("occurredAtMs", (double) System.currentTimeMillis());
        } catch (JSONException ignored) {
            return;
        }
        synchronized (EVENT_LOCK) {
            while (EVENT_QUEUE.size() >= MAX_EVENTS) {
                EVENT_QUEUE.pollFirst();
            }
            EVENT_QUEUE.addLast(ev);
        }
    }

    public static String drainEventsJson() {
        JSONArray out = new JSONArray();
        synchronized (EVENT_LOCK) {
            while (!EVENT_QUEUE.isEmpty()) {
                out.put(EVENT_QUEUE.pollFirst());
            }
        }
        return out.toString();
    }
}
