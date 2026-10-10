// 界面中文串抽取：英文词典（web/i18n-en.js）的来源清单。
// 抽字面量 → 按 DOM 文本节点切分（${} → {N}，HTML 标签处切开）；自带最小 JS 词法（字符串/模板/注释/正则），
// 项目的 TypeScript 是 Go 原生版，没有 JS scanner API 可用。
//   bun scripts/i18n-extract.ts             → 打印 web + 服务端全部界面串（JSON）
//   bun scripts/i18n-extract.ts --missing   → 只列 web/i18n-en.js 里还没有译文的串（加了中文界面文本后跑一下补词典）
const CJK = /[㐀-鿿！-～、-〿]/;
const ent = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, "·").replace(/&times;/g, "×").replace(/&hellip;/g, "…").replace(/&amp;/g, "&");
function segments(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/(?:title|placeholder|aria-label|alt|data-tip|label|data-empty)=["']([^"']*)["']/g)) out.push(m[1]);
  for (const part of raw.replace(/<[^<>]*>/g, "\u0001").split("\u0001")) out.push(part);
  return out.map((s) => ent(s).replace(/\s+/g, " ").trim()).filter((s) => CJK.test(s));
}
function unescape(s: string) { return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|t|r|.)/g, (_, e) => e[0] === "u" ? (Number.isFinite(parseInt(e.replace(/[u{}]/g, ""), 16)) ? String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16)) : "") : e[0] === "x" ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "" : e); }
function scanJs(code: string, emit: (s: string) => void) {
  let i = 0, n = code.length, lastSig = "";  // lastSig 判断 / 是除号还是正则
  const regexOk = () => !lastSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastSig);
  function readTemplate(): string { // i 指向 ` 之后
    let out = "", ph = 0;
    while (i < n) {
      const c = code[i];
      if (c === "\\") { out += unescape(code.slice(i, i + 2)); i += 2; continue; }
      if (c === "`") { i++; return out; }
      if (c === "$" && code[i + 1] === "{") { i += 2; out += `{${ph++}}`; skipExpr(); continue; }
      out += c; i++;
    }
    return out;
  }
  function skipExpr() { // 跳过 ${...} 表达式；里面的字面量也照样抽
    let depth = 1; const saved = lastSig; lastSig = "(";
    while (i < n && depth > 0) { const c = code[i]; if (c === "}") { depth--; i++; continue; } if (c === "{") { depth++; i++; continue; } step(); }
    lastSig = saved;
  }
  function step() {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") { while (i < n && code[i] !== "\n") i++; return; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; return; }
    if (c === '"' || c === "'") { let j = i + 1, s = ""; while (j < n && code[j] !== c && code[j] !== "\n") { if (code[j] === "\\") { s += code.slice(j, j + 2); j += 2; } else s += code[j++]; } i = j + 1; emit(unescape(s)); lastSig = "a"; return; }
    if (c === "`") { i++; emit(readTemplate()); lastSig = "a"; return; }
    if (c === "/" && regexOk()) { let j = i + 1, cls = false; while (j < n && code[j] !== "\n") { if (code[j] === "\\") { j += 2; continue; } if (code[j] === "[") cls = true; else if (code[j] === "]") cls = false; else if (code[j] === "/" && !cls) break; j++; } i = j + 1; while (/[a-z]/.test(code[i] || "")) i++; lastSig = "a"; return; }
    if (/\s/.test(c)) { i++; return; }
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++; lastSig = code.slice(i, j); i = j; return; }
    lastSig = c; i++;
  }
  while (i < n) step();
}
const ROOT = `${import.meta.dir}/..`, missingOnly = process.argv.includes("--missing");
const argFiles = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const listed = argFiles.length ? argFiles : (await new Response(Bun.spawn(["git", "ls-files", "web/*.js", "web/*.html", "src/*.ts", "src/**/*.ts"], { cwd: ROOT, stdout: "pipe" }).stdout).text()).split("\n").filter((f) => f && !/\.test\.ts$|\/testing\/|^web\/i18n(-en)?\.js$/.test(f)).map((f) => `${ROOT}/${f}`);
const files = listed, acc = new Map<string, Set<string>>();
for (const f of files) {
  const code = await Bun.file(f).text(), rel = f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f;
  const add = (s: string) => { for (const seg of segments(s)) { if (!acc.has(seg)) acc.set(seg, new Set()); acc.get(seg)!.add(rel); } };
  if (f.endsWith(".html")) {
    for (const m of code.matchAll(/<script>([\s\S]*?)<\/script>/g)) scanJs(m[1], add);
    add(code.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, ""));
  } else scanJs(code, add);
}
// 服务端多行 / 超长串是给 agent 的 prompt，不上界面
const entries = [...acc].filter(([zh, fs]) => [...fs].some((f) => f.startsWith("web/")) || (zh.length <= 160 && !/\n/.test(zh))).map(([zh, fs]) => ({ zh, files: [...fs] }));
if (!missingOnly) console.log(JSON.stringify(entries));
else {
  const win: any = {}; new Function("window", await Bun.file(`${ROOT}/web/i18n-en.js`).text())(win);
  const missing = entries.filter((e) => !(e.zh in (win.I18N_EN || {})));
  for (const e of missing) console.log(`${JSON.stringify(e.zh)}\t${e.files[0]}`);
  console.error(`${missing.length} missing of ${entries.length}`);
}
