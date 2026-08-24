import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// 个人签名放在 ~/.ownward/android-signing.properties（storeFile/storePassword/keyAlias/keyPassword），
// 缺失时回落 debug 签名，保证任何机器都能出包
val signingProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".ownward/android-signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "ai.ownward.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.ownward.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 202608241
        versionName = "0.1.0-alpha.20260824"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("ownward") {
                storeFile = File(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (signingProps.isNotEmpty()) signingConfigs.getByName("ownward")
            else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.haze)
    implementation(libs.haze.materials)
    // 纯逻辑的 JVM 测试（会话流分组等）：跑 ./gradlew :app:testReleaseUnitTest，不需要设备
    testImplementation(libs.junit)
}
