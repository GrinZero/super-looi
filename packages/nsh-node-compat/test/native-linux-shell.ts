import fs from "node:fs";
import { spawn } from "node:child_process";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentExecutor } from "../../looi-runtime/src/agent/pi-executor.js";
import type { AgentShellOutput } from "../../looi-runtime/src/agent/executor.js";

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function verifyLinuxShell(onOutput: (event: AgentShellOutput) => void, installPackages = true) {
  let call = 0;
  const command = (script: string, options: {timeout?:number;env?:Record<string,string>;cancelOn?:string} = {}) => new Promise<{stdout:string;stderr:string;status:number|null;signal:string|null;timedOut:boolean}>((resolve,reject) => {
    const id = String(++call);
    const child = spawn("/bin/sh",["-c",script],{cwd:"/workspace",timeout:options.timeout ?? 15_000,env:options.env});
    let stdout = "", stderr = "";
    const output = (stream:"stdout"|"stderr"|"status", chunk:string) => {
      onOutput({taskId:"linux-probe",callId:id,command:script,stream,chunk});
      if (stream==="stdout") stdout+=chunk;
      if (stream==="stderr") stderr+=chunk;
      if (options.cancelOn && (stdout+stderr).includes(options.cancelOn)) child.kill();
    };
    child.stdout!.on("data",chunk=>output("stdout",chunk.toString()));
    child.stderr!.on("data",chunk=>output("stderr",chunk.toString()));
    child.on("status",chunk=>output("status",chunk));
    let failure: Error | undefined;
    child.on("error",error=>{ failure=error; });
    child.on("close",(status,signal)=>{
      if (failure) reject(failure);
      else resolve({stdout,stderr,status,signal,timedOut:(child as typeof child & {timedOut?:boolean}).timedOut ?? false});
    });
  });
  const pass = (name:string) => console.log(`PASS Linux Shell: ${name}`);
  fs.mkdirSync("/workspace/linux-probe",{recursive:true});
  fs.writeFileSync("/workspace/linux-probe/from-file","文件工具");
  let result = await command("pwd; printf '%s\\n' \"$PATH\" \"$HOME\"; command -v apk");
  equal(result.status,0);
  assert(result.stdout.includes("/workspace\n/usr/local/sbin:"),result.stdout);
  assert(result.stdout.includes("\n/root\n/sbin/apk\n"),result.stdout);
  result = await command("printf '%s|%s|%s' \"$HOME\" \"$CUSTOM\" \"$PATH\"",{env:{HOME:"/custom",CUSTOM:"中文"}});
  assert(result.stdout.startsWith("/custom|中文|/usr/local/sbin:"),result.stdout);
  pass("guest default environment and overrides");
  result = await command("cat linux-probe/from-file; printf shell > linux-probe/from-shell; printf error >&2; exit 7");
  equal(result.stdout,"文件工具"); equal(result.stderr,"error"); equal(result.status,7);
  equal(fs.readFileSync("/workspace/linux-probe/from-shell","utf8"),"shell");
  fs.mkdirSync("/home/agent",{recursive:true});
  fs.writeFileSync("/home/agent/linux-probe-ledger","private-ledger");
  equal((await command("test ! -e /home/agent/linux-probe-ledger")).status,0);
  pass("bidirectional workspace, separate streams, nonzero exit and ledger isolation");
  result = await command("yes work | head -c 50000");
  equal(result.status,0); equal(Buffer.byteLength(result.stdout),50000); equal(result.stderr,"");
  result = await command("printf 中文; sleep 0.05; printf 尾部; printf 错误尾部 >&2");
  equal(result.stdout,"中文尾部"); equal(result.stderr,"错误尾部");
  pass("SIGPIPE pipeline, 50000 bytes and UTF-8 streaming");
  for (const script of ["sleep 600 & echo done", "setsid sh -c 'sleep 600' >/dev/null 2>&1 & echo done", "sh -c 'setsid sh -c \"sleep 600\" >/dev/null 2>&1 &' ; echo done"]) {
    const start = Date.now(); result = await command(script);
    equal(result.status,0); equal(result.stdout,"done\n"); assert(Date.now()-start<3000,"descendants were not reaped within stop grace");
  }
  pass("normal completion reaps background, setsid and reparented descendants");
  result = await command("head -c 24000 /dev/zero | tr '\\0' e >&2; printf STDERR_END >&2; head -c 24000 /dev/zero | tr '\\0' o; printf STDOUT_END; sleep 600",{cancelOn:"STDOUT_END"});
  equal(result.signal,"SIGTERM");
  equal(Buffer.byteLength(result.stdout),24010); equal(Buffer.byteLength(result.stderr),24010);
  assert(result.stdout.endsWith("STDOUT_END") && result.stderr.endsWith("STDERR_END"),"large cancellation tails were not drained");
  pass("cancellation drains more than one native read block from both streams");

  result = await command("printf cancel-tail; printf error-tail >&2; setsid sh -c 'sleep 600' & wait",{cancelOn:"cancel-tail"});
  equal(result.signal,"SIGTERM"); assert(result.stdout.includes("cancel-tail"),"cancel stdout tail missing");
  result = await command("printf timeout-tail; setsid sh -c 'sleep 600' & wait",{timeout:150});
  equal(result.timedOut,true); equal(result.status,124); equal(result.stdout,"timeout-tail");
  result = await command("echo next"); equal(result.stdout,"next\n"); equal(result.status,0);
  equal((await command("exit 124")).timedOut,false);
  pass("cancel and timeout receipts, output drain and next command");
  result = await command("cd linux-probe; rm -f relative absolute external hardlink; printf a > original; ln -s original relative; ln -s /workspace/linux-probe/original absolute; ln -s /usr/bin/python3 external; ln original hardlink");
  equal(result.status,0);
  for (const file of ["original","relative","absolute","hardlink"]) {
    equal(fs.readFileSync(`/workspace/linux-probe/${file}`,"utf8"),"a");
    equal(fs.statSync(`/workspace/linux-probe/${file}`).isFile(),true);
  }
  fs.writeFileSync("/workspace/linux-probe/absolute","changed");
  equal((await command("cat linux-probe/hardlink")).stdout,"changed");
  fs.writeFileSync("/workspace/linux-probe/hardlink","changed-through-hardlink");
  equal((await command("cat linux-probe/original")).stdout,"changed-through-hardlink");
  equal((await command("ln linux-probe/original z-linux-hardlink; ln -s /usr/bin/python3 a-linux-external")).status,0);
  let denied = false;
  try { fs.readFileSync("/workspace/linux-probe/external"); } catch { denied = true; }
  assert(denied,"external guest link was exposed to file tools");
  const builtinOutput = await new Promise<string>((resolve,reject)=>{
    const child = spawn("rg",["--json","--","changed","/workspace/linux-probe/absolute"]);
    let text="";
    child.stdout!.on("data",chunk=>{text+=chunk.toString();});
    child.on("error",reject); child.on("close",code=>{if(code===0)resolve(text);else reject(new Error("builtin rg failed on absolute workspace link"));});
  });
  assert(builtinOutput.includes("changed"),builtinOutput);
  pass("relative/absolute links, hardlinks and external link rejection");
  if (installPackages) {
    const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
    const scripts = ["apk add git python3 nodejs npm ripgrep", "npm install -g pnpm", "git --version && python3 -c 'print(123)' && node -v && pnpm -v && rg --version && printf artifact >> z-linux-hardlink"];
    faux.setResponses([...scripts.map(script=>fauxAssistantMessage(fauxToolCall("bash",{command:script}),{stopReason:"toolUse"})),fauxAssistantMessage("Packages ready")]);
    const executor = new PiAgentExecutor({stateDirectory:"/home/agent/linux-probe",workspaceRoot:"/workspace",modelSpec:faux.getModel(),modelsRegistry: models, streamFn: models.streamSimple.bind(models),commandTimeoutMs:300_000,deadlineMs:600_000});
    let approvals=0;
    try {
      const report = await executor.run("Install the requested Linux tools",{taskId:"package-probe",approvalMode:"local_auto",onShellOutput:onOutput,onStep(event) {
        if (event.interaction?.kind === "approval") { approvals++; executor.respond(event.taskId!,event.interaction.id,{outcome:"allowed-once"}); }
      }});
      equal(approvals,2);
      for (const receipt of report.executions ?? []) {
        assert(receipt.exitCode===0 && !receipt.timedOut,JSON.stringify(receipt));
      }
      equal(report.executions?.length,3);
      assert(report.artifacts?.some(item=>item.path==="z-linux-hardlink"),"hardlink artifact was lost after an external symlink");
      assert(!report.artifacts?.some(item=>item.path==="a-linux-external"),"external symlink became an artifact");
    } finally { await executor.close(); }
    pass("approved apk/npm installation and executable versions");
  }
  result = await command("git --version && python3 -c 'print(123)' && node -v && pnpm -v && rg --version");
  equal(result.status,0);
  pass("installed packages available in persistent guest");
}
