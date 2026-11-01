package com.kithwall.app;

import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Capacitor shows the bundled offline page for ANY main-frame error, including an HTTP 404 or 401 from the
 * site and navigations the WebView cancels itself. That replaced working pages (a deep link to a deleted
 * post, a sign-in redirect) with "Kithwall can't connect". Here only real connection failures and the
 * server being down (502/503/504) show it; every other response is the site's own page.
 */
class KwWebViewClient extends BridgeWebViewClient {
    /**
     * "Use Tor (Orbot)": true from the moment the bridge is created until the WebView proxy override is
     * confirmed. Every request the page makes meanwhile is refused here, so nothing leaves without Tor
     * (MainActivity.load creates the bridge at the normal time and reloads once the proxy is in effect).
     */
    static volatile boolean holdNetwork = false;

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (holdNetwork) {
            return new WebResourceResponse("text/plain", "utf-8", 503, "Waiting for Tor", null, new java.io.ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }

    private static final String TAG = "KwWebView";

    private final Bridge bridge;

    KwWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    /**
     * Everything that means "couldn't get the page" (no connection, DNS, timeout, reset, empty response, TLS)
     * shows the offline page. Not: a navigation the WebView cancelled itself (net::ERR_ABORTED: replaced by
     * another navigation or turned into a download) or a response the browser refused (ERR_BLOCKED_BY_*),
     * where the current page is still fine.
     */
    static boolean isOffline(int code, String description) {
        String d = description == null ? "" : description;
        if (d.contains("ERR_ABORTED") || d.contains("ERR_BLOCKED_BY")) return false;
        return code != WebViewClient.ERROR_UNSAFE_RESOURCE;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame()) return;
        int code = error.getErrorCode();
        if (BuildConfig.DEBUG) Log.w(TAG, "main-frame error " + code + " " + error.getDescription() + " " + request.getUrl());
        if (isOffline(code, String.valueOf(error.getDescription()))) {
            super.onReceivedError(view, request, error);
            // Maybe the usual address is blocked here: try the mirrors (KwNet, docs/v2/08-censorship.md).
            if (bridge.getActivity() != null) KwNet.failover(bridge.getActivity());
        }
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame()) return;
        int status = response.getStatusCode();
        if (BuildConfig.DEBUG) Log.w(TAG, "main-frame HTTP " + status + " " + request.getUrl());
        if (status == 502 || status == 503 || status == 504) {
            super.onReceivedHttpError(view, request, response);
            if (bridge.getActivity() != null) KwNet.failover(bridge.getActivity());
        }
    }
}
