import type { createLooiModelsRegistry } from "@super-looi/runtime/agent/llm-providers";
import type { LlmOAuthUiEvent } from "./types.js";

type MutableModels = ReturnType<typeof createLooiModelsRegistry>;

/**
 * Owns the transient OAuth device-code / manual-callback state machine for LLM providers.
 */
export class LlmOAuthFlow {
  private abort?: AbortController;
  private manualPrompt?: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    providerId: string;
    authorizationUrl: string;
  };

  get isActive(): boolean {
    return Boolean(this.abort);
  }

  async run(input: {
    providerId: string;
    modelsRegistry: MutableModels;
    getDeviceId: () => string;
    onEvent: (event: LlmOAuthUiEvent) => void;
    afterLogin: (signal: AbortSignal) => Promise<void>;
  }): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let authorizationUrl = "";

    try {
      await input.modelsRegistry.login(
        input.providerId,
        "oauth",
        {
          signal: abort.signal,
          notify: (ev: {
            type: string;
            userCode?: string;
            verificationUri?: string;
            expiresInSeconds?: number;
            url?: string;
            instructions?: string;
            message?: string;
          }) => {
            if (ev.type === "device_code" && ev.userCode && ev.verificationUri) {
              input.onEvent({
                kind: "device_code",
                userCode: ev.userCode,
                verificationUri: ev.verificationUri,
                expiresInSeconds: ev.expiresInSeconds,
              });
            } else if (ev.type === "auth_url" && ev.url) {
              authorizationUrl = ev.url;
              input.onEvent({
                kind: "auth_url",
                url: ev.url,
                instructions: ev.instructions,
              });
            } else if (
              (ev.type === "progress" || ev.type === "info") &&
              typeof ev.message === "string"
            ) {
              input.onEvent({
                kind: "progress",
                message: ev.message,
              });
            }
          },
          prompt: async (p: {
            type: string;
            message: string;
            placeholder?: string;
            signal?: AbortSignal;
          }) => {
            if (p.type === "manual_code") {
              input.onEvent({
                kind: "awaiting_callback",
                message: p.message,
                placeholder: p.placeholder ?? "",
              });
              return await new Promise<string>((resolve, reject) => {
                this.manualPrompt = {
                  resolve,
                  reject,
                  providerId: input.providerId,
                  authorizationUrl,
                };
                const onAbort = () => {
                  if (this.manualPrompt) {
                    this.manualPrompt = undefined;
                    reject(new Error("@looi:runtimeSigninCancelled"));
                  }
                };
                p.signal?.addEventListener("abort", onAbort, { once: true });
                abort.signal.addEventListener("abort", onAbort, { once: true });
              });
            }
            throw new Error("@looi:runtimeUnsupportedInteractionType");
          },
        },
        {
          getDeviceId: input.getDeviceId,
          agentName: "Super LOOI",
        },
      );

      await input.afterLogin(abort.signal);
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        this.manualPrompt = undefined;
      }
    }
  }

  submitCallback(callbackUrl: string): void {
    const prompt = this.manualPrompt;
    if (!prompt) throw new Error("@looi:runtimeNoSigninIsAwaitingACallback");
    let value = callbackUrl.trim();
    if (prompt.providerId === "openai") {
      if (/^(localhost|127\.0\.0\.1):1455\//i.test(value)) value = `http://${value}`;
      let callback: URL;
      try {
        callback = new URL(value);
      } catch {
        throw new Error("@looi:runtimePasteFullChatgptCallbackUrl");
      }
      const authorization = new URL(prompt.authorizationUrl);

      if (
        !["http://localhost:1455", "http://127.0.0.1:1455"].includes(callback.origin) ||
        callback.pathname !== "/auth/callback"
      ) {
        throw new Error("@looi:runtimePasteFullChatgptCallbackUrl");
      }
      if (callback.searchParams.has("error")) {
        throw new Error("@looi:runtimeChatgptAuthorizationRejected");
      }
      if (!callback.searchParams.get("code")) {
        throw new Error("@looi:runtimeChatgptCallbackMissingCode");
      }
      if (callback.searchParams.get("state") !== authorization.searchParams.get("state")) {
        throw new Error("@looi:runtimeChatgptCallbackDoesNotMatchSignin");
      }
    }
    this.manualPrompt = undefined;
    prompt.resolve(value);
  }

  cancel(): void {
    if (this.manualPrompt) {
      const prompt = this.manualPrompt;
      this.manualPrompt = undefined;
      prompt.reject(new Error("@looi:runtimeSigninCancelled"));
    }
    if (this.abort) {
      const abort = this.abort;
      this.abort = undefined;
      abort.abort();
    }
  }
}
