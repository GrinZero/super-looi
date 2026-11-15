import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const repo = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(path.join(repo, 'apps/hub/package.json'));
const { parse } = require('dotenv');
const cfg = parse(await readFile(path.join(repo, '.env')));
const root = process.cwd();
const evidence = { runtimeVersion: '0.2.2-rc.1', usesRealModel: true, checks: [] };
const out = path.join(root, 'probe-model-result.json');
if (!cfg.LLM_BASE_URL || !cfg.LLM_API_KEY || !cfg.LLM_MODEL) {
  evidence.skipped = 'Required LLM env variables are absent';
  await writeFile(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence)); process.exit(2);
}
const workspace = path.join(root, 'model-workspace');
await mkdir(workspace, { recursive: true });
const marker = 'LOOI_DSH_' + crypto.randomUUID();
await writeFile(path.join(workspace, 'proof-input.txt'), marker + '\n');
const childEnv = Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
childEnv.LOOI_PROBE_MODEL_KEY = cfg.LLM_API_KEY;
const patch = path.join(root, 'probe-model.patch.yml');
await writeFile(patch, JSON.stringify([{ id: 'llm-pi-ai', config: { providers: { 'looi-probe': { api: 'openai-completions', baseURL: cfg.LLM_BASE_URL, apiKeyEnv: 'LOOI_PROBE_MODEL_KEY', models: [{ id: cfg.LLM_MODEL, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024 }], timeoutMs: 20000, streamIdleTimeoutMs: 20000, retryPolicy: { mode: 'normal', maxRetries: 0 } } } } }]));
const harness = new DeepSeekHarness({ profile: 'sdk', dshHome: path.join(root, 'model-home'), cwd: workspace, processCwd: workspace, env: childEnv, patches:[patch], provider:'looi-probe', model:cfg.LLM_MODEL, maxTokens:512, initializeTimeoutMs:30000, requestTimeoutMs:60000 });
let toolEvents = 0;
try {
  await harness.start(); evidence.checks.push({name:'custom-provider-initialize',ok:true});
  const session = harness.session();
  const result = await session.run('请使用文件读取工具读取当前目录 proof-input.txt，只回复文件中的标记。必须实际调用工具，不要猜测，也不要执行其他操作。', {onNotification:n=>{
    if(n.method==='session.event' && String(n.params.event?.type).startsWith('tool/')) toolEvents++;
  }});
  evidence.checks.push({name:'real-model-read-marker',ok:result.finalResponse.includes(marker)});
  evidence.finishReason=result.finishReason;
  evidence.eventTypes=[...new Set(result.events.map(e=>e.type))];

  evidence.toolEvents=toolEvents;
  evidence.toolNames=result.events.filter(event => event.type === 'tool/call').map(event => event.data.name);
  evidence.sessionId=session.id;
} catch(e) { evidence.error={type:e.constructor.name,message: e.message.replaceAll(cfg.LLM_API_KEY,'[redacted]').replaceAll(cfg.LLM_BASE_URL,'[model-endpoint]')}; }
finally { try{await harness.close(); evidence.checks.push({name:'close',ok:true});}catch(e){evidence.closeError=e.constructor.name;}
await writeFile(out,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
if (evidence.error || evidence.closeError || evidence.finishReason !== 'completed' || evidence.checks.some(check => !check.ok)) process.exitCode = 1;}
