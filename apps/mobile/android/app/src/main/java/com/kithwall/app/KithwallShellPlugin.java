package com.kithwall.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * KithwallShell (apps/web/src/lib/native/plugins.ts): the app frame around the website.
 *  - Navigation: only the configured origin (and the bundled offline page) loads inside the app. https,
 *    mailto and tel links open in the system; every other scheme (intent:, file:, javascript:, …) is blocked.
 *  - "Block screenshots and hide app preview": FLAG_SECURE + no recents screenshot. Off by default; the
 *    person turns it on in Safety centre → App lock (docs/v2/05-native.md §6).
 *  - Screenshot notice (Android 14+): a local event only; nobody else is told.
 */
@CapacitorPlugin(name = "KithwallShell")
public class KithwallShellPlugin extends Plugin {
    static final String PREFS = "kw_shell";
    static final String SECURE = "secure_screen";

    // Activity.ScreenCaptureCallback (API 34); typed as Object so older Androids never resolve the class.
    private Object captureCallback;

    static boolean secureScreen(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(SECURE, false);
    }

    static void applySecure(Activity a, boolean on) {
        if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) a.setRecentsScreenshotEnabled(!on);
    }

    private String origin() {
        String o = getConfig().getString("origin", null);
        if (o == null) o = getBridge().getServerUrl();
        return o == null ? "https://www.kithwall.com" : o;
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("platform", "android");
        r.put("env", getConfig().getString("env", BuildConfig.KW_ENV));
        r.put("origin", origin());
        r.put("flavor", BuildConfig.FLAVOR);
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", p.versionName == null ? "" : p.versionName);
            r.put("build", String.valueOf(Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : 0));
        } catch (Exception e) {
            r.put("version", "");
            r.put("build", "");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        SharedPreferences.Editor e = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putBoolean(SECURE, on).apply();
        getActivity().runOnUiThread(() -> applySecure(getActivity(), on));
        call.resolve();
    }

    @PluginMethod
    public void getSecureScreen(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", secureScreen(getContext()));
        call.resolve(r);
    }

    private boolean openOutside(Uri uri) {
        String s = uri.getScheme();
        if (s == null) return false;
        s = s.toLowerCase();
        if (!s.equals("https") && !s.equals("http") && !s.equals("mailto") && !s.equals("tel")) return false;
        Intent i = new Intent(Intent.ACTION_VIEW, uri);
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        Uri u = url == null ? null : Uri.parse(url);
        if (u == null || !"https".equalsIgnoreCase(u.getScheme()) || !openOutside(u)) { call.reject("not opened", "failed"); return; }
        call.resolve();
    }

    /** Quick exit: show the neutral site in the browser and remove Kithwall from the recent-apps list. */
    @PluginMethod
    public void exit(PluginCall call) {
        String url = call.getString("url");
        Uri u = url == null ? null : Uri.parse(url);
        if (u != null && "https".equalsIgnoreCase(u.getScheme())) openOutside(u);
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finishAndRemoveTask());
    }

    /**
     * Every main-frame navigation passes here before Capacitor's own rule. Same origin (and the local
     * offline page) → load in the app. Anything else never loads in the app.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
        if (scheme.equals("data") || scheme.equals("blob")) return null;   // Capacitor's default (in-page downloads)
        Uri o = Uri.parse(origin());
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase();
        if (scheme.equals(o.getScheme()) && host.equals(o.getHost())) return null;   // the app itself
        if (scheme.equals("https") && host.equals("localhost")) return null;        // bundled offline page
        openOutside(url);
        return true;
    }

    // Android 14+: screenshot detection, registered while the activity is visible.
    @Override
    protected void handleOnStart() {
        if (Build.VERSION.SDK_INT < 34) return;
        Activity.ScreenCaptureCallback cb = () -> {
            JSObject d = new JSObject();
            d.put("kind", "screenshot");
            notifyListeners("screenshot", d);
        };
        try {
            getActivity().registerScreenCaptureCallback(getContext().getMainExecutor(), cb);
            captureCallback = cb;
        } catch (Exception ignored) {
            captureCallback = null;
        }
    }

    @Override
    protected void handleOnStop() {
        if (Build.VERSION.SDK_INT < 34 || captureCallback == null) return;
        try {
            getActivity().unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) captureCallback);
        } catch (Exception ignored) {
            // already gone
        }
        captureCallback = null;
    }
}
