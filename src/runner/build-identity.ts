import { resolve, relative } from "path";
import { readFileSync } from "fs";

export async function runnerBuildIdentity(root = process.cwd()): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256"), files: string[] = [];
  const glob = new Bun.Glob("**/*.ts");
  for await (const file of glob.scan({ cwd: resolve(root, "src"), absolute: true })) {
    // 路径分隔符在 Windows 上是 \，硬编码 "/testing/" 匹配不上，fixture 会被当成生产源码
    // 算进构建指纹——改一个 fake CLI 就会让 Runner identity 变化。仓库其它地方用的也是这个写法。
    if (file.endsWith(".test.ts") || file.split(/[\\/]/).includes("testing")) continue;
    files.push(file);
  }
  files.sort();
  for (const file of files) { hasher.update(relative(root, file)); hasher.update("\0"); hasher.update(await Bun.file(file).arrayBuffer()); hasher.update("\0"); }
  // Provider config is part of Runner behavior. Hash only that subtree so an
  // unrelated dashboard preference does not restart a live Runner.
  let providers:Record<string,unknown>={};for(const name of["config.default.json","config.json"]){try{const value=JSON.parse(readFileSync(resolve(root,name),"utf8"));if(value?.providers&&typeof value.providers==="object"&&!Array.isArray(value.providers))providers={...providers,...value.providers};}catch{}}
  hasher.update("providers-config\0");hasher.update(JSON.stringify(Object.fromEntries(Object.entries(providers).sort(([a],[b])=>a.localeCompare(b)))));hasher.update("\0");
  return hasher.digest("hex");
}

if (import.meta.main) console.log(await runnerBuildIdentity(resolve(process.argv[2] || process.cwd())));
