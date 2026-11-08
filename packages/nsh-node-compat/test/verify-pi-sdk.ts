import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import { assert, equal } from "./assert.js";
const cwd = "/workspace/sdk";
fs.mkdirSync(cwd, { recursive: true });
const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
runtime.registerNativeProvider(faux.provider);
const settings = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: "/home/sdk-agent",
  settingsManager: settings,
  noExtensions: true,
  noThemes: true,
});
await loader.reload();
const sessionManager = SessionManager.create(cwd, "/workspace/sdk-sessions");
const { session } = await createAgentSession({
  cwd,
  agentDir: "/home/sdk-agent",
  modelRuntime: runtime,
  model: faux.getModel(),
  settingsManager: settings,
  resourceLoader: loader,
  sessionManager,
  tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
});
let calls = 0;
const steps: Array<[string, Record<string, unknown>]> = [
  ["write", { path: "sdk.txt", content: "original\n" }],
  ["read", { path: "sdk.txt" }],
  [
    "edit",
    { path: "sdk.txt", edits: [{ oldText: "original", newText: "updated" }] },
  ],
  ["ls", { path: "." }],
  ["find", { pattern: "*.txt" }],
  ["grep", { pattern: "updated", path: "." }],
  ["bash", { command: "cat sdk.txt | grep updated" }],
];
faux.setResponses([
  ...steps.map(([name, args], index) => (context: any) => {
    if (index > 0) {
      const previous = resolveTranscript(context, undefined).messages.at(-1);
      assert(
        previous?.role === "toolResult" && !previous.isError,
        JSON.stringify(previous),
      );
    }
    calls++;
    return fauxAssistantMessage(fauxToolCall(name, args), {
      stopReason: "toolUse",
    });
  }),
  (context: any) => {
    const previous = resolveTranscript(context, undefined).messages.at(-1);
    assert(
      previous?.role === "toolResult" && !previous.isError,
      JSON.stringify(previous),
    );
    return fauxAssistantMessage("SDK seven tools completed");
  },
]);
try {
  await session.prompt("Run all seven sandbox coding tools");
  const results = session.state.messages.filter(
    (message) => message.role === "toolResult",
  ) as any[];
  equal(calls, 7, JSON.stringify(results.at(-1)));
  equal(results.length, 7);
  for (const [index, expected] of [
    "wrote",
    "original",
    "replaced",
    "sdk.txt",
    "sdk.txt",
    "updated",
    "updated",
  ].entries()) {
    assert(
      !results[index].isError &&
        results[index].content.some(
          (item: any) => item.type === "text" && item.text.includes(expected),
        ),
      JSON.stringify(results[index]),
    );
  }
  equal(fs.readFileSync(`${cwd}/sdk.txt`, "utf8"), "updated\n");
  const file = sessionManager.getSessionFile();
  assert(file && fs.existsSync(file));
  const restored = SessionManager.open(file);
  assert(
    restored.buildSessionContext().messages.length >= 16,
    "SDK transcript should include tool rounds",
  );
} finally {
  session.dispose();
}
console.log(
  "PASS pi-coding-agent@1.5.0 SDK: actual createAgentSession + ModelRuntime + DefaultResourceLoader, seven default tools and JSONL recovery",
);
