import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import fs from "node:fs";
import path from "node:path";
import { assert } from "./assert.js";

/** Test-only real SDK/network path; credentials never enter a disk credential store. */
export async function verifySdkLive(config: {
  baseUrl: string;
  model: string;
  apiKey: string;
}) {
  const cwd = "/workspace/native-sdk-live";
  fs.mkdirSync(cwd, { recursive: true });
  const model = {
    id: config.model,
    name: config.model,
    api: "openai-completions" as const,
    provider: "native-live",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens" as const,
    },
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(
    createProvider({
      id: "native-live",
      name: "Native test",
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { apiKey: config.apiKey } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: "/home/native-sdk-live",
    settingsManager: settings,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  const manager = SessionManager.create(cwd, "/home/native-sdk-live-sessions");
  const { session } = await createAgentSession({
    cwd,
    agentDir: "/home/native-sdk-live",
    modelRuntime: runtime,
    model,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
  });
  try {
    await session.prompt(
      "Use the write tool to create live-proof.txt containing exactly OK. Do not use other tools. After the write tool confirms success, reply exactly OK.",
    );
    await session.prompt(
      "Independently verify the file on disk: use the read tool on live-proof.txt now, even though you wrote it earlier. Do not infer its contents or use other tools. After the read tool returns, reply exactly OK.",
    );
    const messages = session.state.messages;
    const calls = new Map<
      string,
      { name: string; path: string; index: number }
    >();
    let writtenAt = -1,
      readBack = false;
    for (const [index, message] of messages.entries()) {
      if (message.role === "assistant") {
        for (const part of message.content)
          if (part.type === "toolCall")
            calls.set(part.id, {
              name: part.name,
              path: path.resolve(cwd, String(part.arguments.path ?? "")),
              index,
            });
      } else if (message.role === "toolResult" && !message.isError) {
        const call = calls.get(message.toolCallId);
        if (
          !call ||
          call.path !== `${cwd}/live-proof.txt` ||
          call.index >= index
        )
          continue;
        if (call.name === "write" && message.toolName === "write")
          writtenAt = index;
        if (
          call.name === "read" &&
          message.toolName === "read" &&
          writtenAt >= 0 &&
          index > writtenAt
        )
          readBack = message.content.some(
            (part) => part.type === "text" && /\bOK\b/.test(part.text),
          );
      }
    }
    assert(writtenAt >= 0, "Native SDK proof write was not confirmed");
    assert(
      readBack,
      "Native SDK proof read did not follow the confirmed write",
    );
    assert(
      fs.readFileSync(`${cwd}/live-proof.txt`, "utf8").trim() === "OK",
      "Native SDK file mismatch",
    );
    const last = messages.at(-1);
    assert(
      last?.role === "assistant" &&
        last.stopReason === "stop" &&
        last.content.some(
          (part) => part.type === "text" && part.text.trim() === "OK",
        ),
      "Native SDK completion failed",
    );
    const file = manager.getSessionFile();
    assert(file, "Native SDK session file is missing");
    const recovered = SessionManager.open(file).buildSessionContext().messages;
    const results = messages.filter((message) => message.role === "toolResult");
    assert(
      results.every((result) =>
        recovered.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === result.toolCallId &&
            JSON.stringify(message.content) === JSON.stringify(result.content),
        ),
      ),
      "Native SDK recovered tool receipts differ",
    );
    const recoveredFinal = recovered.at(-1);
    assert(
      recoveredFinal?.role === "assistant" &&
        JSON.stringify(recoveredFinal.content) === JSON.stringify(last.content),
      "Native SDK final answer was not persisted",
    );
  } finally {
    session.dispose();
  }
}
