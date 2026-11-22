import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AiTurnDraft,
  Dispose,
  EffectScope,
  PluginAiCapability,
  PluginManifest,
  PluginPermission,
  PluginTaskContext,
  PluginVoiceTool,
  ToolCallBailResult,
  UserTurnBailResult,
} from "./contracts.js";
import { extractPluginFailure, PluginKernelError } from "./errors.js";

export const VOICE_WATERFALL_BUDGET_MS = 80;
export const TASK_WATERFALL_BUDGET_MS = 1500;

export interface DualLoopAiBusBridge {
  speak?: (options: {
    pluginId: string;
    spokenText: string;
    contextNote?: string;
    delivery: "when_idle" | "interrupt";
    capturePolicy?: "duplex" | "muted_broadcast";
    verbatim?: boolean;
    holdAliveMs?: number;
    closeToStandbyOnComplete?: boolean;
  }) => Promise<{ readonly completed: boolean; readonly interruptedReason?: string }>;
  runBackgroundTask?: (options: {
    pluginId: string;
    prompt: string;
  }) => Promise<{ readonly taskId: string; readonly answer: string }>;
  onVoiceContextUpdated?: (summaryPrompt: string) => void;
  onVoiceToolsUpdated?: () => void;
}

interface RegisteredSlice {
  readonly pluginId: string;
  summary: string;
  readonly priority: number;
}

interface RegisteredPersona {
  readonly pluginId: string;
  readonly mode: "append_rules" | "stage_persona";
  readonly instructions: string;
}

type TurnAssemblerFn = (
  draft: AiTurnDraft,
  signal: AbortSignal,
  next: (draft: AiTurnDraft) => Promise<AiTurnDraft>,
) => Promise<AiTurnDraft>;

interface RegisteredAssembler {
  readonly pluginId: string;
  readonly fn: TurnAssemblerFn;
}

interface RegisteredUserGuard {
  readonly pluginId: string;
  readonly fn: (input: { channel: "voice" | "task"; text: string }) => Promise<UserTurnBailResult> | UserTurnBailResult;
}

interface RegisteredToolGuard {
  readonly pluginId: string;
  readonly fn: (call: {
    channel: "voice" | "task";
    toolName: string;
    approvalMode: string;
    arguments: Record<string, unknown>;
  }) => Promise<ToolCallBailResult> | ToolCallBailResult;
}

interface RegisteredContribution {
  readonly pluginId: string;
  readonly voiceTools?: readonly PluginVoiceTool[];
  readonly taskTools?: (context: PluginTaskContext) => readonly AgentTool<any>[];
  readonly skillPaths?: readonly string[];
}

function assertPermission(manifest: PluginManifest, required: PluginPermission, stage: string): void {
  if (!manifest.permissions.includes(required)) {
    throw new PluginKernelError({
      stage,
      code: "ERR_PLUGIN_PERMISSION_DENIED",
      pluginId: manifest.id,
      reason: `Plugin "${manifest.id}" has not declared required permission "${required}"`,
    });
  }
}

export class DualLoopAiBus {
  private readonly slices = new Set<RegisteredSlice>();
  private readonly personas = new Set<RegisteredPersona>();
  private readonly assemblers = new Set<RegisteredAssembler>();
  private readonly userGuards = new Set<RegisteredUserGuard>();
  private readonly toolGuards = new Set<RegisteredToolGuard>();
  private readonly contributions = new Set<RegisteredContribution>();
  private bridge: DualLoopAiBusBridge;

  constructor(
    private readonly getForegroundStagePluginId: () => string | null = () => null,
    bridge: DualLoopAiBusBridge = {},
  ) {
    this.bridge = bridge;
  }

  setBridge(next: DualLoopAiBusBridge): void {
    this.bridge = { ...this.bridge, ...next };
  }

  private sortByPriority<T extends { readonly pluginId: string }>(entries: Iterable<T>): T[] {
    const fg = this.getForegroundStagePluginId();
    return [...entries].sort((a, b) => {
      if (a.pluginId === fg && b.pluginId !== fg) return -1;
      if (b.pluginId === fg && a.pluginId !== fg) return 1;
      return 0;
    });
  }

