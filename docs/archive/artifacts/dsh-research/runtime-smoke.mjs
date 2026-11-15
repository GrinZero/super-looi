import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const harness = new DeepSeekHarness({
  profile: 'sdk', dshHome: path.join(root, 'isolated-home'),
  processCwd: workspace, cwd: workspace, env: childEnv,
  initializeTimeoutMs: 90000, requestTimeoutMs: 15000,
});
const evidence = { node: process.version, profile: 'sdk', usesRealModel: false, checks: [] };
const start = Date.now();
try {
  await harness.start();
  evidence.checks.push({ name: 'initialize', ok: true, durationMs: Date.now() - start });
  const session = harness.session('super-looi-research-session');
  const cwd = await session.getWorkingDirectory();
  evidence.checks.push({ name: 'session-working-directory', ok: cwd === workspace });
  try {
    await harness.resumeSession('super-looi-definitely-missing-session');
    evidence.checks.push({ name: 'missing-session-rejects', ok: false });
  } catch (e) {
    evidence.checks.push({ name: 'missing-session-rejects', ok: true, errorType: e.constructor.name });
  }
} catch (e) {
  evidence.error = { type: e.constructor.name, message: e.message };
} finally {
  try { await harness.close(); evidence.checks.push({ name: 'close', ok: true }); }
  catch (e) { evidence.closeError = { type: e.constructor.name, message: e.message }; }
  evidence.durationMs = Date.now() - start;
  await writeFile(path.join(root, 'probe-start-result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.error || evidence.closeError || evidence.checks.some(check => !check.ok)) process.exitCode = 1;
}
