package com.kithwall.app;

import android.os.Build;
import android.os.CancellationSignal;

import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException;
import androidx.credentials.exceptions.CreateCredentialUnsupportedException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;
import androidx.credentials.exceptions.domerrors.InvalidStateError;
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * KithwallPasskey (apps/web/src/lib/native/plugins.ts): WebAuthn ceremonies through Android Credential
 * Manager, because the WebView offers no passkeys with PRF. Requests and responses are the standard WebAuthn
 * JSON, including the `prf` extension (Google Password Manager evaluates it with the same WebAuthn salt
 * hashing as Chrome, so a synced passkey gives the web and the app the same PRF output).
 *
 * The rpId is the website's (www.kithwall.com); Credential Manager checks it against
 * https://<rpId>/.well-known/assetlinks.json, and the server accepts this app's
 * android:apk-key-hash:<cert> origin (docs/v2/05-native.md §2–3).
 */
@CapacitorPlugin(name = "KithwallPasskey")
public class KithwallPasskeyPlugin extends Plugin {
    private CredentialManager cm;

    @Override
    public void load() {
        cm = CredentialManager.create(getContext());
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
        JSObject r = new JSObject();
        r.put("available", ok);
        // Can't be queried ahead of time on Android; a ceremony without a PRF result falls back to the passphrase.
        r.put("prf", ok);
        call.resolve(r);
    }

    private static String codeFor(Exception e) {
        if (e instanceof CreateCredentialCancellationException || e instanceof GetCredentialCancellationException) return "cancelled";
        if (e instanceof NoCredentialException) return "no_credential";
        if (e instanceof CreatePublicKeyCredentialDomException
                && ((CreatePublicKeyCredentialDomException) e).getDomError() instanceof InvalidStateError) return "exists";
        if (e instanceof CreateCredentialProviderConfigurationException || e instanceof GetCredentialProviderConfigurationException
                || e instanceof CreateCredentialUnsupportedException || e instanceof GetCredentialUnsupportedException) return "unsupported";
        return "failed";
    }

    @PluginMethod
    public void create(PluginCall call) {
        String json = call.getString("requestJson");
        if (json == null || json.length() > 16384) { call.reject("bad request", "failed"); return; }
        CreatePublicKeyCredentialRequest req = new CreatePublicKeyCredentialRequest(json, null, false);
        getActivity().runOnUiThread(() -> cm.createCredentialAsync(getActivity(), req, new CancellationSignal(),
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                    @Override
                    public void onResult(CreateCredentialResponse res) {
                        if (!(res instanceof CreatePublicKeyCredentialResponse)) { call.reject("unexpected response", "failed"); return; }
                        JSObject r = new JSObject();
                        r.put("responseJson", ((CreatePublicKeyCredentialResponse) res).getRegistrationResponseJson());
                        call.resolve(r);
                    }

                    @Override
                    public void onError(CreateCredentialException e) {
                        String code = codeFor(e);
                        call.reject(code, code);
                    }
                }));
    }

    @PluginMethod
    public void get(PluginCall call) {
        String json = call.getString("requestJson");
        if (json == null || json.length() > 16384) { call.reject("bad request", "failed"); return; }
        GetCredentialRequest req = new GetCredentialRequest.Builder()
                .addCredentialOption(new GetPublicKeyCredentialOption(json, null))
                .build();
        getActivity().runOnUiThread(() -> cm.getCredentialAsync(getActivity(), req, new CancellationSignal(),
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse res) {
                        Credential c = res.getCredential();
                        if (!(c instanceof PublicKeyCredential)) { call.reject("unexpected credential", "failed"); return; }
                        JSObject r = new JSObject();
                        r.put("responseJson", ((PublicKeyCredential) c).getAuthenticationResponseJson());
                        call.resolve(r);
                    }

                    @Override
                    public void onError(GetCredentialException e) {
                        String code = codeFor(e);
                        call.reject(code, code);
                    }
                }));
    }
}
