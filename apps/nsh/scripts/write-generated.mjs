import { readFile, writeFile } from "node:fs/promises";

/** Preserve the file timestamp when a build produced the same bytes. */
export async function writeGenerated(path, content) {
  const bytes = Buffer.from(content);
  const previous = await readFile(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous?.equals(bytes)) return;
  await writeFile(path, bytes);
}
