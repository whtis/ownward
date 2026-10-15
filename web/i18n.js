"use strict";
/* 界面语言：中文是源语言，英文走 i18n-en.js 的词典（键 = 中文原文）。
 * 不改 2000+ 处调用点：MutationObserver 把渲染进 DOM 的文本节点与 title/placeholder/aria-label/alt 就地换成英文。
 * - 只做整串命中（精确 / 带 {0} 占位的模板），不做子串替换：用户内容（任务标题、聊天正文、笔记）
 *   恰好整串等于某个界面词的概率极低，子串替换则会把「修复设置页」改成「修复Settings页」。
 * - 模板的占位捕获来自服务端动态内容（报错原因等），只对捕获段做短语级替换。
 * - 用户 / agent 内容整块跳过：聊天气泡正文、Markdown 块、笔记正文、编辑区、pre/code，或显式 data-i18n-skip / translate="no"。
 * 语言选择存 localStorage（ownward-lang = auto | zh | en，跟皮肤一样是每个浏览器自己的偏好），auto 跟随浏览器。 */
(function () {
  const KEY = "ownward-lang";
  const CJK = /[㐀-鿿]/;
  let pref = "auto";
  try { pref = localStorage.getItem(KEY) || "auto"; } catch { /* 隐私模式：按 auto */ }
  if (!["auto", "zh", "en"].includes(pref)) pref = "auto";
  const browserZh = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""]).some((l) => /^zh\b/i.test(l || ""));
  const lang = pref === "auto" ? (browserZh ? "zh" : "en") : pref;
  const I18N = window.I18N = {
    pref, lang, locale: lang === "en" ? "en-US" : "zh-CN",
    /** 设置页切换：存偏好后整页重载（已渲染的中文节点没有回退表，重载最干净） */
    set(next) { try { localStorage.setItem(KEY, next); } catch { /* 存不住就只能本次 */ } location.reload(); },
    t: (s) => s, missing: () => [],
  };
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  // 服务端按界面语言生成任务标题，但选择只在浏览器里：每次加载报一次生效语言（服务端不变不写盘）
  try { fetch("/api/ui/lang", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang }) }).catch(() => {}); } catch { /* 报不上就沿用上次 */ }
  if (lang !== "en") return;
  const dict = window.I18N_EN || {};
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const exact = new Map(), templates = [], buckets = new Map(), phrases = [];
  for (const [zh, en] of Object.entries(dict)) {
    if (typeof en !== "string" || !en) continue;
    const key = norm(zh);
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, en);
      if ((key.match(/[㐀-鿿]/g) || []).length >= 2) phrases.push([key, en]);
      continue;
    }
    // 模板：字面段转义，{N} → 惰性捕获；literal 里的第一个汉字做分桶键
    const order = [];
    const source = key.split(/(\{\d+\})/).map((part) => { const m = /^\{(\d+)\}$/.exec(part); if (m) { order.push(Number(m[1])); return "([\\s\\S]*?)"; } return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("");
    const first = (key.replace(/\{\d+\}/g, "").match(/[㐀-鿿]/) || [])[0];
    if (!first) continue;
    const tpl = { re: new RegExp(`^${source}$`), order, en, literal: key.replace(/\{\d+\}/g, "").length };
    templates.push(tpl);
    if (!buckets.has(first)) buckets.set(first, []);
    buckets.get(first).push(tpl);
  }
  // 字面更长的模板更具体，优先匹配
  for (const list of buckets.values()) list.sort((a, b) => b.literal - a.literal);
  phrases.sort((a, b) => b[0].length - a[0].length);
  const PUNCT = { "，": ", ", "；": "; ", "：": ": ", "（": " (", "）": ") ", "「": "\"", "」": "\"", "“": "\"", "”": "\"", "、": ", ", "。": ". ", "！": "! ", "？": "? " };
  const punct = (s) => s.replace(/[，；：（）「」“”、。！？]/g, (c) => PUNCT[c]).replace(/ {2,}/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ([,.;:!?)])/g, "$1");
  /** 动态捕获段：整串 → 模板 → 短语替换（服务端报错原文常是「已知短语 + 标识符」的拼接） */
  function fragment(s, depth) {
    if (!CJK.test(s)) return s;
    const whole = translate(s, depth + 1);
    if (whole !== null) return whole;
    let out = s;
    for (const [zh, en] of phrases) { if (out.includes(zh)) { out = out.split(zh).join(en); if (!CJK.test(out)) break; } }
    return punct(out).trim() === punct(s).trim() ? s : punct(out);
  }
  /** 整串翻译；命中不了返回 null */
  function translate(text, depth = 0) {
    const key = norm(text);
    if (!key || !CJK.test(key)) return null;
    const hit = exact.get(key);
    if (hit !== undefined) return hit;
    if (depth > 2) return null;
    const seen = new Set();
    for (const ch of key) {
      if (!CJK.test(ch) || seen.has(ch)) continue; seen.add(ch);
      const list = buckets.get(ch); if (!list) continue;
      for (const tpl of list) {
        const m = tpl.re.exec(key); if (!m) continue;
        const caps = m.slice(1);
        return tpl.en.replace(/\{(\d+)\}/g, (_, n) => { const i = tpl.order.indexOf(Number(n)); return i < 0 ? "" : fragment(caps[i] ?? "", depth); });
      }
    }
    // 会话里的系统提示带「⚠️ / ⏳ / ✅」前缀（runner-consumer 拼的），词典只收正文：剥掉前缀再翻
    const lead = depth === 0 ? /^([^\p{L}\p{N}\s]+)\s+(?=\S)/u.exec(key) : null;
    if (lead) { const rest = translate(key.slice(lead[0].length), 1); if (rest !== null) return `${lead[1]} ${rest}`; }
    // 「A · B」「A / B」这类拼接标签：每个含汉字的段都能整串命中才拼回去，否则不动（避免半翻译用户内容）
    if (depth === 0) for (const sep of [" · ", " / ", " | "]) {
      if (!key.includes(sep)) continue;
      const parts = key.split(sep), outParts = [];
      for (const part of parts) { if (!CJK.test(part)) { outParts.push(part); continue; } const hit2 = translate(part, 1); if (hit2 === null) { outParts.length = 0; break; } outParts.push(hit2); }
      if (outParts.length === parts.length) return outParts.join(sep);
    }
    return null;
  }
  const t = (s) => { if (typeof s !== "string") return s; const out = translate(s); return out === null ? s : out; };
  I18N.t = t;
  // 只跳过内容本身：气泡正文、Markdown 渲染块、笔记正文；「我 · 10:30」这类标签照常翻
  const SKIP = '[data-i18n-skip],[translate="no"],.msg[data-role="user"] .bubble,.msg[data-role="assistant"] .bubble,.msg[data-role="thinking"] .bubble,[class^="md-"],[class*=" md-"],.nt-doc,.task-card-title,.nt-name,.file-chip-name,.role-hero-desc,pre,code,textarea,[contenteditable="true"],script,style';
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const skipped = (el) => !!(el && el.closest && el.closest(SKIP));
  // 输入框里是用户写的字，跳过；但它自己的 placeholder / title 是界面文本，照翻
  const attrSkipped = (el) => (el.tagName === "TEXTAREA" || el.isContentEditable) ? skipped(el.parentElement) : skipped(el);
  function textNode(node) {
    const raw = node.nodeValue;
    if (!raw || !CJK.test(raw) || skipped(node.parentElement)) return;
    // 没写 value 的 <option>：select.value 就是它的文字，翻了会把译文当值提交
    if (node.parentElement?.tagName === "OPTION" && !node.parentElement.hasAttribute("value")) return;
    const out = translate(raw);
    if (out === null) return;
    const lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
    node.nodeValue = lead + out + trail;
  }
  function attrs(el) {
    if (attrSkipped(el)) return;
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v && CJK.test(v)) { const out = translate(v); if (out !== null) el.setAttribute(a, out); } }
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1) return;
    attrs(root);
    if (skipped(root)) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (n) => { if (n.nodeType === 1 && n.matches(SKIP)) { attrs(n); return NodeFilter.FILTER_REJECT; } return NodeFilter.FILTER_ACCEPT; } });
    let n; while ((n = tw.nextNode())) { if (n.nodeType === 3) textNode(n); else attrs(n); }
  }
  // 把我们自己写回去的变更也会再触发一次：英文没有汉字，第二遍直接放过，不会循环
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") textNode(r.target);
      else if (r.type === "attributes") { if (r.target.nodeType === 1) attrs(r.target); }
      else for (const n of r.addedNodes) walk(n);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener("DOMContentLoaded", () => walk(document.documentElement));
  // 原生弹窗不走 DOM。prompt 的默认值是用户数据（改名时的当前名字），不能翻——翻了会被原样存回去
  const wrap = (name) => { const native = window[name].bind(window); window[name] = (message, ...rest) => native(typeof message === "string" ? t(message) : message, ...rest); };
  wrap("alert"); wrap("confirm"); wrap("prompt");
  /** 调试：列出页面上还没翻译的中文界面文本（跳过区之外），补词典用 */
  I18N.missing = () => {
    const out = new Set(), tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = tw.nextNode())) { const v = norm(n.nodeValue || ""); if (CJK.test(v) && !skipped(n.parentElement)) out.add(v); }
    return [...out];
  };
})();
