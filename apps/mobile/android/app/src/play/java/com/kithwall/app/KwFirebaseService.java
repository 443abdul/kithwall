package com.kithwall.app;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Receives FCM data messages {kw: <base64url aes128gcm>}, decrypts them on the device and shows them. */
public class KwFirebaseService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String body = message.getData().get("kw");
        if (body == null || body.length() > 8192) return;
        try {
            Notifier.show(this, PushStore.decryptOwn(this, body));
        } catch (Exception ignored) {
            // Not for this key (e.g. sent before a re-install): drop it. Never show undecryptable data.
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The web app re-registers the new token with the person's session next time it opens
        // (lib/native/push.ts nativeSyncPush); keep it so current() reports it.
        String[] reg = PushStore.registration(this);
        if (reg == null) return;
        try {
            PushStore.saveRegistration(this, reg[0], token, reg[2], reg[3]);
        } catch (Exception ignored) {
            // the next register() call fixes it
        }
    }
}
