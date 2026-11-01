package com.kithwall.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;

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
 *  - Kit Drop (docs/v2/08-censorship.md §5): whether the offline shell is kept (for the bundled offline
 *    page), and reading a Kit Drop file handed to the app from outside (KwKitDrop).
 */
@CapacitorPlugin(name = "KithwallShell")
public class KithwallShellPlugin extends Plugin {
    static final String PREFS = "kw_shell";
    static final String SECURE = "secure_screen";
    /** The origin whose service worker keeps the offline shell (none: no "Open Kit Drop" on the offline page). */
    static final String OFFLINE_SHELL = "offline_shell";

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

    /**
     * SHA-256 of the certificate this installed app is signed with ("AA:BB:..."), or "" if unknown. The page
     * compares it with the fingerprints the website publishes (assetlinks.json): a repackaged copy is signed
     * with someone else's key. (A deliberately modified app could lie here; this catches the common fakes.)
     */
    private String signerSha256() {
        try {
            android.content.pm.PackageManager pm = getContext().getPackageManager();
            android.content.pm.Signature[] sigs;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo p = pm.getPackageInfo(getContext().getPackageName(), android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES);
                sigs = p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners();
            } else {
                @SuppressWarnings("deprecation")
                PackageInfo p = pm.getPackageInfo(getContext().getPackageName(), android.content.pm.PackageManager.GET_SIGNATURES);
                sigs = p.signatures;
            }
            if (sigs == null || sigs.length == 0) return "";
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray());
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < d.length; i++) { if (i > 0) b.append(':'); b.append(String.format("%02X", d[i])); }
            return b.toString();
        } catch (Exception e) {
            return "";
        }
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
        r.put("signer", signerSha256());
        call.resolve(r);
    }

    /**
     * Panic wipe (security review N6/P1): forget the WebView's own data too: cookies, DOM storage and
     * IndexedDB of every origin, the HTTP cache, form data and history. The web side has already cleared
     * what it can reach; this covers what it can't (cache, cookies, other origins' storage).
     */
    @PluginMethod
    public void clearWebData(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                WebStorage.getInstance().deleteAllData();
                CookieManager cm = CookieManager.getInstance();
                cm.removeAllCookies(null);
                cm.removeSessionCookies(null);
                cm.flush();
                WebView w = getBridge().getWebView();
                if (w != null) {
                    w.clearCache(true);
                    w.clearFormData();
                    w.clearHistory();
                }
                // Copies of picked attachments (KwChromeClient), Android 9 download copies (KwDownloads) and Kit
                // Drop files handed to the app (KwKitDrop); the offline shell is gone with the web storage.
                deleteTree(new java.io.File(getContext().getCacheDir(), "picked"));
                deleteTree(new java.io.File(getContext().getCacheDir(), "downloads"));
                KwKitDrop.clear(getContext());
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(OFFLINE_SHELL).apply();
                call.resolve();
            } catch (Exception e) {
                call.reject("could not clear web data", e);
            }
        });
    }

    private static void deleteTree(java.io.File f) {
        java.io.File[] kids = f.listFiles();
        if (kids != null) for (java.io.File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    // ---- Kit Drop without the internet (docs/v2/08-censorship.md §5) ----------------------------------------

    /** Does this origin's service worker keep the offline shell (reported by the page, lib/net/shell.ts)? */
    static boolean offlineShellReady(Context c, String origin) {
        String o = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(OFFLINE_SHELL, null);
        return o != null && origin != null && o.equals(origin.replaceAll("/+$", ""));
    }

    @PluginMethod
    public void setOfflineShell(PluginCall call) {
        boolean ready = Boolean.TRUE.equals(call.getBoolean("ready", false));
        String origin = getBridge().getServerUrl();
        SharedPreferences.Editor e = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (ready && origin != null) e.putString(OFFLINE_SHELL, origin.replaceAll("/+$", "")); else e.remove(OFFLINE_SHELL);
        e.apply();
        call.resolve();
    }

    private static final java.util.concurrent.ExecutorService kitdropIo = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** The Kit Drop file handed to the app (KwKitDrop), once copied: {id, name, size}, or {} if there is none. */
    @PluginMethod
    public void kitdropPending(PluginCall call) {
        kitdropIo.execute(() -> {
            KwKitDrop.Pending p = KwKitDrop.ready(20_000);
            JSObject r = new JSObject();
            if (p != null) {
                r.put("id", p.id);
                r.put("name", p.name);
                r.put("size", p.size);
            }
            call.resolve(r);
        });
    }

    @PluginMethod
    public void kitdropRead(PluginCall call) {
        String id = call.getString("id");
        Long offset = call.getLong("offset", 0L);
        kitdropIo.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("data", KwKitDrop.read(id == null ? "" : id, offset == null ? 0 : offset));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("could not read", "failed");
            }
        });
    }

    @PluginMethod
    public void kitdropDone(PluginCall call) {
        String id = call.getString("id");
        if (id != null) KwKitDrop.done(id);
        call.resolve();
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

    // ---- downloads (KwDownloads): the page streams a blob it made (export, .ics, photo, video) ----------

    @PluginMethod
    public void downloadStart(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("id", KwDownloads.start(getContext(), call.getString("name"), call.getString("mime")));
            call.resolve(r);
        } catch (Exception e) {
            KwDownloads.toast(getActivity(), getContext().getString(R.string.kw_download_failed));
            call.reject("could not save", "failed");
        }
    }

    @PluginMethod
    public void downloadChunk(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        if (id == null || data == null || data.length() > 4 * 1024 * 1024) { call.reject("bad chunk", "failed"); return; }
        try {
            KwDownloads.chunk(id, Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            KwDownloads.abort(getContext(), id);
            call.reject("could not save", "failed");
        }
    }

    @PluginMethod
    public void downloadFinish(PluginCall call) {
        String id = call.getString("id");
        try {
            JSObject r = new JSObject();
            r.put("name", KwDownloads.finish(getActivity(), id == null ? "" : id));
            call.resolve(r);
        } catch (Exception e) {
            if (id != null) KwDownloads.abort(getContext(), id);
            KwDownloads.toast(getActivity(), getContext().getString(R.string.kw_download_failed));
            call.reject("could not save", "failed");
        }
    }

    @PluginMethod
    public void downloadAbort(PluginCall call) {
        String id = call.getString("id");
        if (id != null) KwDownloads.abort(getContext(), id);
        call.resolve();
    }

    // ---- share sheet (navigator.share is not implemented by Android WebView) ------------------------------

    @PluginMethod
    public void share(PluginCall call) {
        String title = call.getString("title");
        String text = call.getString("text");
        String url = call.getString("url");
        StringBuilder body = new StringBuilder();
        if (text != null && !text.isEmpty()) body.append(text);
        if (url != null && !url.isEmpty()) {
            Uri u = Uri.parse(url);
            if (!"https".equalsIgnoreCase(u.getScheme())) { call.reject("only https links", "failed"); return; }
            if (body.length() > 0) body.append(' ');
            body.append(url);
        }
        if (body.length() == 0 || body.length() > 8192) { call.reject("nothing to share", "failed"); return; }
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, body.toString());
        if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_TITLE, title);
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(Intent.createChooser(send, title));
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("no app to share with", "unavailable");
            }
        });
    }

    // ---- calls: keep the screen on, voice-call audio mode, speaker / earpiece -------------------------------

    private Integer savedAudioMode;

    /**
     * Called by the web call UI (lib/native/calls.ts) when a call starts, changes route or ends. While active:
     * the screen stays on, the volume keys control call volume, audio uses the communication mode (echo
     * cancellation, Bluetooth headsets) and goes to the speaker (video calls) or the earpiece (voice calls),
     * and a "call in progress" foreground service keeps the microphone (and camera for video) working when
     * the person switches to another app (KwCallService).
     */
    @PluginMethod
    public void setCallAudio(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        boolean speaker = Boolean.TRUE.equals(call.getBoolean("speaker", true));
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        getActivity().runOnUiThread(() -> {
            Activity a = getActivity();
            AudioManager am = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
            try {
                if (active) {
                    a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    a.setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
                    if (savedAudioMode == null) savedAudioMode = am.getMode();
                    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    route(am, speaker);
                    KwCallService.start(a, video);
                } else {
                    KwCallService.stop(a);
                    a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    a.setVolumeControlStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
                    if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
                    else am.setSpeakerphoneOn(false);
                    am.setMode(savedAudioMode == null ? AudioManager.MODE_NORMAL : savedAudioMode);
                    savedAudioMode = null;
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("audio routing failed", "failed");
            }
        });
    }

    @SuppressWarnings("deprecation")
    private static void route(AudioManager am, boolean speaker) {
        if (Build.VERSION.SDK_INT >= 31) {
            // A wired or Bluetooth headset wins over both; otherwise speaker or earpiece as asked.
            AudioDeviceInfo pick = null;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                int t = d.getType();
                if (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                        || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_USB_HEADSET
                        || (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET)) { pick = d; break; }
                if (t == (speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)) pick = d;
            }
            if (pick != null) am.setCommunicationDevice(pick);
        } else {
            am.setSpeakerphoneOn(speaker);
        }
    }

    @Override
    protected void handleOnDestroy() {
        KwCallService.stop(getContext());
        if (savedAudioMode != null) {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(savedAudioMode);
            savedAudioMode = null;
        }
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
