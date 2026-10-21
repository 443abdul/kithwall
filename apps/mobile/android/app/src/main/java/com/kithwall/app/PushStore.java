package com.kithwall.app;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;

/**
 * This install's push state, Keystore-encrypted (SecureBox "push"): provider, token / endpoint, the
 * device key pair the server encrypts to (FCM / APNs-style; UnifiedPush keys live in the connector
 * library), and the hidden-chat hashes mirrored from the web app (same format as public/sw.js).
 */
final class PushStore {
    private PushStore() {}

    static final int B64U = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;

    private static SecureBox box(Context c) {
        return new SecureBox(c, "push");
    }

    /** The device key pair for FCM: {p256dh, auth}, created on first use. */
    static synchronized String[] ensureOwnKeys(Context c) throws Exception {
        SecureBox b = box(c);
        byte[] priv = b.getBytes("priv");
        byte[] pub = b.getBytes("pub");
        byte[] auth = b.getBytes("auth");
        if (priv == null || pub == null || auth == null) {
            KeyPair kp = PushCrypto.newKeyPair();
            priv = kp.getPrivate().getEncoded();
            pub = kp.getPublic().getEncoded();
            auth = new byte[16];
            new SecureRandom().nextBytes(auth);
            b.putBytes("priv", priv);
            b.putBytes("pub", pub);
            b.putBytes("auth", auth);
        }
        ECPublicKey p = PushCrypto.publicFromX509(pub);
        return new String[] { Base64.encodeToString(PushCrypto.encodePoint(p), B64U), Base64.encodeToString(auth, B64U) };
    }

    /** Decrypt an FCM payload (base64url aes128gcm body) with the device key. */
    static synchronized String decryptOwn(Context c, String b64u) throws Exception {
        SecureBox b = box(c);
        byte[] priv = b.getBytes("priv");
        byte[] pub = b.getBytes("pub");
        byte[] auth = b.getBytes("auth");
        if (priv == null || pub == null || auth == null) throw new IllegalStateException("no device key");
        ECPrivateKey k = PushCrypto.privateFromPkcs8(priv);
        ECPublicKey p = PushCrypto.publicFromX509(pub);
        byte[] pt = PushCrypto.decrypt(k, p, auth, Base64.decode(b64u, Base64.URL_SAFE | Base64.NO_WRAP));
        return new String(pt, StandardCharsets.UTF_8);
    }

    static synchronized void saveRegistration(Context c, String provider, String token, String p256dh, String auth) throws Exception {
        SecureBox b = box(c);
        b.putString("provider", provider);
        b.putString("token", token);
        b.putString("reg_p256dh", p256dh);
        b.putString("reg_auth", auth);
    }

    /** {provider, token, p256dh, auth} or null when not registered. */
    static synchronized String[] registration(Context c) {
        SecureBox b = box(c);
        String provider = b.getString("provider");
        String token = b.getString("token");
        String p256dh = b.getString("reg_p256dh");
        String auth = b.getString("reg_auth");
        if (provider == null || token == null || p256dh == null || auth == null) return null;
        return new String[] { provider, token, p256dh, auth };
    }

    static synchronized void forgetToken(Context c) {
        SecureBox b = box(c);
        b.remove("token");
        b.remove("provider");
    }

    /** Everything: token, device key, hidden hashes (turning push off, signing out, wiping). */
    static synchronized void clear(Context c) {
        box(c).clear();
    }

    // ---------------------------------------------------------------------------------------
    // Hidden chats

    static synchronized void setHidden(Context c, String salt, JSONArray hashes) throws Exception {
        JSONObject o = new JSONObject();
        o.put("salt", salt);
        o.put("hashes", hashes);
        box(c).putString("hidden", o.toString());
    }

    static synchronized void clearHidden(Context c) {
        box(c).remove("hidden");
    }

    /** Same rule as public/sw.js: base64(SHA-256("<salt>:<conversation id>")) is in the list. */
    static synchronized boolean isHidden(Context c, String conversationId) {
        if (conversationId == null) return false;
        String raw = box(c).getString("hidden");
        if (raw == null) return false;
        try {
            JSONObject o = new JSONObject(raw);
            String salt = o.getString("salt");
            JSONArray hashes = o.getJSONArray("hashes");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest((salt + ":" + conversationId.toLowerCase()).getBytes(StandardCharsets.UTF_8));
            String want = Base64.encodeToString(h, Base64.NO_WRAP);
            for (int i = 0; i < hashes.length(); i++) if (want.equals(hashes.optString(i))) return true;
        } catch (Exception ignored) {
            // unreadable list: treat as not hidden
        }
        return false;
    }
}
