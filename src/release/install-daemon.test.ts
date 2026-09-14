import{expect,test}from"bun:test";import{chmodSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync}from"fs";import{tmpdir}from"os";import{join}from"path";
test("daemon bootstrap failure restores the exact old plist",async()=>{const source=join(import.meta.dir,"../.."),root=mkdtempSync(join(tmpdir(),"daemon-install-")),home=join(root,"home"),bin=join(root,"bin");mkdirSync(join(root,"launchd"),{recursive:true});mkdirSync(join(root,"src/runner"),{recursive:true});mkdirSync(join(root,"src/kernel/sessions"),{recursive:true});mkdirSync(join(home,"Library/LaunchAgents"),{recursive:true});mkdirSync(bin);for(const f of["launchd/install.sh","launchd/ownward.plist.template"])writeFileSync(join(root,f),readFileSync(join(source,f)));const plist=join(home,"Library/LaunchAgents/ai.ownward.daemon.plist");writeFileSync(plist,"OLD\n");const tool=(name:string,body:string)=>{const p=join(bin,name);writeFileSync(p,`#!/bin/bash\n${body}\n`);chmodSync(p,0o755)};tool("id",'echo 501');tool("sleep",'exit 0');tool("plutil",'exit 0');tool("curl",`echo '{"ok":true,"pid":2,"generation":"g1","listening":true,"schemaCompatible":true,"buildIdentity":"${"a".repeat(64)}"}'`);tool("bun",`case "$*" in *build-identity*) echo ${"a".repeat(64)};; *parseSessionMigrationMode*) echo off;; *dashboard*) echo 4517;; *observationSec*) echo 0;; *) exit 0;; esac`);tool("launchctl",`if [ "$1" = bootstrap ] && ! grep -q OLD "$HOME/Library/LaunchAgents/ai.ownward.daemon.plist";then exit 1;fi;exit 0`);const proc=Bun.spawn(["bash","launchd/install.sh"],{cwd:root,env:{...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,OWNWARD_BUN:join(bin,"bun"),OWNWARD_RELEASE_ROOT:root},stdout:"pipe",stderr:"pipe"});const output=await new Response(proc.stderr).text(),code=await proc.exited;expect(code).not.toBe(0);expect(output).toContain("restoring previous");expect(readFileSync(plist,"utf8")).toBe("OLD\n");},15_000);

// 零 provider 机器（全部 providers.enabled:false，如只用来跑 Vertical 的顾问机/演示机）：
// runner_status 的 args 是空数组，macOS bash 3.2 在 set -u 下展开裸 "${args[@]}" 会 unbound variable 崩装机。
test("零 required provider 时 runner health 调用不因空数组展开崩溃",async()=>{
  const source=join(import.meta.dir,"../.."),root=mkdtempSync(join(tmpdir(),"daemon-install-noprov-")),home=join(root,"home"),bin=join(root,"bin");
  mkdirSync(join(root,"launchd"),{recursive:true});mkdirSync(join(home,"Library/LaunchAgents"),{recursive:true});mkdirSync(bin);
  for(const f of["launchd/install.sh","launchd/ownward.plist.template"])writeFileSync(join(root,f),readFileSync(join(source,f)));
  const tool=(name:string,body:string)=>{const p=join(bin,name);writeFileSync(p,`#!/bin/bash\n${body}\n`);chmodSync(p,0o755)};
  tool("id",'echo 501');tool("sleep",'exit 0');tool("plutil",'exit 0');tool("launchctl",'exit 0');
  tool("curl",`echo '{"ok":true,"pid":2,"generation":"g1","listening":true,"schemaCompatible":true,"buildIdentity":"${"a".repeat(64)}"}'`);
  // providers 全 disabled ⇒ REQUIRED_PROVIDERS 为空串；health.ts 必须收到零个 --required-provider
  tool("bun",`case "$*" in
  *build-identity*) echo ${"a".repeat(64)};;
  *parseSessionMigrationMode*) echo runner;;
  *dashboard*) echo 4517;;
  *observationSec*) echo 0;;
  *cfg.providers*) echo "";;
  *runner/health.ts*) if [ "$*" = *"--required-provider"* ];then echo "unexpected provider arg" >&2;exit 1;fi;echo '{"ok":true}';;
  *) exit 0;; esac`);
  const proc=Bun.spawn(["bash","launchd/install.sh"],{cwd:root,env:{...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,OWNWARD_BUN:join(bin,"bun"),OWNWARD_RELEASE_ROOT:root},stdout:"pipe",stderr:"pipe"});
  const stderr=await new Response(proc.stderr).text(),code=await proc.exited;
  expect(stderr).not.toContain("unbound variable");
  expect(code).toBe(0);
},15_000);

