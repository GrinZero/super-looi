import type {
  MemoryClaim,
  EventEnvelope,
  ContextPackManifest,
  DeletionTombstone,
  EpochBinding,
  PrivacyEpoch,
  JsonValue,
  Id,
} from "@super-looi/contracts";
import { LateWritebackRejectedError } from "@super-looi/contracts";

export interface LastSeenQueryResult {
  claim: MemoryClaim;
  revision: number;
  observed_at: string;
  locationText: string;
  status: MemoryClaim["status"];
  source_availability: MemoryClaim["source_availability"];
  epistemicAnswer: string;
  statement: string;
}

export interface EvidenceLedger {
  ingestEvent(event: EventEnvelope): Promise<{ deduplicated: boolean }>;
  upsertClaim(claim: MemoryClaim): Promise<void>;
  getClaim(claimId: Id): Promise<MemoryClaim | null>;
  queryClaims(filter?: { predicate?: string; status?: MemoryClaim["status"]; subjectId?: string }): Promise<MemoryClaim[]>;
  queryObjectLastSeen(objectName: string): Promise<LastSeenQueryResult | null>;
  correctClaim(claimId: Id, newObject: JsonValue, userEventId: Id): Promise<MemoryClaim>;
  rejectInference(claimId: Id, suppressionKey?: Id): Promise<void>;
  deleteEvidenceSource(evidenceId: Id, scopeId?: Id): Promise<{ tombstone: DeletionTombstone; retractedClaimsCount: number }>;
  commitDerivedWrite(claim: MemoryClaim, jobEpochBinding: EpochBinding): Promise<void>;
}

export class MemoryLedgerService implements EvidenceLedger {
  // Primary storage
  private readonly eventsByKey = new Map<string, EventEnvelope>();
  private readonly eventsById = new Map<Id, EventEnvelope>();
  private readonly claimsById = new Map<Id, MemoryClaim[]>(); // claimId -> revisions array
  private readonly contextPacks = new Map<Id, ContextPackManifest>();
  private readonly tombstones: DeletionTombstone[] = [];
  private readonly suppressedInferenceKeys = new Set<string>();

  // Scope tracking for privacy & deletion generations
  private readonly scopeGenerations = new Map<string, number>(); // scopeId -> deletion_generation
  private readonly scopeCaptureEpochs = new Map<string, number>(); // scopeId -> capture_epoch

  constructor() {
    this.scopeGenerations.set("scope_household_default", 0);
    this.scopeCaptureEpochs.set("scope_household_default", 1);
  }

  public setScopeState(scopeId: string, captureEpoch: number, deletionGen: number): void {
    this.scopeCaptureEpochs.set(scopeId, captureEpoch);
    this.scopeGenerations.set(scopeId, deletionGen);
  }

  public getCaptureEpoch(scopeId = "scope_household_default"): number {
    return this.scopeCaptureEpochs.get(scopeId) ?? 1;
  }

  public getDeletionGeneration(scopeId = "scope_household_default"): number {
    return this.scopeGenerations.get(scopeId) ?? 0;
  }

  public registerContextPack(pack: ContextPackManifest): void {
    this.contextPacks.set(pack.context_pack_id, pack);
  }

  public getContextPack(packId: Id): ContextPackManifest | null {
    return this.contextPacks.get(packId) ?? null;
  }

  /**
   * Ingest event with strict idempotency and hash conflict checks:
   * (source_id, boot_epoch, sequence) is unique.
   * Same identity + same hash => deduplicated (noop).
   * Same identity + different hash => integrity conflict error!
   */
  public async ingestEvent(event: EventEnvelope): Promise<{ deduplicated: boolean }> {
    const key = `${event.source_id}:${event.boot_epoch}:${event.sequence}`;
    const existing = this.eventsByKey.get(key);

    if (existing) {
      if (existing.content_hash === event.content_hash) {
        return { deduplicated: true };
      }
      throw new Error(
        `Event integrity conflict for key '${key}': existing hash '${existing.content_hash}' does not match incoming hash '${event.content_hash}'`
      );
    }

    this.eventsByKey.set(key, event);
    this.eventsById.set(event.event_id, event);
    return { deduplicated: false };
  }

