package com.kithwall.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shows a decrypted push (the same "who + what" JSON public/sw.js gets): message, notification, test or
 * call. Mirrors the service worker's rules:
 *  - only same-app paths can be opened;
 *  - a hidden chat gets the generic "You have new activity on Kithwall." with no sender and no link into it;
 *  - while Kithwall is on screen, message and call pushes are left to the app itself;
 *  - calls ring with a full-screen, call-style notification (IncomingCallActivity over the lock screen) that
 *    stops when the caller's 45 s are up, when the call is answered, declined or cancelled on this device
 *    (the page calls KithwallPush.cancelCall), or when Answer / Decline is tapped.
 * Lock-screen copies are always the generic text (VISIBILITY_PRIVATE with a public version; for calls,
 * "Incoming call" with no name).
 */
final class Notifier {
    private Notifier() {}

    static final String EXTRA_CONV = "kw_conv";
    static final String EXTRA_CALL = "kw_call";
    /** How long a call rings (lib/calls/engine.ts RING_MS). */
    static final long RING_MS = 45_000;
    private static final Pattern CALL_QUERY = Pattern.compile("[?&]call=([0-9a-fA-F-]{36})(?:&|$)");
    static final Pattern UUID = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    /** Call notifications showing now: tag → call id (a repeated push for the same call doesn't ring again). */
    private static final java.util.Map<String, String> ringing = new java.util.concurrent.ConcurrentHashMap<>();

