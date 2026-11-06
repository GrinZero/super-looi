import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/ui/use-wake-guide.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

// Run the shipped hook with controlled storage latency and a minimal hook lifecycle.
function mount(storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => void }) {
  let visible = false;
  let effect: () => () => void;
  const exports: { useWakeGuide?: () => { dismiss: () => void } } = {};
  runInNewContext(compiled, {
    exports,
    console: { warn() {} },
    require: (name: string) => name === "react-native" ? { Platform: { OS: "ios" } } : name === "expo-file-system" ? {
      Paths: { document: "documents" },
      File: class {
        exists = true;
        constructor(_directory: string, private key: string) {}
        text() { return storage.getItem(this.key); }
        write(value: string) { storage.setItem(this.key, value); }
      },
    } : {
      useState: (initial: boolean) => { visible = initial; return [initial, (value: boolean) => { visible = value; }]; },
      useRef: (initial: boolean) => ({ current: initial }),
      useCallback: (callback: unknown) => callback,
      useEffect: (callback: typeof effect) => { effect = callback; },
    },
  });
  const guide = exports.useWakeGuide!();
  const unmount = effect!();
  return { visible: () => visible, dismiss: guide.dismiss, unmount };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("first-use wake guide", () => {
  it("waits for storage, shows on first use, and stays hidden after remount", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    };
    const first = mount(storage);
    assert.equal(first.visible(), false);
    await settle();
    assert.equal(first.visible(), true);
    first.dismiss();
    assert.equal(first.visible(), false);
    first.unmount();
    const returning = mount(storage);
    await settle();
    assert.equal(returning.visible(), false);
  });

  it("does not revive the guide when a stale read completes after dismissal or unmount", async () => {
    for (const action of ["dismiss", "unmount"] as const) {
      let finishRead!: (value: null) => void;
      const guide = mount({ getItem: () => new Promise((resolve) => { finishRead = resolve; }), setItem: () => {} });
      guide[action]();
      finishRead(null);
      await settle();
      assert.equal(guide.visible(), false);
    }
  });

  it("handles storage failures without resurfacing the guide or rejecting the interaction", async () => {
    const guide = mount({ getItem: async () => { throw new Error("read failed"); }, setItem: () => { throw new Error("write failed"); } });
    await settle();
    assert.equal(guide.visible(), false);
    guide.dismiss();
    await settle();
    assert.equal(guide.visible(), false);
  });
});
