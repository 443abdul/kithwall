package com.kithwall.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.CapConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Censorship resistance for the Android app (docs/v2/08-censorship.md §2, §4):
 *  - Origin failover: the app normally loads the origin from capacitor.config.json. When a main-frame load
 *    fails with a connection error, the built-in fallback origins (plugins.KithwallNet.fallbacks, set at
 *    `cap sync` time from KITHWALL_FALLBACK_ORIGINS) and the mirrors learned from a verified signed list are
 *    health-checked (GET /api/net/health); the first that answers becomes the active origin and the
 *    activity is recreated on it. The next cold start goes back to the primary as soon as it answers.
 *  - "Use Tor (Orbot)": the WebView's traffic goes through Orbot's local HTTP proxy (127.0.0.1:8118, the
 *    hostname is resolved by Tor, so no DNS leak) via androidx.webkit ProxyController. WebRTC media (calls)
 *    does not use the proxy.
 * Nothing here talks to any server other than the configured origins (and Orbot on localhost).
 */
final class KwNet {
    private static final String TAG = "KwNet";
    static final String PREFS = "kw_net";
    private static final String ACTIVE = "active_origin";
    private static final String LEARNED = "learned_origins";
    private static final String TOR = "tor";
    static final String ORBOT_PACKAGE = "org.torproject.android";
    static final String ORBOT_HOST = "127.0.0.1";
    static final int ORBOT_HTTP_PORT = 8118;
    private static final int TIMEOUT_MS = 8000;
    private static final long FAILOVER_EVERY_MS = 30_000;
    private static volatile long lastFailover = 0;
    private static volatile boolean failingOver = false;

    private KwNet() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---- configuration -----------------------------------------------------------------------------------

    private static JSONObject assetConfig(Context c) {
        try (InputStream in = c.getAssets().open("capacitor.config.json");
             BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        }
    }

    /** https origin (scheme://host[:port]) or null. Plain http only for localhost (debug builds). */
    static String cleanOrigin(String s) {
        if (s == null) return null;
        try {
            Uri u = Uri.parse(s.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            String host = u.getHost();
            if (host == null || host.isEmpty() || u.getUserInfo() != null) return null;
            boolean local = host.equals("127.0.0.1") || host.equals("localhost");
            if (!scheme.equals("https") && !(scheme.equals("http") && local && BuildConfig.DEBUG)) return null;
            return scheme + "://" + host.toLowerCase() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return null;
        }
    }

    static String primary(Context c) {
        JSONObject cfg = assetConfig(c);
        String url = cfg == null ? null : cfg.optJSONObject("server") == null ? null : cfg.optJSONObject("server").optString("url", null);
        String o = cleanOrigin(url);
        return o == null ? "https://www.kithwall.com" : o;
    }

    private static List<String> builtInFallbacks(Context c) {
        List<String> out = new ArrayList<>();
        JSONObject cfg = assetConfig(c);
        JSONObject plugins = cfg == null ? null : cfg.optJSONObject("plugins");
        JSONObject net = plugins == null ? null : plugins.optJSONObject("KithwallNet");
        JSONArray arr = net == null ? null : net.optJSONArray("fallbacks");
        if (arr != null) for (int i = 0; i < arr.length(); i++) {
            String o = cleanOrigin(arr.optString(i, null));
            if (o != null) out.add(o);
        }
        return out;
    }

    static List<String> learned(Context c) {
        List<String> out = new ArrayList<>();
        for (String s : prefs(c).getString(LEARNED, "").split("\n")) {
            String o = cleanOrigin(s);
            if (o != null && o.startsWith("https://")) out.add(o);
        }
        return out;
    }

    static void setLearned(Context c, List<String> origins) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (String s : origins) {
            String o = cleanOrigin(s);
            if (o == null || !o.startsWith("https://") || n >= 32) continue;
            sb.append(o).append('\n');
            n++;
        }
        prefs(c).edit().putString(LEARNED, sb.toString()).apply();
    }

    /** Primary first, then built-in fallbacks, then learned mirrors (no duplicates). */
    static List<String> allOrigins(Context c) {
        LinkedHashSet<String> s = new LinkedHashSet<>();
        s.add(primary(c));
        s.addAll(builtInFallbacks(c));
        s.addAll(learned(c));
        return new ArrayList<>(s);
    }

    static String active(Context c) {
        String a = cleanOrigin(prefs(c).getString(ACTIVE, null));
        return a != null && allOrigins(c).contains(a) ? a : primary(c);
    }

    private static void setActive(Context c, String origin) {
        prefs(c).edit().putString(ACTIVE, origin).commit();
    }