// 观察窗不能要求「连续 N 次亚秒响应」：daemon 主线程会因同步读大文件周期性卡几秒，
// 实测健康 daemon 150 次探测失败 9 次（连续 8 秒无响应），于是健康版本也装不上。
// 偶发丢包要放过，真的起不来仍要判死。
const observeEnv=(root:string,home:string,bin:string,failOn:string)=>{
  const B="a".repeat(64),health=`{"ok":true,"pid":2,"generation":"g1","listening":true,"schemaCompatible":true,"buildIdentity":"${B}"}`;
  mkdirSync(join(root,"launchd"),{recursive:true});mkdirSync(join(home,"Library/LaunchAgents"),{recursive:true});mkdirSync(bin,{recursive:true});
  for(const f of["launchd/install.sh","launchd/ownward.plist.template"])writeFileSync(join(root,f),readFileSync(join(join(import.meta.dir,"../.."),f)));
  const tool=(name:string,body:string)=>{const p=join(bin,name);writeFileSync(p,`#!/bin/bash\n${body}\n`);chmodSync(p,0o755)};
  tool("id",'echo 501');tool("sleep",'exit 0');tool("plutil",'exit 0');tool("launchctl",'exit 0');
  // 第 N 次 curl 按 failOn 列表模拟丢包（curl --max-time 超时的退出码 28）
  tool("curl",`n=$(( $(cat "${root}/curl.count" 2>/dev/null || echo 0) + 1 ));echo "$n" > "${root}/curl.count"
for f in ${failOn};do [ "$n" = "$f" ] && exit 28;done
echo '${health}'`);
  tool("bun",`case "$*" in
  *build-identity*) echo ${B};;
  *parseSessionMigrationMode*) echo runner;;
  *dashboard*) echo 4517;;
  *observationSec*) echo 5;;
  *cfg.providers*) echo "";;
  *runner/health.ts*) echo '{"ok":true,"pid":9,"buildIdentity":"${B}","runnerApiVersion":1,"draining":false,"capabilities":[],"providers":[]}';;
  *) exec ${process.execPath} "$@";; esac`);   // 身份漂移程序和 probe 的 -e 要真 bun 执行
  return{...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,OWNWARD_BUN:join(bin,"bun"),OWNWARD_RELEASE_ROOT:root};
};

test("观察窗放过偶发探测失败，不把健康 daemon 判死",async()=>{
  const root=mkdtempSync(join(tmpdir(),"daemon-observe-flap-"));
  // 第 3、4 次 curl 丢包 = 观察窗里连续 2 次没探到，仍在默认容忍度内
  const proc=Bun.spawn(["bash","launchd/install.sh"],{cwd:root,env:observeEnv(root,join(root,"home"),join(root,"bin"),"3 4"),stdout:"pipe",stderr:"pipe"});
  const stderr=await new Response(proc.stderr).text(),code=await proc.exited;
  expect(stderr).not.toContain("observation daemon probe failed");
  expect(code).toBe(0);
},20_000);

test("观察窗仍然判死持续探不到的 daemon",async()=>{
  const root=mkdtempSync(join(tmpdir(),"daemon-observe-dead-"));
  // 基线探到之后一直丢包：超过容忍上限必须 exit 70
  const env={...observeEnv(root,join(root,"home"),join(root,"bin"),"3 4 5 6 7 8 9 10"),OWNWARD_OBSERVATION_MAX_MISS:"2"};
  const proc=Bun.spawn(["bash","launchd/install.sh"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
  const stderr=await new Response(proc.stderr).text(),code=await proc.exited;
  expect(stderr).toContain("observation daemon probe failed");
  expect(code).toBe(70);
},20_000);
