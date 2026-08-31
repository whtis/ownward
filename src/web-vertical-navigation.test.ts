import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "..", "web", "vertical-navigation.js"), "utf8");
const html = readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "vertical-navigation.css"), "utf8");

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = "";
  href = "";
  textContent = "";
  title = "";
  constructor(readonly tagName: string) {}
  append(...children: FakeElement[]) { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

function harness(fetchImpl: (input: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>) {
  const desktop = new FakeElement("span"), mobile = new FakeElement("span"), main = new FakeElement("main");
  const sentinel = new FakeElement("section"); main.append(sentinel);
  const nodes: Record<string, FakeElement> = { "vertical-nav-desktop": desktop, "vertical-nav-mobile": mobile, main };
  const document = {
    getElementById: (id: string) => nodes[id] ?? null,
    createElement: (tag: string) => new FakeElement(tag),
  };
  const api = Function("document", "fetch", "location", `return ${source}`)(
    document,
    fetchImpl,
    { origin: "http://ownward.local" },
  ) as {
    normalizeNavigation(value: unknown): Array<Record<string, string>>;
    renderNavigation(items: Array<Record<string, string>>): void;
    loadNavigation(): Promise<void>;
  };
  return { api, desktop, mobile, main, sentinel };
}

const pendingFetch = () => new Promise<never>(() => {});

describe("generic external Vertical navigation UI", () => {
  test("renders hostile-looking labels only through textContent in distinct desktop/mobile links", () => {
    const { api, desktop, mobile } = harness(pendingFetch);
    const label = '<img src=x onerror="globalThis.pwned=1">';
    const items = api.normalizeNavigation([
      { verticalId: "content-studio", id: "content-studio", label, href: "/verticals/content-studio/index.html", state: "ready" },
    ]);
    api.renderNavigation(items);
    for (const container of [desktop, mobile]) {
      expect(container.children).toHaveLength(1);
      expect(container.children[0]).toMatchObject({ tagName: "a", textContent: label, href: "/verticals/content-studio/index.html" });
      expect(container.children[0]?.attributes["aria-label"]).toBe(label);
    }
    expect(source).toContain('document.createElement("a")');
    expect(source).toContain("link.textContent = item.label");
    expect(source).not.toContain("innerHTML");
  });

  test("client validation rejects malicious hrefs/states and removes duplicate ids or hrefs", () => {
    const { api } = harness(pendingFetch);
    const good = { verticalId: "content-studio", id: "content-studio", label: "内容工作室", href: "/verticals/content-studio/index.html", state: "degraded" };
    expect(api.normalizeNavigation([
      good,
      { ...good, label: "duplicate" },
      { ...good, id: "other", label: "same href" },
      { ...good, id: "cross", href: "/verticals/other/index.html" },
      { ...good, id: "traversal", href: "/verticals/content-studio/../secret" },
      { ...good, id: "encoded", href: "/verticals/content-studio/%2e%2e/secret" },
      { ...good, id: "failed", state: "failed" },
    ])).toEqual([good]);
  });

  test("API failure clears only enhancement containers and leaves the main UI untouched", async () => {
    const shell = harness(async () => { throw new Error("offline"); });
    shell.desktop.append(new FakeElement("old"));
    shell.mobile.append(new FakeElement("old"));
    await shell.api.loadNavigation();
    expect(shell.desktop.children).toEqual([]);
    expect(shell.mobile.children).toEqual([]);
    expect(shell.main.children).toEqual([shell.sentinel]);
  });

  test("successful API data appears once in both desktop and mobile entry points", async () => {
    const navigation = [
      { verticalId: "content-studio", id: "content-studio", label: "内容工作室", href: "/verticals/content-studio/index.html", state: "ready" },
      { verticalId: "content-studio", id: "content-studio", label: "重复", href: "/verticals/content-studio/other.html", state: "ready" },
    ];
    const shell = harness(async () => ({ ok: true, json: async () => ({ navigation }) }));
    await shell.api.loadNavigation();
    expect(shell.desktop.children.map((entry) => entry.textContent)).toEqual(["内容工作室"]);
    expect(shell.mobile.children.map((entry) => entry.textContent)).toEqual(["内容工作室"]);
  });

  test("the shell loads dedicated assets and gives mobile navigation its own responsive surface", () => {
    expect(html).toContain('id="vertical-nav-desktop"');
    expect(html).toContain('id="vertical-nav-mobile"');
    expect(html).toContain('<link rel="stylesheet" href="/vertical-navigation.css">');
    expect(html).toContain('<script src="/vertical-navigation.js"></script>');
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain(".vertical-nav-desktop { display: none; }");
    expect(css).toContain(".topbar-menu a.mobile-menu-item { display: flex; }");
  });
});
