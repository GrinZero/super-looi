import { FixtureResponse } from "./http-fixture.js";
declare global {
  var __nsh_http_create: () => string;
  var __nsh_http_open: (request: string) => Promise<string>;
  var __nsh_http_read: (id: string) => Promise<string>;
  var __nsh_http_cancel: (id: string) => void;
  var __nsh_live_config: string;
}
const unpack = <T>(raw: string): T => {
  const result = JSON.parse(raw);
  if (result.error) throw new Error(result.error);
  return result.value;
};
export const nativeFetch: typeof fetch = async (input, options = {}) => {
  options.signal?.throwIfAborted();
  const id = __nsh_http_create();
  if (!id) throw new Error("HTTP job limit");
  const cancel = () => __nsh_http_cancel(id);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = unpack<{
      status: number;
      headers: Record<string, string>;
    }>(
      await __nsh_http_open(
        JSON.stringify({
          id,
          url: String(input),
          method: options.method,
          headers: Object.fromEntries(new Headers(options.headers)),
          body: options.body,
        }),
      ),
    );
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = unpack<number[] | null>(await __nsh_http_read(id));
          if (chunk === null) {
            controller.close();
            options.signal?.removeEventListener("abort", cancel);
          } else controller.enqueue(new Uint8Array(chunk));
        } catch (error) {
          cancel();
          options.signal?.removeEventListener("abort", cancel);
          controller.error(error);
        }
      },
      cancel() {
        cancel();
        options.signal?.removeEventListener("abort", cancel);
      },
    });
    return new FixtureResponse(body, response) as unknown as Response;
  } catch (error) {
    cancel();
    options.signal?.removeEventListener("abort", cancel);
    throw error;
  }
};
