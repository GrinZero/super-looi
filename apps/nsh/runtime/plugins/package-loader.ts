import { createHash } from "node:crypto";
import {
  HOST_PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginPermission,
} from "./contracts.js";
import { uint8ArrayToBase64 } from "./embodied-drivers.js";
import { PluginKernelError } from "./errors.js";
import { parseSemVer, satisfiesSemVerRange } from "./semver.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;

const VALID_PERMISSIONS: ReadonlySet<PluginPermission> = new Set<PluginPermission>(
  PLUGIN_PERMISSIONS,
);

// ============================================================================
// Pure RFC 8032 Ed25519 Verification (QuickJS + Node.js compatible, 0 deps)
// ============================================================================

const ED25519_P = (1n << 255n) - 19n;
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

function modP(a: bigint): bigint {
  const r = a % ED25519_P;
  return r >= 0n ? r : r + ED25519_P;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % mod;
    }
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const ED25519_D = modP(-121665n * modPow(121666n, ED25519_P - 2n, ED25519_P));
const ED25519_2D = modP(2n * ED25519_D);
const ED25519_SQRT_M1 = modPow(2n, (ED25519_P - 1n) / 4n, ED25519_P);

interface ExtPoint {
  readonly X: bigint;
  readonly Y: bigint;
  readonly Z: bigint;
  readonly T: bigint;
}

const IDENTITY_POINT: ExtPoint = { X: 0n, Y: 1n, Z: 1n, T: 0n };

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc = (acc << 8n) | BigInt(bytes[i]!);
  }
  return acc;
}

function encodeLittleEndian32(val: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = val;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function decodeEd25519Point(bytes: Uint8Array): ExtPoint | null {
  if (bytes.length !== 32) return null;
  const copy = new Uint8Array(bytes);
  const xSign = (copy[31]! >> 7) & 1;
  copy[31] = copy[31]! & 0x7f;
  const y = decodeLittleEndian(copy);
  if (y >= ED25519_P) return null;

  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(ED25519_D * y2 + 1n);

  const v3 = modP(modP(v * v) * v);
  const v7 = modP(modP(v3 * v3) * v);
  const uv7 = modP(u * v7);
  let x = modP(modP(u * v3) * modPow(uv7, (ED25519_P - 5n) / 8n, ED25519_P));

  const vx2 = modP(v * modP(x * x));
  if (vx2 === u) {
    // Valid root
  } else if (vx2 === modP(-u)) {
    x = modP(x * ED25519_SQRT_M1);
  } else {
    return null;
  }

  if (x === 0n && xSign === 1) {
    return null;
  }
  if (Number(x & 1n) !== xSign) {
    x = ED25519_P - x;
  }
  return { X: x, Y: y, Z: 1n, T: modP(x * y) };
}

function encodeEd25519Point(pt: ExtPoint): Uint8Array {
  const zInv = modPow(pt.Z, ED25519_P - 2n, ED25519_P);
  const x = modP(pt.X * zInv);
  const y = modP(pt.Y * zInv);
  const out = encodeLittleEndian32(y);
  out[31] = out[31]! | (Number(x & 1n) << 7);
  return out;
}

function pointAdd(p1: ExtPoint, p2: ExtPoint): ExtPoint {
  const A = modP(modP(p1.Y - p1.X) * modP(p2.Y - p2.X));
  const B = modP(modP(p1.Y + p1.X) * modP(p2.Y + p2.X));
  const C = modP(modP(p1.T * ED25519_2D) * p2.T);
  const D = modP(modP(2n * p1.Z) * p2.Z);
  const E = modP(B - A);
  const F = modP(D - C);
  const G = modP(D + C);
  const H = modP(B + A);
  return {
    X: modP(E * F),
    Y: modP(G * H),
    Z: modP(F * G),
    T: modP(E * H),
  };
}

function scalarMul(pt: ExtPoint, scalar: bigint): ExtPoint {
  let result = IDENTITY_POINT;
  let addend = pt;
  let s = scalar;
  while (s > 0n) {
    if ((s & 1n) === 1n) {
      result = pointAdd(result, addend);
    }
    addend = pointAdd(addend, addend);
    s >>= 1n;
  }
  return result;
}

function pointMul8(pt: ExtPoint): ExtPoint {
  const p2 = pointAdd(pt, pt);
  const p4 = pointAdd(p2, p2);
  return pointAdd(p4, p4);
}

const ED25519_BASE_POINT: ExtPoint = (() => {
  const by = modP(4n * modPow(5n, ED25519_P - 2n, ED25519_P));
  const pt = decodeEd25519Point(encodeLittleEndian32(by));
  if (!pt) {
    throw new Error("Failed to initialize RFC 8032 Ed25519 base point");
  }
  return pt;
})();

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function decodeBase64Bytes(raw: string): Uint8Array | null {
  const cleaned = raw.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return null;
  }
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const c0 = table.indexOf(cleaned[i]!);
    const c1 = table.indexOf(cleaned[i + 1]!);
    const c2 = cleaned[i + 2] === "=" ? -1 : table.indexOf(cleaned[i + 2]!);
    const c3 = cleaned[i + 3] === "=" ? -1 : table.indexOf(cleaned[i + 3]!);
    if (c0 < 0 || c1 < 0 || (cleaned[i + 2] !== "=" && c2 < 0) || (cleaned[i + 3] !== "=" && c3 < 0)) {
      return null;
    }
    const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    out.push((n >> 16) & 0xff);
    if (c2 >= 0) out.push((n >> 8) & 0xff);
    if (c3 >= 0) out.push(n & 0xff);
  }
  return new Uint8Array(out);
}

