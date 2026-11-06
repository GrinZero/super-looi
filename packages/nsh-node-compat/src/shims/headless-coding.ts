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
  if (name === "rg") return "rg";
  return unsupported(`desktop tool ${name}; inject sandbox operations`);
}
