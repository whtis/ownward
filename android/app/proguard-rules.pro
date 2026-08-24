# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class ai.ownward.app.** {
    *** Companion;
}
-keepclasseswithmembers class ai.ownward.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
