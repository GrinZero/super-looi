package com.superlooi.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ConsoleMessage;
import android.security.NetworkSecurityPolicy;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import java.io.ByteArrayInputStream;

/** Dedicated OAuth surface. Never logs URLs or installs a JavaScript bridge. */
public final class MiotLoginDialog {
    static native void registerVm();
    private static native int decide(long id, String url, boolean mainFrame);
    private static native void backgroundAll();
    private static native void shown(long id);
    private static native void end(long id, int reason);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static MiotLoginDialog current;
    private static long lifecycleGeneration;
    private static long pendingId;
    private static Activity pendingOwner;
    private final long id;
    private final Activity owner;
    private Dialog dialog;
    private WebView web;
    private volatile boolean finished;
    private final Runnable timeout = () -> finish(false);

    private MiotLoginDialog(long id, Activity owner) { this.id = id; this.owner = owner; }

    public static synchronized boolean open(long id, String url, boolean english) {
        Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null || NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("homeassistant.local")) return false;
        final long generation = lifecycleGeneration;
        pendingId = id; pendingOwner = owner;
        MAIN.post(() -> {
            synchronized (MiotLoginDialog.class) {
            if (generation != lifecycleGeneration || pendingId != id) { end(id, 0); return; }
            pendingId = 0; pendingOwner = null;
            // An open/cancel race is checked by native generation before any load.
            if (owner != SuperLooiApplication.foregroundActivity() || owner.isFinishing()
                || decide(id, url, true) != 1) { end(id, 0); return; }
            if (current != null) current.finish(false);
            MiotLoginDialog login = new MiotLoginDialog(id, owner);
            current = login;
            try { login.show(url, english); } catch (RuntimeException error) { login.finish(true); }
            }
        });
        return true;
    }
    public static void close(long id) { MAIN.post(() -> { if (current != null && current.id == id) current.finish(false); }); }
    static synchronized void background(Activity owner) {
        ++lifecycleGeneration;
        backgroundAll();
        if (pendingOwner == owner) { end(pendingId, 0); pendingId = 0; pendingOwner = null; }
        if (current != null && current.owner == owner) current.finish(false);
    }

    private void show(String url, boolean english) {
        dialog = new Dialog(owner, android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout layout = new LinearLayout(owner);
        layout.setOrientation(LinearLayout.VERTICAL);
        Button cancel = new Button(owner);
        cancel.setText(english ? "Cancel Xiaomi sign-in" : "取消米家登录");
        cancel.setMinHeight((int) (48 * owner.getResources().getDisplayMetrics().density));
        cancel.setOnClickListener(view -> finish(false));
        layout.addView(cancel, new LinearLayout.LayoutParams(-1, -2));
        WebView.setWebContentsDebuggingEnabled(false);
        web = new WebView(owner);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        // Cookie storage is process-shared on Android; this is not an ephemeral browser.
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
        });
        web.setWebViewClient(new WebViewClient() {
            private boolean navigate(String url, boolean main) {
                int decision = finished ? 0 : decide(id, url, main);
                if (decision == 2) MAIN.post(() -> finish(2));
                return decision != 1;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return navigate(request.getUrl().toString(), request.isForMainFrame());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return navigate(url, true); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // This also handles form POST and subresources skipped by navigation callbacks.
                if (navigate(request.getUrl().toString(), request.isForMainFrame()))
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                return null;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); MAIN.post(() -> finish(true));
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) MAIN.post(() -> finish(true));
            }
        });
        layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        dialog.setContentView(layout);
        dialog.setOnDismissListener(value -> finish(false));
        dialog.setCanceledOnTouchOutside(false);
        dialog.show();
        if (dialog.isShowing()) shown(id);
        dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        MAIN.postDelayed(timeout, 600_000);
        web.loadUrl(url);
    }
    private void finish(boolean failed) { finish(failed ? 1 : 0); }
    private void finish(int reason) {
        if (finished) return;
        finished = true;
        MAIN.removeCallbacks(timeout);
        end(id, reason);
        if (web != null) {
            web.stopLoading(); web.setWebViewClient(new WebViewClient()); web.setWebChromeClient(null);
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            web.destroy(); web = null;
        }
        if (dialog != null) { dialog.setOnDismissListener(null); dialog.dismiss(); dialog = null; }
        if (current == this) current = null;
    }
}
