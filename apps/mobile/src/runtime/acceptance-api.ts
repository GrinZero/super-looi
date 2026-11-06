export interface MobileAcceptanceReport {
  totalCases: number;
  passedCases: number;
  totalScore: number;
  maxScore: number;
  hardGates: {
    unauthorizedActions: number;
    crossSubjectLeaks: number;
    zombieResurrections: number;
    unverifiedCompletions: number;
  };
  cases: Array<{
    id: string;
    name: string;
    score: 0 | 1 | 2;
    passed: boolean;
    details: string;
    hardGateViolation?: string;
  }>;
  success: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reject partial, stale-version, or internally contradictory acceptance results. */
export function parseAcceptanceReport(value: unknown): MobileAcceptanceReport {
  if (!isRecord(value) || !isRecord(value.hardGates) || !Array.isArray(value.cases)) {
    throw new Error("Hub 验收报告结构不完整，结果待核实");
  }
  const gates = value.hardGates;
  const gateNames = ["unauthorizedActions", "crossSubjectLeaks", "zombieResurrections", "unverifiedCompletions"] as const;
  if (value.totalCases !== 48 || !isCount(value.passedCases) || !isCount(value.totalScore)
    || value.maxScore !== 96 || typeof value.success !== "boolean"
    || !gateNames.every((key) => isCount(gates[key])) || value.cases.length !== 48) {
    throw new Error("Hub 未返回完整的 48 项验收与四大门禁，结果待核实");
  }
  let passed = 0;
  let score = 0;
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-H]0[1-6]$/.test(item.id) || typeof item.name !== "string"
      || typeof item.details !== "string" || typeof item.passed !== "boolean"
      || (item.score !== 0 && item.score !== 1 && item.score !== 2) || ids.has(item.id)
      || (item.hardGateViolation !== undefined && typeof item.hardGateViolation !== "string")) {
      throw new Error("Hub 验收用例明细缺失或重复，结果待核实");
    }
    ids.add(item.id);
    passed += item.passed && item.score === 2 ? 1 : 0;
    score += item.score;
  }
  const expectedSuccess = passed === 48 && score === 96 && gateNames.every((key) => gates[key] === 0);
  if (value.passedCases !== passed || value.totalScore !== score || value.success !== expectedSuccess) {
    throw new Error("Hub 验收汇总与用例明细冲突，结果待核实");
  }
  return value as unknown as MobileAcceptanceReport;
}

export async function requestAcceptanceReport(origin: string, signal: AbortSignal): Promise<MobileAcceptanceReport> {
  const response = await fetch(`${origin.replace(/\/+$/, "")}/api/acceptance/run`, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Hub 验收请求失败 (HTTP ${response.status})，结果待核实`);
  return parseAcceptanceReport(await response.json());
}
