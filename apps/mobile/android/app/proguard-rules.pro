# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Capacitor reads plugin metadata from annotations at run time (@CapacitorPlugin(permissions = {@Permission(...)}),
# @PermissionCallback, @ActivityCallback). Its own rules keep the annotated classes and methods but not the
# annotation types, and R8 then dropped the nested @Permission values: every permission alias came back
# empty in release builds (the notification permission was never requested, 2.0.0 to 2.3.0). Keep them whole.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault
-keep @interface com.getcapacitor.annotation.** { *; }
-keep class com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
