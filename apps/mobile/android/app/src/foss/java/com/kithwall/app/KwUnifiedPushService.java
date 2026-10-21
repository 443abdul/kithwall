package com.kithwall.app;

import androidx.annotation.NonNull;

import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

import java.nio.charset.StandardCharsets;

/** UnifiedPush events from the distributor. Messages are Web Push, decrypted by the connector library. */
public class KwUnifiedPushService extends PushService {
    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) { PushProviderImpl.fail("failed"); return; }
        try {
            PushStore.saveRegistration(this, PushProviderImpl.PROVIDER, endpoint.getUrl(), keys.getPubKey(), keys.getAuth());
        } catch (Exception e) {
            PushProviderImpl.fail("failed");
            return;
        }
        PushProviderImpl.complete(endpoint.getUrl(), keys.getPubKey(), keys.getAuth());
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        // Only end-to-end encrypted messages are shown: a distributor can't inject plain text.
        if (!message.getDecrypted()) return;
        byte[] content = message.getContent();
        if (content.length > 4096) return;
        Notifier.show(this, new String(content, StandardCharsets.UTF_8));
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        PushProviderImpl.fail("failed");
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        PushStore.forgetToken(this);
    }
}
