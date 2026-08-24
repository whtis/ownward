import { homedir } from "os";
import { join } from "path";

const quote=(value:string)=>`'${value.replaceAll("'",`'\"'\"'`)}'`;

export function expandCodexHome(value:string):string {
  return value==="codex"?join(homedir(),".codex"):value==="codex-alt"?join(homedir(),".codex-alt"):value;
}

export function buildCodexResumeCommand(cwd:string,nativeRef:string,home="codex"):string{const expanded=expandCodexHome(home),defaultHome=join(homedir(),".codex"),altHome=join(homedir(),".codex-alt"),env=expanded===defaultHome?"":expanded===altHome?'CODEX_HOME="$HOME/.codex-alt" ':`CODEX_HOME=${quote(expanded)} `;return `cd ${quote(cwd)} && ${env}codex resume ${quote(nativeRef)}`;}
