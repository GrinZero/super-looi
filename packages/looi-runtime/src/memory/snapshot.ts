import type { LedgerSnapshot } from "./ledger.js";

function record(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ledger snapshot record");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 512)
    throw new Error("Invalid ledger snapshot identity");
}
function integer(value: unknown, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error("Invalid ledger snapshot epoch or revision");
}
function array(value: unknown): asserts value is any[] {
  if (!Array.isArray(value))
    throw new Error("Invalid ledger snapshot collection");
}
function ids(value: unknown): void {
  array(value);
  value.forEach(id);
}
function time(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid ledger snapshot timestamp");
}
function bindings(value: unknown): void {
  array(value);
  for (const binding of value) {
    record(binding);
    id(binding.scope_id);
    integer(binding.deletion_generation);
    if (binding.capture_epoch !== null) integer(binding.capture_epoch, 1);
  }
}
function pairs(
  value: unknown,
  validate: (key: string, entry: any) => void,
): void {
  array(value);
  const seen = new Set<string>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new Error("Invalid ledger snapshot pair");
    id(pair[0]);
    if (seen.has(pair[0]))
      throw new Error("Duplicate ledger snapshot identity");
    seen.add(pair[0]);
    validate(pair[0], pair[1]);
  }
}

/** Validate before touching live state or serializing epochs. In particular NaN,
 * strings and null must never become an epoch that can roll back after JSON. */
export function assertLedgerSnapshot(
  value: unknown,
): asserts value is LedgerSnapshot {
  record(value);
  if (value.version !== 1)
    throw new Error("Unsupported ledger snapshot version");
  pairs(value.scopeGenerations, (_, number) => integer(number));
  pairs(value.scopeCaptureEpochs, (_, number) => integer(number, 1));
  ids(value.suppressedInferenceKeys);
  array(value.tombstones);
  for (const grave of value.tombstones) {
    record(grave);
    id(grave.tombstone_id);
    id(grave.scope_id);
    integer(grave.deletion_generation, 1);
    ids(grave.target_evidence_ids);
    ids(grave.target_derivation_roots);
    ids(grave.target_claim_ids);
    time(grave.created_at);
  }
  pairs(value.claims, (key, revisions) => {
    array(revisions);
    const seen = new Set<number>();
    for (const claim of revisions) {
      record(claim);
      id(claim.claim_id);
      if (claim.claim_id !== key)
        throw new Error("Ledger claim identity mismatch");
      integer(claim.revision, 1);
      integer(claim.deletion_generation);
      if (seen.has(claim.revision))
        throw new Error("Duplicate ledger claim revision");
      seen.add(claim.revision);
      ids(claim.evidence_ids);
      ids(claim.derivation_roots);
      id(claim.predicate);
      if (
        ![
          "candidate",
          "confirmed",
          "observed",
          "inferred",
          "retracted",
          "superseded",
        ].includes(claim.status)
      )
        throw new Error("Invalid ledger claim status");
      time(claim.observed_at);
    }
    revisions.sort((a, b) => a.revision - b.revision);
  });
  pairs(value.events, (_, event) => {
    record(event);
    id(event.event_id);
    id(event.source_id);
    id(event.boot_epoch);
    integer(event.sequence);
    id(event.content_hash);
    ids(event.derivation_roots);
    bindings([event.epoch_binding]);
    array(event.evidence_refs);
    for (const ref of event.evidence_refs) {
      record(ref);
      id(ref.evidence_id);
    }
  });
  pairs(value.contextPacks, (key, pack) => {
    record(pack);
    if (pack.context_pack_id !== key)
      throw new Error("Ledger context identity mismatch");
    bindings(pack.epoch_bindings);
    ids(pack.derivation_roots);
    time(pack.expires_at);
    if (!["active", "invalidated", "expired"].includes(pack.status))
      throw new Error("Invalid ledger context status");
    array(pack.claim_refs);
    for (const ref of pack.claim_refs) {
      record(ref);
      id(ref.claim_id);
      integer(ref.revision, 1);
    }
    array(pack.evidence_refs);
    for (const ref of pack.evidence_refs) {
      record(ref);
      id(ref.evidence_id);
    }
  });
}
