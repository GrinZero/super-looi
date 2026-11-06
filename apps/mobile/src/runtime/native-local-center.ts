import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { LocalControlCenter } from "./local-control-center.js";
import type { LocalStorage } from "./local-memory.js";

const digest = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** Two validated slots survive interrupted writes; successful writes delete the older copy. */
class NativeLocalStorage implements LocalStorage {
  private readonly directory = new Directory(Paths.document, "looi-local");
  private async slots(key: string) {
    this.directory.create({ intermediates: true, idempotent: true });
    const name = await digest(key);
    return [new File(this.directory, `${name}.0.json`), new File(this.directory, `${name}.1.json`)];
  }
  private async read(key: string) {
    const slots = await this.slots(key);
    const valid: Array<{ sequence: number; value: string }> = [];
    let found = false;
    for (const slot of slots) {
      if (!slot.exists) continue;
      found = true;
      try {
        const item = JSON.parse(await slot.text());
        if (Number.isSafeInteger(item.sequence) && item.sequence >= 0 && typeof item.value === "string" && item.checksum === await digest(item.value)) valid.push(item);
      } catch { /* The other committed slot may survive an interrupted write. */ }
    }
    if (found && !valid.length) throw new Error("本机文件校验失败，请保留文件后检查");
    return { slots, item: valid.sort((a, b) => b.sequence - a.sequence)[0] };
  }
  async get(key: string) { return (await this.read(key)).item?.value ?? null; }
  async set(key: string, value: string) {
    const { slots, item } = await this.read(key);
    const sequence = (item?.sequence ?? -1) + 1;
    const destination = slots[sequence % 2];
    destination.write(JSON.stringify({ sequence, value, checksum: await digest(value) }));
    const verified = JSON.parse(await destination.text());
    if (verified.checksum !== await digest(verified.value)) throw new Error("本机文件写入未确认");
    const previous = slots[(sequence + 1) % 2];
    if (previous.exists) previous.delete();
  }
}

export function createNativeLocalCenter(hubOrigin: string): LocalControlCenter {
  return new LocalControlCenter({ hubOrigin, storage: new NativeLocalStorage(),
    credentials: {
      async get(key) { return SecureStore.getItemAsync(await digest(key), secureOptions); },
      async set(key, value) { await SecureStore.setItemAsync(await digest(key), value, secureOptions); },
      async delete(key) { await SecureStore.deleteItemAsync(await digest(key), secureOptions); },
    },
    crypto: { randomUUID: Crypto.randomUUID, sha1: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, value) },
  });
}
