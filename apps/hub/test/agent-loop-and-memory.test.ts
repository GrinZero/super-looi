import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonalMemoryStore } from "../src/agent/personal-memory.js";
import { buildApp } from "../src/app.js";

describe("Personal Memory and Hub routes", () => {
  it("PersonalMemoryStore persists to disk, deduplicates by subject, recalls, and forgets", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "looi-mem-"));
    const memFile = path.join(tmpDir, "personal-memory.json");

    try {
      const store1 = new PersonalMemoryStore({
        filePath: memFile,
        persistToDisk: true,
        seedDefaultsIfEmpty: false,
      });

      const e1 = await store1.remember({
        fact: "备用钥匙放在玄关抽屉里",
        subject: "备用钥匙",
        location: "玄关抽屉",
        source: "voice",
      });
      assert.equal(e1.subject, "备用钥匙");
      assert.equal(e1.location, "玄关抽屉");
      assert.ok(fs.existsSync(memFile));

      // Upsert same subject updates location without creating duplicate
      const e2 = await store1.remember({
        fact: "备用钥匙移到了书桌左侧",
        subject: "备用钥匙",
        location: "书桌左侧",
        source: "voice",
      });
      assert.equal(e2.id, e1.id);
      assert.equal(store1.listAll().length, 1);
      assert.equal(store1.listAll()[0].location, "书桌左侧");

      // Reload from disk in a fresh instance
      const store2 = new PersonalMemoryStore({
        filePath: memFile,
        persistToDisk: true,
        seedDefaultsIfEmpty: false,
      });
      const recalled = store2.recall("备用钥匙");
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0].location, "书桌左侧");
      assert.match(store2.buildSystemPromptBlock(), /备用钥匙/);

      // Forget removes from disk
      const forgotten = store2.forget("备用钥匙");
      assert.equal(forgotten.removedCount, 1);
      assert.equal(store2.listAll().length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes /api/agent/memories and /api/agent/run routes on Hub", async () => {
    const app = buildApp();
    try {
      const memRes = await app.inject({
        method: "POST",
        url: "/api/agent/memories",
        payload: { fact: "蓝牙耳机放在充电底座右侧", subject: "蓝牙耳机", location: "充电底座右侧" },
      });
      assert.equal(memRes.statusCode, 200);
      const memBody = JSON.parse(memRes.body);
      assert.equal(memBody.success, true);
      assert.equal(memBody.entry.subject, "蓝牙耳机");

      const listRes = await app.inject({
        method: "GET",
        url: "/api/agent/memories?q=蓝牙耳机",
      });
      assert.equal(listRes.statusCode, 200);
      const listBody = JSON.parse(listRes.body);
      assert.equal(listBody.memories.length, 1);
    } finally {
      await app.close();
    }
  });
});
