package com.kithwall.app;

import android.Manifest;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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

    private String state() {
        if (Build.VERSION.SDK_INT < 33) {
            return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
        }
        PermissionState s = getPermissionState("notifications");
        if (s == PermissionState.GRANTED) return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
        if (s == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private void resolveState(PluginCall call) {
        JSObject r = new JSObject();
        r.put("state", state());
        call.resolve(r);
    }

    @PluginMethod
    public void permission(PluginCall call) {
        resolveState(call);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            resolveState(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionDone");
    }

    @PermissionCallback
    private void permissionDone(PluginCall call) {
        resolveState(call);
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

    /** A notification was tapped while the app runs: let the web app navigate in place (keeps its keys). */
    void emitOpen(String path) {
        JSObject d = new JSObject();
        d.put("url", Notifier.safePath(path));
        notifyListeners("open", d, true);
    }
}
