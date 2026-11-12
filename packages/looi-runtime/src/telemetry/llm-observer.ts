import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { LangfuseTracer, TraceContext } from "./langfuse.js";

export function wrapStreamFnWithLangfuse(baseStreamFn: StreamFn, options: {
  tracer: LangfuseTracer;
  getTraceContext: () => TraceContext | undefined;
  onGeneration?: (context: TraceContext) => void;
}): (...args: Parameters<StreamFn>) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model, context, streamOptions) => {
    const system = context.messages[0]?.role === "system" ? context.messages[0] : undefined;
    const observation = options.tracer.start("llm.chat", "generation", options.getTraceContext(), {
      "langfuse.observation.model.name": model.id,
      "langfuse.observation.model.parameters": { samplingParams: model.samplingParams, thinkingLevel: streamOptions?.reasoning },
      "langfuse.observation.input": { systemPrompt: system?.content, messages: context.messages, tools: system?.toolsAdded },
    });
    if (options.tracer.enabled) options.onGeneration?.(observation.context);
    let requestPayload: unknown;
    const observedOptions = { ...streamOptions, onPayload: async (payload: unknown, requestModel: Model<Api>) => {
      const replacement = await streamOptions?.onPayload?.(payload, requestModel);
      requestPayload = structuredClone(replacement ?? payload);
      return replacement;
    } };
    const requestAttributes = () => requestPayload === undefined ? {} : { "langfuse.observation.metadata.request": requestPayload };
    const target = createAssistantMessageEventStream();
    void (async () => {
      let firstDelta: number | undefined;
      try {
        const source = await baseStreamFn(model, context, observedOptions);
        for await (const event of source) {
          if (!firstDelta && ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type)) firstDelta = Date.now();
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            observation.end({ ...requestAttributes(), ...observationResult(model, message, firstDelta) });
          }
          target.push(event);
        }
        target.end(await source.result());
      } catch (error) {
        observation.end({ ...requestAttributes(), "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": String(error) });
        const failed = {
          role: "assistant", content: [], api: model.api, provider: model.provider,
          model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: String(error), timestamp: Date.now(),
        } as AssistantMessage;
        target.push({ type: "error", reason: "error", error: failed });
        target.end(failed);
      }
    })();
    return target;
  };
}

function observationResult(model: Model<Api>, message: AssistantMessage, firstDelta?: number) {
  const usage = message.usage;
  const priced = usage.cost.totalFromProvider === true || [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((value) => value > 0);
  return {
    "langfuse.observation.output": message.content,
    ...(message.stopReason === "aborted" ? { "langfuse.observation.metadata.cancelled": true } : {}),
    ...(firstDelta ? { "langfuse.observation.completion_start_time": firstDelta } : {}),
    "langfuse.observation.usage_details": {
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite, total: usage.totalTokens,
      ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    },
    ...(priced ? { "langfuse.observation.cost_details": {
      input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite, total: usage.cost.total,
    } } : {}),
    ...(message.stopReason === "error" ? {
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message": message.errorMessage || "LLM request failed",
    } : {}),
  };
}
