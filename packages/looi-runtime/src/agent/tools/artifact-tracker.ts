import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveWorkspacePath } from "../workspace-path.js";
import type { WorkspaceArtifact } from "./types.js";

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/**
 * Tracks workspace files touched or produced during a task run, verifying
 * workspace containment, symlink validity, and SHA-256 content digests.
 */
export class WorkspaceArtifactTracker {
  private readonly artifacts = new Map<string, WorkspaceArtifact>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskStartMs: number,
  ) {}

  record(absPath: string, onlyIfRecent = false): void {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(absPath);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        return;
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      try {
        (fs.realpathSync.native ?? fs.realpathSync)(absPath);
      } catch (error) {
        if (
          ["EACCES", "ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          return;
        }
        throw error;
      }
    }
    const { inside, relative } = resolveWorkspacePath(
      this.workspaceRoot,
      absPath,
    );
    if (!inside) return;
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return;
    if (onlyIfRecent && stat.mtimeMs < this.taskStartMs - 50) return;
    const buf = fs.readFileSync(absPath);
    this.artifacts.set(relative, {
      path: relative,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.byteLength,
    });
  }

  scanRecentTopLevel(): void {
    try {
      for (const entry of fs.readdirSync(this.workspaceRoot)) {
        this.record(path.join(this.workspaceRoot, entry), true);
      }
    } catch {
      // ignore workspace scan errors
    }
  }

  list(): WorkspaceArtifact[] {
    return [...this.artifacts.values()];
  }
}
