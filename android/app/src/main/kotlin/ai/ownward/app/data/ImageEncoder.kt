package ai.ownward.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

// 服务端约束（src/chat-images.ts）：png/jpeg/webp/gif，≤6张/条，≤5MB/张（解码后），
// ≤12MB/条，裸 base64 且魔数必须匹配声明类型。HEIC 等一律本地转码成 JPEG。
object ImageEncoder {
    const val MAX_IMAGES = 6
    private const val MAX_BYTES = 5 * 1024 * 1024
    private const val SCALE_TARGET = 1920

    /** 返回 null 表示读取失败 */
    suspend fun fromUri(context: Context, uri: Uri): OutImage? = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val declared = resolver.getType(uri) ?: ""
        val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null

        // gif 保持原样（重编码会丢动画）；超限的 gif 直接拒绝，由调用方提示
        if (declared == "image/gif" && sniff(raw) == "image/gif") {
            return@withContext if (raw.size <= MAX_BYTES)
                OutImage("image/gif", Base64.encodeToString(raw, Base64.NO_WRAP)) else null
        }

        // png/jpeg/webp 且不超限：原样发，媒体类型以魔数为准（服务端会严格校验）
        val sniffed = sniff(raw)
        if (sniffed != null && raw.size <= MAX_BYTES) {
            return@withContext OutImage(sniffed, Base64.encodeToString(raw, Base64.NO_WRAP))
        }

        // 其余（HEIC、超大图）：解码位图重编码为 JPEG，必要时缩边
        var bmp = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: return@withContext null
        val longest = maxOf(bmp.width, bmp.height)
        if (longest > SCALE_TARGET) {
            val scale = SCALE_TARGET.toFloat() / longest
            bmp = Bitmap.createScaledBitmap(
                bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true
            )
        }
        var quality = 88
        var out: ByteArray
        do {
            val buf = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, buf)
            out = buf.toByteArray()
            quality -= 12
        } while (out.size > MAX_BYTES && quality > 30)
        if (out.size > MAX_BYTES) return@withContext null
        OutImage("image/jpeg", Base64.encodeToString(out, Base64.NO_WRAP))
    }

    /** 服务端按魔数校验，所以这里也按魔数判型而不是信 ContentResolver */
    private fun sniff(b: ByteArray): String? = when {
        b.size > 8 && b[0] == 0x89.toByte() && b[1] == 0x50.toByte() -> "image/png"
        b.size > 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() -> "image/jpeg"
        b.size > 12 && b[0] == 'R'.code.toByte() && b[8] == 'W'.code.toByte() && b[9] == 'E'.code.toByte() -> "image/webp"
        b.size > 6 && b[0] == 'G'.code.toByte() && b[1] == 'I'.code.toByte() && b[2] == 'F'.code.toByte() -> "image/gif"
        else -> null
    }
}
