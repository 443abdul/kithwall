package com.kithwall.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * KithwallNet (apps/web/src/lib/net/native.ts): "Use Tor (Orbot)" and the mirror origins the app may fail
 * over to (KwNet, docs/v2/08-censorship.md). Error codes: 'orbot_missing', 'unsupported', 'failed'.
 */
@CapacitorPlugin(name = "KithwallNet")
public class KithwallNetPlugin extends Plugin {

    private JSObject status() {
        JSObject r = new JSObject();
        r.put("proxySupported", KwNet.proxySupported());
        r.put("orbotInstalled", KwNet.orbotInstalled(getContext()));
        r.put("orbotRunning", KwNet.orbotRunning());
        r.put("tor", KwNet.torEnabled(getContext()));
        r.put("origin", KwNet.active(getContext()));
        r.put("origins", new JSArray(KwNet.allOrigins(getContext())));
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        // orbotRunning opens a local socket: off the main thread.
        Executors.newSingleThreadExecutor().execute(() -> call.resolve(status()));
    }

    @PluginMethod
    public void setTor(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        if (on && !KwNet.proxySupported()) { call.reject("WebView can't use a proxy", "unsupported"); return; }
        if (on && !KwNet.orbotInstalled(getContext())) { call.reject("Orbot is not installed", "orbot_missing"); return; }
        KwNet.setTorEnabled(getContext(), on);
        KwNet.applyProxy(getContext(), () -> Executors.newSingleThreadExecutor().execute(() -> {
            JSObject r = status();
            call.resolve(r);
            // Reload so every connection (including the open Realtime socket) is re-made through the new route.
            getActivity().runOnUiThread(() -> { if (getBridge().getWebView() != null) getBridge().getWebView().reload(); });
        }));
    }

    @PluginMethod
    public void openOrbot(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (KwNet.orbotInstalled(getContext())) {
                    // Orbot's documented "please start" broadcast, then its own screen.
                    Intent start = new Intent("org.torproject.android.intent.action.START");
                    start.setPackage(KwNet.ORBOT_PACKAGE);
                    start.putExtra("org.torproject.android.intent.extra.PACKAGE_NAME", getContext().getPackageName());
                    getContext().sendBroadcast(start);
                    Intent open = getContext().getPackageManager().getLaunchIntentForPackage(KwNet.ORBOT_PACKAGE);
                    if (open != null) getActivity().startActivity(open);
                } else {
                    openStore();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("could not open Orbot", "failed");
            }
        });
    }

    private void openStore() {
        Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + KwNet.ORBOT_PACKAGE));
        market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(market);
        } catch (ActivityNotFoundException e) {
            // No store app (F-Droid users usually have one; otherwise the Tor Project's page in the browser).
            Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://guardianproject.info/apps/org.torproject.android/"));
            web.addCategory(Intent.CATEGORY_BROWSABLE);
            web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(web);
        }
    }

    @PluginMethod
    public void setLearnedOrigins(PluginCall call) {
        JSONArray arr = call.getArray("origins");
        List<String> list = new ArrayList<>();
        if (arr != null) for (int i = 0; i < arr.length() && i < 64; i++) list.add(arr.optString(i, ""));
        KwNet.setLearned(getContext(), list);
        call.resolve();
    }
}
