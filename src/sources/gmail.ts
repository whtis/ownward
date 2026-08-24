// Gmail 轮询：支持多账号——data/secrets/ 下每个 gmail*.json 一个账号
// （scripts/gmail-auth.ts 重复跑即可添加），读接口可按账号或 "all" 合并。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, cfg, log } from "../util.ts";
import type { ConnectorContext, ConnectorEvent } from "../kernel/connectors/contracts.ts";
import { createHash } from "crypto";

const SECRETS = join(DATA, "secrets");
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailCreds {
  email?: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

export interface GmailAccountInfo { email: string; file: string; }

export function gmailAccounts(): GmailAccountInfo[] {
  if (!existsSync(SECRETS)) return [];
  const out: GmailAccountInfo[] = [];
  for (const f of readdirSync(SECRETS)) {
    if (!/^gmail(-.+)?\.json$/.test(f)) continue;
    try {
      const c = JSON.parse(readFileSync(join(SECRETS, f), "utf8"));
      out.push({ email: c.email || f.replace(/^gmail-?/, "").replace(/\.json$/, "") || "default", file: join(SECRETS, f) });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/** account: 邮箱地址 / 空 / "all"（写操作落到第一个账号） */
function credsFileFor(account?: string): string {
  const accs = gmailAccounts();
  if (!accs.length) throw new Error("Gmail 未授权（bun scripts/gmail-auth.ts）");
  if (!account || account === "all") return accs[0].file;
  return accs.find((a) => a.email === account)?.file || accs[0].file;
}

export function startGmail() {
  void import("../connectors.ts").then((m)=>m.startConnectors()).catch((e)=>log(`gmail connector start: ${e instanceof Error?e.name:"unknown"}`));
}

async function accessToken(file: string): Promise<string> {
  const creds: GmailCreds = JSON.parse(readFileSync(file, "utf8"));
  if (creds.access_token && creds.expires_at && Date.now() < creds.expires_at - 60_000) {
    return creds.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const tok = await res.json() as { access_token: string; expires_in: number };
  creds.access_token = tok.access_token;
  creds.expires_at = Date.now() + tok.expires_in * 1000;
  writeFileSync(file, JSON.stringify(creds, null, 2));
  return tok.access_token;
}

const grantTokenCache=new Map<string,{token?:string;expiresAt?:number;refresh?:Promise<string>}>();
function grantKey(creds:GmailCreds):string{return createHash("sha256").update(`${creds.client_id}\0${creds.refresh_token}`).digest("hex");}
export async function accessTokenFromGrant(creds:GmailCreds):Promise<string>{const now=Date.now(),key=grantKey(creds),cached=grantTokenCache.get(key)??{};if(creds.access_token&&creds.expires_at&&now<creds.expires_at-60_000&&(!cached.expiresAt||creds.expires_at>cached.expiresAt)){cached.token=creds.access_token;cached.expiresAt=creds.expires_at;}if(cached.token&&cached.expiresAt&&now<cached.expiresAt-60_000){grantTokenCache.set(key,cached);return cached.token;}if(cached.refresh)return cached.refresh;cached.refresh=(async()=>{const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:creds.client_id,client_secret:creds.client_secret,refresh_token:creds.refresh_token,grant_type:"refresh_token"})});if(!res.ok)throw new Error(`token refresh failed: ${res.status}`);const token=await res.json()as{access_token:string;expires_in:number};cached.token=token.access_token;cached.expiresAt=Date.now()+Math.max(0,token.expires_in)*1000;creds.access_token=cached.token;creds.expires_at=cached.expiresAt;return cached.token;})().finally(()=>{cached.refresh=undefined;});grantTokenCache.set(key,cached);return cached.refresh;}
async function grantedGapi(creds:GmailCreds,path:string){const token=await accessTokenFromGrant(creds),res=await fetch(`${API}${path}`,{headers:{Authorization:`Bearer ${token}`}});if(!res.ok)throw new Error(`gmail api ${path}: ${res.status}`);return res.json();}

async function gapi(path: string, account?: string): Promise<any> {
  const token = await accessToken(credsFileFor(account));
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gmail api ${path}: ${res.status}`);
  return res.json();
}

// ---- 工作台：收件箱 / 读正文 / 回复 ----

async function fetchList(q: string, limit: number, acc: GmailAccountInfo) {
  const list = await gapi(`/messages?q=${encodeURIComponent(q)}&maxResults=${limit}`, acc.email);
  const out = [];
  for (const m of (list.messages || []).slice(0, limit)) {
    const msg = await gapi(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, acc.email);
    const h = Object.fromEntries((msg.payload?.headers || []).map((x: any) => [x.name.toLowerCase(), x.value]));
    out.push({
      id: m.id, account: acc.email,
      from: h.from || "", subject: h.subject || "(无主题)", date: h.date || "",
      snippet: msg.snippet || "", unread: (msg.labelIds || []).includes("UNREAD"),
      _ts: Date.parse(h.date || "") || 0,
    });
  }
  return out;
}

/** 多账号合并（按时间倒序），account 指定则只看该账号 */
async function multiList(q: string, limit: number, account?: string) {
  const accs = gmailAccounts();
  const targets = !account || account === "all" ? accs : accs.filter((a) => a.email === account);
  const per = Math.max(8, Math.ceil(limit / Math.max(1, targets.length)));
  const chunks = await Promise.all(targets.map((a) =>
    fetchList(q, per, a).catch((e) => { log(`gmail list (${a.email}): ${e}`); return []; })));
  return chunks.flat().sort((a, b) => b._ts - a._ts).slice(0, limit).map(({ _ts, ...m }) => m);
}

export async function gmailInbox(limit = 20, account?: string) {
  return multiList("in:inbox newer_than:7d", limit, account);
}

function walkParts(payload: any, want: string): string | null {
  if (payload?.mimeType === want && payload.body?.data) return payload.body.data;
  for (const part of payload?.parts || []) {
    const hit = walkParts(part, want);
    if (hit) return hit;
  }
  return null;
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

export async function gmailMessageDetail(id: string, account?: string) {
  const msg = await gapi(`/messages/${id}?format=full`, account);
  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]),
  );
  let body = "";
  const plain = walkParts(msg.payload, "text/plain");
  if (plain) body = b64urlDecode(plain);
  else {
    const html = walkParts(msg.payload, "text/html");
    if (html) body = b64urlDecode(html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s{3,}/g, "\n").trim();
    else body = msg.snippet || "";
  }
  return {
    from: headers.from, to: headers.to, subject: headers.subject, date: headers.date,
    threadId: msg.threadId, body: body.slice(0, 20_000),
  };
}

function rfc2047(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
}

/** 标签操作：归档=去 INBOX、已读=去 UNREAD、星标=加 STARRED */
export async function gmailModify(id: string, add: string[] = [], remove: string[] = [], account?: string) {
  const token = await accessToken(credsFileFor(account));
  const res = await fetch(`${API}/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
  if (!res.ok) throw new Error(`modify failed: ${res.status}`);
}

export async function gmailSearch(q: string, limit = 20, account?: string) {
  return multiList(q, limit, account);
}

/** 写新邮件（纯文本，需 gmail.send scope） */
export async function gmailCompose(to: string, subject: string, text: string, account?: string) {
  const raw = [
    `To: ${to}`,
    `Subject: ${rfc2047(subject)}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(text).toString("base64"),
  ].join("\r\n");
  const token = await accessToken(credsFileFor(account));
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

/** 简单回复：沿用原线程（In-Reply-To/References/threadId），需要 gmail.send scope */
export async function gmailReply(id: string, text: string, account?: string) {
  const orig = await gapi(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To`, account);
  const headers = Object.fromEntries(
    (orig.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]),
  );
  const to = headers["reply-to"] || headers.from;
  const subject = headers.subject?.startsWith("Re:") ? headers.subject : `Re: ${headers.subject || ""}`;
  const mid = headers["message-id"];
  const raw = [
    `To: ${to}`,
    `Subject: ${rfc2047(subject)}`,
    ...(mid ? [`In-Reply-To: ${mid}`, `References: ${mid}`] : []),
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(text).toString("base64"),
  ].join("\r\n");

  const token = await accessToken(credsFileFor(account));
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId: orig.threadId }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