function decodeHexBytes(raw: string): Uint8Array | null {
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    return null;
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeFlexibleBytes(input: string | Uint8Array): Uint8Array | null {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  const trimmed = input.trim();
  if (trimmed.startsWith("-----BEGIN PUBLIC KEY-----")) {
    const body = trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    return decodeBase64Bytes(body);
  }
  const fromHex = decodeHexBytes(trimmed);
  if (fromHex) return fromHex;
  return decodeBase64Bytes(trimmed);
}

export function normalizeEd25519PublicKey(input: string | Uint8Array): Uint8Array | null {
  const bytes = decodeFlexibleBytes(input);
  if (!bytes) return null;
  if (bytes.length === 32) return bytes;
  if (bytes.length === 44) {
    for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
      if (bytes[i] !== ED25519_SPKI_PREFIX[i]) return null;
    }
    return bytes.subarray(12, 44);
  }
  return null;
}

export function verifyEd25519Signature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey32: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey32.length !== 32) return false;
  const rBytes = signature.subarray(0, 32);
  const sBytes = signature.subarray(32, 64);
  const S = decodeLittleEndian(sBytes);
  if (S >= ED25519_L) return false;

  const A = decodeEd25519Point(publicKey32);
  const R = decodeEd25519Point(rBytes);
  if (!A || !R) return false;

  const hash = createHash("sha512");
  hash.update(rBytes);
  hash.update(publicKey32);
  hash.update(message);
  const kDigest = new Uint8Array(hash.digest());
  const k = decodeLittleEndian(kDigest) % ED25519_L;

  const lhs = encodeEd25519Point(pointMul8(scalarMul(ED25519_BASE_POINT, S)));
  const rhs = encodeEd25519Point(pointMul8(pointAdd(R, scalarMul(A, k))));

  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= lhs[i]! ^ rhs[i]!;
  }
  return diff === 0;
}

// ============================================================================
// `.nshpkg` Canonical Archive Serialization & Verification
// ============================================================================

export interface NshPackageEnvelope {
  readonly format: "nshpkg-v1";
  readonly manifest: PluginManifest;
  readonly runtimeEntry: string;
  readonly uiEntry?: string;
  readonly sha256: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface VerifiedNshPackage {
  readonly manifest: PluginManifest;
  readonly runtimeEntry: string;
  readonly uiEntry?: string;
  readonly sha256: string;
  readonly keyId: string;
}

export interface VerifyNshPackageOptions {
  /** Trusted Ed25519 public keys indexed by `keyId` (raw 32-byte, SPKI DER, PEM, hex, or base64). */
  readonly trustedKeys: Readonly<Record<string, string | Uint8Array>>;
  /** Override host API version for compatibility tests (defaults to `HOST_PLUGIN_API_VERSION`). */
  readonly hostApiVersion?: number;
}

function canonicalizeJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`).join(",")}}`;
}

