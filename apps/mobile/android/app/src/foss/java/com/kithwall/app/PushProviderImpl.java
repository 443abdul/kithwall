package com.kithwall.app;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.unifiedpush.android.connector.UnifiedPush;

/**
 * foss flavour: UnifiedPush (no Google libraries). The person's distributor app (ntfy, NextPush, ...) gives
 * an https endpoint; the server sends standard Web Push to it, encrypted to keys the connector library
 * keeps on this phone. The endpoint arrives asynchronously in KwUnifiedPushService.
 */
final class PushProviderImpl {
    private PushProviderImpl() {}

    static final String PROVIDER = "unifiedpush";
    private static final String INSTANCE = "default";
    private static PushCallback pending;
    private static final Handler main = new Handler(Looper.getMainLooper());

    static synchronized void complete(String token, String p256dh, String auth) {
        if (pending == null) return;
        PushCallback cb = pending;
        pending = null;
        cb.ok(PROVIDER, token, p256dh, auth);
    }

    static synchronized void fail(String code) {
        if (pending == null) return;
        PushCallback cb = pending;
        pending = null;
        cb.error(code);
    }

    private static synchronized void setPending(PushCallback cb) {
        if (pending != null) pending.error("failed");
        pending = cb;
    }

    static void register(Activity activity, String vapid, PushCallback cb) {
        Context c = activity.getApplicationContext();
        String[] known = PushStore.registration(c);
        activity.runOnUiThread(() -> UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, success -> {
            if (!success) {
                cb.error("no_distributor");
                return kotlin.Unit.INSTANCE;
            }
            setPending(cb);
            String v = vapid != null && vapid.matches("^[A-Za-z0-9_-]{87}$") ? vapid : null;
            try {
                UnifiedPush.register(c, INSTANCE, "Kithwall notifications", v);
            } catch (Exception e) {
                fail("failed");
                return kotlin.Unit.INSTANCE;
            }
            // An install that is already registered may not get a new endpoint callback: answer with the
            // endpoint we know, then give up after 30 s.
            main.postDelayed(() -> {
                if (known != null && PROVIDER.equals(known[0])) complete(known[1], known[2], known[3]);
            }, 5_000);
            main.postDelayed(() -> fail("failed"), 30_000);
            return kotlin.Unit.INSTANCE;
        }));
    }

    static void unregister(Context c) {
        UnifiedPush.unregister(c, INSTANCE);
    }
}
