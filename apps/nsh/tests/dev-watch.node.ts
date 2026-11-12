import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
if (!binary) throw new Error("Pass the prepared NSH CLI path as the test argument");

test("dev ignores unrelated outputs, reloads imported code, and recovers new imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "looi-dev-watch-"));
  await writeFile(join(dir, "nsh.json"), '{"name":"Watch regression"}');
  await writeFile(join(dir, "label.ts"), 'export const label = "first";');
  await writeFile(join(dir, "active-label.ts"), 'export const label = "active";');
  const entry = 'import {mount,Text} from "nsh"; import {label} from "./label"; mount(()=><Text>{label}</Text>);';
  await writeFile(join(dir, "App.tsx"), entry);
  const child = spawn(binary, ["dev", dir, "--server-only", "--release", "--port", "0"], {
    env: {
      ...process.env, NO_COLOR: "1",
      NSH_DEV_RESOLVE_ALIAS: JSON.stringify({ "./label": join(dir, "active-label.ts") }),
    }, stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { log += chunk; });
  const waitFor = (pattern: RegExp, offset = 0) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`No ${pattern}: ${log.slice(offset)}`)); }, 10_000);
    const check = () => { if (pattern.test(log.slice(offset))) { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timeout); child.stderr.off("data", check); };
    child.stderr.on("data", check);
    check();
  });
  try {
    await waitFor(/built .*App\.tsx/);
    let offset = log.length;
    for (const path of ["tests/unused.ts", "scripts/build.ts", "generated/compat-probe.js", "target/info.json"]) {
      const [folder] = path.split("/");
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(join(dir, path), path.endsWith("json") ? "{}" : "export const unused = 1;");
    }
    await writeFile(join(dir, "label.ts"), 'export const label = "ordinary output changed";');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.doesNotMatch(log.slice(offset), /rebuilt|error/);
    await writeFile(join(dir, "active-label.ts"), 'export const label = "second";');
    await waitFor(/rebuilt .*App\.tsx/, offset);
    offset = log.length;
    await writeFile(join(dir, "App.tsx"), entry.replace('"./label"', '"./new-label"'));
    await waitFor(/error/, offset);
    offset = log.length;
    await writeFile(join(dir, "new-label.ts"), 'export const label = "recovered";');
    await waitFor(/rebuilt .*App\.tsx/, offset);
    offset = log.length;
    await writeFile(join(dir, "nsh.json"), '{"name":"Watch regression","appearance":"dark"}');
    await waitFor(/rebuilt .*App\.tsx/, offset);
  } finally {
    child.kill("SIGINT");
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
});