export function serializeCanonicalNshPayload(input: {
  readonly manifest: PluginManifest;
  readonly runtimeEntry: string;
  readonly uiEntry?: string;
}): Uint8Array {
  const canonicalText = canonicalizeJson({
    format: "nshpkg-v1",
    manifest: input.manifest,
    runtimeEntry: input.runtimeEntry,
    ...(input.uiEntry !== undefined ? { uiEntry: input.uiEntry } : {}),
  });
  return new TextEncoder().encode(canonicalText);
}

export function computePayloadSha256Hex(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function assembleSignedNshPackage(input: {
  readonly manifest: PluginManifest;
  readonly runtimeEntry: string;
  readonly uiEntry?: string;
  readonly keyId: string;
  readonly signPayload: (canonicalPayload: Uint8Array) => Uint8Array | string;
}): NshPackageEnvelope {
  const payload = serializeCanonicalNshPayload(input);
  const sha256 = computePayloadSha256Hex(payload);
  const rawSig = input.signPayload(payload);
  const signature =
    typeof rawSig === "string"
      ? rawSig
      : uint8ArrayToBase64(rawSig);
  return {
    format: "nshpkg-v1",
    manifest: structuredClone(input.manifest),
    runtimeEntry: input.runtimeEntry,
    ...(input.uiEntry !== undefined ? { uiEntry: input.uiEntry } : {}),
    sha256,
    keyId: input.keyId,
    signature,
  };
}

function isLocalizedText(val: unknown): val is { "zh-CN": string; "en-US": string } {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj["zh-CN"] === "string" &&
    obj["zh-CN"].trim().length > 0 &&
    typeof obj["en-US"] === "string" &&
    obj["en-US"].trim().length > 0
  );
}

