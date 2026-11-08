/** Serializable UI message. Runtime code owns IDs and values, not a UI locale. */
export function uiMessage(key: string, parameters?: Record<string, unknown>): string {
  return `@looi:${key}${parameters ? "|" + JSON.stringify(parameters) : ""}`;
}
