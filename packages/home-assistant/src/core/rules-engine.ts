import type {
  Id,
  UserActionRef,
  HomeRuleProposal,
  HomeAutomationRule,
} from "@super-looi/contracts";

export interface ManualAdjustmentRecord {
  entityId: string;
  service: string;
  serviceData: Record<string, unknown>;
  contextHint: string;
  recordedAt: string;
}

export class HomeRulesEngine {
  private readonly adjustments: ManualAdjustmentRecord[] = [];
  private readonly pendingProposals = new Map<Id, HomeRuleProposal>();
  private readonly activeRules = new Map<Id, HomeAutomationRule>();

  /**
   * Records a manual user adjustment.
   * If 3 similar adjustments occur in the same context, generates a HomeRuleProposal.
   */
  public recordManualAdjustment(adjustment: {
    entityId: string;
    service: string;
    serviceData: Record<string, unknown>;
    contextHint?: string;
  }): { recorded: boolean; newProposal?: HomeRuleProposal } {
    const contextHint = adjustment.contextHint ?? "evening_study";
    const nowIso = new Date().toISOString();

    const record: ManualAdjustmentRecord = {
      entityId: adjustment.entityId,
      service: adjustment.service,
      serviceData: adjustment.serviceData,
      contextHint,
      recordedAt: nowIso,
    };

    this.adjustments.push(record);

    // Count matching adjustments
    const matching = this.adjustments.filter(
      (adj) =>
        adj.entityId === adjustment.entityId &&
        adj.service === adjustment.service &&
        adj.contextHint === contextHint
    );

    if (matching.length >= 3) {
      // Check if a proposal already exists for this pattern
      const existing = Array.from(this.pendingProposals.values()).find(
        (p) => p.entity_id === adjustment.entityId && p.context_pattern === contextHint
      );

      if (!existing) {
        const proposalId = `prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const proposal: HomeRuleProposal = {
          proposal_id: proposalId,
          entity_id: adjustment.entityId,
          context_pattern: contextHint,
          suggested_state: {
            service: adjustment.service,
            ...adjustment.serviceData,
          },
          observed_count: matching.length,
          explanation: `你最近 3 次在 ${contextHint} 都把 ${adjustment.entityId} 设为相同偏好，要把这个设为默认规则吗？`,
          created_at: nowIso,
        };

        this.pendingProposals.set(proposalId, proposal);
        return { recorded: true, newProposal: proposal };
      }
    }

    return { recorded: true };
  }

  public listPendingProposals(): HomeRuleProposal[] {
    return Array.from(this.pendingProposals.values());
  }

  public listRules(): HomeAutomationRule[] {
    return Array.from(this.activeRules.values());
  }

  /**
   * Confirms a proposal using explicit user action ref, promoting it to a deterministic rule.
   */
  public confirmRuleProposal(
    proposalId: Id,
    userAction: UserActionRef
  ): HomeAutomationRule {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Rule proposal '${proposalId}' not found.`);
    }

    const nowIso = new Date().toISOString();
    const ruleId = `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const rule: HomeAutomationRule = {
      rule_id: ruleId,
      entity_id: proposal.entity_id,
      condition: `context == "${proposal.context_pattern}"`,
      desired_state: proposal.suggested_state,
      status: "active",
      created_at: nowIso,
      confirmed_by_user_event_id: userAction.event_id,
      revoked_at: null,
    };

    this.activeRules.set(ruleId, rule);
    this.pendingProposals.delete(proposalId);

    return rule;
  }

  /**
   * Instantly revokes an active automation rule.
   */
  public revokeRule(ruleId: Id): HomeAutomationRule {
    const rule = this.activeRules.get(ruleId);
    if (!rule) {
      throw new Error(`Automation rule '${ruleId}' not found.`);
    }

    rule.status = "revoked";
    rule.revoked_at = new Date().toISOString();

    return rule;
  }
}
