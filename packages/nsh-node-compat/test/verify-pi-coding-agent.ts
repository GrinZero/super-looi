import { assert, equal } from "./assert.js";
import { SessionManager } from "pi-coding-headless/session-manager";
const manager = SessionManager.create("/workspace", "/workspace/sessions");
manager.appendMessage({
  role: "user",
  content: "恢复会话",
  timestamp: Date.now(),
});
const file = manager.getSessionFile();
assert(file, "session should persist");
const loaded = SessionManager.open(file);
equal(loaded.buildSessionContext().messages.length, 1);
console.log("PASS pi-coding-agent session recovery");
import { createReadTool } from "pi-coding-headless/tools/read";
import { createWriteTool } from "pi-coding-headless/tools/write";
import { createEditTool } from "pi-coding-headless/tools/edit";
import { createLsTool } from "pi-coding-headless/tools/ls";
import { createFindTool } from "pi-coding-headless/tools/find";
import { createGrepTool } from "pi-coding-headless/tools/grep";
import { createBashTool } from "pi-coding-headless/tools/bash";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const cwd = "/workspace/project";
fs.mkdirSync(cwd, { recursive: true });
const text = (result: any) =>
  result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
await createWriteTool(cwd).execute("write", {
  path: "hello.txt",
  content: "original\n",
});
await createEditTool(cwd).execute("edit", {
  path: "hello.txt",
  edits: [{ oldText: "original", newText: "updated" }],
});
assert(
  text(
    await createReadTool(cwd).execute("read", { path: "hello.txt" }),
  ).includes("updated"),
);
assert(
  text(await createLsTool(cwd).execute("ls", { path: "." })).includes(
    "hello.txt",
  ),
);
const glob = (pattern: string, root: string) => {
  const match = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".") +
      "$",
  );
  return fs.readdirSync(root).filter((name: string) => match.test(name));
};
assert(
  text(
    await createFindTool(cwd, {
      operations: { exists: fs.existsSync, glob },
    }).execute("find", { pattern: "*.txt" }),
  ).includes("hello.txt"),
);
assert(
  text(
    await createGrepTool(cwd).execute("grep", {
      pattern: "updated",
      path: ".",
    }),
  ).includes("updated"),
);
fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored.txt\n");
fs.writeFileSync(path.join(cwd, "ignored.txt"), "updated\n");
assert(
  !text(
    await createGrepTool(cwd).execute("grep-ignored", {
      pattern: "updated",
      path: ".",
    }),
  ).includes("ignored.txt"),
);
const bash = createBashTool(cwd, {
  operations: {
    exec: (command: string, cwd: string, options: any) =>
      new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", command], {
          cwd,
          signal: options.signal,
        });
        child.stdout.on("data", options.onData);
        child.stderr.on("data", options.onData);
        child.on("error", reject);
        child.on("close", (exitCode: number | null, signal: string | null) =>
          resolve({ exitCode: signal ? 143 : exitCode }),
        );
      }),
  },
});
assert(
  text(
    await bash.execute("bash", { command: "cat hello.txt | grep updated" }),
  ).includes("updated"),
);
console.log(
  "PASS pi-coding-agent@1.5.0 headless source entries: SessionManager JSONL and seven real tools (image/TUI/download excluded; find/bash operations injected)",
);
