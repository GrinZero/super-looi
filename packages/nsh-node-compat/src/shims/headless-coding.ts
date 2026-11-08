import { unsupported } from "../bridge.js";
export const readRenderers = {},
  writeRenderers = {},
  editRenderers = {},
  lsRenderers = {},
  findRenderers = {},
  grepRenderers = {};
export const BASH_UPDATE_THROTTLE_MS = 100;
export function createShellRenderers() {
  return {};
}
export async function processImage() {
  return unsupported(
    "coding-agent image processing; inject a native image service",
  );
}
export async function ensureTool(name: string) {
  if (name === "rg" || name === "fd") return name;
  return unsupported(`desktop tool ${name}; inject sandbox operations`);
}

export function createAllToolRenderers() {
  return Object.fromEntries(
    ["read", "write", "edit", "ls", "find", "grep", "bash", "powershell"].map(
      (name) => [name, {}],
    ),
  );
}
export function withBuiltInRenderers(_name: string, definition?: unknown) {
  return definition ?? {};
}
