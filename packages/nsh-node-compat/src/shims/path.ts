import process from "./process.js";
export const sep = "/",
  delimiter = ":";
export const isAbsolute = (path: string) => path.startsWith("/");
export function normalize(path: string): string {
  if (typeof path !== "string") throw new TypeError("path must be a string");
  const absolute = isAbsolute(path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  const normalized = (absolute ? "/" : "") + parts.join("/");
  return (
    (normalized || (absolute ? "/" : ".")) +
    (path.endsWith("/") && normalized && normalized !== "/" ? "/" : "")
  );
}
export function join(...parts: string[]) {
  return normalize(parts.filter(Boolean).join("/"));
}
export function resolve(...parts: string[]) {
  let path = "";
  for (let i = parts.length - 1; i >= -1; i--) {
    const part = i === -1 ? process.cwd() : parts[i];
    if (!part) continue;
    path = part + "/" + path;
    if (isAbsolute(part)) break;
  }
  const result = normalize(path);
  return result.length > 1 ? result.replace(/\/$/, "") : result;
}
export function relative(from: string, to: string) {
  const a = resolve(from).split("/").filter(Boolean),
    b = resolve(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && a[shared] === b[shared]) shared++;
  return [...Array(a.length - shared).fill(".."), ...b.slice(shared)].join("/");
}
export function dirname(path: string) {
  if (!path) return ".";
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : trimmed.slice(0, i);
}
export function basename(path: string, suffix?: string) {
  const base = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}
export function extname(path: string) {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index <= 0 || base === ".." ? "" : base.slice(index);
}
export function parse(path: string) {
  const base = basename(path),
    ext = extname(path);
  const dir = dirname(path);
  return {
    root: isAbsolute(path) ? "/" : "",
    dir: dir === "." ? "" : dir,
    base,
    ext,
    name: base.slice(0, base.length - ext.length),
  };
}
export function format(p: {
  dir?: string;
  root?: string;
  base?: string;
  name?: string;
  ext?: string;
}) {
  const dir = p.dir ?? p.root ?? "";
  const base =
    p.base ??
    (p.name ?? "") +
      (p.ext && !p.ext.startsWith(".") ? "." : "") +
      (p.ext ?? "");
  return dir ? dir + (dir.endsWith("/") ? "" : "/") + base : base;
}
export const toNamespacedPath = (path: string) => path;
export const posix = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  toNamespacedPath,
};
// Portable consumers test this object for Windows-style input; it never grants I/O.
export const win32 = {
  ...posix,
  sep: "\\",
  isAbsolute: (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p),
};
export default { ...posix, posix, win32 };
