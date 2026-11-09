package com.superlooi.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.app.Fragment;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.DisplayCutout;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import java.lang.ref.WeakReference;

/** App-owned lifecycle, secure-vault and explicit audio permission hooks. */
public final class SuperLooiApplication extends Application {
    private static native void registerVm();
    private static native void registerAudioVm();
    private static native void registerShellVm(String nativeLibraryDir);
    private static SuperLooiApplication instance;
    private static volatile WeakReference<Activity> activity = new WeakReference<>(null);
    private static volatile String focus = "lost";
    private static AudioManager manager;
    private static AudioFocusRequest focusRequest;
    private static int previousMode;
    private static int previousVolumeStream = AudioManager.USE_DEFAULT_STREAM_TYPE;
    private static WeakReference<Activity> voiceVolumeActivity = new WeakReference<>(null);
    private static boolean ownsAudio;
    private static boolean ownsSpeakerRoute;
    private static long audioGeneration;
    private static volatile boolean interrupted = true;
    private static volatile boolean permissionPending;
    private static volatile boolean permissionCancelled;
    private static View cutoutView;
    private static ViewTreeObserver.OnGlobalLayoutListener cutoutListener;

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        System.loadLibrary("onnxruntime");
        System.loadLibrary("sherpa-onnx-c-api");
        System.loadLibrary("nsh");
        registerVm();
        registerAudioVm();
        if (android.os.Process.is64Bit() && Build.SUPPORTED_ABIS[0].equals("arm64-v8a")) registerShellVm(getApplicationInfo().nativeLibraryDir);
        MiotLoginDialog.registerVm();
        LooiBleBridge.registerVm();
        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {
            public void onActivityResumed(Activity value) {
                value.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                activity = new WeakReference<>(value);
                observeDisplayCutout(value);
            }
            public void onActivityPaused(Activity value) {
                value.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                stopObservingDisplayCutout();
                MiotLoginDialog.background(value);
                LooiBleBridge.background();
                if (activity.get() == value) {
                    synchronized (SuperLooiApplication.class) { restoreVolumeControlStream(value); }
                    activity.clear();
                    // The native worker observes this even when JS is suspended.
                    interrupted = true;
                    focus = "lost";
                }
            }
            public void onActivityDestroyed(Activity value) { stopObservingDisplayCutout(); MiotLoginDialog.background(value); LooiBleBridge.background(); if (activity.get() == value) activity.clear(); }
            public void onActivityCreated(Activity value, Bundle state) {}
            public void onActivityStarted(Activity value) {}
            public void onActivityStopped(Activity value) {}
            public void onActivitySaveInstanceState(Activity value, Bundle state) {}
        });
    }

    public static void copyLinuxArchive(String destination) throws java.io.IOException {
        try (java.io.InputStream input = instance.getAssets().open("alpine-minirootfs.tar.gz");
             java.io.OutputStream output = new java.io.FileOutputStream(destination)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    private static void observeDisplayCutout(Activity owner) {
        stopObservingDisplayCutout();
        FrameLayout content = owner.findViewById(android.R.id.content);
        if (content == null || content.getChildCount() == 0) return;
        View view = content.getChildAt(0);
        if (!"com.longbridge.nsh.NshView".equals(view.getClass().getName())) return;
        cutoutView = view;
        cutoutListener = () -> {
            WindowInsets insets = view.getRootWindowInsets();
            if (insets == null) return;
            DisplayCutout cutout = insets.getDisplayCutout();
            float left = 0, right = 0;
            if (cutout != null) {
                // NSH uses getInsets(), which reports zero on this phone with its bar hidden.
                int reportedLeft, reportedRight;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets reported = insets.getInsets(
                            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    reportedLeft = reported.left;
                    reportedRight = reported.right;
                } else {
                    reportedLeft = insets.getSystemWindowInsetLeft();
                    reportedRight = insets.getSystemWindowInsetRight();
                }
                float density = view.getResources().getDisplayMetrics().density;
                left = Math.max(0, cutout.getSafeInsetLeft() - reportedLeft) / density;
                right = Math.max(0, cutout.getSafeInsetRight() - reportedRight) / density;
            }
            java.util.HashMap<String, Float> payload = new java.util.HashMap<>();
            payload.put("left", left);
            payload.put("right", right);
            try {
                view.getClass().getMethod("send", String.class, Object.class)
                        .invoke(view, "super-looi/display-cutout", payload);
            } catch (ReflectiveOperationException error) {
                throw new IllegalStateException("Cannot send display cutout insets", error);
            }
        };
        view.getViewTreeObserver().addOnGlobalLayoutListener(cutoutListener);
        view.post(cutoutListener::onGlobalLayout);
    }

    private static void stopObservingDisplayCutout() {
        if (cutoutView != null && cutoutListener != null) {
            ViewTreeObserver observer = cutoutView.getViewTreeObserver();
            if (observer.isAlive()) observer.removeOnGlobalLayoutListener(cutoutListener);
        }
        cutoutView = null;
        cutoutListener = null;
    }

    static Activity foregroundActivity() { return activity.get(); }

    public static String voicePermission() {
        if (instance == null) return "unavailable";
        if (Build.VERSION.SDK_INT < 23) return "granted";
        if (instance.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            final Activity owner = activity.get();
            return owner != null && owner.hasWindowFocus() ? "granted" : "undetermined";
        }
        if (permissionPending) return "undetermined";
        if (permissionCancelled) return "cancelled";
        return instance.getSharedPreferences("voice-permission", MODE_PRIVATE).getBoolean("asked", false) ? "denied" : "undetermined";
    }

    public static String requestVoicePermission() {
        final String state = voicePermission();
        if (instance != null && Build.VERSION.SDK_INT >= 23 && instance.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return state;
        if (!("undetermined".equals(state) || "cancelled".equals(state)) || permissionPending) return state;
        final Activity owner = activity.get();
        if (owner == null || Build.VERSION.SDK_INT < 23) return "unavailable";
        permissionCancelled = false;
        permissionPending = true;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (activity.get() != owner || owner.isFinishing()) { permissionPending = false; return; }
            try {
                owner.getFragmentManager().beginTransaction().add(new VoicePermissionFragment(), "looi-voice-permission").commit();
            } catch (RuntimeException error) { permissionPending = false; }
        });
        return "undetermined";
    }

    /** Application has no permission-result callback; this fragment owns that one request. */
    public static final class VoicePermissionFragment extends Fragment {
        private boolean requested;

        @Override public void onResume() {
            super.onResume();
            if (!requested) {
                requested = true;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7401);
            }
        }

        @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code == 7401) {
                permissionCancelled = results.length == 0;
                if (!permissionCancelled)
                    instance.getSharedPreferences("voice-permission", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
                permissionPending = false;
                getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
            }
        }
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
        selectVoiceSpeaker();
        final Activity owner = activity.get();
        if (owner != null) owner.runOnUiThread(() -> {
            synchronized (SuperLooiApplication.class) {
                if (generation != audioGeneration || !ownsAudio || activity.get() != owner) return;
                if (voiceVolumeActivity.get() != owner) {
                    previousVolumeStream = owner.getVolumeControlStream();
                    voiceVolumeActivity = new WeakReference<>(owner);
                }
                owner.setVolumeControlStream(attributes.getVolumeControlStream());
            }
        });
        focus = "granted";
        return true;
        } catch (RuntimeException error) { endVoiceAudio(); return false; }
    }

    public static synchronized void endVoiceAudio() {
        ++audioGeneration;
        final long generation = audioGeneration;
        interrupted = true;
        focus = "lost";
        final AudioManager oldManager = manager;
        final AudioFocusRequest oldRequest = focusRequest;
        final boolean owned = ownsAudio;
        final boolean speakerOwned = ownsSpeakerRoute;
        ownsSpeakerRoute = false;
        ownsAudio = false; focusRequest = null; manager = null;
        final Activity volumeOwner = voiceVolumeActivity.get();
        if (volumeOwner != null) volumeOwner.runOnUiThread(() -> {
            synchronized (SuperLooiApplication.class) {
                if (generation == audioGeneration && !ownsAudio) restoreVolumeControlStream(volumeOwner);
            }
        });
        if (oldManager != null && owned) {
            if (speakerOwned) {
                if (Build.VERSION.SDK_INT >= 31) oldManager.clearCommunicationDevice();
                else oldManager.setSpeakerphoneOn(false);
            }
            try { if (oldManager.getMode() == AudioManager.MODE_IN_COMMUNICATION) oldManager.setMode(previousMode); }
            catch (RuntimeException ignored) {}
            try { if (Build.VERSION.SDK_INT >= 26 && oldRequest != null) oldManager.abandonAudioFocusRequest(oldRequest); }
            catch (RuntimeException ignored) {}
        }
    }

    /** Use the loudspeaker for hands-free voice; retain an active headset route. */
    private static void selectVoiceSpeaker() {
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo current = manager.getCommunicationDevice();
            if (current != null && current.getType() != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    && current.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return;
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    ownsSpeakerRoute = manager.setCommunicationDevice(device);
                    return;
                }
            }
        } else if (!manager.isSpeakerphoneOn() && !manager.isBluetoothScoOn() && !manager.isWiredHeadsetOn()) {
            manager.setSpeakerphoneOn(true);
            ownsSpeakerRoute = true;
        }
    }

    private static void restoreVolumeControlStream(Activity owner) {
        if (voiceVolumeActivity.get() != owner) return;
        owner.setVolumeControlStream(previousVolumeStream);
        voiceVolumeActivity.clear();
    }

    public static String voiceAudioFocus() { return interrupted || activity.get() == null ? "lost" : focus; }
}
