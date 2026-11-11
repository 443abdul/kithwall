package com.kithwall.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.os.Build;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;

/**
 * KithwallPush (apps/web/src/lib/native/plugins.ts). Registers this install with the flavour's provider
 * (play: FCM; foss: UnifiedPush) and reports {provider, token, p256dh, auth} for register_native_push().
 * Pushes are decrypted and shown natively (Notifier); taps come back as 'open' events.
 */
@CapacitorPlugin(
    name = "KithwallPush",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class KithwallPushPlugin extends Plugin {

    /** The running page's plugin instance, for call actions that start outside it (CallActionReceiver). */
    private static volatile java.lang.ref.WeakReference<KithwallPushPlugin> running = new java.lang.ref.WeakReference<>(null);

    /**
     * Our own launcher for the notification permission. Capacitor's requestPermissionForAlias() looks the
     * permission up in the @CapacitorPlugin annotation, and in release builds R8 emptied that list: Capacitor
     * then requested nothing, showed no dialog and never answered the call, so "Turn on notifications" waited
     * forever (2.0.0 to 2.3.0; debug builds were fine). Nothing here depends on that annotation any more.
     * Registered in load(), i.e. while the bridge is built in onCreate: Android refuses later registrations.
     */
    private ActivityResultLauncher<String> permissionLauncher;
    private volatile PluginCall pendingPermission;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    @Override
    public void load() {
        running = new java.lang.ref.WeakReference<>(this);
        try {
            permissionLauncher = getActivity().registerForActivityResult(
                    new ActivityResultContracts.RequestPermission(), granted -> permissionAnswered(false));
        } catch (Exception e) {
            permissionLauncher = null;   // requestPermission() then answers "blocked": the settings page still works
        }
    }

    /**
     * An incoming-call action for the page (only "decline" today), if a page is running; not retained, so a
     * page that loads later never acts on a stale one. Returns false when there was nobody to tell.
     */
    static boolean emitCall(String action, String conv, String call) {
        KithwallPushPlugin p = running.get();
        if (p == null || p.getBridge() == null) return false;
        JSObject d = new JSObject();
        d.put("action", action);
        d.put("conv", conv);
        d.put("call", call);
        p.notifyListeners("call", d, false);
        return true;
    }

    /**
     * The real state, from Android itself. Capacitor's getPermissionState() answers from a cache that records
     * "denied" the first time the dialog closes without a yes (on Android 13+ even dismissing it counts) and
     * never forgets it, so the app stopped asking although Android would still show the dialog. Here: granted
     * and enabled = "granted"; not grantable by a dialog (Android 12 and older, or switched off in settings) =
     * "denied"; otherwise "prompt": ask, and let Android decide whether it still shows the dialog.
     */
    private String state() {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < 33) return enabled ? "granted" : "denied";
        boolean granted = androidx.core.content.ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (granted) return enabled ? "granted" : "denied";
        return "prompt";
    }

    /** When the current permission request started, and whether Android wanted a rationale just before it. */
    private volatile long askedAt = 0;
    private volatile boolean rationaleBefore = false;
    /** No human answers a dialog this fast: an answer sooner than this was Android's own. */
    private static final long AUTO_DENY_MS = 700;
    private static final String PERM_PREFS = "kw_push_perm";
    private static final String SAW_RATIONALE = "saw_rationale";
    private static final String UNEXPLAINED = "unexplained_refusals";

    /** Android's "explain before asking again" flag: true only between the first and the second "Don't allow". */
    private boolean rationale() {
        android.app.Activity a = getActivity();
        return a != null && androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(a, Manifest.permission.POST_NOTIFICATIONS);
    }
    /** No dialog on screen and no answer after this long: Android showed nothing, stop waiting. */
    private static final long NO_DIALOG_MS = 5000;
    /** Told to the page so it knows this build answers every request itself (lib/native/push.ts). */
    private static final int PERMISSION_API = 2;

    private void resolveState(PluginCall call) {
        JSObject r = new JSObject();
        r.put("state", state());
        r.put("api", PERMISSION_API);
        call.resolve(r);
    }

    @PluginMethod
    public void permission(PluginCall call) {
        resolveState(call);
    }

    /**
     * Ask Android. Resolves {state, blocked}: blocked = Android refused without showing the dialog (or there is
     * no dialog to show), so only the notification settings can turn notifications on.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        String now = state();
        if (!"prompt".equals(now)) {
            JSObject r = new JSObject();
            r.put("state", now);
            r.put("blocked", "denied".equals(now));
            call.resolve(r);
            return;
        }
        // Forget Capacitor's cached answer so its bookkeeping can't contradict what Android says now.
        getContext().getSharedPreferences("PluginPermStates", android.content.Context.MODE_PRIVATE).edit()
                .remove(Manifest.permission.POST_NOTIFICATIONS).apply();
        PluginCall earlier = pendingPermission;
        pendingPermission = call;
        if (earlier != null) answer(earlier, false);   // a second tap while the dialog is up: the first gets the state so far
        main.post(() -> {
            if (pendingPermission != call) return;
            try {
                rationaleBefore = rationale();
                askedAt = android.os.SystemClock.elapsedRealtime();
                if (permissionLauncher == null) throw new IllegalStateException("no launcher");
                permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
            } catch (Exception e) {
                permissionAnswered(true);
                return;
            }
            // Every request gets an answer: if Android neither shows its dialog (the activity would lose focus)
            // nor reports back, say so instead of leaving the page waiting.
            main.postDelayed(() -> {
                if (pendingPermission != call) return;
                android.app.Activity a = getActivity();
                if (a != null && a.hasWindowFocus() && KwActivity.isForeground()) permissionAnswered(true);
            }, NO_DIALOG_MS);
        });
    }

    /**
     * blocked = not granted and Android did not ask the person this time (it stops asking after two "Don't
     * allow", or notifications were switched off in the settings): only the settings can turn them on, so the
     * page opens them. Android doesn't say whether it showed its dialog, and neither timing (a slow phone takes
     * seconds to refuse by itself) nor window focus (lost briefly either way) tells; the rationale flag does:
     *   false -> true    the first "Don't allow": Android will ask once more        not blocked
     *   true  -> false   the second "Don't allow", answered in the dialog           not blocked (this time)
     *   false -> false   Android refused by itself, OR the very first dialog was dismissed without an
     *                    answer. Blocked if a refusal was seen before, if the answer came faster than a
     *                    person can tap, or if it happens twice in a row.
     */
    private void answer(PluginCall call, boolean noDialog) {
        String now = state();
        boolean granted = "granted".equals(now);
        boolean blocked = false;
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PERM_PREFS, android.content.Context.MODE_PRIVATE);
        if (granted) {
            prefs.edit().remove(UNEXPLAINED).apply();
        } else if (noDialog) {
            blocked = true;
        } else if (rationale()) {
            prefs.edit().putBoolean(SAW_RATIONALE, true).remove(UNEXPLAINED).apply();
        } else if (!rationaleBefore) {
            int unexplained = prefs.getInt(UNEXPLAINED, 0);
            blocked = prefs.getBoolean(SAW_RATIONALE, false) || unexplained >= 1
                    || android.os.SystemClock.elapsedRealtime() - askedAt < AUTO_DENY_MS;
            prefs.edit().putInt(UNEXPLAINED, unexplained + 1).apply();
        }
        JSObject r = new JSObject();
        r.put("state", now);
        r.put("blocked", blocked);
        call.resolve(r);
    }

    /** Android answered the request (or, noDialog, showed nothing at all). */
    private void permissionAnswered(boolean noDialog) {
        PluginCall call = pendingPermission;
        pendingPermission = null;
        if (call != null) answer(call, noDialog);
    }

    /**
     * Android asks for the notification permission at most twice; after that (or when notifications were
     * switched off for the app) only the system settings can turn them back on. Opens this app's
     * notification settings page (the app's details page on older systems).
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 26) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("no settings screen", "failed");
        }
    }

    @PluginMethod
    public void register(PluginCall call) {
        String vapid = call.getString("vapid");
        PushProviderImpl.register(getActivity(), vapid, new PushCallback() {
            @Override
            public void ok(String provider, String token, String p256dh, String auth) {
                try {
                    PushStore.saveRegistration(getContext(), provider, token, p256dh, auth);
                } catch (Exception e) {
                    call.reject("could not save", "failed");
                    return;
                }
                JSObject r = new JSObject();
                r.put("provider", provider);
                r.put("token", token);
                r.put("p256dh", p256dh);
                r.put("auth", auth);
                call.resolve(r);
            }

            @Override
            public void error(String code) {
                call.reject(code, code);
            }
        });
    }

    @PluginMethod
    public void current(PluginCall call) {
        String[] reg = PushStore.registration(getContext());
        JSObject r = new JSObject();
        if (reg != null) {
            r.put("provider", reg[0]);
            r.put("token", reg[1]);
            r.put("p256dh", reg[2]);
            r.put("auth", reg[3]);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        try {
            PushProviderImpl.unregister(getContext());
        } catch (Exception ignored) {
            // provider unavailable: forgetting locally is what matters
        }
        PushStore.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setHidden(PluginCall call) {
        String salt = call.getString("salt");
        JSArray hashes = call.getArray("hashes");
        if (salt == null || hashes == null || hashes.length() > 10000) { call.reject("bad list", "failed"); return; }
        try {
            PushStore.setHidden(getContext(), salt, new JSONArray(hashes.toString()));
            call.resolve();
        } catch (Exception e) {
            call.reject("could not save", "failed");
        }
    }

    @PluginMethod
    public void clearHidden(PluginCall call) {
        PushStore.clearHidden(getContext());
        call.resolve();
    }

    @PluginMethod
    public void clearNotifications(PluginCall call) {
        Notifier.cancelAll(getContext());
        call.resolve();
    }

    /** This device stopped ringing for a call in that chat (answered, declined, cancelled…): stop the notification and screen. */
    @PluginMethod
    public void cancelCall(PluginCall call) {
        String conv = call.getString("conv");
        if (conv == null || !Notifier.UUID.matcher(conv).matches()) { call.reject("bad conversation", "failed"); return; }
        Notifier.cancel(getContext(), "call:" + conv);
        call.resolve();
    }

    /** A notification was tapped while the app runs: let the web app navigate in place (keeps its keys). */
    void emitOpen(String path) {
        JSObject d = new JSObject();
        d.put("url", Notifier.safePath(path));
        notifyListeners("open", d, true);
    }
}
