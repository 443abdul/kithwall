package com.kithwall.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Decline" on an incoming-call notification (or IncomingCallActivity): stops the ringing here, and when the
 * page is running (in the background, unlocked) hands the decline to it, which sends the sealed decline the
 * caller hears (lib/calls/engine.ts declineFromPush). The native side holds no keys, so with the app closed
 * the caller just stops hearing this device ring (their own ringing times out).
 */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        decline(context, intent.getStringExtra(Notifier.EXTRA_TAG), intent.getStringExtra(Notifier.EXTRA_CONV),
                intent.getStringExtra(Notifier.EXTRA_CALL));
    }

    static void decline(Context c, String tag, String conv, String call) {
        Notifier.cancel(c, tag);
        if (conv != null && call != null && Notifier.UUID.matcher(conv).matches() && Notifier.UUID.matcher(call).matches()) {
            KithwallPushPlugin.emitCall("decline", conv, call);
        }
    }
}
