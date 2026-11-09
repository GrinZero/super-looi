import fs from "node:fs";
import path from "node:path";

function resolveRealAncestor(targetPath: string): string {
  let current = targetPath;
  const suffix: string[] = [];
  for (;;) {
    try { fs.lstatSync(current); break; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const realBase = (fs.realpathSync.native ?? fs.realpathSync)(current);
  return suffix.length > 0 ? path.join(realBase, ...suffix) : realBase;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
): { resolved: string; relative: string; inside: boolean } {
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(targetPath) ? targetPath : `${root}/${targetPath}`;
  const lexicalRel = path.relative(root, resolved);
  try {
    const realRoot = resolveRealAncestor(root);
    const realTarget = resolveRealAncestor(resolved);
    const realRel = path.relative(realRoot, realTarget);
    const inside = realRel === "" || (!realRel.startsWith("..") && !path.isAbsolute(realRel));
    return { resolved, relative: lexicalRel.startsWith("..") ? realRel : lexicalRel || ".", inside };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") return {resolved, relative:lexicalRel, inside:false};
    throw error;
  }
}
