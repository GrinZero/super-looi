import { installNodeCompatGlobals } from "./polyfills.js";

/** Implemented by an NSH native class around Rust Bridge. begin is synchronous
 * so input admission precedes the engine's asynchronous task scheduling. */
export interface NshNativeCompatHost {
  request(request: string): string;
  begin(kind: string, request: string): string;
  wait(ticket: string): Promise<string>;
  close(): void;
}

export function installNshNativeCompat(host: NshNativeCompatHost): () => void {
  if (globalThis.__nsh_compat)
    throw new Error("Native compatibility host already installed");
  const request = (raw: string) => host.request(raw);
  const asyncRequest =
    (kind: string) =>
    async (raw: string): Promise<string> => {
      try {
        return await host.wait(host.begin(kind, raw));
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  const shell = asyncRequest("shell"),
    codemode = asyncRequest("codemode");
  globalThis.__nsh_compat = request;
  globalThis.__nsh_shell_wait = shell;
  globalThis.__nsh_codemode_step = codemode;
  installNodeCompatGlobals();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (globalThis.__nsh_compat === request) delete globalThis.__nsh_compat;
    if (globalThis.__nsh_shell_wait === shell)
      delete globalThis.__nsh_shell_wait;
    if (globalThis.__nsh_codemode_step === codemode)
      delete globalThis.__nsh_codemode_step;
    host.close();
  };
}
