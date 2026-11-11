package com.kithwall.app;

import android.app.Application;

/**
 * The application object: only installs the crash recorder (KwCrash) before any activity, service or
 * receiver of the app runs, so a crash anywhere can be written down. It records nothing unless the person
 * turned "Send crash reports" on (off by default).
 */
public class KwApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        KwCrash.install(this);
    }
}
