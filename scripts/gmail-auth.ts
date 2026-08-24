// Gmail OAuth 一次性授权：本地回环流程换取 refresh token。
// 前置：Google Cloud Console 建好 OAuth client（Desktop app 类型），见 README。
// 用法: bun scripts/gmail-auth.ts <client_id> <client_secret>
import { writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir } from "../src/util.ts";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("用法: bun scripts/gmail-auth.ts <client_id> <client_secret>");
  process.exit(1);
}

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
// modify = 读+标签管理；send = 工作台里直接回复
const SCOPE = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent", // 强制返回 refresh_token
});

console.log("在浏览器中打开授权页面…\n如果没有自动打开，手动访问：\n" + authUrl + "\n");
Bun.spawn(["open", authUrl]);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
    const code = url.searchParams.get("code");
    if (!code) return new Response("missing code", { status: 400 });

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const tok = await res.json() as any;
    if (!tok.refresh_token) {
      console.error("未拿到 refresh_token：", JSON.stringify(tok));
      setTimeout(() => process.exit(1), 100);
      return new Response("授权失败，查看终端输出", { status: 500 });
    }

    // 拿账号邮箱，按邮箱落盘——重复跑脚本即可添加多个账号（类似 ChatGPT 的多账号）
    let email = "";
    try {
      const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      email = ((await prof.json()) as any).emailAddress || "";
    } catch { /* 拿不到就落默认文件 */ }

    ensureDir(join(DATA, "secrets"));
    const file = email ? `gmail-${email}.json` : "gmail.json";
    writeFileSync(
      join(DATA, "secrets", file),
      JSON.stringify({ email, client_id: clientId, client_secret: clientSecret, refresh_token: tok.refresh_token }, null, 2),
    );
    console.log(`✅ 已保存到 data/secrets/${file}，重启 daemon 后生效`);
    console.log("   要加另一个账号？换个 Google 登录再跑一遍本脚本即可。");
    setTimeout(() => { server.stop(); process.exit(0); }, 500);
    return new Response("✅ Gmail 授权成功，可以关闭此页面", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});
console.log(`等待回调 (127.0.0.1:${PORT})…`);
