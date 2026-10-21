package com.kithwall.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * Kithwall for Android: a Capacitor WebView showing the deployed web app (docs/v2/05-native.md), plus four
 * app-local plugins. Opening a notification or a verified Kithwall link goes to that path in the app.
 */
public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground = false;

    static boolean isForeground() {
        return foreground;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KithwallShellPlugin.class);
        registerPlugin(KithwallPasskeyPlugin.class);
        registerPlugin(KithwallSecurePlugin.class);
        registerPlugin(KithwallPushPlugin.class);
        super.onCreate(savedInstanceState);
        KithwallShellPlugin.applySecure(this, KithwallShellPlugin.secureScreen(this));
        Notifier.ensureChannels(this);
        String path = pathFrom(getIntent());
        if (path != null) load(path);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String path = pathFrom(intent);
        if (path == null) return;
        PluginHandle h = bridge == null ? null : bridge.getPlugin("KithwallPush");
        if (h != null && h.getInstance() instanceof KithwallPushPlugin) {
            // The page is running: navigate inside it, keeping its unlocked keys in memory.
            ((KithwallPushPlugin) h.getInstance()).emitOpen(path);
        } else {
            load(path);
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

    /** The in-app path from a notification tap or a verified https://<origin>/… link, else null. */
    private String pathFrom(Intent intent) {
        if (intent == null) return null;
        String extra = intent.getStringExtra(Notifier.EXTRA_URL);
        if (extra != null) {
            Notifier.cancel(this, intent.getStringExtra(Notifier.EXTRA_TAG));
            intent.removeExtra(Notifier.EXTRA_URL);
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