    static final String CH_MESSAGES = "messages";
    static final String CH_CALLS = "calls";
    static final String CH_ACTIVITY = "activity";
    static final String EXTRA_URL = "kw_url";
    static final String EXTRA_TAG = "kw_tag";
    /** Per-install secret on our own notification intents (security review L15): MainActivity is exported, so
     *  other apps could otherwise send it kw_url / kw_tag to open paths or cancel our notifications. */
    static final String EXTRA_TOKEN = "kw_token";
    private static final String TOKEN_PREFS = "kw_intent";
    private static final String GENERIC = "You have new activity on Kithwall.";
    private static final Pattern MSG_PATH = Pattern.compile("^/messages/([0-9a-fA-F-]{36})");
    private static final Pattern CONV_TAG = Pattern.compile("^conv:([0-9a-fA-F-]{36})$");
    private static final Pattern CALL_TAG = Pattern.compile("^call:([0-9a-fA-F-]{36})$");

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel msgs = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msgs.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        calls.enableVibration(true);
        NotificationChannel activity = new NotificationChannel(CH_ACTIVITY, "Activity", NotificationManager.IMPORTANCE_DEFAULT);
        activity.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(msgs);
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(activity);
    }

    /** Only same-app paths: "/x…", never "//host", a scheme, a backslash or a control character. */
    static String safePath(String u) {
        if (u == null || !u.startsWith("/") || u.startsWith("//") || u.length() > 512 || u.contains("\\")) return "/activity";
        for (int k = 0; k < u.length(); k++) if (u.charAt(k) < 0x20 || u.charAt(k) == 0x7f) return "/activity";
        return u;
    }

    /** A random secret made once per install; never leaves the app (only our PendingIntents carry it). */
    static synchronized String installToken(Context c) {
        android.content.SharedPreferences p = c.getSharedPreferences(TOKEN_PREFS, Context.MODE_PRIVATE);
        String t = p.getString("t", null);
        if (t == null) {
            byte[] b = new byte[32];
            new java.security.SecureRandom().nextBytes(b);
            t = android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP | android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING);
            p.edit().putString("t", t).apply();
        }
        return t;
    }

    /** True when an intent came from one of our own notifications (constant-time token check). */
    static boolean fromOurNotification(Context c, android.content.Intent i) {
        String got = i == null ? null : i.getStringExtra(EXTRA_TOKEN);
        if (got == null) return false;
        return java.security.MessageDigest.isEqual(got.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                installToken(c).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static String conversationOf(String path, String tag) {
        Matcher m = MSG_PATH.matcher(path);
        if (m.find()) return m.group(1);
        if (tag != null) {
            m = CONV_TAG.matcher(tag);
            if (m.find()) return m.group(1);
            m = CALL_TAG.matcher(tag);
            if (m.find()) return m.group(1);
        }
        return null;
    }

    private static String clip(String s, int n) {
        return s == null ? "" : s.length() > n ? s.substring(0, n) : s;
    }

    /** Opens the app at an in-app path (MainActivity checks the per-install token). */
    static Intent openActivityIntent(Context c, String path, String tag) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(EXTRA_URL, path);
        i.putExtra(EXTRA_TAG, tag);
        i.putExtra(EXTRA_TOKEN, installToken(c));
        return i;
    }

    private static PendingIntent openIntent(Context c, String path, String tag, int req) {
        return PendingIntent.getActivity(c, req, openActivityIntent(c, path, tag), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The call's chat link with "&answer=1": the page accepts the call's ring without a second tap. */
    static String answerPath(String path) {
        return path + (path.indexOf('?') >= 0 ? "&" : "?") + "answer=1";
    }

    static void show(Context c, String json) {
        JSONObject d;
        try { d = new JSONObject(json); } catch (Exception e) { return; }
        String kind = d.optString("kind", "notification");
        String title = clip(d.optString("title", "Kithwall"), 60);
        String body = clip(d.optString("body", GENERIC), 200);
        String tag = clip(d.optString("tag", "kithwall"), 120);
        String path = safePath(d.optString("url", "/activity"));
        if (title.isEmpty()) title = "Kithwall";
        if (body.isEmpty()) body = GENERIC;

        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannels(c);

        // Hidden chat: say only that something happened.
        if (PushStore.isHidden(c, conversationOf(path, tag))) {
            post(c, "kithwall", base(c, CH_ACTIVITY, "Kithwall", GENERIC, openIntent(c, "/activity", "kithwall", 1)).build());
            return;
        }
        // The app is on screen: it shows new messages and rings for calls itself.
        if (MainActivity.isForeground() && ("message".equals(kind) || "call".equals(kind))) return;

        int req = tag.hashCode();
        PendingIntent open = openIntent(c, path, tag, req);
        if ("call".equals(kind)) {
            showCall(c, body, tag, path, d.optLong("ts", 0), open, req);
            return;
        }
        String channel = "message".equals(kind) ? CH_MESSAGES : CH_ACTIVITY;
        NotificationCompat.Builder b = base(c, channel, title, body, open);
        if ("message".equals(kind)) b.setCategory(NotificationCompat.CATEGORY_MESSAGE);
        post(c, tag, b.build());
    }

    private static NotificationCompat.Builder base(Context c, String channel, String title, String body, PendingIntent open) {
        NotificationCompat.Builder pub = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_kithwall)
                .setContentTitle("Kithwall")
                .setContentText(GENERIC);
        return new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_kithwall)
                .setColor(0xFFB4532A)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(pub.build())
                .setContentIntent(open);
    }

    /**
     * How much of a call's ring is left, from when the call started (`ts`, the server's time of the call
     * notice): 0 = over, don't ring. Clocks differ between phones and the server, so a little slack: a
     * push that looks up to 15 s too old still rings for 15 s, and a clock that runs behind rings 45 s.
     */
    static long ringLeft(long ts, long now) {
        if (ts <= 0) return RING_MS;
        long age = now - ts;
        if (age > RING_MS + 15_000) return 0;
        return Math.max(15_000, Math.min(RING_MS, RING_MS - age));
    }

    /** The call id in a call push's link (/messages/<chat>?call=<id>), or null. */
    static String callIdOf(String path) {
        Matcher m = CALL_QUERY.matcher(path);
        return m.find() ? m.group(1) : null;
    }

    private static void showCall(Context c, String body, String tag, String path, long ts, PendingIntent open, int req) {
        String conv = conversationOf(path, tag);
        String call = callIdOf(path);
        long left = ringLeft(ts, System.currentTimeMillis());
        if (conv == null || call == null || left <= 0) return;
        if (call.equals(ringing.get(tag)) && isShowing(c, tag)) return; // the same call again: it's ringing already
        ringing.put(tag, call);
        // "Dan is calling" / "Dan is calling a group conversation" → "Dan" for the call-style layout.
        boolean group = body.endsWith(" is calling a group conversation");
        String suffix = group ? " is calling a group conversation" : " is calling";
        String who = body.endsWith(suffix) ? body.substring(0, body.length() - suffix.length()) : null;
        String incoming = c.getString(group ? R.string.kw_call_group : R.string.kw_call_incoming);
        Person caller = new Person.Builder().setName(who != null ? who : c.getString(R.string.app_name)).setImportant(true).build();

        Intent decline = new Intent(c, CallActionReceiver.class);
        decline.putExtra(EXTRA_TAG, tag);
        decline.putExtra(EXTRA_CONV, conv);
        decline.putExtra(EXTRA_CALL, call);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, req, decline, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // Answer: straight into the call (the page accepts the ring itself, lib/calls/engine.ts probe()).
        PendingIntent answerPi = openIntent(c, answerPath(path), tag, req + 1);
        Intent screen = new Intent(c, IncomingCallActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
                .putExtra(EXTRA_TAG, tag).putExtra(EXTRA_URL, path).putExtra(EXTRA_CONV, conv).putExtra(EXTRA_CALL, call)
                .putExtra(IncomingCallActivity.EXTRA_NAME, who).putExtra(IncomingCallActivity.EXTRA_GROUP, group)
                .putExtra(IncomingCallActivity.EXTRA_DEADLINE, System.currentTimeMillis() + left);
        PendingIntent screenPi = PendingIntent.getActivity(c, req + 2, screen, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        // On a locked phone: "Incoming call" only, never who (the same rule as every other lock-screen copy).
        NotificationCompat.Builder pub = new NotificationCompat.Builder(c, CH_CALLS)
                .setSmallIcon(R.drawable.ic_stat_kithwall)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText(incoming)
                .setCategory(NotificationCompat.CATEGORY_CALL);
        NotificationCompat.Builder b = base(c, CH_CALLS, who != null ? who : c.getString(R.string.app_name), incoming, open)
                .setPublicVersion(pub.build())
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(left);
        // Call style needs a full-screen intent (or a foreground service); Android 14+ only allows those
        // when the person hasn't withdrawn "full-screen notifications" for the app. Otherwise: a plain
        // high-priority (heads-up) notification with the same Decline / Answer actions.
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        boolean fullScreen = Build.VERSION.SDK_INT < 34 || (nm != null && nm.canUseFullScreenIntent());
        if (fullScreen) {
            b.setFullScreenIntent(screenPi, true);
            b.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi));
        } else {
            b.addAction(0, c.getString(R.string.kw_call_decline), declinePi);
            b.addAction(0, c.getString(R.string.kw_call_answer), answerPi);
        }
        android.app.Notification n = b.build();
        n.flags |= android.app.Notification.FLAG_INSISTENT; // the ringtone repeats until the call stops ringing
        post(c, tag, n);
    }

    private static boolean isShowing(Context c, String tag) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        for (android.service.notification.StatusBarNotification s : nm.getActiveNotifications()) {
            if (tag.equals(s.getTag())) return true;
        }
        return false;
    }

    private static void post(Context c, String tag, android.app.Notification n) {
        try {
            NotificationManagerCompat.from(c).notify(tag, 0, n);
        } catch (SecurityException ignored) {
            // permission withdrawn meanwhile
        }
    }

    static void cancel(Context c, String tag) {
        if (tag == null) return;
        NotificationManagerCompat.from(c).cancel(tag, 0);
        if (CALL_TAG.matcher(tag).matches()) {
            ringing.remove(tag);
            IncomingCallActivity.close(tag);
        }
    }

    static void cancelAll(Context c) {
        NotificationManagerCompat.from(c).cancelAll();
        ringing.clear();
        IncomingCallActivity.close(null);
    }
}
