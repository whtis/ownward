// 目录浏览（对齐 android data/FsDirListingTest.kt + ui/DirPickerNavTest.kt）：
// query 拼接、根视图/截断标记的解码、失败回退授权根只发生一次。
import Foundation
import Testing
@testable import Ownward

struct DirPickerTests {
    @Test func fsDirsPath对空白路径回根视图_特殊字符会转义() {
        #expect(OwnwardClient.fsDirsPath(nil) == "/api/fs/dirs")
        #expect(OwnwardClient.fsDirsPath("   ") == "/api/fs/dirs")
        // 与 android 的 URLEncoder 表现不同（iOS 保留 "/"、空格转 %20 而非 +），
        // 但服务端 URLSearchParams 两种都能还原；钉住的是「?&=#+ 必须转义」这个口径
        #expect(OwnwardClient.fsDirsPath("/Users/example/全部 工作/#草稿")
            == "/api/fs/dirs?path=/Users/example/%E5%85%A8%E9%83%A8%20%E5%B7%A5%E4%BD%9C/%23%E8%8D%89%E7%A8%BF")
    }

    @Test func 解码根视图和git标记() throws {
        let l = try JSONDecoder().decode(FsDirListing.self, from: Data(
            #"{"ok":true,"path":null,"parent":null,"entries":[{"name":"/srv/work","path":"/srv/work","git":true}],"truncated":false}"#.utf8))
        #expect(l.ok)
        #expect(l.path == nil)
        #expect(l.parent == nil)
        #expect(l.entries.count == 1)
        #expect(l.entries[0].path == "/srv/work")
        #expect(l.entries[0].git)
        #expect(!l.truncated)
    }

    @Test func 解码截断的子目录列表() throws {
        let l = try JSONDecoder().decode(FsDirListing.self, from: Data(
            #"{"ok":true,"path":"/srv/work","parent":null,"entries":[],"truncated":true}"#.utf8))
        #expect(l.path == "/srv/work")
        #expect(l.truncated)
    }

    @Test func 起点路径失败只自动回退授权根一次() {
        let retryAtRoots = DirPickerNav(requestedPath: "/missing/path").failed()
        #expect(retryAtRoots == DirPickerNav(requestedPath: nil, canFallbackToRoots: false))
        #expect(retryAtRoots?.failed() == nil)
        #expect(DirPickerNav(requestedPath: nil).failed() == nil)   // 根视图本身失败不回退
    }

    @Test func 载入成功后不再回退_上级可以一路走回根视图() {
        let loaded = DirPickerNav(requestedPath: "/allowed/project").loaded()
        #expect(loaded.failed() == nil)
        let parent = loaded.go("/allowed")
        #expect(parent.requestedPath == "/allowed")
        #expect(!parent.canFallbackToRoots)
        let roots = parent.go(nil)
        #expect(roots.requestedPath == nil)
        #expect(!roots.canFallbackToRoots)
    }
}
