(() => {
  "use strict";

  const ID = /^[a-z][a-z0-9-]{0,63}$/;

  function safeHref(verticalId, value) {
    if (!ID.test(verticalId) || typeof value !== "string" || value.length > 512 || value.includes("%") || value.includes("\\") || /[?#\u0000-\u001f\u007f]/.test(value)) return "";
    const prefix = `/verticals/${verticalId}/`;
    if (!value.startsWith(prefix)) return "";
    const suffix = value.slice(prefix.length);
    if (!suffix || !/^[A-Za-z0-9._~/-]+$/.test(suffix) || suffix.split("/").some((part) => !part || part === "." || part === "..")) return "";
    try {
      const parsed = new URL(value, location.origin);
      return parsed.origin === location.origin && parsed.pathname === value && !parsed.search && !parsed.hash ? value : "";
    } catch { return ""; }
  }

  function normalizeNavigation(value) {
    if (!Array.isArray(value)) return [];
    const seenEntries = new Set(), seenHrefs = new Set(), result = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const verticalId = typeof item.verticalId === "string" ? item.verticalId : "";
      const id = typeof item.id === "string" ? item.id : "";
      const label = typeof item.label === "string" ? item.label.trim() : "";
      const href = safeHref(verticalId, item.href);
      const state = item.state;
      const key = `${verticalId}:${id}`;
      if (!ID.test(verticalId) || !ID.test(id) || !label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label) || !href || !["ready", "degraded"].includes(state) || seenEntries.has(key) || seenHrefs.has(href)) continue;
      seenEntries.add(key); seenHrefs.add(href);
      result.push({ verticalId, id, label, href, state });
    }
    return result;
  }

  function linkFor(item, mobile) {
    const link = document.createElement("a");
    link.className = mobile ? "mobile-menu-item external-vertical-link" : "nav-tab external-vertical-link";
    link.href = item.href;
    link.textContent = item.label;
    link.dataset.verticalId = item.verticalId;
    link.dataset.state = item.state;
    link.title = item.state === "degraded" ? `${item.label}（降级运行）` : item.label;
    link.setAttribute("aria-label", link.title);
    return link;
  }

  function renderNavigation(items) {
    const desktop = document.getElementById("vertical-nav-desktop");
    const mobile = document.getElementById("vertical-nav-mobile");
    if (!desktop || !mobile) return;
    desktop.replaceChildren();
    mobile.replaceChildren();
    for (const item of items) {
      desktop.append(linkFor(item, false));
      mobile.append(linkFor(item, true));
    }
  }

  async function loadNavigation() {
    try {
      const response = await fetch("/api/system/verticals", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("vertical diagnostics unavailable");
      const payload = await response.json();
      renderNavigation(normalizeNavigation(payload && payload.navigation));
    } catch {
      // 扩展入口是增强项。诊断 API 或某个 Vertical 失败时清空入口，不影响主工作台启动。
      try { renderNavigation([]); } catch { /* DOM 壳不完整时也静默降级 */ }
    }
  }

  const api = Object.freeze({ normalizeNavigation, renderNavigation, loadNavigation });
  void loadNavigation();
  return api;
})();
