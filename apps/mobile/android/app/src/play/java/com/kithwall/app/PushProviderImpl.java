package com.kithwall.app;

import android.app.Activity;
import android.content.Context;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * play flavour: Firebase Cloud Messaging. Firebase only starts (and only creates a token) when the person
 * turns notifications on; payloads are data-only ciphertext for the device key in PushStore.
 */
final class PushProviderImpl {
    private PushProviderImpl() {}

    static final String PROVIDER = "fcm";

    private static boolean ready(Context c) {
        if (!FirebaseApp.getApps(c).isEmpty()) return true;
        // No google-services.json in this build: no FCM project to talk to.
        return FirebaseApp.initializeApp(c) != null;
    }

    static void register(Activity activity, String vapid, PushCallback cb) {
        Context c = activity.getApplicationContext();
        try {
            if (!ready(c)) { cb.error("unavailable"); return; }
            FirebaseMessaging fm = FirebaseMessaging.getInstance();
            fm.setAutoInitEnabled(true);
            fm.getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) { cb.error("unavailable"); return; }
                try {
                    String[] keys = PushStore.ensureOwnKeys(c);
                    cb.ok(PROVIDER, task.getResult(), keys[0], keys[1]);
                } catch (Exception e) {
                    cb.error("failed");
                }
            });
        } catch (Exception e) {
            cb.error("unavailable");
        }
    }

    static void unregister(Context c) {
        if (FirebaseApp.getApps(c).isEmpty()) return;
        FirebaseMessaging fm = FirebaseMessaging.getInstance();
        fm.setAutoInitEnabled(false);
        fm.deleteToken();
    }
}
