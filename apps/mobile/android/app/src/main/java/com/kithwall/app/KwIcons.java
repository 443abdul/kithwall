package com.kithwall.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.ArrayList;
import java.util.List;

/**
 * Disguised app icon (docs/v2/03-safety.md §13, docs/v2/05-native.md §14): how Kithwall shows on the home
 * screen. Each choice is an activity-alias of KwActivity in the manifest with its own name and icon; exactly
 * one is enabled at a time:
 *
 *   kithwall    com.kithwall.app.MainActivity    "Kithwall"    enabled in the manifest (the default, and the
 *                                                             component name of every icon made before 2.5.0)
 *   calculator  com.kithwall.app.IconCalculator  "Calculator"  disabled until chosen
 *   notes       com.kithwall.app.IconNotes       "Notes"
 *   weather     com.kithwall.app.IconWeather     "Weather"
 *
 * Switching uses PackageManager.setComponentEnabledSetting(…, DONT_KILL_APP): the newly chosen entry is
 * enabled before the others are disabled, so there is never a moment without a launcher entry. Android
 * remembers the setting itself (it survives updates, restarts and the panic wipe, which must not bring the
 * real icon back). The launcher needs a few seconds to follow, and Android removes the running task when the
 * entry it was started from goes away, so the app usually closes once after a switch.
 *
 * What a disguise does not change: the system's app list and app info (Settings → Apps) still say Kithwall,
 * and so do notifications and the incoming-call screen. The web side says so (safety.icon.limits).
 */
final class KwIcons {
    static final String KITHWALL = "kithwall";
    /** Ids as the web app knows them (lib/native/plugins.ts AppIconId), default first. */
    static final String[] IDS = {KITHWALL, "calculator", "notes", "weather"};

    private KwIcons() {}

    static boolean known(String id) {
        for (String k : IDS) if (k.equals(id)) return true;
        return false;
    }

    /** The alias component of a choice (names are part of the manifest and must never change). */
    static ComponentName component(Context c, String id) {
        String cls = KITHWALL.equals(id) ? "MainActivity" : "Icon" + Character.toUpperCase(id.charAt(0)) + id.substring(1);
        return new ComponentName(c.getPackageName(), "com.kithwall.app." + cls);
    }

    private static boolean enabled(PackageManager pm, ComponentName cn, boolean manifestDefault) {
        int s = pm.getComponentEnabledSetting(cn);
        if (s == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) return manifestDefault;
        return s == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    /** The choice that is switched on now ("kithwall" when nothing was ever chosen). */
    static String current(Context c) {
        PackageManager pm = c.getPackageManager();
        for (String id : IDS) {
            if (KITHWALL.equals(id)) continue;
            if (enabled(pm, component(c, id), false)) return id;
        }
        return KITHWALL;
    }

    /** Switch the launcher entry. A no-op when it is the current one. */
    static void set(Context c, String id) {
        if (!known(id)) throw new IllegalArgumentException("unknown icon");
        PackageManager pm = c.getPackageManager();
        if (Build.VERSION.SDK_INT >= 33) {
            // One call: the launcher sees a single change.
            List<PackageManager.ComponentEnabledSetting> all = new ArrayList<>();
            all.add(new PackageManager.ComponentEnabledSetting(component(c, id), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP));
            for (String other : IDS) {
                if (!other.equals(id)) all.add(new PackageManager.ComponentEnabledSetting(component(c, other), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP));
            }
            pm.setComponentEnabledSettings(all);
            return;
        }
        pm.setComponentEnabledSetting(component(c, id), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
        for (String other : IDS) {
            if (!other.equals(id)) pm.setComponentEnabledSetting(component(c, other), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
    }

    private static int label(String id) {
        switch (id) {
            case "calculator": return R.string.kw_icon_calculator;
            case "notes": return R.string.kw_icon_notes;
            case "weather": return R.string.kw_icon_weather;
            default: return R.string.app_name;
        }
    }

    private static int icon(String id) {
        switch (id) {
            case "calculator": return R.mipmap.ic_alt_calculator;
            case "notes": return R.mipmap.ic_alt_notes;
            case "weather": return R.mipmap.ic_alt_weather;
            default: return R.mipmap.ic_launcher;
        }
    }

    /** Name and icon of the chosen entry in the recent-apps view, however the task was started. */
    @SuppressWarnings("deprecation")
    static void applyTaskDescription(Activity a) {
        try {
            String id = current(a);
            String name = a.getString(label(id));
            if (Build.VERSION.SDK_INT >= 33) {
                a.setTaskDescription(new ActivityManager.TaskDescription.Builder().setLabel(name).setIcon(icon(id)).build());
            } else {
                a.setTaskDescription(new ActivityManager.TaskDescription(name, icon(id)));
            }
        } catch (Exception ignored) {
            // The recents entry keeps the launcher's own label and icon.
        }
    }
}
