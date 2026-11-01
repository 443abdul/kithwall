package com.kithwall.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/**
 * The incoming-call screen over the lock screen: the full-screen intent of a call notification
 * (Notifier.showCall). Native and deliberately bare: no WebView, nothing from the account, only who is
 * calling, and not even that while the phone is locked with a PIN, pattern or password (the same rule as
 * the notification's lock-screen copy: "Incoming call").
 *
 *  - Answer: the system unlocks first (requestDismissKeyguard), then the app opens straight into the call
 *    (/messages/<chat>?call=<id>&answer=1; the page accepts the ring without a second tap).
 *  - Decline: CallActionReceiver (stops ringing; the running page sends the sealed decline).
 *  - It closes itself when the notification goes away (Notifier.cancel: answered or declined elsewhere,
 *    cancelled, the page stopped ringing) and when the caller's ring time is up.
 * The app's "block screenshots" setting applies here too.
 */
public class IncomingCallActivity extends Activity {
    static final String EXTRA_NAME = "kw_name";
    static final String EXTRA_GROUP = "kw_group";
    static final String EXTRA_DEADLINE = "kw_deadline";

    private static WeakReference<IncomingCallActivity> shown = new WeakReference<>(null);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable expire = this::finish;
    private String tag;
    private String path;
    private String conv;
    private String call;

    /** The call notification `tag` went away (null: every call): close the screen if it shows that call. */
    static void close(String tag) {
        new Handler(Looper.getMainLooper()).post(() -> {
            IncomingCallActivity a = shown.get();
            if (a != null && !a.isFinishing() && (tag == null || tag.equals(a.tag))) a.finish();
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        KithwallShellPlugin.applySecure(this, KithwallShellPlugin.secureScreen(this));
        setContentView(R.layout.activity_incoming_call);
        findViewById(R.id.kw_call_answer).setOnClickListener(v -> answer());
        findViewById(R.id.kw_call_decline).setOnClickListener(v -> decline());
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    private void bind(Intent i) {
        tag = i.getStringExtra(Notifier.EXTRA_TAG);
        path = i.getStringExtra(Notifier.EXTRA_URL);
        conv = i.getStringExtra(Notifier.EXTRA_CONV);
        call = i.getStringExtra(Notifier.EXTRA_CALL);
        long left = i.getLongExtra(EXTRA_DEADLINE, 0) - System.currentTimeMillis();
        if (tag == null || path == null || left <= 0) { finish(); return; }
        shown = new WeakReference<>(this);
        handler.removeCallbacks(expire);
        handler.postDelayed(expire, Math.min(left, Notifier.RING_MS));

        KeyguardManager km = getSystemService(KeyguardManager.class);
        boolean locked = km != null && km.isKeyguardLocked() && km.isKeyguardSecure();
        String name = i.getStringExtra(EXTRA_NAME);
        String incoming = getString(i.getBooleanExtra(EXTRA_GROUP, false) ? R.string.kw_call_group : R.string.kw_call_incoming);
        TextView title = findViewById(R.id.kw_call_name);
        TextView sub = findViewById(R.id.kw_call_sub);
        if (locked || name == null) {
            title.setText(incoming);
            sub.setText(R.string.app_name);
        } else {
            title.setText(name);
            sub.setText(incoming);
        }
    }

    private void answer() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km != null && km.isKeyguardLocked()) {
            // The app itself never shows over the lock screen: unlock first (PIN, fingerprint…), then open it.
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    openCall();
                }
            });
            return;
        }
        openCall();
    }

    private void openCall() {
        if (isFinishing() || path == null) return;
        startActivity(Notifier.openActivityIntent(this, Notifier.answerPath(path), tag));
        finish();
    }

    private void decline() {
        CallActionReceiver.decline(this, tag, conv, call);
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(expire);
        if (shown.get() == this) shown.clear();
        super.onDestroy();
    }
}
