package com.kithwall.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small values encrypted with a non-exportable AES-256-GCM key in the Android Keystore (StrongBox when the
 * phone has one), stored in a private SharedPreferences file. The key never leaves the secure hardware, so
 * a copy of the app's data directory can't be decrypted anywhere else (docs/v2/05-native.md §4).
 *
 * One SecureBox per purpose ("kw_secure" for the web app's device records, "kw_push" for the push key), so
 * wiping one never breaks the other.
 */
final class SecureBox {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final int TAG_BITS = 128;

    private final Context context;
    private final String alias;
    private final String prefsName;

    SecureBox(Context context, String name) {
        this.context = context.getApplicationContext();
        this.alias = "kw_" + name + "_key";
        this.prefsName = "kw_" + name;
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(prefsName, Context.MODE_PRIVATE);
    }

    static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return ks;
    }

    private SecretKey key() throws Exception {
        KeyStore ks = keyStore();
        KeyStore.Entry entry = ks.getEntry(alias, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        try {
            return generate(true);
        } catch (StrongBoxUnavailableException e) {
            return generate(false);
        }
    }

    private SecretKey generate(boolean strongBox) throws Exception {
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true);
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true);
        kg.init(spec.build());
        return kg.generateKey();
    }

    private byte[] aad(String name) {
        return ("kithwall/v1/" + prefsName + "/" + name).getBytes(StandardCharsets.UTF_8);
    }

    synchronized void putBytes(String name, byte[] value) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        c.updateAAD(aad(name));
        byte[] ct = c.doFinal(value);
        byte[] iv = c.getIV();
        byte[] out = new byte[1 + iv.length + ct.length];
        out[0] = (byte) iv.length;
        System.arraycopy(iv, 0, out, 1, iv.length);
        System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
        if (!prefs().edit().putString("v_" + name, Base64.encodeToString(out, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("could not save");
        }
    }

    /** null when missing or no longer decryptable (key deleted, data copied from elsewhere). */
    synchronized byte[] getBytes(String name) {
        String s = prefs().getString("v_" + name, null);
        if (s == null) return null;
        try {
            byte[] raw = Base64.decode(s, Base64.NO_WRAP);
            int ivLen = raw[0] & 0xff;
            byte[] iv = Arrays.copyOfRange(raw, 1, 1 + ivLen);
            byte[] ct = Arrays.copyOfRange(raw, 1 + ivLen, raw.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            c.updateAAD(aad(name));
            return c.doFinal(ct);
        } catch (Exception e) {
            return null;
        }
    }

    void putString(String name, String value) throws Exception {
        putBytes(name, value.getBytes(StandardCharsets.UTF_8));
    }

    String getString(String name) {
        byte[] b = getBytes(name);
        return b == null ? null : new String(b, StandardCharsets.UTF_8);
    }

    synchronized void remove(String name) {
        prefs().edit().remove("v_" + name).commit();
    }

    /** Forget every value and delete the key (panic wipe). */
    synchronized void clear() {
        prefs().edit().clear().commit();
        try {
            keyStore().deleteEntry(alias);
        } catch (Exception ignored) {
            // already gone
        }
    }
}