  /**
   * Save or update a memory claim, checking reinference suppression.
   */
  public async upsertClaim(claim: MemoryClaim): Promise<void> {
    if (claim.suppression_key && this.suppressedInferenceKeys.has(claim.suppression_key)) {
      if (claim.status === "candidate" || claim.status === "inferred") {
        throw new Error(
          `Claim creation rejected: suppression key '${claim.suppression_key}' is active against reinference`
        );
      }
    }

    const revisions = this.claimsById.get(claim.claim_id) ?? [];
    const existingIndex = revisions.findIndex((r) => r.revision === claim.revision);
    if (existingIndex >= 0) {
      revisions[existingIndex] = claim;
    } else {
      revisions.push(claim);
      revisions.sort((a, b) => a.revision - b.revision);
    }
    this.claimsById.set(claim.claim_id, revisions);
  }

  public async getClaim(claimId: Id): Promise<MemoryClaim | null> {
    const revisions = this.claimsById.get(claimId);
    if (!revisions || revisions.length === 0) return null;
    return revisions[revisions.length - 1]; // latest revision
  }

  public async queryClaims(filter?: {
    predicate?: string;
    status?: MemoryClaim["status"];
    subjectId?: string;
  }): Promise<MemoryClaim[]> {
    const results: MemoryClaim[] = [];
    for (const revisions of this.claimsById.values()) {
      const latest = revisions[revisions.length - 1];
      if (!latest) continue;

      if (filter?.predicate && latest.predicate !== filter.predicate) continue;
      if (filter?.status && latest.status !== filter.status) continue;
      if (filter?.subjectId && latest.subject_id !== filter.subjectId) continue;

      results.push(latest);
    }
    return results;
  }

  /**
   * Query the last-seen observation for an object, returning an epistemically honest response.
   */
  public async queryObjectLastSeen(objectName: string): Promise<LastSeenQueryResult | null> {
    const cleanQuery = objectName.trim().toLowerCase();
    const candidateClaims: MemoryClaim[] = [];

    for (const revisions of this.claimsById.values()) {
      const latest = revisions[revisions.length - 1];
      if (!latest || latest.status === "retracted" || latest.status === "superseded") continue;

      const obj = (latest.object as Record<string, unknown>) ?? {};
      const target = String(obj.target ?? obj.object ?? latest.predicate).toLowerCase();
      if (target.includes(cleanQuery) || cleanQuery.includes(target)) {
        candidateClaims.push(latest);
      }
    }

    if (candidateClaims.length === 0) {
      return null;
    }

    candidateClaims.sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime());
    const latestClaim = candidateClaims[0];
    const obj = (latestClaim.object as Record<string, unknown>) ?? {};
    const locationText = String(obj.location ?? obj.text ?? "未知位置");

    const date = new Date(latestClaim.observed_at);
    const timeFormatted = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;

    let epistemicAnswer = `我最后在 ${timeFormatted} 看到它在 ${locationText}`;
    if (latestClaim.status === "inferred") {
      epistemicAnswer += "（依据近期观察推测，待确认）";
    } else {
      epistemicAnswer += "（依据当时抓拍记录，不排除之后已被移动）";
    }

    if (latestClaim.source_availability === "source_expired") {
      epistemicAnswer += " [注：原始图像已按隐私策略过期，仅保留结构化摘要]";
    }

