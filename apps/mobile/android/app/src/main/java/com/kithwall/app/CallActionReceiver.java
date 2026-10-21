package com.kithwall.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Decline" on an incoming-call notification: just closes it (the caller's ringing times out). */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Notifier.cancel(context, intent.getStringExtra(Notifier.EXTRA_TAG));
    }
}
