// 斜杠命令补全 + 外部会话归并：两段纯逻辑，都是「三端必须同一口径」的东西，
// 各写各的迟早漂成三种行为，所以逐条钉住。
import Foundation
import Testing
@testable import Ownward

private func task(_ id: String, _ text: String, cc: String? = nil) -> WorkTask {
    WorkTask(id: id, project: "", projectDir: nil, cwd: "", task: text, title: nil, mode: "",
             engine: nil, model: nil, status: "running", startedAt: "", endedAt: nil, exitCode: nil, ccSessionId: cc)
}

private func cc(_ id: String, firstUser: String = "", active: Bool = false, mtime: Int64 = 0) -> ObservedSession {
    ObservedSession(id: id, cwd: "", project: "", title: "", firstUser: firstUser, mtime: mtime, active: active, kind: nil)
}

struct SlashTests {
    @Test func 整条是斜杠开头的词才提示_打了空格就不弹了() {
        #expect(Slash.query("/") == "")
        #expect(Slash.query("/comp") == "comp")
        #expect(Slash.query("/compact ") == nil)      // 空格 = 命令已选定，开始写参数
        #expect(Slash.query("/btw 顺便看下 README") == nil)
        #expect(Slash.query("看下 /etc 配置") == nil)  // 不在开头不算
        #expect(Slash.query("") == nil)
    }

    @Test func 候选表_本地命令在前_服务端同名不重复() {
        let all = Slash.all(["compact", "new", "resume"])
        #expect(all?.map(\.name) == ["new", "clear", "btw", "compact", "resume"])
        #expect(all?.first?.desc == "同任务丢上下文重开")   // 同名以本地的说明为准
        #expect(Slash.all(nil) == nil)                    // nil = 这个输入框不该有补全
    }

    @Test func 前缀命中排在包含命中前面() {
        let hits = Slash.matches(input: "/c", commands: ["compact", "context"])
        // clear/compact/context 前缀命中在前（按名字排），"包含 c" 的 new/btw 不含 c 所以不进
        #expect(hits.map(\.name) == ["clear", "compact", "context"])
        // 包含即命中：ea 只在 clear 里
        #expect(Slash.matches(input: "/ea", commands: []).map(\.name) == ["clear"])
    }

    @Test func 只打一个斜杠时全表都算命中() {
        #expect(Slash.matches(input: "/", commands: []).map(\.name) == ["btw", "clear", "new"])
    }

    @Test func 不该弹菜单的时候一条都不给() {
        #expect(Slash.matches(input: "你好", commands: []).isEmpty)
        #expect(Slash.matches(input: "/new", commands: nil).isEmpty)   // commands 为 nil：整个功能关掉
        #expect(Slash.matches(input: "/zzzz", commands: []).isEmpty)   // 没有命中
    }

    @Test func 选中一条就换成整条命令并留个空格接参数() {
        #expect(Slash.accept(SlashCmd(name: "compact", desc: "")) == "/compact ")
    }

    @Test func 最多40条_不把菜单撑到看不完() {
        let many = (0..<200).map { "cmd\($0)" }
        #expect(Slash.matches(input: "/cmd", commands: many).count == 40)
    }
}

struct SessionListTests {
    @Test func terminal已认领的会话不再重复列进本机会话() {
        let tasks = [task("t1", "跑测试", cc: "abc-uuid")]
        let list = externalSessions(tasks: tasks, ccList: [cc("hash/abc-uuid"), cc("hash/other")])
        #expect(list.map(\.id) == ["hash/other"])   // 认领的按末段 id 认出来
    }

    @Test func 首条user消息与任务原文同头的_其实就是ownward派的_不重复列() {
        let tasks = [task("t1", "  把安卓的功能   同步到 ios 上 ")]
        let list = externalSessions(tasks: tasks, ccList: [
            cc("s1", firstUser: "把安卓的功能 同步到 ios 上"),   // 空白归一后同头
            cc("s2", firstUser: "别的活"),
        ])
        #expect(list.map(\.id) == ["s2"])
    }

    @Test func 活跃优先_其次按最近写入排() {
        let list = externalSessions(tasks: [], ccList: [
            cc("old", mtime: 100), cc("new", mtime: 300), cc("live", active: true, mtime: 1),
        ])
        #expect(list.map(\.id) == ["live", "new", "old"])
    }

    @Test func 同一个id只留一条() {
        let list = externalSessions(tasks: [], ccList: [cc("dup", mtime: 2), cc("dup", mtime: 1)])
        #expect(list.count == 1)
    }
}

struct SyncedContractTests {
    @Test func 排队消息带得出id_老daemon不带就是空串() throws {
        let json = #"{"queued":[{"id":"q1","text":"等会儿","images":2},{"text":"老服务端没有 id"}],"turn":"running"}"#
        let s = try JSONDecoder().decode(AgentState.self, from: Data(json.utf8))
        #expect(s.queued.map(\.id) == ["q1", ""])   // 空串 → UI 不画撤回钮，撤不了就别摆按钮
        #expect(s.queued.first?.images == 2)
    }

    @Test func slash_commands带得出来_缺字段落空表() throws {
        let withCmds = try JSONDecoder().decode(AgentState.self, from: Data(#"{"commands":["compact","resume"]}"#.utf8))
        #expect(withCmds.commands == ["compact", "resume"])
        #expect(try JSONDecoder().decode(AgentState.self, from: Data("{}".utf8)).commands.isEmpty)
    }

    @Test func 旁观分页缺ok键要当成功_不然每页都被判读取失败() throws {
        let ok = try JSONDecoder().decode(CcPage.self, from: Data(#"{"messages":[],"offset":42}"#.utf8))
        #expect(ok.isOK)                 // 服务端成功体不写 ok，缺省必须是 true
        #expect(ok.offset == 42)
        let bad = try JSONDecoder().decode(CcPage.self, from: Data(#"{"ok":false,"msg":"会话不存在"}"#.utf8))
        #expect(!bad.isOK)
        #expect(bad.msg == "会话不存在")
    }

    @Test func 派发回执只取taskId_task整包形状随服务端演进() throws {
        let r = try JSONDecoder().decode(DispatchResult.self,
            from: Data(#"{"ok":true,"msg":"已派发","task":{"id":"t9","未来新字段":1}}"#.utf8))
        #expect(r.ok)
        #expect(r.taskId == "t9")
        // 没有 task / id 为空时不能假装成功拿到会话
        #expect(try JSONDecoder().decode(DispatchResult.self, from: Data(#"{"ok":true}"#.utf8)).taskId == nil)
        #expect(try JSONDecoder().decode(DispatchResult.self, from: Data(#"{"ok":true,"task":{"id":""}}"#.utf8)).taskId == nil)
    }

    @Test func 派发默认值缺省不炸_state没配dispatchDefaults也能开表单() throws {
        let s = try JSONDecoder().decode(StateSnapshot.self, from: Data(#"{"pid":1}"#.utf8))
        #expect(s.allowFullAccess == false)   // 缺失 ≠ 开全权限
        #expect(s.dispatchDefaults.dir == nil)
    }
}
