import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  LLM_PROVIDER_CATALOG,
  parseModelVaultEnvelope,
  serializeModelVaultEnvelope,
  resolveProviderBaseUrl,
  VaultCredentialStore,
  createLooiModelsRegistry,
  syncLooiModelsRegistry,
  registerLooiBundledOAuthFlows,
  type BackingVault,
  type ModelVaultEnvelope,
} from "../src/agent/llm-providers.js";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

test("1. LLM Provider Catalog integrity and Zhipu/Z.AI endpoint distinction", () => {
  const brandIds = LLM_PROVIDER_CATALOG.map((b) => b.brandId);
  assert.deepEqual(brandIds, [
    "openai",
    "kimi",
    "minimax",
    "xiaomi",
    "zai",
    "custom",
  ]);

  const zaiBrand = LLM_PROVIDER_CATALOG.find((b) => b.brandId === "zai");
  assert.ok(zaiBrand);
  assert.equal(zaiBrand.label, "智谱 / Z.AI");
  assert.equal(zaiBrand.shortLabel, "智谱");

  const zaiChannelIds = zaiBrand.channels.map((c) => c.providerId);
  assert.deepEqual(zaiChannelIds, [
    "zai-cn",
    "zai-intl",
    "zai-coding-cn",
    "zai",
  ]);

  // zai-cn is first (default) and points to standard BigModel PAAS v4
  const zaiCn = zaiBrand.channels[0];
  assert.equal(zaiCn.providerId, "zai-cn");
  assert.equal(zaiCn.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(zaiCn.protocolLabel, "OpenAI Chat Completions");
  assert.deepEqual(zaiCn.authTypes, ["api_key"]);

  // zai-intl points to standard international Z.AI PAAS v4
  const zaiIntl = zaiBrand.channels[1];
  assert.equal(zaiIntl.providerId, "zai-intl");
  assert.equal(zaiIntl.baseUrl, "https://api.z.ai/api/paas/v4");

  // Coding plan endpoints
  const zaiCodingCn = zaiBrand.channels[2];
  assert.equal(zaiCodingCn.providerId, "zai-coding-cn");
  assert.equal(zaiCodingCn.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");

  const zaiCodingIntl = zaiBrand.channels[3];
  assert.equal(zaiCodingIntl.providerId, "zai");
  assert.equal(zaiCodingIntl.baseUrl, "https://api.z.ai/api/coding/paas/v4");

  // Verify resolveProviderBaseUrl mappings
  assert.equal(
    resolveProviderBaseUrl("zai-cn"),
    "https://open.bigmodel.cn/api/paas/v4",
  );
  assert.equal(
    resolveProviderBaseUrl("zai-coding-cn"),
    "https://open.bigmodel.cn/api/coding/paas/v4",
  );
  assert.equal(
    resolveProviderBaseUrl("zai-intl"),
    "https://api.z.ai/api/paas/v4",
  );
  assert.equal(
    resolveProviderBaseUrl("zai"),
    "https://api.z.ai/api/coding/paas/v4",
  );
  assert.equal(
    resolveProviderBaseUrl("openai"),
    "https://api.openai.com/v1",
  );
  assert.equal(
    resolveProviderBaseUrl("kimi-coding"),
    "https://api.kimi.com/coding/v1",
  );
  assert.equal(
    resolveProviderBaseUrl("minimax-cn"),
    "https://api.minimaxi.com/anthropic",
  );
  assert.equal(
    resolveProviderBaseUrl("xiaomi"),
    "https://api.xiaomimimo.com/v1",
  );
  assert.equal(resolveProviderBaseUrl("custom"), undefined);

  // Verify registry contains correctly configured models
  const dummyVault: BackingVault = {
    get: () => "",
    set: () => {},
  };
  const store = new VaultCredentialStore(dummyVault);
  const models = createLooiModelsRegistry(store);

  const zaiCnModel = models.getModel("zai-cn", "glm-5.3");
  assert.ok(zaiCnModel);
  assert.equal(zaiCnModel.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(zaiCnModel.provider, "zai-cn");

  const zaiCodingCnModel = models.getModel("zai-coding-cn", "glm-5.3");
  assert.ok(zaiCodingCnModel);
  assert.equal(
    zaiCodingCnModel.baseUrl,
    "https://open.bigmodel.cn/api/coding/paas/v4",
  );
  assert.equal(zaiCodingCnModel.provider, "zai-coding-cn");
});

test("2. Legacy envelope migration, mirror fields preservation, and vault failure rollback", async () => {
  // Test empty/invalid input
  const empty = parseModelVaultEnvelope("");
  assert.equal(empty.version, 2);
  assert.ok(empty.deviceId);
  assert.ok(empty.conversationId.startsWith("session_"));
  assert.deepEqual(empty.credentials, {});

  // Test legacy format: { baseUrl, model, apiKey, conversationId }
  const legacyRaw = JSON.stringify({
    baseUrl: "https://compat.proxy.org/v1",
    model: "legacy-gpt",
    apiKey: "sk-legacy-secret",
    conversationId: "session_retained_123",
  });
  const migrated = parseModelVaultEnvelope(legacyRaw);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.conversationId, "session_retained_123");
  assert.deepEqual(migrated.custom, {
    api: "openai-completions",
    baseUrl: "https://compat.proxy.org/v1",
    modelId: "legacy-gpt",
  });
  assert.deepEqual(migrated.credentials.custom, {
    type: "api_key",
    key: "sk-legacy-secret",
  });
  assert.deepEqual(migrated.active, {
    providerId: "custom",
    modelId: "legacy-gpt",
    authType: "api_key",
  });

  // Verify serializeModelVaultEnvelope mirrors top-level model and baseUrl
  const serializedStr = serializeModelVaultEnvelope(migrated);
  const mirrorParsed = JSON.parse(serializedStr);
  assert.equal(mirrorParsed.model, "legacy-gpt");
  assert.equal(mirrorParsed.baseUrl, "https://compat.proxy.org/v1");
  assert.equal(mirrorParsed.conversationId, "session_retained_123");

  // When active is switched to preset provider (e.g. openai)
  migrated.active = {
    providerId: "openai",
    modelId: "gpt-5.4",
    authType: "api_key",
  };
  const serializedOpenAI = JSON.parse(serializeModelVaultEnvelope(migrated));
  assert.equal(serializedOpenAI.model, "gpt-5.4");
  assert.equal(serializedOpenAI.baseUrl, "https://api.openai.com/v1");

  // Test Vault failure rollback: if vault.set throws, state is not committed
  let slot = serializedStr;
  let failWrite = false;
  const vault: BackingVault = {
    get: (key) => (key === "model" ? slot : ""),
    set: (_key, val) => {
      if (failWrite) throw new Error("vault storage failure");
      slot = val;
    },
  };
  const store = new VaultCredentialStore(vault);

  failWrite = true;
  await assert.rejects(
    () =>
      store.modify("openai", async () => ({
        type: "api_key",
        key: "sk-fail-key",
      })),
    /vault storage failure/,
  );

  // Slot should be completely untouched
  assert.equal(slot, serializedStr);
  const readBack = store.readEnvelope();
  assert.equal(readBack.credentials.openai, undefined);

  // Now allow writing
  failWrite = false;
  await store.modify("openai", async () => ({
    type: "api_key",
    key: "sk-success-key",
  }));
  assert.equal(
    store.readEnvelope().credentials.openai?.type === "api_key" &&
      (store.readEnvelope().credentials.openai as any).key,
    "sk-success-key",
  );
  assert.equal(JSON.parse(slot).credentials.openai.key, "sk-success-key");
});

test("3. VaultCredentialStore, models registry, custom model injection, and 3-protocol switching", async () => {
  let vaultData = "";
  const vault: BackingVault = {
    get: (key) => (key === "model" ? vaultData : ""),
    set: (_key, val) => {
      vaultData = val;
    },
  };
  const store = new VaultCredentialStore(vault);
  const models = createLooiModelsRegistry(store);

  // 1. API key storage and resolution
  await store.modify("openai", async () => ({
    type: "api_key",
    key: "sk-openai-live",
  }));
  const openaiAuth = await models.getAuth("openai");
  assert.equal(openaiAuth?.auth?.apiKey, "sk-openai-live");
  assert.equal(openaiAuth?.source, "stored credential");

  // 2. Custom model injection for preset provider
  let envelope = store.updateEnvelope((draft) => ({
    ...draft,
    customModelsByProvider: {
      openai: ["custom-gpt-finetuned", "custom-gpt-experiment"],
    },
  }));
  syncLooiModelsRegistry(models, envelope);

  const customModel = models.getModel("openai", "custom-gpt-finetuned");
  assert.ok(customModel);
  assert.equal(customModel.id, "custom-gpt-finetuned");
  assert.equal(customModel.provider, "openai");
  assert.equal(customModel.baseUrl, "https://api.openai.com/v1");

  // 3. Custom provider switching between 3 protocols
  // Protocol 1: openai-completions
  envelope = store.updateEnvelope((draft) => ({
    ...draft,
    custom: {
      api: "openai-completions",
      baseUrl: "https://custom.endpoint/v1",
      modelId: "custom-completions-v1",
    },
  }));
  syncLooiModelsRegistry(models, envelope);

  const compModel = models.getModel("custom", "custom-completions-v1");
  assert.ok(compModel);
  assert.equal(compModel.api, "openai-completions");
  assert.equal(compModel.compat?.supportsDeveloperRole, false);
  assert.equal(compModel.compat?.maxTokensField, "max_tokens");

  // Protocol 2: openai-responses
  envelope = store.updateEnvelope((draft) => ({
    ...draft,
    custom: {
      api: "openai-responses",
      baseUrl: "https://custom.endpoint/v1",
      modelId: "custom-responses-v1",
    },
  }));
  syncLooiModelsRegistry(models, envelope);

  const respModel = models.getModel("custom", "custom-responses-v1");
  assert.ok(respModel);
  assert.equal(respModel.api, "openai-responses");

  // Protocol 3: anthropic-messages
  envelope = store.updateEnvelope((draft) => ({
    ...draft,
    custom: {
      api: "anthropic-messages",
      baseUrl: "https://custom.endpoint/anthropic",
      modelId: "custom-claude-v1",
    },
  }));
  syncLooiModelsRegistry(models, envelope);

  const anthModel = models.getModel("custom", "custom-claude-v1");
  assert.ok(anthModel);
  assert.equal(anthModel.api, "anthropic-messages");

  // Clear custom endpoint removes provider
  envelope = store.updateEnvelope((draft) => {
    delete draft.custom;
    return draft;
  });
  syncLooiModelsRegistry(models, envelope);
  assert.equal(models.getModel("custom", "custom-claude-v1"), undefined);
});

test("4. Statically registered OAuth flow with Kimi Code and vault persistence", async () => {
  registerLooiBundledOAuthFlows();

  let vaultData = "";
  const vault: BackingVault = {
    get: (key) => (key === "model" ? vaultData : ""),
    set: (_key, val) => {
      vaultData = val;
    },
  };
  const store = new VaultCredentialStore(vault);
  const models = createLooiModelsRegistry(store);

  const originalFetch = globalThis.fetch;
  let deviceAuthCalled = false;
  let tokenCalled = false;

  globalThis.fetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes("device_authorization")) {
      deviceAuthCalled = true;
      return new Response(
        JSON.stringify({
          device_code: "dev_mock_12345",
          user_code: "USER-CODE-XYZ",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete:
            "https://auth.kimi.com/device?code=USER-CODE-XYZ",
          interval: 0.01,
          expires_in: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("/api/oauth/token")) {
      tokenCalled = true;
      return new Response(
        JSON.stringify({
          access_token: "kimi_access_token_mock_test",
          refresh_token: "kimi_refresh_token_mock_test",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    let notifiedDeviceCode = "";
    const interaction = {
      signal: new AbortController().signal,
      prompt: async () => "",
      notify: (event: any) => {
        if (event.type === "device_code") {
          notifiedDeviceCode = event.userCode;
        }
      },
    };

    const credential = await models.login("kimi-coding", "oauth", interaction);
    assert.ok(deviceAuthCalled);
    assert.ok(tokenCalled);
    assert.equal(notifiedDeviceCode, "USER-CODE-XYZ");
    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "kimi_access_token_mock_test");
    assert.equal(credential.refresh, "kimi_refresh_token_mock_test");

    // Credential must be persisted in VaultCredentialStore and vault JSON
    const storedCred = await store.read("kimi-coding");
    assert.ok(storedCred);
    assert.equal(storedCred.type, "oauth");
    assert.equal((storedCred as any).access, "kimi_access_token_mock_test");

    const env = store.readEnvelope();
    assert.equal(
      (env.credentials["kimi-coding"] as any)?.access,
      "kimi_access_token_mock_test",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("5. PiAgentExecutor execution with modelsRegistry and providerId", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-executor-registry-"));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("Hello from registry executor!")]);

  let vaultData = "";
  const vault: BackingVault = {
    get: (key) => (key === "model" ? vaultData : ""),
    set: (_key, val) => {
      vaultData = val;
    },
  };
  const store = new VaultCredentialStore(vault);
  const models = createLooiModelsRegistry(store);

  // Register the faux provider into models registry
  models.setProvider(faux.provider);
  const fauxModelId = faux.getModel().id;

  // Test validation error: missing model
  const executorNoModel = new PiAgentExecutor({
    modelsRegistry: models,
    providerId: "faux",
  });
  await assert.rejects(
    () => executorNoModel.run("Hi", { sessionId: "s1" }),
    /requires a model when using modelsRegistry/,
  );

  // Test validation error: model not found
  const executorBadModel = new PiAgentExecutor({
    modelsRegistry: models,
    providerId: "faux",
    model: "non-existent-model",
  });
  await assert.rejects(
    () => executorBadModel.run("Hi", { sessionId: "s1" }),
    /Model non-existent-model not found in provider faux/,
  );

  // Test successful execution with modelsRegistry
  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "work"),
    modelsRegistry: models,
    providerId: "faux",
    model: fauxModelId,
  });

  try {
    const result = await executor.run("Greet me", { sessionId: "reg_session" });
    assert.ok(result.taskId);
    assert.equal(result.finishReason, "completed");
    assert.ok(result.answer.includes("Hello from registry executor!"));
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
