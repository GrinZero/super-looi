import type { AgentTool } from "@earendil-works/pi-agent-core";
import { int, obj, str } from "@earendil-works/pi-schema";

export interface GitHubVault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface GitHubFailure {
  stage: string;
  code?: string | number;
  reason: string;
}

export interface GitHubCredentialStatus {
  configured: boolean;
  tokenHint?: string;
}

export interface GitHubTokenVerificationResult {
  valid: boolean;
  configured: boolean;
  tokenHint?: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    resetAt: string;
  };
  failure?: GitHubFailure;
}

export interface GitHubPrStatusOptions {
  vault: Pick<GitHubVault, "get">;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_GITHUB_TIMEOUT_MS = 15_000;

const githubPrStatusParams = obj({
  owner: str({ description: "GitHub repository owner or organization name." }),
  repo: str({ description: "GitHub repository name." }),
  pullNumber: int({ minimum: 1, description: "Positive pull request number." }),
});

/** Extracts the stored GitHub token from the encrypted `"github"` vault slot. */
export function readGitHubToken(vault: Pick<GitHubVault, "get">): string {
  const raw = vault.get("github");
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown };
      if (typeof parsed?.token === "string") {
        return parsed.token.trim();
      }
    } catch {
      // Treat non-JSON slot values as raw token strings.
    }
  }
  return trimmed;
}

/** Scrubs stored GitHub PAT and bearer tokens from text before logging or display. */
export function redactGitHubSecret(text: string, token: string): string {
  if (!text) return text;
  let scrubbed = text;
  if (token.length >= 4) {
    scrubbed = scrubbed.replaceAll(token, "[redacted]");
  }
  scrubbed = scrubbed.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
  scrubbed = scrubbed.replace(/(token\s+)[^\s"']+/gi, "$1[redacted]");
  return scrubbed;
}

/** Returns whether a GitHub read-only PAT is configured and a masked hint (never plaintext). */
export function githubCredentialStatus(vault: Pick<GitHubVault, "get">): GitHubCredentialStatus {
  const token = readGitHubToken(vault);
  if (!token) {
    return { configured: false };
  }
  const tokenHint = token.length >= 4 ? `••••••••${token.slice(-4)}` : "••••";
  return { configured: true, tokenHint };
}

/** Validates and stores a GitHub fine-grained PAT in the `"github"` vault slot. */
export function saveGitHubToken(vault: GitHubVault, rawToken: string): GitHubCredentialStatus {
  if (typeof rawToken !== "string") {
    throw new Error("@looi:runtimeEnterAValidGithubToken");
  }
  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.length > 8192 || /[\r\n\s]/.test(trimmed)) {
    throw new Error("@looi:runtimeEnterAValidGithubToken");
  }
  vault.set("github", trimmed);
  return githubCredentialStatus(vault);
}

/** Removes the stored GitHub token from the `"github"` vault slot. */
export function clearGitHubToken(vault: Pick<GitHubVault, "remove">): GitHubCredentialStatus {
  vault.remove("github");
  return { configured: false };
}

function buildRequestSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function extractNetworkFailure(
  stage: string,
  error: unknown,
  token: string,
  callerSignal?: AbortSignal,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
): GitHubFailure {
  if (callerSignal?.aborted) {
    return {
      stage,
      code: "ERR_ABORTED",
      reason: "GitHub API request was aborted",
    };
  }
  if (error && typeof error === "object") {
    const errObj = error as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown };
    if (errObj.name === "TimeoutError") {
      return {
        stage,
        code: "ETIMEDOUT",
        reason: `GitHub API request timed out after ${timeoutMs}ms`,
      };
    }
    const rawCode =
      typeof errObj.code === "string" || typeof errObj.code === "number"
        ? errObj.code
        : typeof errObj.errno === "string" || typeof errObj.errno === "number"
          ? errObj.errno
          : "ERR_GITHUB_NETWORK";
    const rawReason =
      typeof errObj.message === "string" && errObj.message
        ? errObj.message
        : String(error);
    return {
      stage,
      code: rawCode,
      reason: redactGitHubSecret(rawReason, token),
    };
  }
  return {
    stage,
    code: "ERR_GITHUB_NETWORK",
    reason: redactGitHubSecret(String(error), token),
  };
}

