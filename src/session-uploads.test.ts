import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const run = async (root: string, body: string) => {
  const mod = JSON.stringify(join(import.meta.dir, "session-uploads.ts"));
  const proc = Bun.spawn([process.execPath, "--eval", `const U=await import(${mod});${body}`],
    { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};
const fresh = () => mkdtempSync(join(tmpdir(), "ownward-uploads-"));

test("scope 越界一律拒绝：路径穿越、分隔符、空名都进不了 uploads/ 之外", async () => {
  const root = fresh();
  try {
    const r = await run(root, `const bad=["..","../../etc","a/b","a\\\\b","",".","draft-xxx/../../x"," "];` +
      `console.log(JSON.stringify(bad.map(s=>{try{U.uploadScopeDir(s);return"ACCEPTED:"+s}catch(e){return e.code}})))`);
    expect(r.code, r.err).toBe(0);
    const codes = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(codes.every((c: string) => c === "UPLOAD_SCOPE_INVALID")).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("文件名归一：去目录成分与控制字符、压前导点、限长，同名不覆盖", async () => {
  const root = fresh();
  try {
    const r = await run(root, `const n=U.sanitizeUploadName;` +
      `const out={traverse:n("../../etc/passwd"),win:n("C:\\\\tmp\\\\a.pdf"),dots:n("....hidden.txt"),` +
      `ctrl:n("a\\u0000b\\u001fc.txt"),empty:n("   "),long:n("x".repeat(200)+".pdf")};` +
      `const a=U.stageUpload("t1","dup.txt",Buffer.from("one"));const b=U.stageUpload("t1","dup.txt",Buffer.from("two"));` +
      `out.first=a.name;out.second=b.name;out.list=U.listUploads("t1").map(f=>f.name);` +
      `console.log(JSON.stringify(out))`);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(o.traverse).toBe("passwd");
    expect(o.win).toBe("a.pdf");
    expect(o.dots).toBe("hidden.txt");
    expect(o.ctrl).toBe("abc.txt");
    expect(o.empty).toBe("upload");
    expect(o.long.length).toBeLessThanOrEqual(120);
    expect(o.long.endsWith(".pdf")).toBeTrue();
    expect(o.first).toBe("dup.txt");
    expect(o.second).toBe("dup (2).txt");   // 两份都在，不互相覆盖
    expect(o.list).toEqual(["dup (2).txt", "dup.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("配额：单文件、件数、合计三道闸各自报自己的码", async () => {
  const root = fresh();
  try {
    const r = await run(root, `const grab=(f)=>{try{f();return"OK"}catch(e){return e.code}};` +
      `const out={};` +
      `out.empty=grab(()=>U.stageUpload("t","a.txt",Buffer.alloc(0)));` +
      `out.tooBig=grab(()=>U.stageUpload("t","a.bin",Buffer.alloc(U.UPLOAD_MAX_BYTES+1)));` +
      `for(let i=0;i<U.UPLOAD_MAX_FILES;i++)U.stageUpload("many","f"+i+".txt",Buffer.from("x"));` +
      `out.tooMany=grab(()=>U.stageUpload("many","over.txt",Buffer.from("x")));` +
      `console.log(JSON.stringify(out))`);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(o.empty).toBe("UPLOAD_EMPTY");
    expect(o.tooBig).toBe("UPLOAD_TOO_LARGE");
    expect(o.tooMany).toBe("UPLOAD_TOO_MANY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("派发落定：draft- 改名成 sent-，正文路径指向落定后的目录（不是失效的草稿路径）", async () => {
  const root = fresh();
  try {
    const draft = "draft-" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12);
    const r = await run(root, `const d=${JSON.stringify(draft)};` +
      `U.stageUpload(d,"需求.pdf",Buffer.alloc(1536*1024));` +
      `const sealed=U.sealUploadScope(d);` +
      `const trailer=U.uploadTrailer(sealed.files);` +
      `console.log(JSON.stringify({scope:sealed.scope,trailer,draftGone:U.listUploads(d).length,emptyTrailer:U.uploadTrailer([])}))`);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(o.scope.startsWith("sent-")).toBeTrue();
    expect(o.trailer).toContain("[附件]");
    expect(o.trailer).toContain("需求.pdf (1.5MB)");
    expect(o.trailer).toContain(join(root, "uploads", o.scope));   // 绝对路径，且指向落定后的目录
    expect(o.trailer).not.toContain(draft);                        // 正文里绝不能留草稿路径
    expect(o.draftGone).toBe(0);
    expect(o.emptyTrailer).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("会话落定：草稿文件搬进 uploads/<taskId>/，每条消息只带自己那批，同名不覆盖", async () => {
  const root = fresh();
  try {
    const d1 = "draft-" + "1".repeat(8) + "-1111-1111-1111-" + "1".repeat(12);
    const d2 = "draft-" + "2".repeat(8) + "-2222-2222-2222-" + "2".repeat(12);
    const r = await run(root, `const a=${JSON.stringify(d1)},b=${JSON.stringify(d2)},task="20260917-zzzz";` +
      `U.stageUpload(a,"spec.md",Buffer.from("one"));` +
      `const first=U.mergeUploadScope(a,task);` +
      // 第二条消息：另一个草稿 scope，同名文件
      `U.stageUpload(b,"spec.md",Buffer.from("two"));` +
      `const second=U.mergeUploadScope(b,task);` +
      `console.log(JSON.stringify({firstScope:first.scope,firstNames:first.files.map(f=>f.name),` +
      `secondNames:second.files.map(f=>f.name),allInTask:U.listUploads(task).map(f=>f.name),` +
      `draftsGone:[U.listUploads(a).length,U.listUploads(b).length]}))`);
    expect(r.code, r.err).toBe(0);
    const o = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(o.firstScope).toBe("20260917-zzzz");
    expect(o.firstNames).toEqual(["spec.md"]);
    // 关键：第二条消息只带自己那一份，不把第一条的再列一遍
    expect(o.secondNames).toEqual(["spec (2).md"]);
    expect(o.allInTask).toEqual(["spec (2).md", "spec.md"]);       // 两份都留着，agent 还能回头读
    expect(o.draftsGone).toEqual([0, 0]);                          // 草稿目录已清
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sweep 只收过期草稿，不碰已提升的任务目录", async () => {
  const root = fresh();
  try {
    const uploads = join(root, "uploads");
    mkdirSync(join(uploads, "draft-" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12)), { recursive: true });
    mkdirSync(join(uploads, "20260917-live"), { recursive: true });
    writeFileSync(join(uploads, "20260917-live", "keep.txt"), "x");
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(join(uploads, "draft-" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12)), old, old);
    const r = await run(root, `console.log(JSON.stringify({removed:U.sweepUploads()}))`);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out.trim().split("\n").at(-1)!).removed).toBe(1);
    expect(existsSync(join(uploads, "20260917-live", "keep.txt"))).toBeTrue();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("/api/uploads 端点：传→列→删闭环，越界 scope 与超限各自报码", async () => {
  const root = fresh();
  try {
    const wb = JSON.stringify(join(import.meta.dir, "workbench.ts"));
    const mod = JSON.stringify(join(import.meta.dir, "session-uploads.ts"));
    const script = `const{handleWorkbench}=await import(${wb});const U=await import(${mod});` +
      `const call=async(path,init)=>{const u=new URL("http://localhost"+path);` +
      `const r=await handleWorkbench(new Request(u,init),u);return{status:r.status,body:await r.json()}};` +
      `const d="draft-"+"3".repeat(8)+"-3333-3333-3333-"+"3".repeat(12);` +
      `const out={};` +
      `out.up=await call("/api/uploads?scope="+d+"&name="+encodeURIComponent("../../etc/passwd"),` +
      `{method:"POST",body:Buffer.from("hello")});` +
      `out.list=await call("/api/uploads?scope="+d);` +
      `out.badScope=await call("/api/uploads?scope="+encodeURIComponent("../escape"));` +
      `out.tooBig=await call("/api/uploads?scope="+d+"&name=big.bin",` +
      `{method:"POST",body:Buffer.alloc(U.UPLOAD_MAX_BYTES+1),headers:{"content-length":String(U.UPLOAD_MAX_BYTES+1)}});` +
      `out.rm=await call("/api/uploads/remove",{method:"POST",headers:{"content-type":"application/json"},` +
      `body:JSON.stringify({scope:d,name:"passwd"})});` +
      `out.after=await call("/api/uploads?scope="+d);` +
      `console.log(JSON.stringify(out));`;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir, env: { ...process.env, OWNWARD_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const o = JSON.parse(out.trim().split("\n").at(-1)!);
    // 目录成分被剥干净才落盘：传 ../../etc/passwd 只会得到 passwd
    expect(o.up.body).toMatchObject({ ok: true, name: "passwd", bytes: 5 });
    expect(o.list.body.files).toEqual([{ name: "passwd", bytes: 5 }]);
    expect(o.badScope.status).toBe(400);
    expect(o.badScope.body.errorCode).toBe("UPLOAD_SCOPE_INVALID");
    expect(o.tooBig.status).toBe(413);
    expect(o.rm.body.ok).toBeTrue();
    expect(o.after.body.files).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