  private notifyAmbientChanged(): void {
    this.bridge.onVoiceContextUpdated?.(this.renderAmbientInstructions());
  }

  /** Called by PluginHost when foreground stage ownership changes so active voice sessions sync persona overlays. */
  notifyStageChanged(): void {
    this.notifyAmbientChanged();
  }

  renderAmbientInstructions(): string {
    const fg = this.getForegroundStagePluginId();
    const parts: string[] = [];

    for (const persona of this.sortByPriority(this.personas)) {
      if (persona.mode === "stage_persona" && persona.pluginId !== fg) {
        continue;
      }
      if (persona.instructions.trim()) {
        parts.push(`[Plugin:${persona.pluginId} Persona]\n${persona.instructions.trim()}`);
      }
    }

    const orderedSlices = [...this.slices].sort((a, b) => b.priority - a.priority);
    for (const slice of orderedSlices) {
      if (slice.summary.trim()) {
        parts.push(slice.summary.trim());
      }
    }

    return parts.join("\n");
  }

  taskContribution(context: PluginTaskContext): { tools: AgentTool<any>[]; skillPaths: string[] } {
    const active = [...this.contributions];
    return {
      tools: active.flatMap((entry) => (entry.taskTools ? [...entry.taskTools(context)] : [])),
      skillPaths: active.flatMap((entry) => [...(entry.skillPaths ?? [])]),
    };
  }

  voiceTools(): PluginVoiceTool[] {
    return [...this.contributions].flatMap((entry) =>
      (entry.voiceTools ?? []).map((rawTool): PluginVoiceTool => ({
        name: rawTool.name,
        description: rawTool.description,
        parametersJsonSchema: rawTool.parametersJsonSchema,
        execute: async (params, context) => {
          if (!this.contributions.has(entry)) {
            throw new PluginKernelError({
              stage: `plugin:${entry.pluginId}:voice_tool`,
              code: "ERR_PLUGIN_TOOL_INACTIVE",
              pluginId: entry.pluginId,
              reason: `Voice tool "${rawTool.name}" belongs to an inactive plugin or disposed scope`,
            });
          }
          return rawTool.execute(params, context);
        },
      })),
    );
  }

  /**
   * Executes `bail` short-circuit user turn guards.
   * Fail-Closed: if a guard throws, blocks the turn and preserves exact plugin failure stage, code, and cause.
   */
  async evaluateUserTurn(input: {
    channel: "voice" | "task";
    text: string;
  }): Promise<(Exclude<UserTurnBailResult, undefined> & { readonly pluginId: string }) | undefined> {
    for (const guard of this.sortByPriority(this.userGuards)) {
      try {
        const outcome = await guard.fn(input);
        if (outcome !== undefined) {
          return { ...outcome, pluginId: guard.pluginId };
        }
      } catch (error) {
        const defaultStage = `${guard.pluginId}:ai.interceptUserTurn`;
        const failure = extractPluginFailure(error, defaultStage, "ERR_PLUGIN_USER_TURN_GUARD_FAILED");
        return {
          decision: "block",
          pluginId: guard.pluginId,
          stage: failure.stage,
          code: failure.code !== undefined ? String(failure.code) : "ERR_PLUGIN_USER_TURN_GUARD_FAILED",
          reason: `[${failure.stage}] ${failure.reason}`,
          cause: error,
        };
      }
    }
    return undefined;
  }

