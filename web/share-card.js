"use strict";
/* 会话分享图：在会话里点选几条消息，画成一张带 Ownward 落款的 PNG。
 * - 纯 Canvas 2D 绘制：零依赖；不走 SVG foreignObject（Safari 会污染画布，toBlob 直接抛错）。
 * - 图片只在本机浏览器里生成，不上传；默认隐去本机路径与常见密钥形态。
 * - 选择态只存在这里：会话轮询每 10s 整块重渲染，msgHtml 只给可选消息打 data-share-i，
 *   重渲染后由 MutationObserver 把选中标记补回去，不必改每条渲染路径。 */
const ShareCard = (() => {
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const isEn = () => window.I18N?.lang === "en";
  const state = { on: false, oneShot: false, done: false, picked: new Map(), ctx: null, theme: "warm", redact: true, title: "", blob: null, url: "", seq: 0 };
  try { state.theme = localStorage.getItem("ownward-share-theme") || "warm"; } catch { /* 存不住就用默认 */ }

  // ── 主题：便签纸风格（纸面 + 双细框 + 角块），参考 zhaoolee/notes 的锤子便签排版，配色与代码自写 ──
  // frame=false 的主题不画框；grain = 纸纹噪点的强度；glows = 品牌主题的背景光晕
  const THEMES = {
    warm: {
      label: "暖白纸感", paper: "#fffcf7", frame: "#e4dccf", text: "#5f5044", heading: "#3f3127", muted: "#a39684", accent: "#b08a5e",
      quote: "#9a8b7b", quoteMark: "#dccfbf", pre: "#f6efe4", preText: "#6b5443", inline: "rgba(125,78,32,0.08)", codeText: "#8a6548", rule: "#ece4d7", foot: "#b9ad9c", grain: 0.035,
    },
    night: {
      label: "深夜便签", paper: "#1c1a1c", frame: "#353235", text: "#cdcacd", heading: "#e8e5e8", muted: "#7f7b7f", accent: "#d5ab36",
      quote: "#a29fa2", quoteMark: "#555155", pre: "#252225", preText: "#cfcccf", inline: "#2c292c", codeText: "#e0c27a", rule: "#2f2c2f", foot: "#6d696d", grain: 0.04,
    },
    memo: {
      label: "备忘录", paper: "#ffffff", frame: null, text: "#2c2c2e", heading: "#1c1c1e", muted: "#8e8e93", accent: "#e0a800",
      quote: "#636366", quoteMark: "#ebb800", pre: "#f2f2f7", preText: "#2c2c2e", inline: "#f0f0f5", codeText: "#3a3a3c", rule: "#e5e5ea", foot: "#aeaeb2", grain: 0,
    },
    aurora: {
      label: "极光", paper: "#0d1322", frame: "rgba(255,255,255,0.10)", text: "#d9e1ee", heading: "#f2f6fc", muted: "#7f8aa0", accent: "#6fb0ff",
      quote: "#9fb0c8", quoteMark: "#34507a", pre: "rgba(0,0,0,0.32)", preText: "#cfe2ff", inline: "rgba(255,255,255,0.08)", codeText: "#a9cdff", rule: "rgba(255,255,255,0.08)", foot: "#6f7b92", grain: 0,
      glows: [[0.1, 0.0, 0.9, "rgba(99,168,255,0.30)"], [1.0, 0.45, 0.7, "rgba(71,199,244,0.16)"], [0.2, 1.0, 0.9, "rgba(140,92,255,0.22)"]],
    },
  };

  // ── 文本处理（纯函数，不碰 DOM：测试直接调） ──
  /** 隐去本机路径与常见密钥形态。宁可多遮：分享出去的图收不回来 */
  function redact(s) {
    return String(s || "")
      .replace(/\/(?:Users|home)\/[^/\s'"`)\]]+/g, "~")
      .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "••••••")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1••••••")
      .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi, "$1$2••••••$2");
  }
  /** Markdown 精简版 → 块：标题 / 列表 / 引用 / 代码 / 表格 / 分隔线 / 段落（段内单换行保留） */
  function blocks(src) {
    const out = [], lines = String(src || "").replace(/\r/g, "").split("\n");
    let para = null;
    const flush = () => { if (para) { out.push({ type: "p", text: para.join("\n") }); para = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        flush(); const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
        out.push({ type: "code", lang: fence[2] || "", lines: body }); continue;
      }
      if (!line.trim()) { flush(); continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push({ type: "h", level: m[1].length, text: m[2] }); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ type: "hr" }); continue; }
      if ((m = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) { flush(); out.push({ type: "li", indent: Math.min(3, Math.floor(m[1].length / 2)), mark: m[2] ? (m[2] === " " ? "☐" : "☑") : "•", text: m[3] }); continue; }
      if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) { flush(); out.push({ type: "li", indent: Math.min(3, Math.floor(m[1].length / 2)), mark: `${m[2]}.`, text: m[3] }); continue; }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); const last = out[out.length - 1]; if (last?.type === "quote") last.text += "\n" + m[1]; else out.push({ type: "quote", text: m[1] }); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flush(); if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;   // |---|---| 分隔行
        const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        const last = out[out.length - 1]; if (last?.type === "table") last.rows.push(cells); else out.push({ type: "table", rows: [cells] }); continue;
      }
      (para ??= []).push(line);
    }
    flush();
    return out;
  }
  /** 行内：`code` / **粗体** / [链接](url) / 裸链接，其余原样 */
  function inline(text) {
    const runs = [], re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((?:[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) runs.push({ text: text.slice(last, m.index), style: "body" });
      if (m[1] !== undefined) runs.push({ text: m[1], style: "code" });
      else if (m[2] !== undefined) runs.push({ text: m[2].replace(/`/g, ""), style: "bold" });   // 粗体里的 `code` 只留字，不露反引号
      else runs.push({ text: m[3] ?? m[4], style: "link" });
      last = re.lastIndex;
    }
    if (last < text.length) runs.push({ text: text.slice(last), style: "body" });
    return runs.map((r) => ({ ...r, text: r.style === "body" ? r.text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2") : r.text }));
  }
  // 中日韩字符逐个成词（随处可断），其余按空白切词
  const TOKEN = /[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g;
  const NO_START = /^[，。、；：！？）」』”’》〉,.;:!?)\]}%…]/;
  /** 按宽度折行：中文逐字可断，西文按词断，词比整行还宽就逐字断；行首不放收尾标点 */
  function wrap(measure, runs, maxW) {
    const lines = []; let cur = [], curW = 0;
    const push = () => {
      while (cur.length && /^\s+$/.test(cur[cur.length - 1].text)) curW -= cur.pop().w;
      lines.push({ segs: cur, w: curW }); cur = []; curW = 0;
    };
    const add = (text, style, w) => { const last = cur[cur.length - 1]; if (last && last.style === style) { last.text += text; last.w += w; } else cur.push({ text, style, w }); curW += w; };
    for (const run of runs) {
      run.text.split("\n").forEach((part, n) => {
        if (n > 0) push();
        for (let tok of part.match(TOKEN) || []) {
          if (/^\s+$/.test(tok)) { if (!cur.length) continue; tok = " "; }
          const w = measure(tok, run.style);
          if (w > maxW) { for (const ch of tok) { const cw = measure(ch, run.style); if (curW + cw > maxW && cur.length) push(); add(ch, run.style, cw); } continue; }
          if (curW + w > maxW && cur.length && !NO_START.test(tok)) { push(); if (tok === " ") continue; }
          add(tok, run.style, w);
        }
      });
    }
    if (cur.length || !lines.length) push();
    return lines;
  }

  // ── 绘制：便签纸竖版（手机里刷着顺眼）。同一个 layout 跑两遍：第一遍只量高度，第二遍按量出的尺寸真画 ──
  const W = 390, SIDE = 30, CONTENT = W - SIDE * 2, FOOT_H = 56;
  const SANS = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
  const MONO = `"SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;
  const SERIF = `Georgia, "Times New Roman", "Songti SC", serif`;
  const BODY = 14.5, LH = 26;   // 正文字号 / 行高（约 1.8 倍，便签的松快感主要靠它）
  const FONTS = { body: `400 ${BODY}px ${SANS}`, bold: `600 ${BODY}px ${SANS}`, link: `400 ${BODY}px ${SANS}`, code: `500 12.5px ${MONO}`, mono: `400 11.5px ${MONO}` };
  const MAX_LINES = 80;   // 单条消息最多画这么多行，超出注明省略
  function roundRect(c, x, y, w, h, r) {
    const rr = typeof r === "number" ? [r, r, r, r] : r;
    c.beginPath(); c.moveTo(x + rr[0], y); c.lineTo(x + w - rr[1], y); c.quadraticCurveTo(x + w, y, x + w, y + rr[1]);
    c.lineTo(x + w, y + h - rr[2]); c.quadraticCurveTo(x + w, y + h, x + w - rr[2], y + h); c.lineTo(x + rr[3], y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - rr[3]); c.lineTo(x, y + rr[0]); c.quadraticCurveTo(x, y, x + rr[0], y); c.closePath();
  }
  function layout(c, opts, draw) {
    const th = THEMES[opts.theme] || THEMES.warm;
    const measure = (s, style) => { c.font = FONTS[style] || style; return c.measureText(s).width; };
    const text = (s, x, y, style, color) => { if (!draw) return; c.font = FONTS[style] || style; c.fillStyle = color; c.fillText(s, x, y); };
    const clean = (s) => (opts.redact ? redact(s) : String(s || ""));
    const left = SIDE;
    let y = 52;
    c.textBaseline = "middle";

    // 标题 + 一行小字（项目 · 引擎 · 日期）
    const title = clean(opts.title).trim(), tfont = `700 22px ${SANS}`;
    if (title) {
      for (const line of wrap((s) => measure(s, tfont), [{ text: title, style: tfont }], CONTENT).slice(0, 3)) { text(line.segs.map((s) => s.text).join(""), left, y + 15, tfont, th.heading); y += 31; }
      y += 4;
    }
    const sub = [clean(opts.project), opts.provider, opts.date].filter(Boolean).join("  ·  ");
    if (sub) { for (const line of wrap((s) => measure(s, `400 11.5px ${SANS}`), [{ text: sub, style: "s" }], CONTENT).slice(0, 2)) { text(line.segs.map((s) => s.text).join(""), left, y + 8, `400 11.5px ${SANS}`, th.muted); y += 18; } }
    y += 18;

    const drawLines = (lines, x, lh, color, max = Infinity) => {
      const shown = lines.slice(0, max);
      for (const line of shown) {
        let cx = x;
        for (const seg of line.segs) {
          if (draw && seg.style === "code") { roundRect(c, cx - 1.5, y + 4, seg.w + 3, lh - 8, 3); c.fillStyle = th.inline; c.fill(); }
          text(seg.text, cx, y + lh / 2, seg.style, seg.style === "link" ? th.accent : seg.style === "code" ? th.codeText : color);
          if (draw && seg.style === "link") { c.fillStyle = th.accent; c.globalAlpha = 0.35; c.fillRect(cx, y + lh / 2 + 9, seg.w, 1); c.globalAlpha = 1; }
          cx += seg.w;
        }
        y += lh;
      }
      return lines.length - shown.length;
    };
    const omittedNote = (n, x) => { if (n > 0) { text(isEn() ? `… ${n} more lines omitted` : `…以下省略 ${n} 行`, x, y + 10, `400 11.5px ${SANS}`, th.muted); y += 22; } };

    opts.messages.forEach((m, idx) => {
      if (idx) y += 14;
      const body = clean(m.text);
      if (m.role === "user") {
        // 提问画成引文：左上一个大引号，正文退格、颜色压一档——一眼分得清「问」和「答」
        text("“", left - 2, y + 14, `700 30px ${SERIF}`, th.quoteMark);
        const lines = wrap(measure, [{ text: body, style: "body" }], CONTENT - 20);
        const rest = drawLines(lines, left + 20, LH, th.quote, MAX_LINES); omittedNote(rest, left + 20);
        if (m.images) { text(isEn() ? `🖼 ${m.images} image(s)` : `🖼 ${m.images} 张图片`, left + 20, y + 10, `400 11.5px ${SANS}`, th.muted); y += 22; }
        y += 2;
        return;
      }
      let budget = MAX_LINES, cut = 0;
      for (const b of blocks(body)) {
        if (budget <= 0) { cut += b.type === "code" ? b.lines.length : 1; continue; }
        if (b.type === "h") {
          const size = b.level <= 1 ? 18 : b.level === 2 ? 16 : 15, font = `700 ${size}px ${SANS}`;
          const ls = wrap((s) => measure(s, font), [{ text: b.text.replace(/\*\*/g, ""), style: font }], CONTENT);
          y += 8; for (const l of ls) { text(l.segs.map((s) => s.text).join(""), left, y + size * 0.75, font, th.heading); y += size * 1.5; } y += 4; budget -= ls.length;
        } else if (b.type === "li") {
          const indent = 16 + b.indent * 16, ls = wrap(measure, inline(b.text), CONTENT - indent);
          if (b.mark === "•") { if (draw) { c.beginPath(); c.arc(left + indent - 9, y + LH / 2, 2.2, 0, Math.PI * 2); c.fillStyle = th.accent; c.fill(); } }
          else text(b.mark, left + indent - (b.mark.length > 1 ? 16 : 13), y + LH / 2, b.mark.length > 1 ? `600 13px ${SANS}` : FONTS.body, th.accent);
          cut += drawLines(ls, left + indent, LH, th.text, budget); budget -= ls.length; y += 2;
        } else if (b.type === "quote") {
          const ls = wrap(measure, inline(b.text), CONTENT - 16), top = y;
          cut += drawLines(ls, left + 16, LH, th.quote, budget); budget -= ls.length;
          if (draw) { c.fillStyle = th.quoteMark; c.fillRect(left + 2, top + 5, 2.5, y - top - 10); } y += 6;
        } else if (b.type === "code" || b.type === "table") {
          const raw = b.type === "code" ? b.lines : b.rows.map((r) => r.join("  │  "));
          const ls = wrap(measure, [{ text: raw.join("\n"), style: "mono" }], CONTENT - 28);
          const n = Math.min(ls.length, Math.max(1, budget)), h = n * 18.5 + 22 + (ls.length > n ? 20 : 0);
          y += 4; if (draw) { roundRect(c, left, y, CONTENT, h, 6); c.fillStyle = th.pre; c.fill(); }
          y += 11; const rest = drawLines(ls, left + 14, 18.5, th.preText, n);
          if (rest) { text(isEn() ? `… ${rest} more lines` : `…还有 ${rest} 行`, left + 14, y + 9, `400 11px ${SANS}`, th.muted); y += 20; }
          y += 19; budget -= n;
        } else if (b.type === "hr") {
          y += 10; if (draw) { c.fillStyle = th.rule; c.fillRect(left + CONTENT * 0.35, y, CONTENT * 0.3, 1); } y += 12;
        } else {
          const ls = wrap(measure, inline(b.text), CONTENT); cut += drawLines(ls, left, LH, th.text, budget); budget -= ls.length; y += 8;
        }
      }
      omittedNote(cut, left);
    });

    // 正文收尾；落款在框外的底带里
    y += 30;
    const frameBottom = y;
    const fy = y + FOOT_H / 2 + 2;
    if (draw) drawLogo(c, left - 4, fy - 8, 16);
    const made = isEn() ? "Made with Ownward" : "由 Ownward 生成";
    text(made, left + 18, fy, `500 11px ${SANS}`, th.foot);
    c.font = `500 11px ${SANS}`; const mw = c.measureText(made).width;
    text("github.com/whtis/ownward", left + 18 + mw + 10, fy, `400 9.5px ${MONO}`, th.foot + "aa");
    return { height: Math.ceil(frameBottom + FOOT_H), frameBottom };
  }
  function drawLogo(c, x, y, size) {
    const s = size / 64;
    c.save(); c.translate(x, y); c.scale(s, s);
    roundRect(c, 0, 0, 64, 64, 14); c.fillStyle = "#111720"; c.fill();
    c.beginPath(); c.moveTo(16, 44); c.lineTo(32, 16); c.lineTo(48, 44); c.strokeStyle = "#63a8ff"; c.lineWidth = 6.4; c.lineCap = "round"; c.lineJoin = "round"; c.stroke();
    c.beginPath(); c.arc(32, 36, 4.8, 0, Math.PI * 2); c.fillStyle = "#47c7f4"; c.fill();
    c.restore();
  }
  /** 纸面：底色 + 品牌光晕 + 极淡的纸纹噪点（固定种子，同一内容每次画出来一样） */
  function paper(c, th, h) {
    c.fillStyle = th.paper; c.fillRect(0, 0, W, h);
    for (const [gx, gy, r, col] of th.glows || []) {
      const g = c.createRadialGradient(gx * W, gy * h, 0, gx * W, gy * h, r * Math.max(W, Math.min(h, 900)));
      g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(0, 0, W, h);
    }
    if (th.grain) {
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const dark = /^#[0-3]/.test(th.paper);
      for (let k = 0, n = Math.round(W * h / 9); k < n; k++) { c.fillStyle = dark ? `rgba(255,255,255,${rnd() * th.grain})` : `rgba(90,60,30,${rnd() * th.grain})`; c.fillRect(rnd() * W, rnd() * h, 1, 1); }
    }
  }
  /** 双细框 + 四角小方块：便签纸的标志性边框 */
  function frame(c, th, bottom) {
    if (!th.frame) return;
    c.strokeStyle = th.frame; c.lineWidth = 0.75;
    c.strokeRect(10.5, 16.5, W - 21, bottom - 16.5);
    c.strokeRect(13.5, 19.5, W - 27, bottom - 22.5);
    for (const [x, y] of [[8, 14], [W - 13, 14], [8, bottom - 2], [W - 13, bottom - 2]]) { c.fillStyle = th.paper; c.fillRect(x, y, 5, 5); c.strokeRect(x + 0.5, y + 0.5, 4, 4); }
  }
  /** 画整张图：返回 canvas。3 倍清晰度；超过浏览器画布上限（Safari 约 1670 万像素）时自动降 */
  function render(opts) {
    const probe = document.createElement("canvas").getContext("2d");
    const { height, frameBottom } = layout(probe, opts, false);
    let scale = 3;
    while (scale > 1 && W * scale * height * scale > 16_000_000) scale -= 0.25;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * scale); canvas.height = Math.round(height * scale);
    const c = canvas.getContext("2d"); c.scale(scale, scale);
    const th = THEMES[opts.theme] || THEMES.warm;
    paper(c, th, height); frame(c, th, frameBottom);
    layout(c, opts, true);
    return canvas;
  }
  // ── 选择态 ──
  let observer = null, bar = null;
  const scroll = () => document.getElementById("tk-scroll");
  function decorate() {
    const sc = scroll(); if (!sc) return;
    sc.classList.toggle("share-mode", state.on);
    placeBar();
    for (const el of sc.querySelectorAll(".msg[data-share-i]")) {
      const p = state.on ? state.picked.get(Number(el.dataset.shareI)) : null;
      el.dataset.picked = p ? (p.partial ? "partial" : "true") : "false";
    }
  }
  function updateBar() {
    if (!bar) return;
    const n = state.picked.size;
    bar.querySelector(".share-count").textContent = n ? t(`已选 ${n} 条`) : t("点选消息，或划选其中一段文字");
    bar.querySelector(".share-go").disabled = !n;
    placeBar();
  }
  /** 浮条贴在会话区输入框上方、按会话区居中：压在输入框上会挡住发送键（手机上尤其） */
  function placeBar() {
    if (!bar) return;
    const box = document.getElementById("tk-detail")?.getBoundingClientRect(), composer = document.querySelector("#tk-detail .composer")?.getBoundingClientRect();
    if (box?.width) bar.style.left = `${box.left + box.width / 2}px`;
    bar.style.bottom = composer?.height ? `${Math.max(12, innerHeight - composer.top + 10)}px` : "";
  }
  addEventListener("resize", () => placeBar());
  function start(ctx) {
    stop();
    state.on = true; state.ctx = ctx; state.picked = new Map(); state.title = ctx.title || "";
    if (ctx.preset?.length) for (const f of ctx.preset) state.picked.set(f.i, whole(f, ctx));   // 从划选进来：只要划中的那几段
    else {
      // 默认选上最近一问一答：大多数时候想晒的就是这一段
      const list = ctx.indices || [];
      const lastA = [...list].reverse().find((x) => x.role === "assistant");
      const lastU = lastA ? [...list].reverse().find((x) => x.role === "user" && x.i < lastA.i) : [...list].reverse().find((x) => x.role === "user");
      for (const x of [lastU, lastA]) if (x) { const m = ctx.resolve(x.i); if (m) state.picked.set(x.i, m); }
    }
    bar = document.createElement("div");
    bar.className = "share-bar"; bar.setAttribute("role", "toolbar");
    bar.innerHTML = `<span class="share-count"></span>
      <button class="button sm ghost share-clear">全不选</button>
      <button class="button sm primary share-go">生成图片</button>
      <button class="button sm secondary share-cancel">取消</button>`;
    bar.querySelector(".share-clear").onclick = () => { state.picked.clear(); decorate(); updateBar(); };
    bar.querySelector(".share-go").onclick = () => openDialog();
    bar.querySelector(".share-cancel").onclick = () => stop();
    document.body.appendChild(bar);
    const host = document.getElementById("tk-detail");
    if (host) { observer = new MutationObserver(decorate); observer.observe(host, { childList: true }); }
    decorate(); updateBar();
    state.oneShot = !!ctx.open;   // 从划选直接进的预览：关掉就整个退出，不留选择态
    if (ctx.open) openDialog();
  }
  function stop() {
    if (!state.on) return;
    state.on = false; state.oneShot = false; state.done = false; state.picked.clear(); state.ctx = null;
    observer?.disconnect(); observer = null; bar?.remove(); bar = null;
    decorate();
  }
  // 捕获阶段拦：选择态下点消息只做勾选，不触发里面的链接/图片/展开
  document.addEventListener("click", (e) => {
    if (!state.on) return;
    const el = e.target.closest?.("#tk-scroll .msg[data-share-i]"); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    if (!getSelection()?.isCollapsed) return;   // 刚拖完一段划选：交给「加入所选」，不当成点选整条
    const i = Number(el.dataset.shareI);
    if (state.picked.has(i)) state.picked.delete(i);
    else { const m = state.ctx?.resolve(i); if (m) state.picked.set(i, m); }
    el.dataset.picked = String(state.picked.has(i)); updateBar();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.on && !document.getElementById("share-dialog")?.open) stop(); });

  // ── 划选分享：在消息里选中一段文字，旁边浮出「分享所选」，只分享选中的部分 ──
  /** 渲染后的 HTML 片段 → 精简 Markdown：保住标题/列表/代码/引用/粗体，图片与按钮丢掉 */
  function htmlToMd(node) {
    const kids = (n) => [...n.childNodes].map(walk).join("");
    function walk(n) {
      if (n.nodeType === 3) return n.nodeValue;
      if (n.nodeType !== 1 && n.nodeType !== 11) return "";
      if (n.nodeType === 11) return kids(n);
      const tag = n.tagName.toLowerCase();
      if (/^(img|button|svg|script|style|input|textarea)$/.test(tag)) return "";
      if (tag === "br") return "\n";
      if (tag === "pre") return `\n\`\`\`\n${n.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
      if (tag === "code") return `\`${n.textContent}\``;
      if (tag === "strong" || tag === "b") return `**${kids(n)}**`;
      if (/^h[1-6]$/.test(tag)) return `\n${"#".repeat(Number(tag[1]))} ${kids(n).trim()}\n\n`;
      if (tag === "li") return `${n.parentElement?.tagName === "OL" ? "1." : "-"} ${kids(n).trim()}\n`;
      if (tag === "ul" || tag === "ol") return `\n${kids(n)}\n`;
      if (tag === "blockquote") return kids(n).trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
      if (tag === "tr") return `| ${[...n.children].map((c) => kids(c).trim()).join(" | ")} |\n`;
      if (tag === "p" || tag === "div" || tag === "table") return `${kids(n)}\n\n`;
      return kids(n);
    }
    return walk(node).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  /** 当前划选落在哪几条可分享消息里，各取消息正文里被选中的那段 */
  function fragments() {
    const sel = getSelection(), sc = scroll();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sc) return null;
    const range = sel.getRangeAt(0);
    if (!sc.contains(range.commonAncestorContainer)) return null;
    const out = [];
    for (const el of sc.querySelectorAll(".msg[data-share-i]")) {
      const bubble = el.querySelector(".bubble");
      if (!bubble || !range.intersectsNode(bubble)) continue;
      const r = document.createRange(); r.selectNodeContents(bubble);
      let partial = false;
      if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) { r.setStart(range.startContainer, range.startOffset); partial = true; }
      if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) { r.setEnd(range.endContainer, range.endOffset); partial = true; }
      // 整段落在一个代码块里时，克隆出的片段没有 <pre> 外壳，会被当成普通段落——补回代码块
      const pre = r.commonAncestorContainer.parentElement?.closest?.("pre") || (r.commonAncestorContainer.nodeName === "PRE" ? r.commonAncestorContainer : null);
      const text = el.dataset.role === "user" ? r.toString().trim() : pre && bubble.contains(pre) ? `\`\`\`\n${r.toString().replace(/\n$/, "")}\n\`\`\`` : htmlToMd(r.cloneContents());
      if (text) out.push({ i: Number(el.dataset.shareI), role: el.dataset.role === "user" ? "user" : "assistant", text, partial });
    }
    return out.length ? out : null;
  }
  /** 整条都被划中时换回原始 Markdown（比从渲染结果反推的更准）；只划中一段才用片段 */
  const whole = (f, ctx) => (!f.partial && ctx?.resolve(f.i)) || f;
  let selBtn = null, selTimer = 0;
  function hideSelBtn() { selBtn?.remove(); selBtn = null; }
  function showSelBtn() {
    const frags = fragments();
    if (!frags || document.getElementById("share-dialog")?.open) return hideSelBtn();
    const range = getSelection().getRangeAt(0), rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();   // 选区结尾那一行
    if (!selBtn) {
      selBtn = document.createElement("button");
      selBtn.className = "button sm primary share-sel-btn";
      // mousedown 时就记下片段并拦默认行为：点按钮本身不能把划选清掉
      selBtn.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.appendChild(selBtn);
    }
    selBtn.textContent = state.on ? t("加入所选") : t("分享所选");
    selBtn.onclick = () => {
      const now = fragments() || frags;
      hideSelBtn(); getSelection()?.removeAllRanges();
      if (state.on) { for (const f of now) state.picked.set(f.i, whole(f, state.ctx)); decorate(); updateBar(); }
      else if (typeof window.tkShareStart === "function") window.tkShareStart({ preset: now, open: true });
    };
    // 贴着选区的结尾放；选区很长、结尾滚出了视野时，卡在会话区的上下沿，别跑到顶栏上去
    const box = scroll().getBoundingClientRect(), w = selBtn.offsetWidth || 120;
    let top = rect.bottom + 8;
    if (top + 34 > box.bottom) top = rect.top - 42;
    selBtn.style.top = `${Math.min(Math.max(top, box.top + 8), box.bottom - 42)}px`;
    selBtn.style.left = `${Math.min(box.right - w - 8, Math.max(box.left + 8, rect.right - w / 2))}px`;
  }
  // selectionchange 同时覆盖鼠标拖选与手机长按选字；防抖，等手指/鼠标停稳再出按钮
  document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(showSelBtn, 250); });
  // 滚动时跟着划选挪位置，别藏起来：手机长按选字后页面常会轻微滚一下，藏了就再也点不到
  let selRaf = 0;
  document.addEventListener("scroll", () => { if (!selBtn || selRaf) return; selRaf = requestAnimationFrame(() => { selRaf = 0; showSelBtn(); }); }, true);

  // ── 预览弹窗 ──
  function cardOpts() {
    const ctx = state.ctx || {};
    const messages = [...state.picked.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text || "", images: (m.images || []).length }));
    const d = new Date();
    return {
      theme: state.theme, redact: state.redact, title: state.title, project: ctx.project || "", provider: ctx.provider || "", agentName: ctx.agentName || "Agent",
      date: d.toLocaleDateString(isEn() ? "en-US" : "zh-CN", { year: "numeric", month: "short", day: "numeric" }), messages,
    };
  }
  function dialogEl() {
    let dlg = document.getElementById("share-dialog");
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "share-dialog"; dlg.className = "control-dialog share-dialog"; dlg.setAttribute("aria-label", "分享图片");
    dlg.innerHTML = `<div>
      <div class="share-dialog-head"><h2>分享图片</h2><button class="button sm ghost" data-act="close" aria-label="关闭">✕</button></div>
      <div class="share-layout">
        <div class="share-preview"><img alt="分享图片预览"></div>
        <div class="share-side">
          <label class="share-field"><span>标题</span><input type="text" data-act="title" maxlength="120" placeholder="给这张图起个标题（可留空）"></label>
          <div class="share-field"><span>风格</span><div class="share-themes">${Object.entries(THEMES).map(([k, v]) =>
            `<button class="share-theme" data-theme="${k}" title="${v.label}" style="background:${v.paper};color:${v.accent}">Aa</button>`).join("")}</div></div>
          <label class="share-check"><input type="checkbox" data-act="redact"> 隐去本机路径和密钥</label>
          <p class="modal-note">图片只在本机生成，不会上传。</p>
          <div class="share-actions">
            <button class="button primary" data-act="copy">复制图片</button>
            <button class="button secondary" data-act="download">下载 PNG</button>
            <button class="button secondary" data-act="share" hidden>分享…</button>
          </div>
        </div>
      </div></div>`;
    document.body.appendChild(dlg);
    const q = (s) => dlg.querySelector(s);
    // 关预览：划选进来的、或已经复制/下载/分享过的，整个退出选择态；只是看看就关的，留在选择态接着挑。
    // ✕ 和点背景直接收尾，不等异步的 close 事件；close 事件只兜 Esc（stop 本身幂等）
    const afterClose = () => { if (state.oneShot || state.done) stop(); };
    const closeDialog = () => { dlg.close(); afterClose(); };
    q('[data-act="close"]').onclick = closeDialog;
    dlg.addEventListener("close", afterClose);
    let timer = 0;
    q('[data-act="title"]').oninput = (e) => { state.title = e.target.value; clearTimeout(timer); timer = setTimeout(refresh, 250); };
    q('[data-act="redact"]').onchange = (e) => { state.redact = e.target.checked; refresh(); };
    for (const b of dlg.querySelectorAll(".share-theme")) b.onclick = () => { state.theme = b.dataset.theme; try { localStorage.setItem("ownward-share-theme", state.theme); } catch {} refresh(); };
    q('[data-act="copy"]').onclick = copy;
    q('[data-act="download"]').onclick = download;
    q('[data-act="share"]').onclick = shareNative;
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(); });
    return dlg;
  }
  async function refresh() {
    const dlg = dialogEl(), seq = ++state.seq;
    for (const b of dlg.querySelectorAll(".share-theme")) b.dataset.on = String(b.dataset.theme === state.theme);
    const canvas = render(cardOpts());
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (seq !== state.seq || !blob) return;
    if (state.url) URL.revokeObjectURL(state.url);
    state.blob = blob; state.url = URL.createObjectURL(blob);
    dlg.querySelector(".share-preview img").src = state.url;
    const file = new File([blob], fileName(), { type: "image/png" });
    dlg.querySelector('[data-act="share"]').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  }
  function openDialog() {
    if (!state.picked.size) return;
    if (!THEMES[state.theme]) state.theme = "warm";   // 旧版存下的主题名已不存在
    const dlg = dialogEl();
    state.done = false;
    dlg.querySelector('[data-act="title"]').value = state.title;
    dlg.querySelector('[data-act="redact"]').checked = state.redact;
    if (!dlg.open) dlg.showModal();
    refresh();
  }
  const fileName = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `ownward-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`; };
  async function copy() {
    if (!state.blob) return;
    try {
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("unsupported");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": state.blob })]);
      toast(t("图片已复制，可直接粘贴")); state.done = true;
    } catch { toast(t(isSecureContext ? "浏览器没让复制图片，请用「下载 PNG」" : "浏览器不让复制图片（远程访问需 HTTPS），请用「下载 PNG」")); }
  }
  function download() {
    if (!state.url) return;
    const a = document.createElement("a"); a.href = state.url; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
    state.done = true;
  }
  async function shareNative() {
    if (!state.blob) return;
    try { await navigator.share({ files: [new File([state.blob], fileName(), { type: "image/png" })], title: state.title || "Ownward" }); state.done = true; }
    catch (e) { if (e?.name !== "AbortError") toast(t("系统分享失败，请用「下载 PNG」")); }
  }

  return { start, stop, get on() { return state.on; }, render, _test: { redact, blocks, inline, wrap, htmlToMd, fragments } };
})();
