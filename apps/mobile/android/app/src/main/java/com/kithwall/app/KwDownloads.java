package com.kithwall.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Downloads. A WebView ignores downloads unless the app handles them:
 *  - files the web app makes itself (data export .zip, event .ics, decrypted photos and videos) are blob:
 *    URLs; lib/native/runtime.ts streams them here in chunks (KithwallShell.download*) and they are written
 *    to Downloads through MediaStore (Android 10+; no storage permission) or, on Android 9, handed to the
 *    share sheet;
 *  - an https link on the app's own origin that the server sends as an attachment goes to DownloadManager
 *    (with the session cookie), like in a browser.
 * Nothing is written anywhere else, and only the app's origin can start a download.
 */
final class KwDownloads implements DownloadListener {
    private final Activity activity;
    private final Bridge bridge;

    KwDownloads(Activity activity, Bridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
    }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
        Uri u = Uri.parse(url);
        Uri origin = Uri.parse(bridge.getServerUrl() == null ? "" : bridge.getServerUrl());
        boolean ours = "https".equalsIgnoreCase(u.getScheme()) && u.getHost() != null && u.getHost().equalsIgnoreCase(origin.getHost());
        if (!ours) {
            // blob:/data: links are saved by the page through the bridge; anything else is not ours to fetch.
            if (!"blob".equalsIgnoreCase(u.getScheme()) && !"data".equalsIgnoreCase(u.getScheme())) toast(activity, activity.getString(R.string.kw_download_failed));
            return;
        }
        try {
            String name = safeName(URLUtil.guessFileName(url, contentDisposition, mimetype));
            DownloadManager.Request r = new DownloadManager.Request(u);
            r.setMimeType(mimetype);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) r.addRequestHeader("Cookie", cookies);
            r.addRequestHeader("User-Agent", userAgent);
            r.setTitle(name);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(r);
            toast(activity, activity.getString(R.string.kw_download_started, name));
        } catch (Exception e) {
            toast(activity, activity.getString(R.string.kw_download_failed));
        }
    }

    // ---- page-made files (blob:), written in chunks -------------------------------------------------

    private static final class Pending {
        final String name;
        final String mime;
        final OutputStream out;
        final Uri uri;      // MediaStore item (Android 10+)
        final File file;    // cache file (Android 9)
        long size;

        Pending(String name, String mime, OutputStream out, Uri uri, File file) {
            this.name = name;
            this.mime = mime;
            this.out = out;
            this.uri = uri;
            this.file = file;
        }
    }

    private static final Map<String, Pending> pending = new HashMap<>();
    static final long MAX_BYTES = 2L * 1024 * 1024 * 1024;

    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "kithwall-download";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    static String mimeFor(String name, String mime) {
        if (mime != null && mime.matches("^[\\w.+-]+/[\\w.+-]+$")) return mime;
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String guess = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return guess == null ? "application/octet-stream" : guess;
    }

    static synchronized String start(Context c, String rawName, String rawMime) throws IOException {
        String name = safeName(rawName);
        String mime = mimeFor(name, rawMime == null ? null : rawMime.split(";")[0].trim());
        String id = UUID.randomUUID().toString();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = c.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            v.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("no MediaStore item");
            OutputStream out = cr.openOutputStream(uri, "w");
            if (out == null) { cr.delete(uri, null, null); throw new IOException("no stream"); }
            pending.put(id, new Pending(name, mime, out, uri, null));
        } else {
            File dir = new File(c.getCacheDir(), "downloads");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache dir");
            File f = new File(dir, name);
            pending.put(id, new Pending(name, mime, new FileOutputStream(f), null, f));
        }
        return id;
    }

    static synchronized void chunk(String id, byte[] data) throws IOException {
        Pending p = pending.get(id);
        if (p == null) throw new IOException("unknown download");
        p.size += data.length;
        if (p.size > MAX_BYTES) throw new IOException("too large");
        p.out.write(data);
    }

    /** Finishes the file; returns its name. */
    static String finish(Activity a, String id) throws IOException {
        Pending p;
        synchronized (KwDownloads.class) {
            p = pending.remove(id);
        }
        if (p == null) throw new IOException("unknown download");
        p.out.close();
        if (p.uri != null) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.IS_PENDING, 0);
            a.getContentResolver().update(p.uri, v, null, null);
            toast(a, a.getString(R.string.kw_download_saved, p.name));
        } else {
            // Android 9: no MediaStore Downloads without a storage permission; let the person choose where.
            Uri shared = FileProvider.getUriForFile(a, a.getPackageName() + ".fileprovider", p.file);
            Intent send = new Intent(Intent.ACTION_SEND).setType(p.mime).putExtra(Intent.EXTRA_STREAM, shared)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.runOnUiThread(() -> a.startActivity(Intent.createChooser(send, p.name)));
        }
        return p.name;
    }

    static void abort(Context c, String id) {
        Pending p;
        synchronized (KwDownloads.class) {
            p = pending.remove(id);
        }
        if (p == null) return;
        try { p.out.close(); } catch (IOException ignored) { /* closing a failed stream */ }
        if (p.uri != null) c.getContentResolver().delete(p.uri, null, null);
        if (p.file != null && !p.file.delete()) p.file.deleteOnExit();
    }

    static void toast(Activity a, String text) {
        a.runOnUiThread(() -> Toast.makeText(a, text, Toast.LENGTH_SHORT).show());
    }
}