  /**
   * Evaluates all tool call guards with monotonic severity (`deny > ask > allow > undefined`).
   * Only `deny` (or a thrown guard error, Fail-Closed) short-circuits immediately;
   * an upstream `"allow"` never skips downstream `"ask"` or `"deny"` guards.
   */
  async evaluateToolCall(call: {
    channel: "voice" | "task";
    toolName: string;
    approvalMode: string;
    arguments: Record<string, unknown>;
  }): Promise<(Exclude<ToolCallBailResult, undefined> & { readonly pluginId: string }) | undefined> {
    let pendingAsk: (Extract<ToolCallBailResult, { decision: "ask" }> & { readonly pluginId: string }) | undefined;
    let pendingAllow: (Extract<ToolCallBailResult, { decision: "allow" }> & { readonly pluginId: string }) | undefined;

    for (const guard of this.sortByPriority(this.toolGuards)) {
      try {
        const outcome = await guard.fn(call);
        if (!outcome) continue;
        if (outcome.decision === "deny") {
          return { ...outcome, pluginId: guard.pluginId };
        }
        if (outcome.decision === "ask") {
          if (!pendingAsk) {
            pendingAsk = { ...outcome, pluginId: guard.pluginId };
          }
        } else if (outcome.decision === "allow") {
          if (!pendingAllow) {
            pendingAllow = { ...outcome, pluginId: guard.pluginId };
          }
        }
      } catch (error) {
        const defaultStage = `${guard.pluginId}:ai.interceptToolCall`;
        const failure = extractPluginFailure(error, defaultStage, "ERR_PLUGIN_TOOL_GUARD_FAILED");
        return {
          decision: "deny",
          pluginId: guard.pluginId,
          stage: failure.stage,
          code: failure.code !== undefined ? String(failure.code) : "ERR_PLUGIN_TOOL_GUARD_FAILED",
          reason: `[${failure.stage}] ${failure.reason}`,
          cause: error,
        };
      }
    }
    return pendingAsk ?? pendingAllow;
  }

