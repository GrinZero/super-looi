import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Utf8Decoder } from "../src/encoding.js";
import { assert, equal, throws } from "./assert.js";
equal(path.resolve("relative.txt"), "/workspace/relative.txt");
equal(path.relative("/workspace/a", "/workspace/b"), "../b");
equal(new Utf8Decoder().decode(new Uint8Array([0xc2, 0x41])), "�A");
equal(new Utf8Decoder().decode(new Uint8Array([0xe2, 0x82, 0x41])), "�A");
const db = new DatabaseSync(":memory:");
equal(db.prepare("SELECT 'attach' AS attachments").get(), {
  attachments: "attach",
});
let start = Date.now();
throws(
  () =>
    db
      .prepare(
        "WITH RECURSIVE r(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM r) SELECT sum(n) FROM r",
      )
      .get(),
  "interrupted",
);
assert(Date.now() - start < 2000, "SQLite native deadline");
db.close();
const child = spawn("sh", ["-c", Array(4000).fill("echo work").join(";")], {
  timeout: 10000,
});
const completion = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code, signal) => {
    equal(code, null);
    equal(signal, "SIGTERM");
    resolve(undefined);
  });
});
child.kill();
await completion;
const active = spawn("sh", ["-c", Array(4000).fill("echo work").join(";")], {
  timeout: 10000,
});
const activeCompletion = new Promise((resolve, reject) => {
  active.on("error", reject);
  active.on("close", (code, signal) => {
    assert(signal === "SIGTERM" && code === null);
    resolve(undefined);
  });
});
setTimeout(() => active.kill(), 1);
await activeCompletion;
equal(
  spawnSync("sh", ["-c", "cat missing | cat"]).stderr.includes("ENOENT"),
  true,
);
fs.mkdirSync("/workspace/watch", { recursive: true });
const watcher = fs.watch("/workspace/watch");
const changed = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("native watch timeout")),
    3000,
  );
  watcher.on("error", reject);
  watcher.on("change", () => {
    clearTimeout(timer);
    watcher.close();
    resolve();
  });
});
fs.writeFileSync("/workspace/watch/created.txt", "change");
await changed;
console.log(
  "PASS budgets: SQLite deadline, active shell cancellation, virtual paths, UTF-8 errors, native notify watch",
);

throws(
  () => spawnSync("sh", ["-c", "(".repeat(1000) + "true" + ")".repeat(1000)]),
  "nesting budget",
);
fs.writeFileSync("src.txt", "src");
fs.writeFileSync("dst.txt", "old");
assert(spawnSync("sh", ["-c", "cp -n src.txt dst.txt"]).status !== 0);
equal(fs.readFileSync("dst.txt", "utf8"), "old");
assert(spawnSync("sh", ["-c", "rm -i src.txt"]).status !== 0);
assert(fs.existsSync("src.txt"));
fs.writeFileSync("relative.txt", "cwd");
equal(fs.readFileSync(path.resolve("relative.txt"), "utf8"), "cwd");

throws(
  () =>
    spawnSync("sh", [
      "-c",
      "(echo ')';".repeat(1000) + "true" + ")".repeat(1000),
    ]),
  "nesting budget",
);

fs.mkdirSync("/workspace/tree", { recursive: true });
fs.writeFileSync("/workspace/tree/keep", "keep");
assert(spawnSync("sh", ["-c", "rm -- -rf tree"]).status !== 0);
assert(fs.existsSync("/workspace/tree/keep"));
