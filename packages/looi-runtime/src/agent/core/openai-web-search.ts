import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

interface UrlCitation {
  type: "url_citation";
  start_index: number;
  end_index: number;
  title: string;
  url: string;
}

interface OutputItem {
  id: string;
  type: string;
  status?: string;
  action?: unknown;
  content?: Array<{
    type: string;
    text?: string;
    refusal?: string;
    annotations?: Array<UrlCitation | { type: string }>;
  }>;
}

export interface HostedSearchEvent {
  phase: "start" | "end";
  callId: string;
  result?: { status?: string; action?: unknown };
}

/** Official OpenAI Responses requests, including the provider's ChatGPT OAuth path. */
export function hasOpenAIWebSearch(model: Model<Api>): boolean {
  return (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl === "https://api.openai.com/v1"
  );
}

/**
 * One task's hosted search hooks. Pi normalizes away hosted calls and URL
 * annotations, so retain their progress and turn citations into persisted links.
 */
export function createOpenAIWebSearch(
  onSearch: (event: HostedSearchEvent) => void,
): {
  onPayload: NonNullable<SimpleStreamOptions["onPayload"]>;
  onProviderStreamEvent: NonNullable<SimpleStreamOptions["onProviderStreamEvent"]>;
  decorateMessage: (message: AssistantMessage) => void;
} {
  const searches = new Set<string>();
  const replies = new Map<string, string>();

  return {
    onPayload(payload, model) {
      if (!hasOpenAIWebSearch(model)) return;
      const request = payload as { tools?: Array<{ type: string }> };
      if (request.tools?.some((tool) => tool.type === "web_search")) return;
      return {
        ...request,
        tools: [...(request.tools ?? []), { type: "web_search", external_web_access: true }],
      };
    },
    onProviderStreamEvent(data, model) {
      if (!hasOpenAIWebSearch(model)) return;
      const event = data as { type: string; item?: OutputItem };
      const item = event.item;
      if (!item) return;
      if (item.type === "web_search_call") {
        if (event.type === "response.output_item.added" && !searches.has(item.id)) {
          searches.add(item.id);
          onSearch({ phase: "start", callId: item.id });
        } else if (event.type === "response.output_item.done") {
          if (!searches.has(item.id)) {
            searches.add(item.id);
            onSearch({ phase: "start", callId: item.id });
          }
          onSearch({
            phase: "end",
            callId: item.id,
            result: { status: item.status, action: item.action },
          });
        }
      } else if (event.type === "response.output_item.done" && item.type === "message") {
        if (!item.content?.some((part) => part.annotations?.some((annotation) => annotation.type === "url_citation"))) return;
        replies.set(item.id, (item.content ?? []).map((part) =>
          part.type === "output_text" ? citeText(part.text ?? "", part.annotations ?? []) : part.refusal ?? "",
        ).join(""));
      }
    },
    decorateMessage(message) {
      if (replies.size === 0) return;
      for (const block of message.content) {
        if (block.type !== "text" || !block.textSignature) continue;
        // Pi's Responses text signature is {v:1,id,phase}; legacy signatures are raw IDs.
        const id = block.textSignature.startsWith("{")
          ? (JSON.parse(block.textSignature) as { id: string }).id
          : block.textSignature;
        const reply = replies.get(id);
        if (reply !== undefined) {
          block.text = reply;
          replies.delete(id);
        }
      }
    },
  };
}

function citeText(text: string, annotations: Array<UrlCitation | { type: string }>): string {
  const spans = new Map<string, UrlCitation[]>();
  for (const annotation of annotations) {
    if (annotation.type !== "url_citation") continue;
    const citation = annotation as UrlCitation;
    const key = `${citation.start_index}:${citation.end_index}`;
    const group = spans.get(key) ?? [];
    if (!group.some((source) => source.url === citation.url)) group.push(citation);
    spans.set(key, group);
  }
  // Provider offsets count Unicode characters, rather than UTF-16 code units.
  const characters = Array.from(text);
  for (const citations of [...spans.values()].sort((a, b) => b[0].start_index - a[0].start_index)) {
    const citation = citations[0];
    const quoted = characters.slice(citation.start_index, citation.end_index).join("");
    const missing = citations.filter((source) =>
      !quoted.includes(`](${source.url})`) && !quoted.includes(`](<${source.url}>)`),
    );
    if (missing.length === 0) continue;
    const link = missing.map((source) => {
      const label = source.title.replace(/[\\[\]]/g, "\\$&");
      return `[${label}](<${source.url}>)`;
    }).join(" ");
    const replacement = /\uE200cite\uE202.*?\uE201/.test(quoted)
      ? quoted.replace(/\uE200cite\uE202.*?\uE201/g, link)
      : `${quoted} (${link})`;
    characters.splice(citation.start_index, citation.end_index - citation.start_index, replacement);
  }
  return characters.join("");
}
