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
 *  - calls ring with a full-screen, call-style notification that expires after 45 s.
 * Lock-screen copies are always the generic text (VISIBILITY_PRIVATE with a public version).
 */
final class Notifier {
    private Notifier() {}

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

    private static PendingIntent openIntent(Context c, String path, String tag, int req) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(EXTRA_URL, path);
        i.putExtra(EXTRA_TAG, tag);
        i.putExtra(EXTRA_TOKEN, installToken(c));
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
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
            showCall(c, body, tag, open, req);
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

    private static void showCall(Context c, String body, String tag, PendingIntent open, int req) {
        // "Dan is calling" → caller name "Dan" for the call-style layout.
        String who = body.endsWith(" is calling") ? body.substring(0, body.length() - " is calling".length()) : "Kithwall";
        Person caller = new Person.Builder().setName(who).setImportant(true).build();
        Intent decline = new Intent(c, CallActionReceiver.class);
        decline.putExtra(EXTRA_TAG, tag);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, req, decline, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = base(c, CH_CALLS, "Kithwall", body, open)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(45_000);
        // Call style needs a full-screen intent (or a foreground service); Android 14+ only allows those
        // when the person hasn't withdrawn "full-screen notifications" for the app. Otherwise: a plain
        // high-priority notification with the same actions.
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        boolean fullScreen = Build.VERSION.SDK_INT < 34 || (nm != null && nm.canUseFullScreenIntent());
        if (fullScreen) {
            b.setFullScreenIntent(open, true);
            b.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, open));
        } else {
            b.addAction(0, "Decline", declinePi);
            b.addAction(0, "Open", open);
        }
        post(c, tag, b.build());
    }

    private static void post(Context c, String tag, android.app.Notification n) {
        try {
            NotificationManagerCompat.from(c).notify(tag, 0, n);
        } catch (SecurityException ignored) {
            // permission withdrawn meanwhile
        }
    }

    static void cancel(Context c, String tag) {
        if (tag != null) NotificationManagerCompat.from(c).cancel(tag, 0);
    }

    static void cancelAll(Context c) {
        NotificationManagerCompat.from(c).cancelAll();
    }
}
