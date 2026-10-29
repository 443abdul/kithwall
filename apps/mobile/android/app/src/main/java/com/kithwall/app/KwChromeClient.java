package com.kithwall.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.database.Cursor;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * File inputs. Capacitor opens the generic "Files" picker for every <input type=file>; for photos and videos
 * (posts, albums, avatars, stories, chat attachments) Android 13+ has the system photo picker, which is what
 * people expect from an Android app and needs no storage permission. Inputs with `capture` (take a photo
 * now) and other file types keep Capacitor's behaviour (camera intent / Files picker).
 *
 * Every picked file is first copied into the app's cache and handed to the page through our own
 * FileProvider: the WebView reads a picked file lazily (when the page encrypts and uploads it), and by then
 * a photo-picker / documents URI could no longer be read ("NotReadableError ... permission problems"), so
 * the attachment preview was broken and sending failed. Copies older than a day are removed.
 *
 * Fullscreen video. Capacitor's client answers every fullscreen request (a YouTube/Vimeo embed's button, a
 * <video>'s fullscreen control, element.requestFullscreen) by hiding the view straight away, so nothing
 * could go fullscreen in the app. Here the player's view is laid over the whole window with the system bars
 * hidden, the screen may rotate freely while it is up, and Back (MainActivity) or the player's own button
 * leaves it.
 */
class KwChromeClient extends BridgeWebChromeClient {
    private final AppCompatActivity activity;
    private final ActivityResultLauncher<Intent> picker;
    private ValueCallback<Uri[]> callback;
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;

    private View fullView;
    private CustomViewCallback fullCallback;
    private int savedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private static KwChromeClient current;

    /** MainActivity's Back: leave fullscreen video first. True if it did. */
    static boolean exitFullscreen() {
        KwChromeClient c = current;
        if (c == null || c.fullView == null) return false;
        c.onHideCustomView();
        return true;
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        if (fullView != null) { callback.onCustomViewHidden(); return; }
        fullView = view;
        fullCallback = callback;
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        view.setBackgroundColor(Color.BLACK);
        decor.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), decor);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
        savedOrientation = activity.getRequestedOrientation();
        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
    }

    @Override
    public void onHideCustomView() {
        View view = fullView;
        CustomViewCallback cb = fullCallback;
        fullView = null;
        fullCallback = null;
        if (view == null) return;
        ViewGroup decor = (ViewGroup) activity.getWindow().getDecorView();
        decor.removeView(view);
        WindowCompat.getInsetsController(activity.getWindow(), decor).show(WindowInsetsCompat.Type.systemBars());
        activity.setRequestedOrientation(savedOrientation);
        if (cb != null) cb.onCustomViewHidden();
    }

    KwChromeClient(Bridge bridge) {
        super(bridge);
        this.activity = bridge.getActivity();
        current = this;
        this.picker = activity.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (res) -> {
            ValueCallback<Uri[]> cb = callback;
            callback = null;
            if (cb == null) return;
            Intent data = res.getData();
            if (res.getResultCode() != Activity.RESULT_OK || data == null) { cb.onReceiveValue(null); return; }
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                Uri[] out = new Uri[clip.getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
                copied(cb).onReceiveValue(out);
            } else if (data.getData() != null) {
                copied(cb).onReceiveValue(new Uri[] { data.getData() });
            } else {
                cb.onReceiveValue(null);
            }
        });
    }

    /** "image/*", "video/*", or null (both) when every accepted type is a photo/video type; else "" (not media). */
    static String mediaKind(String[] accept) {
        boolean img = false, vid = false, any = false;
        for (String raw : accept == null ? new String[0] : accept) {
            for (String t : raw.split(",")) {
                String s = t.trim().toLowerCase();
                if (s.isEmpty()) continue;
                any = true;
                if (s.startsWith("image/") || s.matches("\\.(jpe?g|png|gif|webp|heic|heif|avif)")) img = true;
                else if (s.startsWith("video/") || s.matches("\\.(mp4|mov|webm|m4v|3gp)")) vid = true;
                else return "";
            }
        }
        if (!any) return "";
        if (img && !vid) return "image/*";
        if (vid && !img) return "video/*";
        return null;
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
        String kind = mediaKind(params.getAcceptTypes());
        if (Build.VERSION.SDK_INT < 33 || params.isCaptureEnabled() || "".equals(kind)) {
            return super.onShowFileChooser(webView, params.isCaptureEnabled() ? filePathCallback : copied(filePathCallback), params);
        }
        Intent i = new Intent(MediaStore.ACTION_PICK_IMAGES);
        if (kind != null) i.setType(kind);
        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            i.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(20, MediaStore.getPickImagesMaxLimit()));
        }
        if (callback != null) callback.onReceiveValue(null);
        callback = filePathCallback;
        try {
            picker.launch(i);
        } catch (Exception e) {
            callback = null;
            return super.onShowFileChooser(webView, copied(filePathCallback), params);
        }
        return true;
    }

    /** Wraps the page's callback: picked URIs are copied to the cache first (see the class comment). */
    private ValueCallback<Uri[]> copied(ValueCallback<Uri[]> cb) {
        return (uris) -> {
            if (uris == null || uris.length == 0) { cb.onReceiveValue(uris); return; }
            io.execute(() -> {
                File dir = new File(activity.getCacheDir(), "picked");
                cleanup(dir);
                Uri[] out = new Uri[uris.length];
                for (int i = 0; i < uris.length; i++) out[i] = copy(dir, uris[i]);
                main.post(() -> cb.onReceiveValue(out));
            });
        };
    }

    private Uri copy(File dir, Uri src) {
        if (src == null) return null;
        String authority = activity.getPackageName() + ".fileprovider";
        if (authority.equals(src.getAuthority())) return src; // already ours (camera capture)
        try {
            File sub = new File(dir, UUID.randomUUID().toString());
            if (!sub.mkdirs()) return src;
            File f = new File(sub, KwDownloads.safeName(displayName(src)));
            try (InputStream in = activity.getContentResolver().openInputStream(src); OutputStream o = new FileOutputStream(f)) {
                if (in == null) return src;
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            return FileProvider.getUriForFile(activity, authority, f);
        } catch (Exception e) {
            return src;
        }
    }

    private String displayName(Uri u) {
        String name = null;
        try (Cursor c = activity.getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
            // fall back below
        }
        if (name == null || name.isEmpty()) name = u.getLastPathSegment();
        String type = activity.getContentResolver().getType(u);
        String ext = type == null ? null : android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
        if (name == null || name.isEmpty()) name = "file";
        if (ext != null && !name.contains(".")) name += "." + ext;
        return name;
    }

    private static void cleanup(File dir) {
        File[] subs = dir.listFiles();
        if (subs == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        for (File sub : subs) {
            if (sub.lastModified() >= cutoff) continue;
            File[] files = sub.listFiles();
            if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
                f.delete();
            //noinspection ResultOfMethodCallIgnored
            sub.delete();
        }
    }
}
