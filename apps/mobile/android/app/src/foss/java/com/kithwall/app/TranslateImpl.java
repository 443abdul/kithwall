package com.kithwall.app;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

/**
 * foss flavour: no on-device translation. ML Kit is a Google library, and this build has none; status()
 * reports unsupported so the web app hides "Translate" (and its settings), and every other call refuses.
 */
final class TranslateImpl {
    TranslateImpl(Context context) {}

    void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", false);
        r.put("wifi", false);
        call.resolve(r);
    }

    private static void unsupported(PluginCall call) {
        call.reject("translation is not available in this build", "unsupported");
    }

    void detect(PluginCall call) { unsupported(call); }
    void pair(PluginCall call) { unsupported(call); }
    void download(PluginCall call) { unsupported(call); }
    void translate(PluginCall call) { unsupported(call); }
    void packs(PluginCall call) { unsupported(call); }
    void removePack(PluginCall call) { unsupported(call); }
    void close() {}
}
