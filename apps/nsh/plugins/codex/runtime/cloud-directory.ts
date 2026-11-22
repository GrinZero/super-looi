import type { CodexCloudEnvironment } from "../contracts.js";
import type { PluginFailure } from "../../../runtime/plugins/contracts.js";
import { extractPluginFailure, PluginKernelError } from "../../../runtime/plugins/errors.js";

interface CatalogPage {
  data: { id: string; name: string }[];
  next_cursor?: string | null;
}

export async function readCloudDirectory(rawCredentials: string): Promise<{
  environments: CodexCloudEnvironment[];
  failures: PluginFailure[];
}> {
  let auth: { tokens?: { access_token?: string; account_id?: string } };
  try {
    auth = JSON.parse(rawCredentials);
  } catch {
    // The JSON parser's error may include fragments of the credential file.
    throw new PluginKernelError({ stage: "cloud.directory.auth", code: "ERR_CODEX_AUTH_FORMAT", reason: "Codex auth.json is not valid JSON" });
  }
  const token = auth?.tokens?.access_token;
  if (!token) {
    throw new PluginKernelError({ stage: "cloud.directory.auth", code: "ERR_CODEX_CHATGPT_LOGIN_REQUIRED", reason: "Cloud environments require a ChatGPT login" });
  }
  const signal = AbortSignal.timeout(15_000);
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(auth.tokens?.account_id ? { "ChatGPT-Account-Id": auth.tokens.account_id } : {}),
    "X-OpenAI-Product-Sku": "codex",
  };

  async function read<T>(stage: string, url: URL): Promise<T> {
    try {
      const response = await fetch(url.toString(), { headers, redirect: "error", signal });
      const text = await response.text();
      if (!response.ok) {
        throw new PluginKernelError({ stage, code: response.status, reason: text.replaceAll(token!, "[redacted]") || response.statusText });
      }
      return JSON.parse(text);
    } catch (error) {
      const failure = extractPluginFailure(error, stage);
      throw new PluginKernelError({ stage, code: failure.code ?? "ERR_CODEX_DIRECTORY", reason: failure.reason.replaceAll(token!, "[redacted]") });
    }
  }

  async function listSaved(scope: "user" | "workspace"): Promise<CodexCloudEnvironment[]> {
    const stage = `cloud.directory.${scope}`;
    const url = new URL("https://chatgpt.com/api/codex-cloud/v1/environment-configs");
    url.search = new URLSearchParams({ scope, limit: "100", omitDraft: "true", view: "picker" }).toString();
    const entries: CodexCloudEnvironment[] = [];
    let cursor: string | null | undefined;
    do {
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await read<CatalogPage>(stage, url);
      if (!Array.isArray(page?.data)) {
        throw new PluginKernelError({ stage, code: "ERR_CODEX_DIRECTORY_FORMAT", reason: "Cloud catalog response did not include an environment list" });
      }
      for (const { id, name } of page.data) {
        if (id !== "asenvcfg_base") entries.push({ id, name, scope });
      }
      cursor = page.next_cursor;
    } while (cursor);
    return entries;
  }

  async function listLegacy(): Promise<CodexCloudEnvironment[]> {
    const stage = "cloud.directory.legacy";
    const page = await read<{ id: string; label?: string }[]>(stage, new URL("https://chatgpt.com/backend-api/wham/environments"));
    if (!Array.isArray(page)) {
      throw new PluginKernelError({ stage, code: "ERR_CODEX_DIRECTORY_FORMAT", reason: "Legacy catalog response did not include an environment list" });
    }
    return page.map(({ id, label }) => ({ id, name: label || id, scope: "legacy" }));
  }

  const scopes = await Promise.allSettled([listSaved("user"), listSaved("workspace"), listLegacy()]);
  const environments = new Map<string, CodexCloudEnvironment>();
  const failures: PluginFailure[] = [];
  for (const scope of scopes) {
    if (scope.status === "rejected") {
      failures.push(extractPluginFailure(scope.reason, "cloud.directory"));
    } else {
      for (const entry of scope.value) {
        if (!environments.has(entry.id)) environments.set(entry.id, entry);
      }
    }
  }
  return { environments: [...environments.values()], failures };
}
