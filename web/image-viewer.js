"use strict";

/** 任务会话图片只能来自 daemon 自己的只读图片仓，禁止外链/data/blob 混进高权限页面。 */
function safeTaskImageUrl(value) {
  const url = String(value || "").trim();
  const agent = /^\/api\/agent-image\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[a-f0-9]{16}\.(png|jpg|webp|gif)$/;
  const session = /^\/api\/session-image\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[a-f0-9]{64}$/;
  return agent.test(url) || session.test(url) ? url : "";
}

/** 对话历史图片走受控读取接口；blob 仅用于刚发送、尚未落盘的本地预览。 */
function safeChatImageUrl(value) {
  const url = String(value || "").trim();
  if (url.startsWith("blob:")) return url;
  if (!url.startsWith("/api/chat/image?")) return "";
  try {
    const parsed = new URL(url, location.origin);
    return parsed.origin === location.origin && parsed.pathname === "/api/chat/image"
      && parsed.searchParams.has("chat_id") && parsed.searchParams.has("id") ? url : "";
  } catch { return ""; }
}

function imageThumbsHtml(urls, sanitizer, alt = "图片附件") {
  const safe = (urls || []).map(sanitizer).filter(Boolean);
  if (!safe.length) return "";
  return `<div class="msg-imgs">${safe.map((url) => {
    const src = esc(url);
    return `<button class="msg-img" type="button" data-image-viewer="${src}" aria-label="查看${esc(alt)}"><img src="${src}" alt="${esc(alt)}" loading="lazy" onerror="imageThumbFailed(this)"></button>`;
  }).join("")}</div>`;
}

function imageThumbFailed(img) {
  const button = img.closest(".msg-img");
  if (!button) return;
  button.classList.add("is-error");
  button.removeAttribute("data-image-viewer");
  button.disabled = true;
  button.setAttribute("aria-label", "图片加载失败");
  img.remove();
  button.textContent = "图片加载失败";
}

const ImageViewer = (() => {
  let urls = [], index = 0, returnFocus = null;
  let overlay, image, counter, error, prev, next;

  function paint() {
    const src = urls[index];
    error.hidden = true;
    image.hidden = false;
    image.alt = `图片 ${index + 1}，共 ${urls.length} 张`;
    image.src = src;
    counter.textContent = `${index + 1} / ${urls.length}`;
    prev.hidden = next.hidden = urls.length < 2;
  }

  function move(delta) {
    if (urls.length < 2) return;
    index = (index + delta + urls.length) % urls.length;
    paint();
  }

  function close() {
    if (!overlay?.dataset.open) return;
    overlay.dataset.open = "";
    image.removeAttribute("src");
    const focus = returnFocus;
    returnFocus = null;
    focus?.focus?.();
  }

  function open(button) {
    const group = button.closest(".msg-imgs") || button.parentElement;
    const buttons = [...group.querySelectorAll("[data-image-viewer]")];
    urls = buttons.map((item) => item.dataset.imageViewer).filter(Boolean);
    index = Math.max(0, buttons.indexOf(button));
    returnFocus = button;
    overlay.dataset.open = "true";
    paint();
    overlay.querySelector(".image-viewer-close").focus();
  }

  function init() {
    document.body.insertAdjacentHTML("beforeend", `<div class="image-viewer" id="image-viewer" role="dialog" aria-modal="true" aria-label="图片查看器">
      <div class="image-viewer-bar"><span class="image-viewer-counter" aria-live="polite"></span><button class="image-viewer-close" type="button" aria-label="关闭图片查看器">✕</button></div>
      <button class="image-viewer-nav image-viewer-prev" type="button" aria-label="上一张">‹</button>
      <div class="image-viewer-stage"><img alt=""><p class="image-viewer-error" role="status" hidden>图片加载失败</p></div>
      <button class="image-viewer-nav image-viewer-next" type="button" aria-label="下一张">›</button>
    </div>`);
    overlay = document.getElementById("image-viewer");
    image = overlay.querySelector("img");
    counter = overlay.querySelector(".image-viewer-counter");
    error = overlay.querySelector(".image-viewer-error");
    prev = overlay.querySelector(".image-viewer-prev");
    next = overlay.querySelector(".image-viewer-next");
    overlay.querySelector(".image-viewer-close").addEventListener("click", close);
    prev.addEventListener("click", () => move(-1));
    next.addEventListener("click", () => move(1));
    image.addEventListener("error", () => { image.hidden = true; error.hidden = false; });
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-image-viewer]");
      if (button) open(button);
    });
    document.addEventListener("keydown", (event) => {
      if (overlay.dataset.open !== "true") return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
      else if (event.key === "Tab") {
        const controls = [...overlay.querySelectorAll("button:not([hidden])")];
        if (!controls.length) return;
        const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
        if (document.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
        }
      }
    });
  }

  return { init, close };
})();