  /**
   * Executes `waterfall` onion-style context assembly bounded by channel deadline
   * (80ms for real-time voice, 1500ms for background task).
   * If a plugin assembler times out or throws, skips only that assembler's mutation without stalling the turn.
   */
  async assembleTurn(options: {
    channel: "voice" | "task";
    userText: string;
    budgetMs?: number;
    includeAmbientBase?: boolean;
    onAssemblerSkipped?: (info: { pluginId: string; stage: string; reason: string }) => void;
  }): Promise<AiTurnDraft> {
    const budgetMs =
      options.budgetMs ??
      (options.channel === "voice" ? VOICE_WATERFALL_BUDGET_MS : TASK_WATERFALL_BUDGET_MS);
    const includeAmbientBase = options.includeAmbientBase ?? (options.channel === "task");

    let baseBlocks: Array<{ pluginId: string; priority: number; text: string }> = [];
    if (includeAmbientBase) {
      const fg = this.getForegroundStagePluginId();
      const personaBlocks: Array<{ pluginId: string; priority: number; text: string }> = [];
      for (const persona of this.sortByPriority(this.personas)) {
        if (persona.mode === "stage_persona" && persona.pluginId !== fg) continue;
        personaBlocks.push({
          pluginId: persona.pluginId,
          priority: persona.pluginId === fg ? 2000 : 1000,
          text: persona.instructions,
        });
      }

      const sliceBlocks = [...this.slices]
        .sort((a, b) => b.priority - a.priority)
        .map((s) => ({ pluginId: s.pluginId, priority: s.priority, text: s.summary }));

      baseBlocks = [...personaBlocks, ...sliceBlocks];
    }

    const initialDraft: AiTurnDraft = {
      channel: options.channel,
      userText: options.userText,
      contextBlocks: baseBlocks,
      ephemeralImages: [],
    };

    const chain = this.sortByPriority(this.assemblers);
    if (chain.length === 0) return initialDraft;

    const dispatch = async (index: number, current: AiTurnDraft): Promise<AiTurnDraft> => {
      if (index >= chain.length) return current;
      const entry = chain[index];
      const snapshotBefore: AiTurnDraft = {
        ...current,
        contextBlocks: [...current.contextBlocks],
        ephemeralImages: [...current.ephemeralImages],
      };

      const controller = new AbortController();
      let preTimer: ReturnType<typeof setTimeout> | undefined;
      let postTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveTimeout!: (tag: "pre" | "post") => void;
      const timeoutRace = new Promise<"pre" | "post">((resolve) => {
        resolveTimeout = resolve;
      });
      let nextCalled = false;
      let preTimedOut = false;
      let downstreamPromise: Promise<AiTurnDraft> | undefined;
      let downstreamResult: AiTurnDraft | undefined;

      const wrappedNext = (passedDraft: AiTurnDraft): Promise<AiTurnDraft> => {
        if (preTimedOut) {
          return Promise.resolve(passedDraft);
        }
        if (!nextCalled) {
          nextCalled = true;
          if (preTimer !== undefined) {
            clearTimeout(preTimer);
            preTimer = undefined;
          }
          downstreamPromise = dispatch(index + 1, passedDraft).then((res) => {
            downstreamResult = res;
            postTimer = setTimeout(() => {
              controller.abort(new Error(`Exceeded ${budgetMs}ms post-next waterfall budget`));
              resolveTimeout("post");
            }, budgetMs);
            return res;
          });
        }
        return downstreamPromise!;
      };

      preTimer = setTimeout(() => {
        if (!nextCalled) {
          preTimedOut = true;
          controller.abort(new Error(`Exceeded ${budgetMs}ms waterfall budget`));
          resolveTimeout("pre");
        }
      }, budgetMs);

      const fnPromise = Promise.resolve().then(() => entry.fn(current, controller.signal, wrappedNext));

      try {
        const outcome = await Promise.race([fnPromise, timeoutRace]);

        if (outcome === "pre") {
          void fnPromise.catch(() => {});
          options.onAssemblerSkipped?.({
            pluginId: entry.pluginId,
            stage: "plugin.ai.waterfall.timeout",
            reason: `Assembler exceeded ${budgetMs}ms deadline before next() on channel "${options.channel}"`,
          });
          return dispatch(index + 1, snapshotBefore);
        }

        if (outcome === "post") {
          void fnPromise.catch(() => {});
          options.onAssemblerSkipped?.({
            pluginId: entry.pluginId,
            stage: "plugin.ai.waterfall.timeout",
            reason: `Assembler exceeded ${budgetMs}ms deadline after next() on channel "${options.channel}"`,
          });
          return downstreamResult ?? snapshotBefore;
        }

        return outcome;
      } catch (error) {
        options.onAssemblerSkipped?.({
          pluginId: entry.pluginId,
          stage: "plugin.ai.waterfall.error",
          reason: error instanceof Error ? error.message : String(error),
        });
        if (downstreamResult) return downstreamResult;
        if (downstreamPromise) return downstreamPromise;
        return dispatch(index + 1, snapshotBefore);
      } finally {
        if (preTimer !== undefined) clearTimeout(preTimer);
        if (postTimer !== undefined) clearTimeout(postTimer);
      }
    };

    return dispatch(0, initialDraft);
  }

