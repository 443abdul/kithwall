package com.kithwall.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * "Call in progress" foreground service (types microphone + camera). Android silences the microphone and
 * camera of an app that is not on screen; without this, switching to another app (or pressing Back/Home)
 * during a Kithwall call muted the person. Started by KithwallShell.setCallAudio({active:true}) while the app
 * is in front, stopped when the call ends or the task is removed. The notification is a plain "Kithwall call
 * in progress" with no name in it (the lock screen may be seen by others).
 */
public class KwCallService extends Service {
    static final String CH_ONGOING = "call_ongoing";
    private static final int ID = 0x4b57;
    private static final String EXTRA_VIDEO = "video";

    static void start(Context c, boolean video) {
        if (ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, KwCallService.class).putExtra(EXTRA_VIDEO, video));
        } catch (Exception ignored) {
            // Not allowed right now (app not in front): the call still works while Kithwall is on screen.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, KwCallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CH_ONGOING) == null) {
                NotificationChannel ch = new NotificationChannel(CH_ONGOING, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CH_ONGOING)
                .setSmallIcon(R.drawable.ic_stat_kithwall)
                .setContentTitle("Kithwall call in progress")
                .setContentText("Tap to return to the call")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(pi)
                .build();
        int type = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
        }
        try {
            ServiceCompat.startForeground(this, ID, n, type);
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
