export interface OnlineModel {
  id: string;
  name: string;
}

export function chooseConnectedModelId(
  models: readonly OnlineModel[] | undefined,
  previousId: string,
  defaultId: string,
  fallbackId: string,
): string {
  if (models?.length) {
    if (models.some((model) => model.id === previousId)) return previousId;
    if (models.some((model) => model.id === defaultId)) return defaultId;
    return models[0].id;
  }
  return previousId || defaultId || fallbackId;
}

/** OpenAI subscription returns `models`; OpenAI-compatible APIs return `data`. */
export async function fetchOnlineModels(
  baseUrl: string,
  headers: Record<string, string>,
  options: {
    knownChatIds?: ReadonlySet<string>;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
): Promise<OnlineModel[]> {
  const { knownChatIds, signal, fetcher = fetch } = options;
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`获取模型列表失败 (${response.status})`);
  const payload: unknown = await response.json();
  const body = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const subscriptionModels = Array.isArray(body.models);
  const entries: unknown = subscriptionModels ? body.models : body.data;
  if (!Array.isArray(entries)) throw new Error("模型列表格式不受支持");
  const models = new Map<string, OnlineModel>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (subscriptionModels && item.visibility !== "list") continue;
    const id = subscriptionModels ? item.slug : item.id;
    if (typeof id !== "string" || !id.trim()) continue;
    if (knownChatIds && !knownChatIds.has(id)) continue;
    const name = subscriptionModels ? item.display_name : item.name;
    models.set(id, {
      id,
      name: typeof name === "string" && name.trim() ? name : id,
    });
  }
  return [...models.values()];
}
