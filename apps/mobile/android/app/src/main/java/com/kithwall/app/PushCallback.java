package com.kithwall.app;

/** Result of a push registration with the flavour's provider (PushProviderImpl in src/play or src/foss). */
interface PushCallback {
    void ok(String provider, String token, String p256dh, String auth);

    /** 'unavailable', 'no_distributor', 'failed'. */
    void error(String code);
}
