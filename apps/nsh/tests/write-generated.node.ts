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

test("concurrent bundle writes publish complete files to readers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "looi-generated-"));
  const path = join(dir, "runtime.js");
  const bundles = Array.from({ length: 8 }, (_, index) =>
    Buffer.alloc(2 * 1024 * 1024 + index * 65537, 65 + index),
  );
  let writing = true;
  const incompleteSizes: number[] = [];
  try {
    await writeGenerated(path, bundles[0]);
    const reader = (async () => {
      while (writing) {
        const bytes = await readFile(path);
        if (!bundles.some(bundle => bundle.equals(bytes))) incompleteSizes.push(bytes.length);
      }
    })();
    try {
      await Promise.all(bundles.map(bundle => writeGenerated(path, bundle)));
    } finally {
      writing = false;
      await reader;
    }
    assert.deepEqual(incompleteSizes, []);
    const final = await readFile(path);
    assert.ok(bundles.some(bundle => bundle.equals(final)));
  } finally {
    await rm(dir, { recursive: true });
  }
});