    return {
      claim: latestClaim,
      revision: latestClaim.revision,
      observed_at: latestClaim.observed_at,
      locationText,
      status: latestClaim.status,
      source_availability: latestClaim.source_availability,
      epistemicAnswer,
      statement: epistemicAnswer,
    };
  }

  /**
   * User Fact Correction:
   * Marks previous revision superseded, appends confirmed revision (r+1) with confirmed_by_user_event_id.
   */
  public async correctClaim(claimId: Id, newObject: JsonValue, userEventId: Id): Promise<MemoryClaim> {
    const revisions = this.claimsById.get(claimId);
    if (!revisions || revisions.length === 0) {
      throw new Error(`Cannot correct claim '${claimId}': claim not found.`);
    }

    const current = revisions[revisions.length - 1];
    const now = new Date().toISOString();

    // Close previous revision
    current.status = "superseded";
    current.valid_to = now;
    current.revised_at = now;

    // Create revision r + 1
    const nextRevision: MemoryClaim = {
      ...current,
      revision: current.revision + 1,
      object: newObject,
      status: "confirmed",
      valid_from: now,
      valid_to: null,
      recorded_at: now,
      revised_at: now,
      supersedes: { claim_id: current.claim_id, revision: current.revision },
      revision_reason: "user_correction",
      confirmed_by_user_event_id: userEventId,
    };

    revisions.push(nextRevision);
    this.claimsById.set(claimId, revisions);
    return nextRevision;
  }

  /**
   * Inference Rejection:
   * Marks inference claim as retracted and records suppression key to block future reinferences.
   */
  public async rejectInference(claimId: Id, suppressionKey?: Id): Promise<void> {
    const revisions = this.claimsById.get(claimId);
    if (!revisions || revisions.length === 0) {
      throw new Error(`Cannot reject inference for '${claimId}': claim not found.`);
    }

    const current = revisions[revisions.length - 1];
    const key = suppressionKey || current.suppression_key || current.claim_id;
    this.suppressedInferenceKeys.add(key);

    const now = new Date().toISOString();
    current.status = "retracted";
    current.valid_to = now;
    current.revised_at = now;
    current.revision_reason = "user_correction";
    current.suppression_key = key;
  }

  /**
   * Delete Evidence Source & Cascade Tombstone:
   * Bumps deletion_generation, issues tombstone, retracts all downstream claims,
   * and invalidates active ContextPacks.
   */
  public async deleteEvidenceSource(
    evidenceId: Id,
    scopeId = "scope_household_default"
  ): Promise<{ tombstone: DeletionTombstone; retractedClaimsCount: number }> {
    const currentGen = this.scopeGenerations.get(scopeId) ?? 0;
    const nextGen = currentGen + 1;
    this.scopeGenerations.set(scopeId, nextGen);

    const now = new Date().toISOString();
    const targetClaims: Id[] = [];
    const targetDerivations: Id[] = [evidenceId];

    // Find and cascade retract dependent claims
    for (const [cId, revisions] of this.claimsById.entries()) {
      const current = revisions[revisions.length - 1];
      if (!current || current.status === "retracted") continue;

      const hasEvidence = current.evidence_ids.includes(evidenceId);
      const hasDerivation = current.derivation_roots.includes(evidenceId);

      if (hasEvidence || hasDerivation) {
        current.status = "retracted";
        current.source_availability = "source_expired";
        current.revision_reason = "source_deleted";
        current.deletion_generation = nextGen;
        current.valid_to = now;
        current.revised_at = now;
        targetClaims.push(cId);
      }
    }

    // Invalidate active ContextPacks referencing deleted evidence or retracted claims
    for (const pack of this.contextPacks.values()) {
      if (pack.status === "active") {
        const referencesEvidence = pack.evidence_refs.some((e) => e.evidence_id === evidenceId);
        const referencesClaim = pack.claim_refs.some((c) => targetClaims.includes(c.claim_id));
        if (referencesEvidence || referencesClaim) {
          pack.status = "invalidated";
          pack.invalidation_reason = "source_deleted";
        }
      }
    }

    const tombstone: DeletionTombstone = {
      schema_version: "0.2",
      tombstone_id: `tomb_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      scope_id: scopeId,
      deletion_generation: nextGen,
      target_evidence_ids: [evidenceId],
      target_derivation_roots: targetDerivations,
      target_claim_ids: targetClaims,
      created_at: now,
    };

    this.tombstones.push(tombstone);
    return { tombstone, retractedClaimsCount: targetClaims.length };
  }

  /**
   * Late Writeback Guard:
   * Validates job generation against current deletion generation and capture epoch.
   * If outdated, strictly rejects write to prevent deleted/paused content resurrection.
   */
  public async commitDerivedWrite(claim: MemoryClaim, jobEpochBinding: EpochBinding): Promise<void> {
    const scopeId = jobEpochBinding.scope_id || "scope_household_default";
    const currentGen = this.scopeGenerations.get(scopeId) ?? 0;
    const currentEpoch = this.scopeCaptureEpochs.get(scopeId) ?? 1;

    // 1. Check deletion generation
    if (jobEpochBinding.deletion_generation < currentGen) {
      throw new LateWritebackRejectedError(
        `Late write rejected: deletion generation ${jobEpochBinding.deletion_generation} < current ${currentGen} (source was deleted)`
      );
    }

    // 2. Check capture epoch (privacy pause during background processing)
    if (jobEpochBinding.capture_epoch !== null && jobEpochBinding.capture_epoch < currentEpoch) {
      throw new LateWritebackRejectedError(
        `Late write rejected: capture epoch ${jobEpochBinding.capture_epoch} < current ${currentEpoch} (privacy pause occurred)`
      );
    }

    await this.upsertClaim(claim);
  }

  public getStats(): { eventsCount: number; claimsCount: number; tombstonesCount: number } {
    let totalClaimsCount = 0;
    for (const revisions of this.claimsById.values()) {
      totalClaimsCount += revisions.length;
    }
    return {
      eventsCount: this.eventsByKey.size,
      claimsCount: totalClaimsCount,
      tombstonesCount: this.tombstones.length,
    };
  }
}
