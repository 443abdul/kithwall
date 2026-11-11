package com.kithwall.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Crash reports, the app's own part (opt-in; docs/v2/03-transparency.md §6, apps/web/src/lib/crash). When the
 * person has turned "Send crash reports" on in Settings → Your data, a crash of the app itself (an uncaught
 * Java exception on any thread) is written to one small file in the app's private storage, and the web app
 * sends it the next time it starts (KithwallShell.pendingCrash / clearCrash), after scrubbing it like every
 * other report.
 *
 * What is written: the exception's class name, its stack frames (class, method, file, line) and those of its
 * root cause, and the app version. Never the exception MESSAGE: Android's messages quote file paths, content
 * URIs and values. Nothing is written while the setting is off (the default), and the file and the setting
 * are removed by the panic wipe (KithwallShell.clearWebData).
 *
 * The previous default handler always runs afterwards, so the app still stops the way Android expects.
 */
final class KwCrash {
    private static final String PREFS = "kw_crash";
    private static final String ENABLED = "enabled";
    private static final String FILE = "kw-crash.json";
    private static final int MAX_FRAMES = 40;
    private static final int MAX_CAUSE_FRAMES = 20;
    private static final int MAX_BYTES = 16 * 1024;

    private static volatile boolean enabled = false;
    private static String version = "";
    private static String build = "";

    private KwCrash() {}

    /** Called once from KwApp.onCreate, before anything else of the app runs. */
    static void install(Context app) {
        final Context c = app.getApplicationContext();
        try {
            enabled = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false);
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            version = p.versionName == null ? "" : p.versionName;
            build = String.valueOf(Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : 0);
        } catch (Exception ignored) {
            // Stays off / unknown.
        }
        beFirst(c);
    }

    /** Our handler: records once (it may sit in the chain twice, see beFirst), then lets the others run. */
    private static final class Recorder implements Thread.UncaughtExceptionHandler {
        private final Context app;
        private final Thread.UncaughtExceptionHandler previous;

        Recorder(Context app, Thread.UncaughtExceptionHandler previous) {
            this.app = app;
            this.previous = previous;
        }

        @Override
        public void uncaughtException(Thread thread, Throwable error) {
            try {
                if (enabled && !recorded) {
                    recorded = true;
                    record(app, error);
                }
            } catch (Throwable ignored) {
                // Recording must never get in the way of the crash itself.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        }
    }

    private static volatile boolean recorded = false;

    /**
     * Keep our handler in front of the others. Android System WebView installs its own default handler when
     * it starts (after KwApp.onCreate), and that handler ends the process itself (logcat: "FATAL
     * java_exception_reporter: Uncaught exception") rather than passing the crash on: whatever sits behind it
     * in the chain never runs. So the activity calls this again once the WebView exists and every time it
     * comes to the front; whenever another handler has moved in front, ours wraps it. Cheap when nothing
     * changed. The main thread does not depend on this ordering at all (guardMainThread).
     */
    static void beFirst(Context app) {
        final Context c = app.getApplicationContext();
        guardMainThread(c);
        Thread.UncaughtExceptionHandler current = Thread.getDefaultUncaughtExceptionHandler();
        if (current instanceof Recorder) return;
        Thread.setDefaultUncaughtExceptionHandler(new Recorder(c, current));
    }

    /**
     * The main thread gets its own handler, which Android calls BEFORE any default handler, so recording a
     * main-thread crash cannot be pre-empted by a default handler installed later (the WebView installs its
     * own lazily). Nearly every crash of this app surfaces on the main thread (the WebView's callbacks and
     * the activity run there); other threads rely on beFirst() staying in front of the default chain. After
     * recording, the default chain runs as if this handler were not there.
     * Verified on a device with a release build (scripts/verify-release.mjs): `am crash <pid of the app>`
     * leaves kw-crash.json with the class and frames. Note `am crash <package>` may crash the WebView's
     * renderer process instead of the app, which records nothing and proves nothing.
     */
    private static void guardMainThread(final Context app) {
        Thread main = android.os.Looper.getMainLooper().getThread();
        if (main.getUncaughtExceptionHandler() instanceof MainGuard) return;
        main.setUncaughtExceptionHandler(new MainGuard(app));
    }

    private static final class MainGuard implements Thread.UncaughtExceptionHandler {
        private final Context app;

        MainGuard(Context app) {
            this.app = app;
        }

        @Override
        public void uncaughtException(Thread thread, Throwable error) {
            try {
                if (enabled && !recorded) {
                    recorded = true;
                    record(app, error);
                }
            } catch (Throwable ignored) {
                // Recording must never get in the way of the crash itself.
            }
            Thread.UncaughtExceptionHandler rest = Thread.getDefaultUncaughtExceptionHandler();
            if (rest != null) rest.uncaughtException(thread, error);
            else {
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(10);
            }
        }
    }

    static boolean isEnabled() {
        return enabled;
    }

    static void setEnabled(Context c, boolean on) {
        enabled = on;
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (on) e.putBoolean(ENABLED, true); else e.remove(ENABLED);
        e.apply();
        if (!on) clear(c);
    }

    private static void frames(StringBuilder out, Throwable t, int max) {
        StackTraceElement[] st = t.getStackTrace();
        for (int i = 0; i < st.length && i < max; i++) out.append("at ").append(st[i].toString()).append('\n');
    }

    /** Class names and frames only (the same shape as a Java stack trace, without any message). */
    static String describe(Throwable error) {
        StringBuilder out = new StringBuilder();
        frames(out, error, MAX_FRAMES);
        Throwable root = error;
        for (int depth = 0; depth < 8 && root.getCause() != null && root.getCause() != root; depth++) root = root.getCause();
        if (root != error) {
            // A marker frame, so the cause's class survives the scrubber (which keeps frames, not free lines).
            out.append("at CausedBy.").append(root.getClass().getName()).append("(Unknown Source)\n");
            frames(out, root, MAX_CAUSE_FRAMES);
        }
        return out.toString();
    }

    private static void record(Context c, Throwable error) throws Exception {
        JSONObject o = new JSONObject();
        o.put("name", error.getClass().getName());
        o.put("stack", describe(error));
        o.put("version", version);
        o.put("build", build);
        byte[] bytes = o.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) return;
        try (FileOutputStream f = new FileOutputStream(new File(c.getFilesDir(), FILE))) {
            f.write(bytes);
            f.getFD().sync();
        }
    }

    /** The crash recorded before this start, or null. */
    static JSONObject pending(Context c) {
        File f = new File(c.getFilesDir(), FILE);
        if (!f.isFile() || f.length() == 0 || f.length() > MAX_BYTES) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            return new JSONObject(new String(buf, 0, n, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    static void clear(Context c) {
        //noinspection ResultOfMethodCallIgnored
        new File(c.getFilesDir(), FILE).delete();
    }

    /** Panic wipe: no crash file and the setting back to off (the web side's copy of it is wiped too). */
    static void forget(Context c) {
        setEnabled(c, false);
    }
}
