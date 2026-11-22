package com.superlooi.nsh;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * AlarmManager wakeup receiver that evaluates the persisted quiet-hours snapshot at actual
 * wall-clock delivery time (handling cross-midnight weekdays and Doze drift) and posts a
 * tap-to-open reminder notification launching the app with {@code ruleId}.
 */
public final class ScheduleAlarmReceiver extends BroadcastReceiver {
    private static final int NOTIFICATION_ID_ALARM = 7502;

    @Override public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String ruleId = intent.getStringExtra(ScheduleBridge.EXTRA_RULE_ID);
        if (ruleId == null || ruleId.trim().isEmpty()) return;
        ruleId = ruleId.trim();

        String title = intent.getStringExtra("title");
        if (title == null || title.trim().isEmpty()) {
            title = "Scheduled task due";
        }
        String body = intent.getStringExtra("body");
        if (body == null) body = "";
        long triggerAtMs = intent.getLongExtra("triggerAtMs", 0L);

        ScheduleBridge.ensureChannels(context);
        long nowMs = System.currentTimeMillis();
        boolean quietNow = ScheduleBridge.isQuietAt(context, nowMs);
        String channelId = quietNow ? ScheduleBridge.CHANNEL_SILENT : ScheduleBridge.CHANNEL_ALERTS;
        String notifId = "looi.sched.alarm." + ruleId;

        PendingIntent tapIntent = ScheduleBridge.buildTapPendingIntent(
                context,
                ruleId,
                notifId,
                "",
                "",
                "alarm");
        Notification notification = ScheduleBridge.buildNotification(
                context,
                channelId,
                title,
                body,
                quietNow,
                tapIntent);

        boolean posted = false;
        String postError = "";
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(notifId, NOTIFICATION_ID_ALARM, notification);
                posted = true;
            } catch (SecurityException error) {
                postError = "ERR_NOTIFICATION_PERMISSION_DENIED: " + error.getMessage();
            } catch (RuntimeException error) {
                postError = "ERR_ALARM_NOTIFICATION_FAILED: " + error.getMessage();
            }
        } else {
            postError = "ERR_NOTIFICATION_MANAGER_UNAVAILABLE";
        }

        JSONObject meta = new JSONObject();
        try {
            meta.put("quietNow", quietNow);
            meta.put("channelId", channelId);
            meta.put("triggerAtMs", triggerAtMs);
            meta.put("posted", posted);
            if (!postError.isEmpty()) meta.put("error", postError);
        } catch (JSONException ignored) {}

        ScheduleBridge.enqueueEvent("alarm_fired", ruleId, notifId, "", meta.toString());
    }
}