function validateNshPkgManifest(
  rawManifest: unknown,
  hostApiVersion: number,
): PluginManifest {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      reason: "Package manifest must be a JSON object",
    });
  }
  const m = rawManifest as Record<string, unknown>;
  const pluginId = typeof m.id === "string" ? m.id : undefined;

  if (!pluginId || !PLUGIN_ID_RE.test(pluginId)) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Invalid plugin id "${String(m.id)}"`,
    });
  }

  if (typeof m.version !== "string") {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" must declare a SemVer version string`,
    });
  }
  try {
    parseSemVer(m.version, pluginId);
  } catch (err) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: err instanceof Error ? err.message : `Invalid SemVer "${m.version}"`,
      cause: err,
    });
  }

  if (typeof m.minHostApiVersion !== "number" || !Number.isInteger(m.minHostApiVersion) || m.minHostApiVersion < 1) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" minHostApiVersion must be a positive integer`,
    });
  }

  if (m.minHostApiVersion > hostApiVersion) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.compatibility",
      code: "ERR_NSHPKG_HOST_API_INCOMPATIBLE",
      pluginId,
      reason: `Plugin "${pluginId}" requires Host API v${m.minHostApiVersion}, but running host is v${hostApiVersion}`,
    });
  }

  if (typeof m.category !== "string" || !PLUGIN_CATEGORIES.includes(m.category as any)) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Invalid plugin category "${String(m.category)}"`,
    });
  }

  if (typeof m.icon !== "string" || m.icon.trim().length === 0) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" must declare a non-empty icon identifier`,
    });
  }

  if (!isLocalizedText(m.name) || !isLocalizedText(m.summary)) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" must provide localized zh-CN and en-US name and summary`,
    });
  }

  if (
    !m.author ||
    typeof m.author !== "object" ||
    typeof (m.author as Record<string, unknown>).name !== "string" ||
    ((m.author as Record<string, unknown>).name as string).trim().length === 0
  ) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" must declare author.name`,
    });
  }

  if (!Array.isArray(m.permissions)) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" permissions must be an array`,
    });
  }
  for (const perm of m.permissions) {
    if (typeof perm !== "string" || !VALID_PERMISSIONS.has(perm as PluginPermission)) {
      throw new PluginKernelError({
        stage: "nshpkg.manifest.validate",
        code: "ERR_NSHPKG_MANIFEST_INVALID",
        pluginId,
        reason: `Plugin "${pluginId}" declares unknown permission "${String(perm)}"`,
      });
    }
  }

  if (
    m.activation !== undefined &&
    m.activation !== "startup" &&
    m.activation !== "on_demand"
  ) {
    throw new PluginKernelError({
      stage: "nshpkg.manifest.validate",
      code: "ERR_NSHPKG_MANIFEST_INVALID",
      pluginId,
      reason: `Plugin "${pluginId}" activation must be "startup" or "on_demand"`,
    });
  }

  if (m.provides !== undefined) {
    if (!Array.isArray(m.provides)) {
      throw new PluginKernelError({
        stage: "nshpkg.manifest.validate",
        code: "ERR_NSHPKG_MANIFEST_INVALID",
        pluginId,
        reason: `Plugin "${pluginId}" provides must be an array`,
      });
    }
    for (const svc of m.provides) {
      if (
        !svc ||
        typeof svc !== "object" ||
        typeof (svc as Record<string, unknown>).id !== "string" ||
        !SERVICE_ID_RE.test((svc as Record<string, unknown>).id as string) ||
        typeof (svc as Record<string, unknown>).version !== "string"
      ) {
        throw new PluginKernelError({
          stage: "nshpkg.manifest.validate",
          code: "ERR_NSHPKG_MANIFEST_INVALID",
          pluginId,
          reason: `Plugin "${pluginId}" contains an invalid service descriptor in provides`,
        });
      }
      try {
        parseSemVer((svc as Record<string, unknown>).version as string, pluginId);
      } catch (err) {
        throw new PluginKernelError({
          stage: "nshpkg.manifest.validate",
          code: "ERR_NSHPKG_MANIFEST_INVALID",
          pluginId,
          reason: `Invalid service version on plugin "${pluginId}"`,
          cause: err,
        });
      }
    }
  }

  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      throw new PluginKernelError({
        stage: "nshpkg.manifest.validate",
        code: "ERR_NSHPKG_MANIFEST_INVALID",
        pluginId,
        reason: `Plugin "${pluginId}" dependencies must be an array`,
      });
    }
    for (const dep of m.dependencies) {
      if (
        !dep ||
        typeof dep !== "object" ||
        typeof (dep as Record<string, unknown>).service !== "string" ||
        !SERVICE_ID_RE.test((dep as Record<string, unknown>).service as string) ||
        typeof (dep as Record<string, unknown>).versionRange !== "string"
      ) {
        throw new PluginKernelError({
          stage: "nshpkg.manifest.validate",
          code: "ERR_NSHPKG_MANIFEST_INVALID",
          pluginId,
          reason: `Plugin "${pluginId}" contains an invalid dependency entry`,
        });
      }
      try {
        satisfiesSemVerRange("0.0.0", (dep as Record<string, unknown>).versionRange as string, pluginId);
      } catch (err) {
        throw new PluginKernelError({
          stage: "nshpkg.manifest.validate",
          code: "ERR_NSHPKG_MANIFEST_INVALID",
          pluginId,
          reason: `Invalid dependency SemVer range on plugin "${pluginId}"`,
          cause: err,
        });
      }
    }
  }

  return structuredClone(rawManifest as PluginManifest);
}

/**
 * Verifies a `.nshpkg` Marketplace archive:
 * 1. Structural envelope decode (JSON object, UTF-8 string, or raw `Uint8Array`)
 * 2. Trusted `keyId` resolution
 * 3. Canonical SHA-256 archive integrity verification
 * 4. RFC 8032 Ed25519 signature verification over canonical manifest + code bundle
 * 5. `PluginManifest` schema, SemVer, permission set, and `minHostApiVersion` check
 */
