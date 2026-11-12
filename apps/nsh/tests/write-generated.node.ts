import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGenerated } from "../scripts/write-generated.mjs";

test("unchanged generated bundles keep their timestamp; changed bundles update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "looi-generated-"));
  const path = join(dir, "runtime.js");
  try {
    await writeGenerated(path, "first");
    await utimes(path, 1, 1);
    await writeGenerated(path, new TextEncoder().encode("first"));
    assert.equal((await stat(path)).mtimeMs, 1000);
    await writeGenerated(path, "second");
    assert.equal(await readFile(path, "utf8"), "second");
    assert.notEqual((await stat(path)).mtimeMs, 1000);
  } finally {
    await rm(dir, { recursive: true });
  }
});
