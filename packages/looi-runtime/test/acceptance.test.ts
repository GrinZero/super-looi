import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcceptanceRunner } from "../src/acceptance/runner.js";

describe("AcceptanceRunner - retained runtime behavior cases", () => {
  it("executes retained behavior cases with no hard gate violations", async () => {
    const runner = new AcceptanceRunner();
    const report = await runner.runFullSuite();

    // Verify the retained cases after removing the unused memory subsystem.
    assert.equal(report.totalCases, 33, `Expected exactly 33 test cases, got ${report.totalCases}`);
    assert.equal(report.passedCases, 33, `Expected all 33 test cases to pass, got ${report.passedCases}`);
    assert.equal(report.totalScore, 66, `Expected maximum score of 66 (33 * 2), got ${report.totalScore}`);
    assert.equal(report.maxScore, 66);
    assert.equal(report.success, true, "Full acceptance suite should succeed");

    // Verify the task execution gates.
    assert.equal(
      report.hardGates.unauthorizedActions,
      0,
      `Hard Gate 1 Violation: unauthorizedActions must be 0, got ${report.hardGates.unauthorizedActions}`
    );
    assert.equal(
      report.hardGates.unverifiedCompletions,
      0,
      `Hard Gate 4 Violation: unverifiedCompletions must be 0, got ${report.hardGates.unverifiedCompletions}`
    );

    const retainedCases: Record<string, string[]> = {
      A: ["A04", "A05", "A06"],
      B: ["B01", "B03", "B06"],
      C: ["C02", "C03", "C04", "C05"],
      E: ["E01", "E02", "E03", "E04", "E05", "E06"],
      F: ["F01", "F02", "F04", "F05", "F06"],
      G: ["G01", "G02", "G03", "G04", "G05", "G06"],
      H: ["H01", "H02", "H03", "H04", "H05", "H06"],
    };
    for (const [g, expectedIds] of Object.entries(retainedCases)) {
      const groupCases = report.cases.filter((c) => c.id.startsWith(g));
      assert.deepEqual(groupCases.map((c) => c.id), expectedIds);
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
