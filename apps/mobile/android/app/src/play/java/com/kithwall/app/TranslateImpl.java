package com.kithwall.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.languageid.IdentifiedLanguage;
import com.google.mlkit.nl.languageid.LanguageIdentification;
import com.google.mlkit.nl.languageid.LanguageIdentificationOptions;
import com.google.mlkit.nl.languageid.LanguageIdentifier;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * play flavour: on-device translation with Google ML Kit (Translation + Language Identification).
 *
 *  - Language identification uses the model bundled in the app (no download, nothing leaves the phone).
 *  - Translation models (~30 MB per language, English is the pivot every pair goes through) are downloaded
 *    from Google only through download(), which the web app calls after the person agreed (with "Wi-Fi only"
 *    unless they chose mobile data). translate() never downloads: without the packs it answers
 *    'not_downloaded' so the page can ask first.
 *  - The text itself is only ever handed to the on-device models. ML Kit's own usage metrics (languages,
 *    sizes, device model) are switched off in the play manifest (no telemetry backend).
 */
final class TranslateImpl {
    /** Detection looks at the start of a long text only (more adds time, not accuracy). */
    private static final int DETECT_CHARS = 1000;

    private final Context context;
    private final RemoteModelManager models = RemoteModelManager.getInstance();
    private final Map<String, Translator> translators = new HashMap<>();
    private LanguageIdentifier identifier;

    TranslateImpl(Context context) {
        this.context = context.getApplicationContext();
    }

    // ---------------------------------------------------------------------------------- helpers

    /** ML Kit's code for a BCP 47 tag ('ur', 'zh'), or null when it can't translate that language. */
    private static String lang(String tag) {
        return tag == null || tag.isEmpty() ? null : TranslateLanguage.fromLanguageTag(tag);
    }

    private synchronized LanguageIdentifier identifier() {
        // A low threshold returns every plausible language with its confidence; the web app decides.
        if (identifier == null) {
            identifier = LanguageIdentification.getClient(new LanguageIdentificationOptions.Builder().setConfidenceThreshold(0.1f).build());
        }
        return identifier;
    }

    private synchronized Translator translator(String source, String target) {
        String key = source + ">" + target;
        Translator t = translators.get(key);
        if (t == null) {
            t = Translation.getClient(new TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build());
            translators.put(key, t);
        }
        return t;
    }

    private synchronized void closeTranslatorsWith(String language) {
        Iterator<Map.Entry<String, Translator>> it = translators.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Translator> e = it.next();
            String[] pair = e.getKey().split(">");
            if (pair[0].equals(language) || pair[1].equals(language)) {
                e.getValue().close();
                it.remove();
            }
        }
    }

    /** Languages whose translation model is on this phone. */
    private void downloaded(PluginCall call, Consumer<Set<String>> then) {
        models.getDownloadedModels(TranslateRemoteModel.class)
            .addOnSuccessListener(set -> {
                Set<String> have = new HashSet<>();
                for (TranslateRemoteModel m : set) have.add(m.getLanguage());
                then.accept(have);
            })
            .addOnFailureListener(e -> call.reject("could not list language packs", "failed"));
    }

    /** On Wi-Fi (or Ethernet) now: what ML Kit's "Wi-Fi only" download condition waits for. */
    private boolean onWifi() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
        return caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    // ---------------------------------------------------------------------------------- calls

    void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", true);
        r.put("wifi", onWifi());
        call.resolve(r);
    }

    void detect(PluginCall call) {
        String text = call.getString("text", "");
        if (text.length() > DETECT_CHARS) {
            int end = DETECT_CHARS;
            if (Character.isHighSurrogate(text.charAt(end - 1))) end--;
            text = text.substring(0, end);
        }
        identifier().identifyPossibleLanguages(text)
            .addOnSuccessListener(list -> {
                JSArray out = new JSArray();
                for (IdentifiedLanguage l : list) {
                    if ("und".equals(l.getLanguageTag())) continue;
                    JSObject o = new JSObject();
                    o.put("lang", l.getLanguageTag());
                    o.put("confidence", (double) l.getConfidence());
                    out.put(o);
                }
                JSObject r = new JSObject();
                r.put("languages", out);
                call.resolve(r);
            })
            .addOnFailureListener(e -> call.reject("language identification failed", "failed"));
    }

    void pair(PluginCall call) {
        String source = lang(call.getString("source")), target = lang(call.getString("target"));
        if (source == null || target == null || source.equals(target)) {
            JSObject r = new JSObject();
            r.put("supported", false);
            r.put("missing", new JSArray());
            call.resolve(r);
            return;
        }
        downloaded(call, have -> {
            JSArray missing = new JSArray();
            if (!have.contains(source)) missing.put(source);
            if (!have.contains(target)) missing.put(target);
            JSObject r = new JSObject();
            r.put("supported", true);
            r.put("missing", missing);
            call.resolve(r);
        });
    }

    void download(PluginCall call) {
        String source = lang(call.getString("source")), target = lang(call.getString("target"));
        if (source == null || target == null) { call.reject("language not supported", "unsupported"); return; }
        DownloadConditions.Builder conditions = new DownloadConditions.Builder();
        if (!Boolean.FALSE.equals(call.getBoolean("wifiOnly", true))) conditions.requireWifi();
        translator(source, target).downloadModelIfNeeded(conditions.build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject("language pack download failed", "failed"));
    }

    void translate(PluginCall call) {
        String source = lang(call.getString("source")), target = lang(call.getString("target"));
        String text = call.getString("text", "");
        if (source == null || target == null) { call.reject("language not supported", "unsupported"); return; }
        // Never download from here (that needs the person's consent): check the packs first.
        downloaded(call, have -> {
            if (!have.contains(source) || !have.contains(target)) { call.reject("language pack not downloaded", "not_downloaded"); return; }
            translator(source, target).translate(text)
                .addOnSuccessListener(out -> {
                    JSObject r = new JSObject();
                    r.put("text", out);
                    call.resolve(r);
                })
                .addOnFailureListener(e -> call.reject("translation failed", "failed"));
        });
    }

    void packs(PluginCall call) {
        downloaded(call, have -> {
            JSArray out = new JSArray();
            for (String l : have) if (!TranslateLanguage.ENGLISH.equals(l)) out.put(l);
            JSObject r = new JSObject();
            r.put("packs", out);
            call.resolve(r);
        });
    }

    void removePack(PluginCall call) {
        String l = lang(call.getString("lang"));
        if (l == null || TranslateLanguage.ENGLISH.equals(l)) { call.reject("this pack can't be removed", "unsupported"); return; }
        closeTranslatorsWith(l);
        models.deleteDownloadedModel(new TranslateRemoteModel.Builder(l).build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject("could not remove the language pack", "failed"));
    }

    synchronized void close() {
        for (Translator t : translators.values()) t.close();
        translators.clear();
        if (identifier != null) identifier.close();
        identifier = null;
    }
}
