// PhotosPicker 选出的图片 → 服务端可接受的 OutImage（后台编码，不卡主线程）
import SwiftUI
import PhotosUI

extension PendingImage {
    /// 返回 (成功列表, 失败数)
    static func load(_ items: [PhotosPickerItem]) async -> ([PendingImage], Int) {
        var out: [PendingImage] = []
        var failed = 0
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { failed += 1; continue }
            let encoded = await Task.detached(priority: .userInitiated) { ImageEncoder.encode(data) }.value
            guard let encoded, let thumb = UIImage(data: data) else { failed += 1; continue }
            out.append(PendingImage(thumbnail: thumb.preparingThumbnail(of: CGSize(width: 256, height: 256)) ?? thumb, payload: encoded))
        }
        return (out, failed)
    }
}
