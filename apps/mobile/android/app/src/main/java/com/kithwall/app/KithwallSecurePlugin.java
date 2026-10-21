package com.kithwall.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * KithwallSecure (apps/web/src/lib/native/plugins.ts): Keystore-backed storage for the web app's device
 * records (remembered AMK, app-PIN record, attempt counter) and the optional biometric unlock.
 *
 * Biometric unlock keeps its value under a second Keystore key that needs a class-3 (strong) biometric
 * for EVERY use (auth-per-use, CryptoObject-bound) and is invalidated when biometrics are re-enrolled. It
 * never opens the decoy: it only ever returns the real account's AMK (docs/v2/05-native.md §4).
 */
@CapacitorPlugin(name = "KithwallSecure")
public class KithwallSecurePlugin extends Plugin {
    private static final String BIO_ALIAS = "kw_bio_key";
    private static final String BIO_PREFS = "kw_bio";
    private static final int TAG_BITS = 128;

    private SecureBox box;

    @Override
    public void load() {
        box = new SecureBox(getContext(), "secure");
    }

    private static boolean validKey(String k) {
        return k != null && k.matches("[a-z0-9.-]{1,64}");
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("bad key", "failed"); return; }
        JSObject r = new JSObject();
        String v = box.getString(key);
        r.put("value", v == null ? JSObject.NULL : v);
        call.resolve(r);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!validKey(key) || value == null || value.length() > 65536) { call.reject("bad value", "failed"); return; }
        try {
            box.putString(key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not save", "failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("bad key", "failed"); return; }
        box.remove(key);
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        box.clear();
        bioPrefs().edit().clear().commit();
        try { SecureBox.keyStore().deleteEntry(BIO_ALIAS); } catch (Exception ignored) { /* gone */ }
        call.resolve();
    }

    // -------------------------------------------------------------------------------------------
    // Biometrics

    private SharedPreferences bioPrefs() {
        return getContext().getSharedPreferences(BIO_PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void biometricStatus(PluginCall call) {
        BiometricManager bm = BiometricManager.from(getContext());
        int can = bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        PackageManager pm = getContext().getPackageManager();
        boolean finger = pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT);
        boolean face = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pm.hasSystemFeature(PackageManager.FEATURE_FACE);
        boolean iris = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pm.hasSystemFeature(PackageManager.FEATURE_IRIS);
        int kinds = (finger ? 1 : 0) + (face ? 1 : 0) + (iris ? 1 : 0);
        String kind = kinds == 0 ? "none" : kinds > 1 ? "biometric" : finger ? "fingerprint" : face ? "face" : "iris";
        JSObject r = new JSObject();
        r.put("available", can == BiometricManager.BIOMETRIC_SUCCESS || can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED);
        r.put("enrolled", can == BiometricManager.BIOMETRIC_SUCCESS);
        r.put("kind", kind);
        call.resolve(r);
    }

    private SecretKey bioKey(boolean create) throws Exception {
        KeyStore ks = SecureBox.keyStore();
        KeyStore.Entry e = ks.getEntry(BIO_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        if (!create) return null;
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(BIO_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(-1);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(spec.build());
        return kg.generateKey();
    }

    private void deleteBio() {
        bioPrefs().edit().clear().commit();
        try { SecureBox.keyStore().deleteEntry(BIO_ALIAS); } catch (Exception ignored) { /* gone */ }
    }

    private interface CipherDone { void run(Cipher cipher) throws Exception; }

    private void prompt(PluginCall call, Cipher cipher, String title, String cancel, CipherDone done) {
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(false)
                    .build();
            BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    BiometricPrompt.CryptoObject co = result.getCryptoObject();
                    if (co == null || co.getCipher() == null) { call.reject("no cipher", "failed"); return; }
                    try {
                        done.run(co.getCipher());
                    } catch (Exception e) {
                        call.reject("biometric operation failed", "failed");
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                    switch (code) {
                        case BiometricPrompt.ERROR_USER_CANCELED:
                        case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
                        case BiometricPrompt.ERROR_CANCELED:
                            call.reject("cancelled", "cancelled");
                            break;
                        case BiometricPrompt.ERROR_LOCKOUT:
                        case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                            call.reject("locked out", "lockout");
                            break;
                        case BiometricPrompt.ERROR_NO_BIOMETRICS:
                        case BiometricPrompt.ERROR_HW_NOT_PRESENT:
                        case BiometricPrompt.ERROR_HW_UNAVAILABLE:
                            call.reject("unavailable", "unavailable");
                            break;
                        default:
                            call.reject("failed", "failed");
                    }
                }
                // onAuthenticationFailed (a finger that didn't match) keeps the prompt open: nothing to do.
            });
            bp.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    @PluginMethod
    public void bioSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!validKey(key) || value == null || value.length() > 8192) { call.reject("bad value", "failed"); return; }
        Cipher cipher;
        try {
            // A fresh key each time biometric unlock is turned on.
            deleteBio();
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, bioKey(true));
        } catch (Exception e) {
            call.reject("unavailable", "unavailable");
            return;
        }
        prompt(call, cipher, call.getString("title", "Kithwall"), call.getString("cancel", "Cancel"), (c) -> {
            c.updateAAD(("kithwall/v1/bio/" + key).getBytes(StandardCharsets.UTF_8));
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            bioPrefs().edit()
                    .putString("iv_" + key, Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .putString("ct_" + key, Base64.encodeToString(ct, Base64.NO_WRAP))
                    .commit();
            call.resolve();
        });
    }

    @PluginMethod
    public void bioGet(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("bad key", "failed"); return; }
        String iv = bioPrefs().getString("iv_" + key, null);
        String ct = bioPrefs().getString("ct_" + key, null);
        if (iv == null || ct == null) {
            JSObject r = new JSObject();
            r.put("value", JSObject.NULL);
            call.resolve(r);
            return;
        }
        Cipher cipher;
        try {
            SecretKey k = bioKey(false);
            if (k == null) { deleteBio(); call.reject("invalidated", "invalidated"); return; }
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException e) {
            // New fingerprints or faces were enrolled: the key is gone for good.
            deleteBio();
            call.reject("invalidated", "invalidated");
            return;
        } catch (Exception e) {
            call.reject("unavailable", "unavailable");
            return;
        }
        prompt(call, cipher, call.getString("title", "Kithwall"), call.getString("cancel", "Cancel"), (c) -> {
            c.updateAAD(("kithwall/v1/bio/" + key).getBytes(StandardCharsets.UTF_8));
            byte[] pt = c.doFinal(Base64.decode(ct, Base64.NO_WRAP));
            JSObject r = new JSObject();
            r.put("value", new String(pt, StandardCharsets.UTF_8));
            Arrays.fill(pt, (byte) 0);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void bioRemove(PluginCall call) {
        deleteBio();
        call.resolve();
    }
}
