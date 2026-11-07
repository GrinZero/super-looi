import test from "node:test";
import assert from "node:assert/strict";
import { chooseConnectedModelId, fetchOnlineModels } from "../runtime/model-list.js";

test("reads the signed-in ChatGPT account catalog using visible slugs", async () => {
  const models = await fetchOnlineModels(
    "https://api.openai.com/v1/",
    { Authorization: "Bearer account-token" },
    { fetcher: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.deepEqual(options?.headers, { Authorization: "Bearer account-token" });
      return Response.json({ models: [
        { slug: "gpt-live", display_name: "GPT Live", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
      ] });
    } },
  );
  assert.deepEqual(models, [{ id: "gpt-live", name: "GPT Live" }]);
});

test("reads an OpenAI-compatible API key catalog", async () => {
  const models = await fetchOnlineModels(
    "https://api.kimi.com/coding/v1",
    { Authorization: "Bearer key" },
    { knownChatIds: new Set(["k3.1-pro"]), fetcher: async (url) => {
      assert.equal(url, "https://api.kimi.com/coding/v1/models");
      return Response.json({ data: [
        { id: "k3.1-pro" }, { id: "image-model" }, { id: "k3.1-pro" },
      ] });
    } },
  );
  assert.deepEqual(models, [{ id: "k3.1-pro", name: "k3.1-pro" }]);
});

test("picks a model actually listed for the connected subscription", () => {
  const accountModels = [{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol" }];
  assert.equal(
    chooseConnectedModelId(accountModels, "", "gpt-5.4", "gpt-5.4"),
    "gpt-6.1-sol",
  );
});
