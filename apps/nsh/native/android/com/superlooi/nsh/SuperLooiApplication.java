package com.superlooi.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;

/** App-owned lifecycle, secure-vault and explicit audio permission hooks. */
public final class SuperLooiApplication extends Application {
    private static native void registerVm();
    private static native void registerAudioVm();
    private static SuperLooiApplication instance;
    private static volatile WeakReference<Activity> activity = new WeakReference<>(null);
    private static volatile String focus = "lost";
    private static AudioManager manager;
    private static AudioFocusRequest focusRequest;
    private static int previousMode;
    private static boolean ownsAudio;
    private static long audioGeneration;
    private static volatile boolean interrupted = true;

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        System.loadLibrary("onnxruntime");
        System.loadLibrary("sherpa-onnx-c-api");
        System.loadLibrary("nsh");
        registerVm();
        registerAudioVm();
        MiotLoginDialog.registerVm();
        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {
            public void onActivityResumed(Activity value) { activity = new WeakReference<>(value); }
            public void onActivityPaused(Activity value) {
                MiotLoginDialog.background(value);
                if (activity.get() == value) {
                    activity.clear();
                    // The native worker observes this even when JS is suspended.
                    interrupted = true;
                    focus = "lost";
                }
            }
            public void onActivityDestroyed(Activity value) { MiotLoginDialog.background(value); if (activity.get() == value) activity.clear(); }
            public void onActivityCreated(Activity value, Bundle state) {}
            public void onActivityStarted(Activity value) {}
            public void onActivityStopped(Activity value) {}
            public void onActivitySaveInstanceState(Activity value, Bundle state) {}
        });
    }

    static Activity foregroundActivity() { return activity.get(); }

    public static String voicePermission() {
        if (instance == null) return "unavailable";
        if (Build.VERSION.SDK_INT < 23 || instance.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return "granted";
        return instance.getSharedPreferences("voice-permission", MODE_PRIVATE).getBoolean("asked", false) ? "denied" : "undetermined";
    }

    public static String requestVoicePermission() {
        if ("granted".equals(voicePermission())) return "granted";
        final Activity owner = activity.get();
        if (owner == null || Build.VERSION.SDK_INT < 23) return "unavailable";
        new Handler(Looper.getMainLooper()).post(() -> {
            if (activity.get() != owner || owner.isFinishing()) return;
            instance.getSharedPreferences("voice-permission", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
            owner.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7401);
        });
        return "undetermined";
    }

    public static synchronized boolean beginVoiceAudio(boolean capture) {
        if (instance == null || activity.get() == null || Build.VERSION.SDK_INT < 26) return false;
        endVoiceAudio();
        final long generation = audioGeneration;
        interrupted = false;
        try {
        manager = (AudioManager) instance.getSystemService(AUDIO_SERVICE);
        if (manager == null) return false;
        previousMode = manager.getMode();
        AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener(change -> {
                synchronized (SuperLooiApplication.class) {
                if (generation != audioGeneration) return;
                if (change != AudioManager.AUDIOFOCUS_GAIN) interrupted = true;
                focus = change == AudioManager.AUDIOFOCUS_GAIN ? "granted" : change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK ? "duck" : change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ? "transient" : "lost";
                }
            }, new Handler(Looper.getMainLooper())).build();
        if (manager.requestAudioFocus(focusRequest) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focusRequest = null; manager = null; focus = "lost"; return false;
        }
        ownsAudio = true;
        if (capture) manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        focus = "granted";
        return true;
        } catch (RuntimeException error) { endVoiceAudio(); return false; }
    }

    public static synchronized void endVoiceAudio() {
        ++audioGeneration;
        interrupted = true;
        focus = "lost";
        final AudioManager oldManager = manager;
        final AudioFocusRequest oldRequest = focusRequest;
        final boolean owned = ownsAudio;
        ownsAudio = false; focusRequest = null; manager = null;
        if (oldManager != null && owned) {
            try { if (oldManager.getMode() == AudioManager.MODE_IN_COMMUNICATION) oldManager.setMode(previousMode); }
            catch (RuntimeException ignored) {}
            try { if (Build.VERSION.SDK_INT >= 26 && oldRequest != null) oldManager.abandonAudioFocusRequest(oldRequest); }
            catch (RuntimeException ignored) {}
        }
    }

    public static String voiceAudioFocus() { return interrupted || activity.get() == null ? "lost" : focus; }
}