export async function collectGmailAccount(ctx: ConnectorContext, acc: GmailAccountInfo, api: typeof gapi = gapi): Promise<void> {
  const checkpoint = await ctx.checkpoint();
  const knownByAccount = parseKnownMessageIds(checkpoint?.metadata?.knownMessageIds);
  const known = new Set(knownByAccount[acc.email] ?? []);
  const list = await api(`/messages?q=${encodeURIComponent("in:inbox is:unread newer_than:2d")}&maxResults=25`, acc.email);
  const events: ConnectorEvent[] = [];
  for (const item of list.messages || []) {
    const id = String(item.id);
    if (known.has(id)) continue;
    const msg = await api(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, acc.email);
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map((h: any) => [h.name.toLowerCase(), h.value]),
    );
    const occurredAt = Number.isFinite(Date.parse(headers.date)) ? new Date(headers.date).toISOString() : new Date().toISOString();
    const stableId=createHash("sha256").update(`${acc.email}\0${id}`).digest("hex");
    events.push({ id: `msg:${stableId}`, namespace: "gmail.inbox", type: "message", occurredAt, payload: { id, messageId: id, threadId: msg.threadId, account: acc.email, from: headers.from, subject: headers.subject, date: headers.date, snippet: msg.snippet } });
  }
  const listedIds = (list.messages || []).map((item: any) => String(item.id));
  knownByAccount[acc.email] = [...new Set([...listedIds, ...known])].slice(0, 250);
  const cursor = [...events.map((event) => event.occurredAt), checkpoint?.cursor].filter((value): value is string => !!value && value !== "empty").sort().at(-1) ?? "empty";
  await ctx.publish(events, { version: 1, cursor, updatedAt: new Date().toISOString(), metadata: { account: acc.email, count: events.length, knownMessageIds: JSON.stringify(knownByAccount) } });
}

