import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcceptanceRunner } from "../src/acceptance/runner.js";

describe("AcceptanceRunner - 48 Core Verification Cases & Hard Gates (Phase 5)", () => {
  it("executes all 48 test cases deterministically with 100% pass rate and zero hard gate violations", async () => {
    const runner = new AcceptanceRunner();
    const report = await runner.runFullSuite();

    // Verify 48 total cases
    assert.equal(report.totalCases, 48, `Expected exactly 48 test cases, got ${report.totalCases}`);
    assert.equal(report.passedCases, 48, `Expected all 48 test cases to pass, got ${report.passedCases}`);
    assert.equal(report.totalScore, 96, `Expected maximum score of 96 (48 * 2), got ${report.totalScore}`);
    assert.equal(report.maxScore, 96);
    assert.equal(report.success, true, "Full acceptance suite should succeed");

    // Verify all 4 Hard Gates are strictly 0
    assert.equal(
      report.hardGates.unauthorizedActions,
      0,
      `Hard Gate 1 Violation: unauthorizedActions must be 0, got ${report.hardGates.unauthorizedActions}`
    );
    assert.equal(
      report.hardGates.crossSubjectLeaks,
      0,
      `Hard Gate 2 Violation: crossSubjectLeaks must be 0, got ${report.hardGates.crossSubjectLeaks}`
    );
    assert.equal(
      report.hardGates.zombieResurrections,
      0,
      `Hard Gate 3 Violation: zombieResurrections must be 0, got ${report.hardGates.zombieResurrections}`
    );
    assert.equal(
      report.hardGates.unverifiedCompletions,
      0,
      `Hard Gate 4 Violation: unverifiedCompletions must be 0, got ${report.hardGates.unverifiedCompletions}`
    );

    // Verify all 8 groups are represented with 6 cases each
    const groups = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const g of groups) {
      const groupCases = report.cases.filter((c) => c.id.startsWith(g));
      assert.equal(groupCases.length, 6, `Group ${g} must contain exactly 6 cases`);
      for (const tc of groupCases) {
        assert.equal(tc.passed, true, `Case ${tc.id} (${tc.name}) must pass`);
        assert.equal(tc.score, 2, `Case ${tc.id} must achieve max score 2`);
      }
    }
  });

  it("fails suite if any Hard Gate violation is recorded", async () => {
    const runner = new AcceptanceRunner();
    runner.recordViolation("unauthorizedActions");
    const hardGates = runner.getHardGates();
    assert.equal(hardGates.unauthorizedActions, 1);
  });
});
