import { PluginKernelError } from "./errors.js";

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly raw: string;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function parseSemVer(version: string, pluginId?: string): SemVer {
  const trimmed = version.trim();
  const match = SEMVER_RE.exec(trimmed);
  if (!match) {
    throw new PluginKernelError({
      stage: "plugin.semver.parse",
      code: "ERR_PLUGIN_INVALID_SEMVER",
      pluginId,
      reason: `Invalid SemVer "${version}"`,
    });
  }
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: trimmed,
  };
}

export function compareSemVer(aInput: SemVer | string, bInput: SemVer | string): -1 | 0 | 1 {
  const a = typeof aInput === "string" ? parseSemVer(aInput) : aInput;
  const b = typeof bInput === "string" ? parseSemVer(bInput) : bInput;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = typeof ai === "number";
    const bNum = typeof bi === "number";
    if (aNum && bNum) return ai < bi ? -1 : 1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return String(ai) < String(bi) ? -1 : 1;
  }
  return 0;
}

type Comparator = (target: SemVer) => boolean;

function parseSingleToken(token: string, pluginId?: string): Comparator[] {
  if (token === "*" || token === "x" || token === "X") {
    return [(v) => v.prerelease.length === 0];
  }

  if (token.startsWith("^")) {
    const base = parseSemVer(token.slice(1), pluginId);
    let upper: SemVer;
    if (base.major > 0) {
      upper = { major: base.major + 1, minor: 0, patch: 0, prerelease: [], raw: "" };
    } else if (base.minor > 0) {
      upper = { major: 0, minor: base.minor + 1, patch: 0, prerelease: [], raw: "" };
    } else {
      upper = { major: 0, minor: 0, patch: base.patch + 1, prerelease: [], raw: "" };
    }
    return [
      (v) => compareSemVer(v, base) >= 0,
      (v) => (v.prerelease.length > 0 ? v.major === base.major && v.minor === base.minor && v.patch === base.patch && base.prerelease.length > 0 : true),
      (v) => compareSemVer(v, upper) < 0,
    ];
  }

  if (token.startsWith("~")) {
    const base = parseSemVer(token.slice(1), pluginId);
    const upper: SemVer = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [], raw: "" };
    return [
      (v) => compareSemVer(v, base) >= 0,
      (v) => (v.prerelease.length > 0 ? v.major === base.major && v.minor === base.minor && v.patch === base.patch && base.prerelease.length > 0 : true),
      (v) => compareSemVer(v, upper) < 0,
    ];
  }

  const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!opMatch) {
    throw new PluginKernelError({
      stage: "plugin.semver.range",
      code: "ERR_PLUGIN_INVALID_SEMVER_RANGE",
      pluginId,
      reason: `Invalid SemVer range token "${token}"`,
    });
  }
  const op = opMatch[1] ?? "=";
  const ref = parseSemVer(opMatch[2], pluginId);
  switch (op) {
    case ">=":
      return [(v) => compareSemVer(v, ref) >= 0];
    case "<=":
      return [(v) => compareSemVer(v, ref) <= 0];
    case ">":
      return [(v) => compareSemVer(v, ref) > 0];
    case "<":
      return [(v) => compareSemVer(v, ref) < 0];
    case "=":
    default:
      return [(v) => compareSemVer(v, ref) === 0];
  }
}

export function satisfiesSemVerRange(versionInput: SemVer | string, range: string, pluginId?: string): boolean {
  const version = typeof versionInput === "string" ? parseSemVer(versionInput, pluginId) : versionInput;
  const trimmed = range.trim();
  if (!trimmed) {
    throw new PluginKernelError({
      stage: "plugin.semver.range",
      code: "ERR_PLUGIN_INVALID_SEMVER_RANGE",
      pluginId,
      reason: "SemVer range must not be empty",
    });
  }

  const branches = trimmed.split("||").map((part) => part.trim()).filter(Boolean);
  if (branches.length === 0) return false;

  return branches.some((branch) => {
    const tokens = branch.split(/\s+/).filter(Boolean);
    const comparators = tokens.flatMap((tok) => parseSingleToken(tok, pluginId));
    return comparators.every((fn) => fn(version));
  });
}