export function verifyNshPackage(
  rawArchive: string | Uint8Array | NshPackageEnvelope,
  options: VerifyNshPackageOptions,
): VerifiedNshPackage {
  let parsed: unknown;
  if (typeof rawArchive === "string") {
    try {
      parsed = JSON.parse(rawArchive);
    } catch (error) {
      throw new PluginKernelError({
        stage: "nshpkg.archive.parse",
        code: "ERR_NSHPKG_CORRUPT_ARCHIVE",
        reason: "Failed to parse .nshpkg JSON archive",
        cause: error,
      });
    }
  } else if (rawArchive instanceof Uint8Array) {
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawArchive));
    } catch (error) {
      throw new PluginKernelError({
        stage: "nshpkg.archive.parse",
        code: "ERR_NSHPKG_CORRUPT_ARCHIVE",
        reason: "Failed to decode .nshpkg UTF-8 JSON bytes",
        cause: error,
      });
    }
  } else {
    parsed = rawArchive;
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PluginKernelError({
      stage: "nshpkg.archive.parse",
      code: "ERR_NSHPKG_CORRUPT_ARCHIVE",
      reason: ".nshpkg archive root must be an object",
    });
  }

  const env = parsed as Record<string, unknown>;
  const pluginIdHint =
    env.manifest && typeof env.manifest === "object" && typeof (env.manifest as any).id === "string"
      ? ((env.manifest as any).id as string)
      : undefined;

  if (
    env.format !== "nshpkg-v1" ||
    typeof env.runtimeEntry !== "string" ||
    env.runtimeEntry.trim().length === 0 ||
    (env.uiEntry !== undefined && typeof env.uiEntry !== "string") ||
    typeof env.sha256 !== "string" ||
    typeof env.keyId !== "string" ||
    typeof env.signature !== "string" ||
    !env.manifest ||
    typeof env.manifest !== "object"
  ) {
    throw new PluginKernelError({
      stage: "nshpkg.archive.parse",
      code: "ERR_NSHPKG_CORRUPT_ARCHIVE",
      pluginId: pluginIdHint,
      reason: "Malformed .nshpkg v1 envelope fields",
    });
  }

  const rawTrustedKey = Object.prototype.hasOwnProperty.call(options.trustedKeys, env.keyId)
    ? options.trustedKeys[env.keyId]
    : undefined;
  if (rawTrustedKey === undefined) {
    throw new PluginKernelError({
      stage: "nshpkg.signature.key",
      code: "ERR_NSHPKG_UNTRUSTED_KEY",
      pluginId: pluginIdHint,
      reason: `Untrusted signing keyId "${env.keyId}"`,
    });
  }

  const publicKey32 = normalizeEd25519PublicKey(rawTrustedKey);
  if (!publicKey32) {
    throw new PluginKernelError({
      stage: "nshpkg.signature.key",
      code: "ERR_NSHPKG_UNTRUSTED_KEY",
      pluginId: pluginIdHint,
      reason: `Invalid Ed25519 public key configured for keyId "${env.keyId}"`,
    });
  }

  const canonicalPayload = serializeCanonicalNshPayload({
    manifest: env.manifest as PluginManifest,
    runtimeEntry: env.runtimeEntry,
    ...(env.uiEntry !== undefined ? { uiEntry: env.uiEntry as string } : {}),
  });

  const computedSha256 = computePayloadSha256Hex(canonicalPayload);
  if (computedSha256 !== env.sha256.trim().toLowerCase()) {
    throw new PluginKernelError({
      stage: "nshpkg.archive.integrity",
      code: "ERR_NSHPKG_INTEGRITY_MISMATCH",
      pluginId: pluginIdHint,
      reason: `SHA-256 mismatch: archive declared ${env.sha256}, computed ${computedSha256}`,
    });
  }

  const signatureBytes = decodeFlexibleBytes(env.signature);
  if (!signatureBytes || !verifyEd25519Signature(canonicalPayload, signatureBytes, publicKey32)) {
    throw new PluginKernelError({
      stage: "nshpkg.signature.verify",
      code: "ERR_NSHPKG_SIGNATURE_INVALID",
      pluginId: pluginIdHint,
      reason: `Ed25519 signature verification failed for keyId "${env.keyId}"`,
    });
  }

  const hostApiVersion = options.hostApiVersion ?? HOST_PLUGIN_API_VERSION;
  const manifest = validateNshPkgManifest(env.manifest, hostApiVersion);

  return {
    manifest,
    runtimeEntry: env.runtimeEntry,
    ...(env.uiEntry !== undefined ? { uiEntry: env.uiEntry as string } : {}),
    sha256: computedSha256,
    keyId: env.keyId,
  };
}
