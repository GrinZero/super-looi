import { assert, equal, throws } from "./assert.js";
import fs from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
import { createInterface } from "node:readline";
import http from "node:http";
import { cloneValue } from "../src/polyfills.js";
import { StringDecoder } from "../src/shims/string_decoder.js";
await import("./verify-stream-promises.js");
fs.mkdirSync("/workspace/test", { recursive: true });
fs.writeFileSync("/workspace/test/hello.txt", "hello 世界\nsecond\nthird\n");
equal(
  fs.readFileSync("/workspace/test/hello.txt", "utf8"),
  "hello 世界\nsecond\nthird\n",
);
assert(fs.statSync("/workspace/test").isDirectory());
const modifiedAt = new Date("2026-11-12T05:00:00.005Z");
fs.utimesSync("/workspace/test/hello.txt", modifiedAt, modifiedAt);
equal(fs.statSync("/workspace/test/hello.txt").mtime.getTime(), modifiedAt.getTime());
const fd = await open("/workspace/test/hello.txt");
const buffer = Buffer.alloc(5);
equal((await fd.read(buffer, 0, 5, 0)).bytesRead, 5);
equal(buffer.toString(), "hello");
await fd.close();
throws(() => fs.readFileSync("/../../etc/passwd"), "EACCES");
const lines: string[] = [];
for await (const line of createInterface({
  input: fs.createReadStream("/workspace/test/hello.txt"),
}))
  lines.push(line);
equal(lines, ["hello 世界", "second", "third"]);
const decoder = new StringDecoder();
const binary = Buffer.from("世");
equal(decoder.write(binary.subarray(0, 1)), "");
equal(decoder.end(binary.subarray(1)), "世");
equal(
  createHash("sha256").update("hello").digest("hex"),
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
);
assert(createHmac("sha256", "key").update("data").digest("hex").length === 64);
assert(randomUUID().length === 36);
equal(
  Buffer.from(
    inflateRawSync(deflateRawSync(Buffer.from("compressed 世界"))),
  ).toString(),
  "compressed 世界",
);
equal(crc32(Buffer.from("123456789")), 0xcbf43926);
let db = new DatabaseSync("/test.sqlite");
db.exec(
  "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT); DELETE FROM items",
);
db.prepare("INSERT INTO items(value) VALUES (?)").run("persisted");
db.close();
db = new DatabaseSync("/test.sqlite");
equal(db.prepare("SELECT value FROM items").get(), { value: "persisted" });
db.exec("BEGIN");
db.prepare("INSERT INTO items(value) VALUES (?)").run("rollback");
db.exec("ROLLBACK");
equal(db.prepare("SELECT count(*) AS n FROM items").get(), { n: 1 });
throws(() => db.exec("ATTACH DATABASE '/tmp/escape.sqlite' AS outside"));
throws(() => db.exec("VACUUM/**/INTO '/tmp/escape.sqlite'"));
db.close();
throws(() => db.exec("select 1"), "closed");
const out = spawnSync(
  "sh",
  [
    "-c",
    "echo alpha > pipe.txt && cat pipe.txt | grep alpha && false || echo recovered",
  ],
  { cwd: "/workspace/test", encoding: "utf8" },
);
equal(out.status, 0);
equal(out.stdout, "alpha\nrecovered\n");
equal(
  spawnSync("sh", ["-c", "echo $(cat pipe.txt)"], {
    cwd: "/workspace/test",
    encoding: "utf8",
  }).stdout,
  "alpha\n",
);
equal(spawnSync("sh", ["-c", "cat /../../etc/passwd"]).status, 1);
equal(spawnSync("curl", ["https://example.com"]).status, 127);
const child = spawn("sh", ["-c", "echo event"]);
let output = "";
child.stdout.on("data", (data) => (output += data.toString()));
await new Promise((resolve) => child.on("close", resolve));
equal(output, "event\n");
const server = http.createServer();
assert(typeof server.listen === "function");
let listened = false;
server.listen(1455, "127.0.0.1", () => {
  listened = true;
});
await new Promise<void>((resolve) => queueMicrotask(resolve));
assert(listened);
equal(server.address().port, 1455);
server.closeAllConnections();
server.close();
const cycle: any = {
  date: new Date(0),
  bytes: new Uint8Array([1, 2]),
  map: new Map([["a", 1]]),
};
cycle.self = cycle;
const clone = cloneValue(cycle);
assert(clone.self === clone && clone !== cycle);
equal(clone.date.getTime(), 0);
equal([...clone.bytes], [1, 2]);
equal(clone.map.get("a"), 1);
console.log(
  "PASS node-shims: fs, binary, readline, SQLite recovery/rollback, shell, crypto, zlib, clone",
);

equal(
  spawnSync("sh", ["-c", "cat missing || echo recovered"]).stdout,
  "recovered\n",
);
const original = fs.openSync("/workspace/test/hello.txt", "r");
fs.renameSync("/workspace/test/hello.txt", "/workspace/test/moved.txt");
fs.writeFileSync("/workspace/test/hello.txt", "new");
const stable = Buffer.alloc(5);
fs.readSync(original, stable, 0, 5, 0);
equal(stable.toString(), "hello");
fs.closeSync(original);