function resolveFetcher(
  stage: string,
  explicit?: typeof fetch,
): { ok: true; fetcher: typeof fetch } | { ok: false; failure: GitHubFailure } {
  if (explicit) return { ok: true, fetcher: explicit };
  const candidate = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof candidate === "function") {
    return { ok: true, fetcher: candidate };
  }
  return {
    ok: false,
    failure: {
      stage,
      code: "ERR_GITHUB_FETCH_UNAVAILABLE",
      reason: "globalThis.fetch is unavailable in this runtime environment",
    },
  };
}

async function fetchGitHubJson<T>(input: {
  stage: string;
  pathname: string;
  token: string;
  fetcher: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  notFoundHint?: string;
}): Promise<{ ok: true; data: T } | { ok: false; failure: GitHubFailure }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Super-LOOI",
  };
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }

  let response: Response;
  try {
    response = await input.fetcher(`${GITHUB_API_BASE}${input.pathname}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: buildRequestSignal(input.timeoutMs, input.signal),
    });
  } catch (error) {
    return {
      ok: false,
      failure: extractNetworkFailure(
        input.stage,
        error,
        input.token,
        input.signal,
        input.timeoutMs,
      ),
    };
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (error) {
    return {
      ok: false,
      failure: extractNetworkFailure(
        input.stage,
        error,
        input.token,
        input.signal,
        input.timeoutMs,
      ),
    };
  }

  if (!response.ok) {
    let message = "";
    try {
      const parsed = JSON.parse(bodyText) as { message?: unknown };
      if (typeof parsed?.message === "string") {
        message = parsed.message.trim();
      }
    } catch {
      message = bodyText.trim();
    }
    const baseReason = message
      ? `GitHub API HTTP ${response.status}: ${message}`
      : `GitHub API HTTP ${response.status} ${response.statusText}`.trim();
    const reason =
      response.status === 404 && input.notFoundHint
        ? `${baseReason} (${input.notFoundHint})`
        : baseReason;
    return {
      ok: false,
      failure: {
        stage: input.stage,
        code: response.status,
        reason: redactGitHubSecret(reason, input.token),
      },
    };
  }

  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch (error) {
    return {
      ok: false,
      failure: {
        stage: `${input.stage}.parse`,
        code: "ERR_GITHUB_INVALID_JSON",
        reason: redactGitHubSecret(
          error instanceof Error ? error.message : String(error),
          input.token,
        ),
      },
    };
  }
}

/**
 * Verifies the configured GitHub PAT with `GET /rate_limit`, which succeeds for
 * fine-grained PATs that hold only repository permissions (no account profile scope).
 */
export async function verifyGitHubToken(
  vault: Pick<GitHubVault, "get">,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GitHubTokenVerificationResult> {
  const token = readGitHubToken(vault);
  if (!token) {
    return {
      valid: false,
      configured: false,
      failure: {
        stage: "github.token.verify",
        code: "ERR_GITHUB_TOKEN_MISSING",
        reason: "No GitHub token is configured",
      },
    };
  }

  const status = githubCredentialStatus(vault);
  const resolvedFetcher = resolveFetcher("github.token.verify", options.fetcher);
  if (!resolvedFetcher.ok) {
    return {
      valid: false,
      configured: true,
      tokenHint: status.tokenHint,
      failure: resolvedFetcher.failure,
    };
  }
  const res = await fetchGitHubJson<{
    rate?: { limit?: number; remaining?: number; reset?: number };
  }>({
    stage: "github.token.verify",
    pathname: "/rate_limit",
    token,
    fetcher: resolvedFetcher.fetcher,
    timeoutMs: options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS,
    signal: options.signal,
  });

  if (!res.ok) {
    return {
      valid: false,
      configured: true,
      tokenHint: status.tokenHint,
      failure: res.failure,
    };
  }

  const rate = res.data?.rate;
  const hasRate =
    typeof rate?.limit === "number" &&
    typeof rate?.remaining === "number" &&
    typeof rate?.reset === "number";

  return {
    valid: true,
    configured: true,
    tokenHint: status.tokenHint,
    ...(hasRate
      ? {
          rateLimit: {
            limit: rate.limit!,
            remaining: rate.remaining!,
            resetAt: new Date(rate.reset! * 1000).toISOString(),
          },
        }
      : {}),
  };
}

function validateRepoSegment(value: unknown, field: "owner" | "repo"): string | GitHubFailure {
  if (typeof value !== "string") {
    return {
      stage: "github.pr_status.validate",
      code: "ERR_INVALID_ARGUMENT",
      reason: `${field} must be a non-empty string`,
    };
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.length > 100 ||
    !GITHUB_SEGMENT_RE.test(trimmed)
  ) {
    return {
      stage: "github.pr_status.validate",
      code: "ERR_INVALID_ARGUMENT",
      reason: `Invalid GitHub ${field} "${value}"`,
    };
  }
  return trimmed;
}

function failureResult(failure: GitHubFailure) {
  const payload = { failure };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true,
  };
}

interface GitHubPullResponse {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  html_url?: string;
  updated_at?: string;
  user?: { login?: string } | null;
  base?: { ref?: string } | null;
  head?: { ref?: string; sha?: string } | null;
}

interface GitHubCheckRunsResponse {
  total_count?: number;
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    details_url?: string;
  }>;
}

interface GitHubCommitStatusResponse {
  state?: string;
  total_count?: number;
  statuses?: Array<{
    context?: string;
    state?: string;
    description?: string | null;
    target_url?: string | null;
  }>;
}

interface GitHubReviewItem {
  user?: { login?: string } | null;
  state?: string;
  submitted_at?: string;
}

const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAIL_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

/**
 * Creates the read-only `github_pr_status` Pi Agent tool using the App's `"github"`
 * vault slot when configured and allowing anonymous GET requests for public repos.
 */
export function createGitHubPrStatusTool(
  options: GitHubPrStatusOptions,
): AgentTool<typeof githubPrStatusParams> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

  return {
    name: "github_pr_status",
    label: "GitHub PR Status",
    description:
      "Read-only lookup of a GitHub pull request's metadata, check-runs, commit statuses, and review summary via api.github.com. Uses the App's GitHub token if configured, or anonymous GET for public repositories.",
    parameters: githubPrStatusParams,
    executionMode: "sequential",
    execute: async (_callId, params, signal) => {
      const owner = validateRepoSegment(params.owner, "owner");
      if (typeof owner !== "string") return failureResult(owner);

      const repo = validateRepoSegment(params.repo, "repo");
      if (typeof repo !== "string") return failureResult(repo);

      if (!Number.isSafeInteger(params.pullNumber) || params.pullNumber < 1) {
        return failureResult({
          stage: "github.pr_status.validate",
          code: "ERR_INVALID_ARGUMENT",
          reason: `pullNumber must be a positive integer, got ${String(params.pullNumber)}`,
        });
      }
      const pullNumber = params.pullNumber;
      const resolvedFetcher = resolveFetcher("github.pr_status.fetch", options.fetcher);
      if (!resolvedFetcher.ok) {
        return failureResult(resolvedFetcher.failure);
      }
      const fetcher = resolvedFetcher.fetcher;
      const token = readGitHubToken(options.vault);

      const prRes = await fetchGitHubJson<GitHubPullResponse>({
        stage: "github.pr_status.pr",
        pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}`,
        token,
        fetcher,
        timeoutMs,
        signal,
        notFoundHint: !token
          ? "repository or PR not found, or private repository requires a configured GitHub token"
          : undefined,
      });
      if (!prRes.ok) {
        return failureResult(prRes.failure);
      }

      const pr = prRes.data;
      const headSha = pr.head?.sha?.trim() ?? "";
      if (!headSha || !GITHUB_SEGMENT_RE.test(headSha)) {
        return failureResult({
          stage: "github.pr_status.pr",
          code: "ERR_GITHUB_MISSING_HEAD_SHA",
          reason: "Pull request response did not include a valid head.sha",
        });
      }

      const encodedSha = encodeURIComponent(headSha);
      const [checksRes, statusesRes, reviewsRes] = await Promise.all([
        fetchGitHubJson<GitHubCheckRunsResponse>({
          stage: "github.pr_status.checks",
          pathname: `/repos/${owner}/${repo}/commits/${encodedSha}/check-runs?per_page=100`,
          token,
          fetcher,
          timeoutMs,
          signal,
        }),
        fetchGitHubJson<GitHubCommitStatusResponse>({
          stage: "github.pr_status.statuses",
          pathname: `/repos/${owner}/${repo}/commits/${encodedSha}/status`,
          token,
          fetcher,
          timeoutMs,
          signal,
        }),
        fetchGitHubJson<GitHubReviewItem[]>({
          stage: "github.pr_status.reviews",
          pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=100`,
          token,
          fetcher,
          timeoutMs,
          signal,
        }),
      ]);

      if (!checksRes.ok) return failureResult(checksRes.failure);
      if (!statusesRes.ok) return failureResult(statusesRes.failure);
      if (!reviewsRes.ok) return failureResult(reviewsRes.failure);

      const checkRuns = Array.isArray(checksRes.data?.check_runs)
        ? checksRes.data.check_runs
        : [];
      let checkPassed = 0;
      let checkFailed = 0;
      let checkPending = 0;
      for (const run of checkRuns) {
        if (run.status !== "completed") {
          checkPending++;
        } else if (run.conclusion && PASS_CONCLUSIONS.has(run.conclusion)) {
          checkPassed++;
        } else if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) {
          checkFailed++;
        } else {
          checkPending++;
        }
      }

      const commitStatus = statusesRes.data;
      const statuses = Array.isArray(commitStatus?.statuses) ? commitStatus.statuses : [];
      const commitState = commitStatus?.state ?? "pending";

      const hasFailed =
        checkFailed > 0 || commitState === "failure" || commitState === "error";
      const hasPending =
        checkPending > 0 || (statuses.length > 0 && commitState === "pending");
      const overallChecks: "passed" | "failed" | "pending" | "none" =
        hasFailed
          ? "failed"
          : hasPending
            ? "pending"
            : checkRuns.length > 0 || statuses.length > 0
              ? "passed"
              : "none";

      const reviews = Array.isArray(reviewsRes.data) ? reviewsRes.data : [];
      let approved = 0;
      let changesRequested = 0;
      let commented = 0;
      let dismissed = 0;
      const latestMap = new Map<
        string,
        { user: string; state: string; submittedAt?: string }
      >();
      for (const rev of reviews) {
        const state = String(rev.state ?? "").toUpperCase();
        if (state === "APPROVED") approved++;
        else if (state === "CHANGES_REQUESTED") changesRequested++;
        else if (state === "COMMENTED") commented++;
        else if (state === "DISMISSED") dismissed++;
        const login = rev.user?.login;
        if (login && state && state !== "PENDING") {
          latestMap.set(login, {
            user: login,
            state,
            ...(rev.submitted_at ? { submittedAt: rev.submitted_at } : {}),
          });
        }
      }

      const summaryPayload = {
        owner,
        repo,
        pullNumber,
        authenticated: Boolean(token),
        pr: {
          number: pr.number ?? pullNumber,
          title: pr.title ?? "",
          state: pr.state ?? "unknown",
          draft: Boolean(pr.draft),
          merged: Boolean(pr.merged),
          mergedAt: pr.merged_at ?? null,
          mergeable: pr.mergeable ?? null,
          mergeableState: pr.mergeable_state ?? null,
          url: pr.html_url ?? "",
          author: pr.user?.login ?? null,
          baseRef: pr.base?.ref ?? null,
          headRef: pr.head?.ref ?? null,
          headSha,
          updatedAt: pr.updated_at ?? null,
        },
        checks: {
          overall: overallChecks,
          checkRuns: {
            total: checksRes.data?.total_count ?? checkRuns.length,
            passed: checkPassed,
            failed: checkFailed,
            pending: checkPending,
            runs: checkRuns.slice(0, 50).map((run) => ({
              name: run.name ?? "",
              status: run.status ?? "",
              conclusion: run.conclusion ?? null,
              detailsUrl: run.details_url ?? run.html_url ?? null,
            })),
          },
          commitStatus: {
            state: commitState,
            totalCount: commitStatus?.total_count ?? statuses.length,
            statuses: statuses.slice(0, 50).map((item) => ({
              context: item.context ?? "",
              state: item.state ?? "",
              description: item.description ?? null,
              targetUrl: item.target_url ?? null,
            })),
          },
        },
        reviews: {
          total: reviews.length,
          approved,
          changesRequested,
          commented,
          dismissed,
          latestByUser: [...latestMap.values()],
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summaryPayload) }],
        details: summaryPayload,
      };
    },
  };
}
