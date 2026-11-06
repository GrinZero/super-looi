import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAcceptanceReport, type MobileAcceptanceReport } from "../src/runtime/acceptance-api.js";

function fullReport(): MobileAcceptanceReport {
  return {
    totalCases: 48, passedCases: 48, totalScore: 96, maxScore: 96, success: true,
    hardGates: { unauthorizedActions: 0, crossSubjectLeaks: 0, zombieResurrections: 0, unverifiedCompletions: 0 },
    cases: [..."ABCDEFGH"].flatMap((group) => Array.from({ length: 6 }, (_, index) => ({
      id: `${group}0${index + 1}`, name: "Acceptance fixture", score: 2 as const, passed: true, details: "Test evidence",
    }))),
  };
}

describe("Hub acceptance result verification", () => {
  it("accepts complete verified details and preserves honest failure outcomes", () => {
    assert.equal(parseAcceptanceReport(fullReport()).success, true);
    const failed = fullReport();
    failed.cases[0] = { ...failed.cases[0], score: 1, passed: false };
    failed.passedCases = 47;
    failed.totalScore = 95;
    failed.success = false;
    assert.equal(parseAcceptanceReport(failed).passedCases, 47);
  });

  it("rejects forged success, partial results, duplicate IDs and unknown groups", () => {
    const wrongScore = fullReport();
    wrongScore.cases[0].score = 0;
    assert.throws(() => parseAcceptanceReport(wrongScore), /冲突/);
    const partial = fullReport();
    partial.cases.pop();
    assert.throws(() => parseAcceptanceReport(partial), /完整/);
    const duplicate = fullReport();
    duplicate.cases[1].id = "A01";
    assert.throws(() => parseAcceptanceReport(duplicate), /重复/);
    const unknown = fullReport();
    unknown.cases[0].id = "X01";
    assert.throws(() => parseAcceptanceReport(unknown), /缺失/);
  });

  it("refuses all-green success when any safety hard gate is nonzero", () => {
    const unsafe = fullReport();
    unsafe.hardGates.unauthorizedActions = 1;
    assert.throws(() => parseAcceptanceReport(unsafe), /冲突/);
    unsafe.success = false;
    assert.equal(parseAcceptanceReport(unsafe).success, false);
  });
});