    /**
     * The Capacitor config to start the bridge with: the bundled one, or (when a mirror is active) the same
     * config with server.url and the shell plugin's origin pointing at the mirror. Null = use the default.
     */
    static CapConfig capConfig(Activity a) {
        String active = active(a);
        if (active.equals(primary(a))) return null;
        try {
            JSONObject cfg = assetConfig(a);
            if (cfg == null) return null;
            cfg.getJSONObject("server").put("url", active);
            JSONObject plugins = cfg.optJSONObject("plugins");
            if (plugins != null && plugins.optJSONObject("KithwallShell") != null) plugins.getJSONObject("KithwallShell").put("origin", active);
            File dir = new File(a.getFilesDir(), "kwnet");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(new File(dir, "capacitor.config.json"))) {
                out.write(cfg.toString().getBytes(StandardCharsets.UTF_8));
            }
            return CapConfig.loadFromFile(a, dir.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "mirror config failed; using the primary origin", e);
            return null;
        }
    }

    // ---- health checks and failover -----------------------------------------------------------------------

    static boolean healthy(Context c, String origin) {
        HttpURLConnection conn = null;
        try {
            URL u = new URL(origin + "/api/net/health");
            conn = (HttpURLConnection) (torEnabled(c)
                    ? u.openConnection(new Proxy(Proxy.Type.HTTP, new InetSocketAddress(ORBOT_HOST, ORBOT_HTTP_PORT)))
                    : u.openConnection());
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[512];
                int n = in.read(buf);
                // A censor's block page also answers 200: require our own JSON.
                return n > 0 && new String(buf, 0, n, StandardCharsets.UTF_8).contains("\"app\":\"kithwall\"");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * The current origin failed to load. In the background, find the first origin that answers (primary
     * first); if it is a different one, switch to it and recreate the activity. Rate-limited.
     */
    static void failover(Activity a) {
        long now = SystemClock.elapsedRealtime();
        if (failingOver || now - lastFailover < FAILOVER_EVERY_MS) return;
        List<String> all = allOrigins(a);
        if (all.size() < 2) return;
        failingOver = true;
        lastFailover = now;
        final String current = active(a);
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                for (String o : all) {
                    if (healthy(a, o)) {
                        if (!o.equals(current)) {
                            setActive(a, o);
                            if (BuildConfig.DEBUG) Log.i(TAG, "switching to " + o);
                            a.runOnUiThread(a::recreate);
                        }
                        return;
                    }
                }
            } finally {
                failingOver = false;
            }
        });
    }

    /** On start, while on a mirror: go back to the primary on the next launch once it answers again. */
    static void checkPrimaryLater(Context c) {
        final String p = primary(c);
        if (active(c).equals(p)) return;
        Executors.newSingleThreadExecutor().execute(() -> {
            if (healthy(c, p)) prefs(c).edit().putString(ACTIVE, p).apply();
        });
    }

    // ---- Tor through Orbot -------------------------------------------------------------------------------

    static boolean torEnabled(Context c) {
        return prefs(c).getBoolean(TOR, false);
    }

    static void setTorEnabled(Context c, boolean on) {
        prefs(c).edit().putBoolean(TOR, on).commit();
    }

    static boolean proxySupported() {
        try {
            return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
        } catch (Throwable t) {
            return false;
        }
    }

    static boolean orbotInstalled(Context c) {
        try {
            c.getPackageManager().getPackageInfo(ORBOT_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** Orbot's HTTP proxy accepts connections (call off the main thread). */
    static boolean orbotRunning() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(ORBOT_HOST, ORBOT_HTTP_PORT), 400);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Applies (or clears) the WebView proxy for the whole app process; `done` runs when it is in effect. */
    static void applyProxy(Context c, Runnable done) {
        if (!proxySupported()) { if (done != null) done.run(); return; }
        try {
            ProxyController pc = ProxyController.getInstance();
            Runnable after = done == null ? () -> {} : done;
            if (torEnabled(c)) {
                ProxyConfig cfg = new ProxyConfig.Builder()
                        .addProxyRule(ORBOT_HOST + ":" + ORBOT_HTTP_PORT)
                        // Nothing bypasses Tor (no "<local>" rule): the bundled offline page never hits the network.
                        .build();
                pc.setProxyOverride(cfg, Runnable::run, after);
            } else {
                pc.clearProxyOverride(Runnable::run, after);
            }
        } catch (Exception e) {
            Log.w(TAG, "proxy override failed", e);
            if (done != null) done.run();
        }
    }
}
