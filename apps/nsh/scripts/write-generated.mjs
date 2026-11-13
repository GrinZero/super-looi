import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

/** Publish complete build output, preserving timestamps for unchanged bytes. */
export async function writeGenerated(path, content) {
  const bytes = Buffer.from(content);
  const previous = await readFile(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous?.equals(bytes)) return;
  // Separate builders must never truncate or interleave writes to a watched file.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
