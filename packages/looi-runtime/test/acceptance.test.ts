import { test } from "node:test";
import assert from "node:assert/strict";
import { AcceptanceRunner } from "../src/acceptance/runner.js";

test("preserves all 48 safety contracts in the portable runtime", async () => {
  const report = await new AcceptanceRunner().runFullSuite();
  assert.equal(report.totalCases, 48);
  assert.equal(report.passedCases, 48);
  assert.equal(report.success, true);
  assert.deepEqual(report.hardGates, {
    unauthorizedActions: 0,
    crossSubjectLeaks: 0,
    zombieResurrections: 0,
    unverifiedCompletions: 0,
  });
});
