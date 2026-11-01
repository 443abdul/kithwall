package com.kithwall.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;

/**
 * Kithwall for Android: a Capacitor WebView showing the deployed web app (docs/v2/05-native.md), plus four
 * app-local plugins. Opening a notification or a verified Kithwall link goes to that path in the app; a Kit
 * Drop file opened from outside (share sheet, "Open with", Quick Share) goes to the Kit Drop page (KwKitDrop).
 *
 * The app frame (docs/v2/05-native.md §1, "App frame"):
 *  - the system splash (Android 12+ SplashScreen API, back-ported by core-splashscreen) stays up until the
 *    first page paints (at most SPLASH_MAX_MS), so there is no blank or white frame between splash and page;
 *  - the WebView and window are painted in the site's background colour (light/dark) from the first frame;
 *  - Back closes the web app's dialogs and sheets first, then goes back in the app's history, and from Home
 *    (or with no history left) sends the app to the background like other Android apps;
 *  - downloads (export, .ics, photos, videos) are saved to Downloads (KwDownloads);
 *  - only network failures show the bundled offline page (KwWebViewClient).
 */
public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground = false;
    private static final long SPLASH_MAX_MS = 4000;

    private volatile boolean firstPaint = false;

    static boolean isForeground() {
        return foreground;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        final long started = SystemClock.uptimeMillis();
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        registerPlugin(KithwallShellPlugin.class);
        registerPlugin(KithwallPasskeyPlugin.class);
        registerPlugin(KithwallSecurePlugin.class);
        registerPlugin(KithwallPushPlugin.class);
        registerPlugin(KithwallNetPlugin.class);
        registerPlugin(KithwallTranslatePlugin.class);
        // Censorship resistance (KwNet, docs/v2/08-censorship.md): start on the mirror that worked last time
        // when the usual origin was unreachable (null = the bundled config, i.e. the usual origin).
        config = KwNet.capConfig(this);
        KwNet.checkPrimaryLater(this);
        super.onCreate(savedInstanceState);
        splash.setKeepOnScreenCondition(() -> !firstPaint && SystemClock.uptimeMillis() - started < SPLASH_MAX_MS);
        KithwallShellPlugin.applySecure(this, KithwallShellPlugin.secureScreen(this));
        Notifier.ensureChannels(this);
        getOnBackPressedDispatcher().addCallback(this, back);
        pendingPath = pathFrom(getIntent());
        if (bridge != null) afterBridge();
    }

    private String pendingPath;
    private static volatile boolean proxyApplied = false;

    /**
     * "Use Tor (Orbot)": the WebView proxy must be in effect BEFORE the first request, or that request would
     * leave without Tor. The bridge is still created right here in onCreate: Capacitor and our plugins
     * register activity-result launchers while it is built, and Android refuses (crashes) once the activity
     * is RESUMED, which is what happened when bridge creation waited for the proxy. Instead every request
     * is held back (KwWebViewClient.holdNetwork) until ProxyController confirms the override, then the start
     * page is loaded again through Tor.
     */
    @Override
    protected void load() {
        boolean waitForTor = !proxyApplied && KwNet.torEnabled(this) && KwNet.proxySupported();
        if (waitForTor) KwWebViewClient.holdNetwork = true;
        super.load();
        if (!waitForTor) return;
        if (bridge != null && bridge.getWebView() != null) bridge.getWebView().stopLoading();
        KwNet.applyProxy(this, () -> runOnUiThread(() -> {
            proxyApplied = true;
            KwWebViewClient.holdNetwork = false;
            if (isFinishing() || isDestroyed() || bridge == null || bridge.getWebView() == null) return;
            bridge.getWebView().loadUrl(bridge.getAppUrl());
        }));
    }

    private void afterBridge() {
        if (bridge == null) return;
        setUpWebView();
        if (pendingPath != null) load(pendingPath);
        pendingPath = null;
    }

    private void setUpWebView() {
        WebView w = bridge.getWebView();
        // The site's background (light/dark) behind the page from the very first frame: no white flash.
        w.setBackgroundColor(ContextCompat.getColor(this, R.color.kw_background));
        WebSettings s = w.getSettings();
        // The page has its own font-size setting and follows the system font size through rem units; WebView's
        // text autosizing would additionally inflate some paragraphs and not others.
        s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false); // calls: remote audio/video starts without a second tap
        bridge.setWebViewClient(new KwWebViewClient(bridge));
        // The offline shell's service worker (docs/v2/08-censorship.md §5) fetches outside the WebViewClient:
        // its requests are held back for Tor exactly like the page's.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return KwWebViewClient.holdNetwork ? KwWebViewClient.held() : null;
            }
        });
        w.setWebChromeClient(new KwChromeClient(bridge));
        w.setDownloadListener(new KwDownloads(this, bridge));
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                firstPaint = true;
            }

            @Override
            public void onReceivedError(WebView view) {
                firstPaint = true;
            }
        });
    }

    /**
     * Android Back / back gesture. Asks the page first (lib/native/runtime.ts, window.__kwBack): it closes the
     * top dialog, sheet, menu or viewer, or answers "background" on Home / during a call. Otherwise go back
     * in the WebView's history; with nothing left, leave like other apps (the task stays, so the page and its
     * unlocked keys are still there when the person comes back; the app lock still applies).
     */
    private final OnBackPressedCallback back = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            if (KwChromeClient.exitFullscreen()) return;
            if (bridge == null || bridge.getWebView() == null) { moveTaskToBack(true); return; }
            WebView w = bridge.getWebView();
            String url = w.getUrl();
            if (url == null || url.contains("/offline.html")) { moveTaskToBack(true); return; }
            boolean canGoBack = w.canGoBack();
            w.evaluateJavascript("(function(){try{return window.__kwBack?String(window.__kwBack(" + canGoBack + ")):''}catch(e){return ''}})()", (r) -> {
                String answer = r == null ? "" : r.replace("\"", "");
                if (answer.equals("handled")) return;
                if (!answer.equals("background") && w.canGoBack()) { w.goBack(); return; }
                moveTaskToBack(true);
            });
        }
    };

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String path = pathFrom(intent);
        if (path == null) return;
        WebView w = bridge == null ? null : bridge.getWebView();
        String current = w == null ? null : w.getUrl();
        if (current != null && current.contains("/offline.html")) {
            // No connection right now: a Kit Drop file opens in the offline shell if this origin keeps one,
            // otherwise it waits (KwKitDrop) until the Kit Drop page next loads.
            if (path.startsWith("/you/kitdrop") && KithwallShellPlugin.offlineShellReady(this, bridge.getServerUrl())) load("/offline");
            return;
        }
        PluginHandle h = bridge == null ? null : bridge.getPlugin("KithwallPush");
        if (h != null && h.getInstance() instanceof KithwallPushPlugin) {
            // The page is running: navigate inside it, keeping its unlocked keys in memory.
            ((KithwallPushPlugin) h.getInstance()).emitOpen(path);
        } else {
            load(path);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // uiMode is handled here (no restart): keep the WebView's backdrop in step with light/dark.
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setBackgroundColor(ContextCompat.getColor(this, R.color.kw_background));
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    public void onPause() {
        foreground = false;
        super.onPause();
    }

    /**
     * The in-app path from a notification tap, a verified https://<origin>/… link, or a Kit Drop file opened
     * from outside (KwKitDrop: copied now, opened by the Kit Drop page), else null.
     */
    private String pathFrom(Intent intent) {
        if (intent == null) return null;
        Uri kitDrop = KwKitDrop.uriFrom(intent);
        if (kitDrop != null) {
            String id = KwKitDrop.receive(this, kitDrop);
            // Handled once: not again when the activity is recreated with the same intent.
            intent.setAction(null);
            intent.setData(null);
            intent.removeExtra(Intent.EXTRA_STREAM);
            return "/you/kitdrop?incoming=" + id;
        }
        String extra = intent.getStringExtra(Notifier.EXTRA_URL);
        if (extra != null) {
            // Only our own notification taps carry the per-install token (security review L15): another app
            // sending kw_url / kw_tag to this exported activity is ignored.
            boolean ours = Notifier.fromOurNotification(this, intent);
            intent.removeExtra(Notifier.EXTRA_URL);
            intent.removeExtra(Notifier.EXTRA_TOKEN);
            if (!ours) return null;
            Notifier.cancel(this, intent.getStringExtra(Notifier.EXTRA_TAG));
            return Notifier.safePath(extra);
        }
        Uri data = intent.getData();
        if (data != null && Intent.ACTION_VIEW.equals(intent.getAction()) && bridge != null) {
            Uri origin = Uri.parse(bridge.getServerUrl());
            if ("https".equals(data.getScheme()) && origin.getHost() != null && origin.getHost().equalsIgnoreCase(data.getHost())) {
                String p = data.getEncodedPath() == null ? "/" : data.getEncodedPath();
                if (data.getEncodedQuery() != null) p += "?" + data.getEncodedQuery();
                intent.setData(null);
                return Notifier.safePath(p);
            }
        }
        return null;
    }

    private void load(String path) {
        if (bridge == null || bridge.getServerUrl() == null) return;
        String origin = bridge.getServerUrl().replaceAll("/+$", "");
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(origin + path));
    }
}