  createScopedCapability(manifest: PluginManifest, defaultScope: EffectScope): PluginAiCapability | undefined {
    const hasAnyAiPermission = manifest.permissions.some((p) => p.startsWith("ai."));
    if (!hasAnyAiPermission) return undefined;

    return {
      useContextSlice: (slice, scope = defaultScope) => {
        assertPermission(manifest, "ai.context", "plugin.ai.useContextSlice");
        const record: RegisteredSlice = {
          pluginId: manifest.id,
          summary: slice.summary,
          priority: slice.priority ?? 0,
        };
        this.slices.add(record);
        this.notifyAmbientChanged();
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          this.slices.delete(record);
          this.notifyAmbientChanged();
        };
        const detach = scope.onDispose(remove);
        const dispose = () => {
          detach();
          remove();
        };
        return Object.assign(dispose, {
          updateSummary: (summary: string) => {
            if (!scope.active || removed || record.summary === summary) return;
            record.summary = summary;
            this.notifyAmbientChanged();
          },
        });
      },

      usePersonaOverlay: (overlay, scope = defaultScope): Dispose => {
        assertPermission(manifest, "ai.context", "plugin.ai.usePersonaOverlay");
        const record: RegisteredPersona = {
          pluginId: manifest.id,
          mode: overlay.mode,
          instructions: overlay.instructions,
        };
        this.personas.add(record);
        this.notifyAmbientChanged();
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          this.personas.delete(record);
          this.notifyAmbientChanged();
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },

      useTurnAssembler: (middleware, scope = defaultScope): Dispose => {
        assertPermission(manifest, "ai.context", "plugin.ai.useTurnAssembler");
        const record: RegisteredAssembler = { pluginId: manifest.id, fn: middleware };
        this.assemblers.add(record);
        const remove = () => {
          this.assemblers.delete(record);
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },

      interceptUserTurn: (guard, scope = defaultScope): Dispose => {
        assertPermission(manifest, "ai.intercept", "plugin.ai.interceptUserTurn");
        const record: RegisteredUserGuard = { pluginId: manifest.id, fn: guard };
        this.userGuards.add(record);
        const remove = () => {
          this.userGuards.delete(record);
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },

      interceptToolCall: (guard, scope = defaultScope): Dispose => {
        assertPermission(manifest, "ai.intercept", "plugin.ai.interceptToolCall");
        const record: RegisteredToolGuard = { pluginId: manifest.id, fn: guard };
        this.toolGuards.add(record);
        const remove = () => {
          this.toolGuards.delete(record);
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },

      useContribution: (contribution, scope = defaultScope): Dispose => {
        assertPermission(manifest, "ai.tools", "plugin.ai.useContribution");
        const record: RegisteredContribution = {
          pluginId: manifest.id,
          voiceTools: contribution.voiceTools,
          taskTools: contribution.taskTools,
          skillPaths: contribution.skillPaths,
        };
        const hasVoiceTools = Boolean(contribution.voiceTools && contribution.voiceTools.length > 0);
        this.contributions.add(record);
        if (hasVoiceTools) {
          this.bridge.onVoiceToolsUpdated?.();
        }
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          this.contributions.delete(record);
          if (hasVoiceTools) {
            this.bridge.onVoiceToolsUpdated?.();
          }
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },

      speak: async (options) => {
        assertPermission(manifest, "ai.proactive", "plugin.ai.speak");
        if (!defaultScope.active) {
          throw new PluginKernelError({
            stage: "plugin.ai.speak",
            code: "ERR_PLUGIN_INACTIVE",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" is not active`,
          });
        }
        if (!this.bridge.speak) {
          throw new PluginKernelError({
            stage: "plugin.ai.speak",
            code: "ERR_VOICE_BRIDGE_UNAVAILABLE",
            pluginId: manifest.id,
            reason: "Host voice playback bridge is not attached",
          });
        }
        return this.bridge.speak({
          pluginId: manifest.id,
          spokenText: options.spokenText,
          contextNote: options.contextNote,
          delivery: options.delivery ?? "when_idle",
          ...(options.capturePolicy !== undefined ? { capturePolicy: options.capturePolicy } : {}),
          ...(options.verbatim !== undefined ? { verbatim: options.verbatim } : {}),
          ...(options.holdAliveMs !== undefined ? { holdAliveMs: options.holdAliveMs } : {}),
          ...(options.closeToStandbyOnComplete !== undefined
            ? { closeToStandbyOnComplete: options.closeToStandbyOnComplete }
            : {}),
        });
      },

      runBackgroundTask: async (prompt: string) => {
        assertPermission(manifest, "ai.proactive", "plugin.ai.runBackgroundTask");
        if (!defaultScope.active) {
          throw new PluginKernelError({
            stage: "plugin.ai.runBackgroundTask",
            code: "ERR_PLUGIN_INACTIVE",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" is not active`,
          });
        }
        if (!this.bridge.runBackgroundTask) {
          throw new PluginKernelError({
            stage: "plugin.ai.runBackgroundTask",
            code: "ERR_TASK_BRIDGE_UNAVAILABLE",
            pluginId: manifest.id,
            reason: "Host task execution bridge is not attached",
          });
        }
        return this.bridge.runBackgroundTask({ pluginId: manifest.id, prompt });
      },
    };
  }
}
