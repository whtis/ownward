import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA } from "./util.ts";

/** 界面语言（zh | en）的服务端副本：选择本身存在浏览器 localStorage，网页每次加载 / 切换时报上来。
 *  任务标题这类服务端生成的内容按它出语言——生成时没有浏览器在场，只能认「最近一次用的界面语言」。 */
export type UiLang = "zh" | "en";

const FILE = () => join(DATA, "ui-lang.json");

export function readUiLang(): UiLang {
  try { return JSON.parse(readFileSync(FILE(), "utf8"))?.lang === "en" ? "en" : "zh"; } catch { return "zh"; }
}

export function writeUiLang(lang: UiLang): void {
  if (readUiLang() === lang) return;   // 每次页面加载都会报，不变就不写盘
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lang }) + "\n");
  renameSync(tmp, FILE());
}
