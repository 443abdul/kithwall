package com.kithwall.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.widget.Toast;

import androidx.core.content.IntentCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Kit Drop files opened in Kithwall from outside (docs/v2/08-censorship.md §5): "Open with" from Files,
 * Downloads or Quick Share (ACTION_VIEW) and the share sheet (ACTION_SEND). Kit Drop files are saved as
 * application/vnd.kithwall.kitdrop+json, but whoever hands one over usually types it by its extension, which
 * Android doesn't know: then it arrives as application/octet-stream (or application/json), so the manifest
 * accepts those too and the content is checked here before anything else happens.
 *
 * The file is copied into the app's cache ("kitdrop/", like picked attachments: KwChromeClient), because the
 * read grant of a content URI ends with the activity and the page can't read content URIs anyway. The page
 * (lib/native/kitdrop.ts) then reads the copy in base64 chunks through KithwallShell and verifies and opens
 * it like any Kit Drop; the copy is deleted right after, and by the panic wipe. One file at a time.
 */
final class KwKitDrop {
    static final String MIME = "application/vnd.kithwall.kitdrop+json";
    /** Same limit as the web app (MAX_FILE_BYTES, apps/web/src/lib/social/kitdropFormat.ts). */
    static final long MAX_BYTES = 16L * 1024 * 1024;
    static final int CHUNK = 768 * 1024;
    private static final String DIR = "kitdrop";

    private static final ExecutorService io = Executors.newSingleThreadExecutor();

    static final class Pending {
        final String id;
        final File file;
        final CountDownLatch copied = new CountDownLatch(1);
        volatile String name = "kitdrop.kwd";
        volatile long size;
        volatile boolean ok;

        Pending(String id, File file) {
            this.id = id;
            this.file = file;
        }
    }

    private static volatile Pending pending;

    private KwKitDrop() {}

    /** The file a VIEW / SEND intent hands over, if it can be a Kit Drop (content URIs only), else null. */
    static Uri uriFrom(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) return null;
        String type = intent.getType();
        if (type != null && !type.equals(MIME) && !type.equals("application/json") && !type.equals("application/octet-stream")) return null;
        return uri;
    }

    /** Start copying the file; returns the id the page asks for (it waits until the copy is done). */
    static String receive(Activity a, Uri uri) {
        Pending old = pending;
        if (old != null) delete(old.file);
        File dir = new File(a.getCacheDir(), DIR);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        String id = UUID.randomUUID().toString();
        Pending p = new Pending(id, new File(dir, id + ".kwd"));
        pending = p;
        io.execute(() -> {
            try {
                p.name = displayName(a, uri);
                p.size = copy(a, uri, p.file);
                p.ok = looksLikeKitDrop(p.file);
            } catch (Exception e) {
                p.ok = false;
            } finally {
                if (!p.ok) {
                    delete(p.file);
                    a.runOnUiThread(() -> Toast.makeText(a, a.getString(R.string.kw_kitdrop_not), Toast.LENGTH_LONG).show());
                }
                p.copied.countDown();
            }
        });
        return id;
    }

    static boolean hasPending() {
        Pending p = pending;
        return p != null && (p.copied.getCount() > 0 || p.ok);
    }

    /** The waiting file once copied (waits up to `ms`), or null (none, refused, or still copying). */
    static Pending ready(long ms) {
        Pending p = pending;
        if (p == null) return null;
        try {
            if (!p.copied.await(ms, TimeUnit.MILLISECONDS)) return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
        return p.ok && pending == p ? p : null;
    }

    /** Up to CHUNK bytes of the copy from `offset`, base64 ("" at the end). */
    static String read(String id, long offset) throws IOException {
        Pending p = pending;
        if (p == null || !p.ok || !p.id.equals(id) || offset < 0) throw new IOException("no such file");
        try (RandomAccessFile f = new RandomAccessFile(p.file, "r")) {
            if (offset >= f.length()) return "";
            byte[] buf = new byte[(int) Math.min(CHUNK, f.length() - offset)];
            f.seek(offset);
            f.readFully(buf);
            return Base64.encodeToString(buf, Base64.NO_WRAP);
        }
    }

    static void done(String id) {
        Pending p = pending;
        if (p == null || !p.id.equals(id)) return;
        pending = null;
        delete(p.file);
    }

    /** Panic wipe: every copy. */
    static void clear(Context c) {
        pending = null;
        File[] files = new File(c.getCacheDir(), DIR).listFiles();
        if (files != null) for (File f : files) delete(f);
    }

    private static long copy(Context c, Uri src, File dst) throws IOException {
        long n = 0;
        try (InputStream in = c.getContentResolver().openInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            if (in == null) throw new IOException("unreadable");
            byte[] buf = new byte[64 * 1024];
            for (int r; (r = in.read(buf)) > 0; ) {
                n += r;
                if (n > MAX_BYTES) throw new IOException("too large");
                out.write(buf, 0, r);
            }
        }
        return n;
    }

    /** A JSON object that names itself a Kit Drop near the start (makeKitDrop writes "kind" second). */
    static boolean looksLikeKitDrop(File f) throws IOException {
        byte[] head = new byte[4096];
        int n;
        try (InputStream in = new java.io.FileInputStream(f)) {
            n = in.read(head);
        }
        if (n <= 0) return false;
        String s = new String(head, 0, n, StandardCharsets.UTF_8).trim();
        return s.startsWith("{") && s.contains("\"kithwall-kitdrop\"");
    }

    private static String displayName(Context c, Uri u) {
        String name = null;
        try (Cursor cur = c.getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cur != null && cur.moveToFirst()) name = cur.getString(0);
        } catch (Exception ignored) {
            // the default below
        }
        return name == null || name.isEmpty() ? "kitdrop.kwd" : KwDownloads.safeName(name);
    }

    private static void delete(File f) {
        if (f != null && f.exists() && !f.delete()) f.deleteOnExit();
    }
}
