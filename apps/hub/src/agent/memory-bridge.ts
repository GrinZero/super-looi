import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PersonalMemoryStore } from "./personal-memory.js";
import type { AgentCommandEvidence } from "./executor.js";

/** A revocable, per-worker capability. Never exposes the Hub's other credentials. */
export class MemoryToolBridge {
  private server?: HttpServer;
  private readonly grants = new Map<string, { active: boolean; discovered: boolean; executions: AgentCommandEvidence[] }>();
  private readonly transports = new Set<StreamableHTTPServerTransport>();
  private starting?: Promise<void>;
  private url = "";

  constructor(private readonly memory: PersonalMemoryStore) {}

  async grant(): Promise<{ url: string; receiptUrl: string; token: string; executions: AgentCommandEvidence[]; ready: () => boolean; revoke: () => void }> {
    this.starting ??= this.start();
    await this.starting;
    const token = randomBytes(32).toString("hex");
    const grant = { active: true, discovered: false, executions: [] as AgentCommandEvidence[] };
    this.grants.set(token, grant);
    return {
      url: this.url, receiptUrl: this.url.replace(/\/mcp$/, "/receipt"), token, executions: grant.executions, ready: () => grant.discovered,
      revoke: () => { grant.active = false; this.grants.delete(token); },
    };
  }

  private async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const grant = token ? this.grants.get(token) : undefined;
      if (req.headers.origin || !["/mcp", "/receipt"].includes(req.url ?? "") || !grant?.active) {
        res.writeHead(403).end(); return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      if (req.url === "/receipt") {
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 32768) throw new Error("Receipt too large");
          }
          if (!grant.active) throw new Error("Capability revoked");
          const receipt = JSON.parse(body) as AgentCommandEvidence;
          if (typeof receipt.callId !== "string" || typeof receipt.command !== "string" || !(receipt.exitCode === null || Number.isInteger(receipt.exitCode)) || !(receipt.signal === null || typeof receipt.signal === "string") || typeof receipt.aborted !== "boolean" || typeof receipt.timedOut !== "boolean") throw new Error("Invalid receipt");
          grant.executions.push(receipt);
          res.writeHead(200).end();
        } catch { res.writeHead(400).end(); }
        return;
      }
      const mcp = new Server({ name: "looi-memory", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => {
        grant.discovered = true;
        return { tools: [{
          name: "memory", description: "记住、回忆或删除用户的个人记忆。物品位置、偏好和备忘使用此工具；不可编造记忆已保存。",
          inputSchema: { type: "object", properties: {
            action: { type: "string", enum: ["remember", "recall", "forget"] },
            fact: { type: "string" }, subject: { type: "string" }, location: { type: "string" }, query: { type: "string" },
          }, required: ["action"], additionalProperties: false },
        }] };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        if (!grant.active) throw new Error("Task capability revoked");
        if (params.name !== "memory") throw new Error("Unknown tool");
        const args = params.arguments ?? {};
        for (const key of ["fact", "subject", "location", "query"]) {
          if (args[key] !== undefined && (typeof args[key] !== "string" || (args[key] as string).length > 8000)) throw new Error(`Invalid ${key}`);
        }
        let value: unknown;
        if (args.action === "recall") value = this.memory.recall(args.query as string | undefined);
        else if (args.action === "remember" && typeof args.fact === "string") value = await this.memory.remember({
          fact: args.fact, subject: args.subject as string | undefined, location: args.location as string | undefined, source: "agent",
        });
        else if (args.action === "forget" && typeof args.query === "string" && args.query.trim()) value = this.memory.forget(args.query);
        else throw new Error("Invalid memory action or required argument");
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      this.transports.add(transport);
      res.on("close", () => { this.transports.delete(transport); void mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Memory bridge failed to bind");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  async close(): Promise<void> {
    for (const grant of this.grants.values()) grant.active = false;
    this.grants.clear();
    await Promise.allSettled([...this.transports].map(transport => transport.close()));
    if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }
}
