package com.kithwall.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * KithwallTranslate (apps/web/src/lib/translate, contract in lib/native/plugins.ts): on-device translation of
 * posts, comments and messages. The play build uses Google ML Kit (TranslateImpl in src/play); the foss build
 * has no Google libraries and its TranslateImpl only answers "unsupported", so the web app hides the action.
 * Text is never sent anywhere; the only network use is downloading a language pack the person agreed to.
 * Error codes: 'unsupported', 'not_downloaded', 'failed'.
 */
@CapacitorPlugin(name = "KithwallTranslate")
public class KithwallTranslatePlugin extends Plugin {
    private TranslateImpl impl;

    @Override
    public void load() {
        impl = new TranslateImpl(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        impl.status(call);
    }

    @PluginMethod
    public void detect(PluginCall call) {
        impl.detect(call);
    }

    @PluginMethod
    public void pair(PluginCall call) {
        impl.pair(call);
    }

    @PluginMethod
    public void download(PluginCall call) {
        impl.download(call);
    }

    @PluginMethod
    public void translate(PluginCall call) {
        impl.translate(call);
    }

    @PluginMethod
    public void packs(PluginCall call) {
        impl.packs(call);
    }

    @PluginMethod
    public void removePack(PluginCall call) {
        impl.removePack(call);
    }

    @Override
    protected void handleOnDestroy() {
        impl.close();
        super.handleOnDestroy();
    }
}
