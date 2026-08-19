# Foundry Android Companion ProGuard rules
-keepattributes *Annotation*
-keepclassmembers class * {
    @org.jetbrains.annotations.Nullable *;
    @org.jetbrains.annotations.NotNull *;
}
