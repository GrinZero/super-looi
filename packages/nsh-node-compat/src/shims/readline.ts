import { EventEmitter } from "./events.js";
import { StringDecoder } from "./string_decoder.js";
export function createInterface(options: {
  input: EventEmitter & AsyncIterable<Uint8Array | string>;
  crlfDelay?: number;
}) {
  const lines: string[] = [];
  let ended = false;
  const waiters: Array<() => void> = [];
  const decoder = new StringDecoder();
  let carry = "";
  const result = Object.assign(new EventEmitter(), {
    close() {
      if (!ended) {
        ended = true;
        result.emit("close");
        waiters.splice(0).forEach((fn) => fn());
      }
    },
    async *[Symbol.asyncIterator]() {
      while (!ended || lines.length) {
        if (lines.length) yield lines.shift()!;
        else await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  });
  options.input.on("data", (chunk: Uint8Array | string) => {
    carry += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const parts = carry.split(/\r?\n/);
    carry = parts.pop()!;
    for (const line of parts) {
      lines.push(line);
      result.emit("line", line);
    }
    waiters.splice(0).forEach((fn) => fn());
  });
  options.input.on("end", () => {
    carry += decoder.end();
    if (carry) {
      lines.push(carry);
      result.emit("line", carry);
    }
    result.close();
  });
  options.input.on("error", (error: Error) => {
    result.emit("error", error);
    result.close();
  });
  return result;
}
export default { createInterface };
