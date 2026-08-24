// 服务端约束（src/chat-images.ts）：png/jpeg/webp/gif，≤6张/条，≤5MB/张，≤12MB/条，
// 裸 base64 且魔数必须匹配声明类型。HEIC 等一律本地转码成 JPEG（对齐 android ImageEncoder.kt）。
import UIKit

enum ImageEncoder {
    static let maxImages = 6
    private static let maxBytes = 5 * 1024 * 1024
    private static let scaleTarget: CGFloat = 1920

    /// 返回 nil 表示无法编码（读取失败或压到 30% 仍超 5MB）
    static func encode(_ raw: Data) -> OutImage? {
        let sniffed = sniff(raw)
        // gif 保持原样（重编码会丢动画）；超限的 gif 直接拒绝
        if sniffed == "image/gif" {
            return raw.count <= maxBytes ? OutImage(media_type: "image/gif", data: raw.base64EncodedString()) : nil
        }
        if let sniffed, raw.count <= maxBytes {
            return OutImage(media_type: sniffed, data: raw.base64EncodedString())
        }
        guard var image = UIImage(data: raw) else { return nil }
        let longest = max(image.size.width, image.size.height) * image.scale
        if longest > scaleTarget {
            let scale = scaleTarget / longest
            let size = CGSize(width: image.size.width * image.scale * scale, height: image.size.height * image.scale * scale)
            let fmt = UIGraphicsImageRendererFormat()
            fmt.scale = 1
            image = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
        }
        var quality: CGFloat = 0.88
        while true {
            guard let out = image.jpegData(compressionQuality: quality) else { return nil }
            if out.count <= maxBytes { return OutImage(media_type: "image/jpeg", data: out.base64EncodedString()) }
            quality -= 0.12
            if quality <= 0.30 { return nil }
        }
    }

    /// 服务端按魔数校验，所以这里也按魔数判型
    static func sniff(_ b: Data) -> String? {
        let bytes = [UInt8](b.prefix(16))
        if bytes.count > 8, bytes[0] == 0x89, bytes[1] == 0x50 { return "image/png" }
        if bytes.count > 3, bytes[0] == 0xFF, bytes[1] == 0xD8 { return "image/jpeg" }
        if bytes.count > 12, bytes[0] == 0x52, bytes[8] == 0x57, bytes[9] == 0x45 { return "image/webp" }
        if bytes.count > 6, bytes[0] == 0x47, bytes[1] == 0x49, bytes[2] == 0x46 { return "image/gif" }
        return nil
    }
}
