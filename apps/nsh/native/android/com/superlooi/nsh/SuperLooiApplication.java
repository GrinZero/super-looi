package com.superlooi.nsh;

/** App-owned native plugin. NSH keeps its original activity and JNI_OnLoad. */
public final class SuperLooiApplication extends android.app.Application {
    private static native void registerVm();

    @Override public void onCreate() {
        super.onCreate();
        System.loadLibrary("nsh");
        registerVm();
    }
}