function parseKnownMessageIds(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([account, ids]) =>
      Array.isArray(ids) ? [[account, ids.filter((id): id is string => typeof id === "string").slice(0, 250)]] : [],
    ));
  } catch { return {}; }
}

export async function runGmailPoll(state:{running:boolean},work:()=>Promise<void>):Promise<boolean>{if(state.running)return false;state.running=true;try{await work();return true;}finally{state.running=false;}}

export function startGmailConnector(ctx: ConnectorContext): void {
  const state={running:false},poll = () => runGmailPoll(state,async () => { let granted:any[]=[];try{granted=JSON.parse((await ctx.secret("GMAIL_ACCOUNTS"))||"[]");}catch{}if (!granted.length) { await ctx.reportHealth({ok:false,code:"GMAIL_CREDENTIALS_MISSING",message:"no credentials"});ctx.log("poll", "no credentials"); return; }const failures:string[]=[]; for (const creds of granted) {const account={email:String(creds.email||"default"),file:"[KERNEL_SECRET_REF]"};try { await collectGmailAccount(ctx, account, (path)=>grantedGapi(creds,path)); } catch (error) {const message=`${account.email}: ${error instanceof Error ? error.message : String(error)}`;failures.push(message);ctx.log("poll",message); }}if(failures.length)await ctx.reportHealth({ok:false,code:"GMAIL_POLL_FAILED",message:failures.join("; ")});else await ctx.reportHealth({ok:true,detail:{accounts:granted.length}}); });
  void poll(); const timer = setInterval(() => void poll(), (Number(ctx.config.pollMin) || 10) * 60_000); ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
