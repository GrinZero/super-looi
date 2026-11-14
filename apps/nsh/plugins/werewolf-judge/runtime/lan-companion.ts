import type {
  LanHttpRequest,
  LanHttpResponse,
} from "../../../runtime/plugins/contracts.js";
import { WerewolfRuleError, type CompanionSeatPrivateView, type WerewolfEngine } from "./engine.js";
import { randomTokenHex } from "./presets.js";

export type CompanionSeatActionPayload =
  | { readonly action: "confirm_deal" }
  | { readonly action: "guard_pick"; readonly targetSeat: number | null }
  | {
      readonly action: "wolf_vote";
      readonly targetSeat: number | null;
      readonly confirm?: boolean;
    }
  | {
      readonly action: "witch_act";
      readonly save: boolean;
      readonly poisonTargetSeat: number | null;
    }
  | { readonly action: "seer_check"; readonly targetSeat: number }
  | { readonly action: "seer_finish" }
  | { readonly action: "sheriff_toggle_signup" }
  | { readonly action: "sheriff_drop_out" }
  | { readonly action: "cast_vote"; readonly targetSeat: number | null }
  | { readonly action: "hunter_shoot"; readonly targetSeat: number | null }
  | { readonly action: "sheriff_transfer"; readonly targetSeat: number | null }
  | { readonly action: "white_wolf_drag"; readonly targetSeat: number | null }
  | {
      readonly action: "wolf_self_explode";
      readonly whiteWolfTargetSeat?: number | null;
    };

export interface LanCompanionOptions {
  readonly engine: WerewolfEngine;
  readonly onClaimsChanged: () => void;
  readonly onAuthenticatedAction: (
    seat: number,
    payload: CompanionSeatActionPayload,
  ) => Promise<void> | void;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(status: number, payload: unknown): LanHttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    body: JSON.stringify(payload),
  };
}

export class LanCompanionController {
  private readonly seatTokens = new Map<number, string>();

  constructor(private readonly options: LanCompanionOptions) {}

  claimedSeats(): number[] {
    const maxSeat = this.options.engine.getPlayerCount();
    return Array.from(this.seatTokens.keys())
      .filter((s) => s >= 1 && s <= maxSeat)
      .sort((a, b) => a - b);
  }

  pruneOutOfRangeClaims(maxSeat: number): void {
    let changed = false;
    for (const seat of Array.from(this.seatTokens.keys())) {
      if (seat < 1 || seat > maxSeat) {
        this.seatTokens.delete(seat);
        changed = true;
      }
    }
    if (changed) {
      this.options.onClaimsChanged();
    }
  }

  clearAllClaims(): void {
    if (this.seatTokens.size === 0) return;
    this.seatTokens.clear();
    this.options.onClaimsChanged();
  }

  async handleHttpRequest(req: LanHttpRequest): Promise<LanHttpResponse> {
    try {
      if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          cacheControl: "no-store",
          body: renderCompanionMobileHtml(),
        };
      }

      if (req.method === "GET" && req.path === "/api/lobby") {
        const claimed = new Set(this.claimedSeats());
        const count = this.options.engine.getPlayerCount();
        const seats = [];
        for (let i = 1; i <= count; i += 1) {
          const pubView = this.options.engine.projectCompanionSeatView(i);
          seats.push({
            seat: i,
            nickname: pubView.nickname,
            claimed: claimed.has(i),
            alive: pubView.alive,
          });
        }
        return jsonResponse(200, {
          ok: true,
          revision: this.options.engine.getRevision(),
          phase: this.options.engine.getPhase(),
          day: this.options.engine.getDay(),
          playerCount: count,
          seats,
        });
      }

      if (req.method === "POST" && req.path === "/api/claim") {
        const body = parseJsonObject(req.bodyText, "lan_claim");
        const seat = Number(body.seat);
        const count = this.options.engine.getPlayerCount();
        if (!Number.isInteger(seat) || seat < 1 || seat > count) {
          return jsonResponse(400, {
            ok: false,
            stage: "lan_claim",
            code: "ERR_LAN_INVALID_SEAT",
            reason: `座位号必须在 1..${count} 之间`,
          });
        }

        const providedToken = typeof body.token === "string" ? body.token.trim() : "";
        const existingToken = this.seatTokens.get(seat);
        if (existingToken && (!providedToken || !constantTimeEquals(existingToken, providedToken))) {
          return jsonResponse(403, {
            ok: false,
            stage: "lan_claim",
            code: "ERR_LAN_SEAT_ALREADY_CLAIMED",
            reason: `${seat} 号座位已被其他设备认领`,
          });
        }

        const token = existingToken ?? randomTokenHex(16);
        this.seatTokens.set(seat, token);

        if (typeof body.nickname === "string" && body.nickname.trim().length > 0) {
          this.options.engine.setSeatNickname(seat, body.nickname);
        }
        this.options.onClaimsChanged();

        const view: CompanionSeatPrivateView =
          this.options.engine.projectCompanionSeatView(seat);
        return jsonResponse(200, {
          ok: true,
          seat,
          seatToken: token,
          view,
        });
      }

      if (req.method === "GET" && req.path === "/api/state") {
        const seat = Number(req.query.seat);
        const token = typeof req.query.token === "string" ? req.query.token : "";
        const authCheck = this.verifySeatToken(seat, token, "lan_state");
        if (authCheck) return authCheck;

        return jsonResponse(200, {
          ok: true,
          view: this.options.engine.projectCompanionSeatView(seat),
        });
      }

      if (req.method === "POST" && req.path === "/api/action") {
        const body = parseJsonObject(req.bodyText, "lan_action");
        const seat = Number(body.seat);
        const token = typeof body.token === "string" ? body.token : "";
        const authCheck = this.verifySeatToken(seat, token, "lan_action");
        if (authCheck) return authCheck;

        const payload = parseActionPayload(body);
        await this.options.onAuthenticatedAction(seat, payload);

        return jsonResponse(200, {
          ok: true,
          view: this.options.engine.projectCompanionSeatView(seat),
        });
      }

      return jsonResponse(404, {
        ok: false,
        stage: "lan_router",
        code: "ERR_LAN_NOT_FOUND",
        reason: `未知副屏接口路径: ${req.method} ${req.path}`,
      });
    } catch (error) {
      if (error instanceof WerewolfRuleError) {
        return jsonResponse(400, {
          ok: false,
          stage: error.stage,
          code: error.code,
          reason: error.reason,
        });
      }
      const stage =
        error && typeof error === "object" && "stage" in error
          ? String((error as { stage?: unknown }).stage)
          : "lan_companion";
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "ERR_LAN_INTERNAL";
      const reason = error instanceof Error ? error.message : String(error);
      return jsonResponse(400, {
        ok: false,
        stage,
        code,
        reason,
      });
    }
  }

  private verifySeatToken(
    seat: number,
    token: string,
    stage: string,
  ): LanHttpResponse | null {
    const count = this.options.engine.getPlayerCount();
    if (!Number.isInteger(seat) || seat < 1 || seat > count) {
      return jsonResponse(400, {
        ok: false,
        stage,
        code: "ERR_LAN_INVALID_SEAT",
        reason: `无效的座位号 ${String(seat)}`,
      });
    }
    const expected = this.seatTokens.get(seat);
    if (!expected || !token || !constantTimeEquals(expected, token)) {
      return jsonResponse(401, {
        ok: false,
        stage,
        code: "ERR_LAN_UNAUTHORIZED_TOKEN",
        reason: "座位专属防窥令牌校验失败，请重新认领座位",
      });
    }
    return null;
  }
}

function parseJsonObject(
  rawText: string,
  stage: string,
): Record<string, unknown> {
  if (!rawText || rawText.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw Object.assign(new Error("请求 JSON 格式非法"), {
      stage,
      code: "ERR_LAN_INVALID_JSON",
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("请求体必须为 JSON 对象"), {
      stage,
      code: "ERR_LAN_JSON_NOT_OBJECT",
    });
  }
  return parsed as Record<string, unknown>;
}

function toNullableSeat(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new WerewolfRuleError(
      "lan_action_parse",
      "ERR_LAN_INVALID_TARGET_SEAT",
      `目标座位参数非法: ${String(raw)}`,
    );
  }
  return num;
}

function parseActionPayload(body: Record<string, unknown>): CompanionSeatActionPayload {
  const action = typeof body.action === "string" ? body.action : "";
  switch (action) {
    case "confirm_deal":
      return { action: "confirm_deal" };
    case "guard_pick":
      return { action: "guard_pick", targetSeat: toNullableSeat(body.targetSeat) };
    case "wolf_vote":
      return {
        action: "wolf_vote",
        targetSeat: toNullableSeat(body.targetSeat),
        confirm: body.confirm !== false,
      };
    case "witch_act":
      return {
        action: "witch_act",
        save: Boolean(body.save),
        poisonTargetSeat: toNullableSeat(body.poisonTargetSeat),
      };
    case "seer_check": {
      const targetSeat = toNullableSeat(body.targetSeat);
      if (targetSeat === null) {
        throw new WerewolfRuleError(
          "lan_action_parse",
          "ERR_LAN_SEER_REQUIRES_TARGET",
          "预言家查验必须指定目标座位",
        );
      }
      return { action: "seer_check", targetSeat };
    }
    case "seer_finish":
      return { action: "seer_finish" };
    case "sheriff_toggle_signup":
      return { action: "sheriff_toggle_signup" };
    case "sheriff_drop_out":
      return { action: "sheriff_drop_out" };
    case "cast_vote":
      return { action: "cast_vote", targetSeat: toNullableSeat(body.targetSeat) };
    case "hunter_shoot":
      return { action: "hunter_shoot", targetSeat: toNullableSeat(body.targetSeat) };
    case "sheriff_transfer":
      return { action: "sheriff_transfer", targetSeat: toNullableSeat(body.targetSeat) };
    case "white_wolf_drag":
      return { action: "white_wolf_drag", targetSeat: toNullableSeat(body.targetSeat) };
    case "wolf_self_explode":
      return {
        action: "wolf_self_explode",
        whiteWolfTargetSeat:
          body.whiteWolfTargetSeat === undefined
            ? undefined
            : toNullableSeat(body.whiteWolfTargetSeat),
      };
    default:
      throw new WerewolfRuleError(
        "lan_action_parse",
        "ERR_LAN_UNKNOWN_ACTION",
        `不支持的副屏动作类型: ${action}`,
      );
  }
}

export function renderCompanionMobileHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>LOOI 狼人杀防窥副屏</title>
<style>
  :root {
    --bg: #0b0d12;
    --card: #151923;
    --border: rgba(255,255,255,0.1);
    --fg: #f3f5f9;
    --muted: #8b93a7;
    --accent: #f59e0b;
    --accent-fg: #111318;
    --danger: #ef4444;
    --ok: #10b981;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; user-select: none; }
  body {
    margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    min-height: 100vh;
  }
  .wrap { max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 16px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .badge {
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    background: rgba(245,158,11,0.16); color: var(--accent); font-weight: 600;
  }
  .status-pill {
    margin-top: 8px; padding: 8px 12px; border-radius: 10px;
    background: rgba(16,185,129,0.14); color: #6ee7b7; font-size: 13px; font-weight: 600;
  }
  .pack-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .pack-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; border-radius: 10px; background: #0f131b; border: 1px solid var(--border);
    font-size: 13px;
  }
  h1 { font-size: 18px; margin: 0; }
  p { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 12px; }
  button {
    min-height: 48px; border-radius: 12px; border: 1px solid var(--border);
    background: #1d2331; color: var(--fg); font-size: 14px; font-weight: 600;
    padding: 10px 12px; cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; width: 100%; }
  button.danger { background: rgba(239,68,68,0.18); color: #fca5a5; border-color: rgba(239,68,68,0.4); }
  button.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(245,158,11,0.35); }
  button:disabled { opacity: 0.42; cursor: not-allowed; }
  input {
    width: 100%; min-height: 46px; border-radius: 12px; border: 1px solid var(--border);
    background: #0f131c; color: var(--fg); padding: 0 12px; font-size: 15px; margin-top: 10px;
    user-select: text;
  }
  .shield {
    text-align: center; padding: 22px 14px; border-radius: 14px;
    background: #0f131b; border: 1px dashed rgba(255,255,255,0.18); margin-top: 10px;
  }
  .role-title { font-size: 24px; font-weight: 800; color: var(--accent); margin-bottom: 6px; }
  .toast { font-size: 13px; color: #fca5a5; min-height: 18px; }
</style>
</head>
<body>
<div class="wrap" id="app">
  <div class="card"><p>正在连接 LOOI 法官局域网房间…</p></div>
</div>
<script>
(() => {
  const STORE_KEY = "looi_werewolf_seat_v1";
  let session = null;
  try { session = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch {}
  let lobby = null;
  let view = null;
  let rev = 0;
  let peekingRole = false;
  let draftTarget = null;
  let confirmExplodeArmed = false;
  let errorMsg = "";

  function esc(val) {
    return String(val == null ? "" : val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!data.ok) throw new Error(data.reason || "操作失败");
    return data;
  }

  async function refresh() {
    errorMsg = "";
    try {
      if (session && session.seat && session.token) {
        const res = await api("/api/state?seat=" + Number(session.seat) + "&token=" + encodeURIComponent(session.token));
        view = res.view;
        rev = view.revision;
      } else {
        const res = await api("/api/lobby");
        lobby = res;
        rev = res.revision;
      }
    } catch (err) {
      session = null;
      view = null;
      try { localStorage.removeItem(STORE_KEY); } catch {}
      errorMsg = err.message || String(err);
      try { lobby = await api("/api/lobby"); rev = lobby.revision; } catch {}
    }
    render();
  }

  async function claimSeat(seat) {
    const nickEl = document.getElementById("nick-input");
    const nickname = nickEl ? nickEl.value.trim() : "";
    try {
      const res = await api("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seat: Number(seat), nickname })
      });
      session = { seat: res.seat, token: res.seatToken };
      try { localStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch {}
      view = res.view;
      rev = view.revision;
      errorMsg = "";
      render();
    } catch (err) {
      errorMsg = err.message;
      render();
    }
  }

  async function sendAction(payload) {
    if (!session) return;
    try {
      const res = await api("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ seat: session.seat, token: session.token }, payload))
      });
      view = res.view;
      rev = view.revision;
      draftTarget = null;
      confirmExplodeArmed = false;
      errorMsg = "";
      render();
    } catch (err) {
      errorMsg = err.message;
      render();
    }
  }

  function renderWolfPackHtml(teammates) {
    if (!Array.isArray(teammates) || teammates.length === 0) return "";
    return '<div class="pack-list">' +
      teammates.map(w => {
        const roleTag = w.role === "white_wolf_king" ? "白狼王" : "狼人";
        let targetText = "待选择";
        if (!w.alive) targetText = "已出局";
        else if (w.selectedTarget === null) targetText = "意向：空刀";
        else if (typeof w.selectedTarget === "number") targetText = "意向：" + Number(w.selectedTarget) + "号";
        return '<div class="pack-item">' +
          '<span>#' + Number(w.seat) + ' · ' + esc(roleTag) + '</span>' +
          '<span class="badge">' + esc(targetText) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function renderSubmittedBanner(p) {
    if (!p || !p.alreadySubmitted) return "";
    const picked = p.selectedTargetSeat == null ? "弃权 / 空过" : (Number(p.selectedTargetSeat) + "号");
    return '<div class="status-pill">已提交选择：' + esc(picked) + '（一致前可改选）</div>';
  }

  function render() {
    const root = document.getElementById("app");
    if (!view) {
      const seats = (lobby && lobby.seats) || [];
      root.innerHTML =
        '<div class="card">' +
          '<div class="row"><h1>LOOI 狼人杀副屏</h1><span class="badge">选座入场</span></div>' +
          '<p>输入你的称呼并点选对应座位号绑定防窥令牌：</p>' +
          '<input id="nick-input" placeholder="输入昵称（可选）" maxlength="12" />' +
          '<div class="grid">' +
            seats.map(s =>
              '<button ' + (s.claimed ? 'disabled' : '') + ' data-claim="' + Number(s.seat) + '">' +
              Number(s.seat) + '号<br/><small>' + (s.claimed ? '已认领' : esc(s.nickname)) + '</small></button>'
            ).join('') +
          '</div>' +
          (errorMsg ? '<p class="toast">' + esc(errorMsg) + '</p>' : '') +
        '</div>';
      root.querySelectorAll("[data-claim]").forEach(btn => {
        btn.onclick = () => claimSeat(Number(btn.getAttribute("data-claim")));
      });
      return;
    }

    const p = view.actionPrompt;
    let actionHtml = '<p>当前无需操作，请听从桌面 LOOI 法官主持。</p>';
    if (view.phase === "game_over") {
      actionHtml =
        '<div class="shield"><div class="role-title">' +
        esc(view.winner === "good" ? "好人阵营获胜" : "狼人阵营获胜") +
        '</div><p>' + esc(view.winReason || "") + '</p></div>' +
        (view.aiMvpReviewText ? '<p style="margin-top:10px;color:var(--fg)">🎙️ AI 法官复盘：' + esc(view.aiMvpReviewText) + '</p>' : '');
    } else if (p) {
      if (p.kind === "confirm_deal") {
        actionHtml = '<button class="primary" id="act-deal">我已记住底牌</button>';
      } else if (p.kind === "sheriff_signup") {
        actionHtml = '<button class="primary" id="act-signup">' + (p.alreadySubmitted ? '取消上警报名' : '报名竞选警长') + '</button>';
      } else if (p.kind === "sheriff_drop") {
        actionHtml = '<button class="danger" id="act-drop" style="width:100%">退水（退出警长竞选）</button>';
      } else if (p.kind === "seer_ack" && p.latestSeerResult) {
        actionHtml = '<div class="shield"><div class="role-title">' + Number(p.latestSeerResult.targetSeat) + '号：' +
          (p.latestSeerResult.isWolf ? '狼人（查杀）' : '好人（金水）') + '</div></div>' +
          '<button class="primary" id="act-seer-done" style="margin-top:10px">记住了，结束查验</button>';
      } else if (p.kind === "witch_act" && p.witchInfo) {
        const atk = p.witchInfo.attackedSeat ? ('今晚倒牌：' + Number(p.witchInfo.attackedSeat) + '号') : '解药已用或无人被刀';
        actionHtml = '<p>' + esc(atk) + '</p>' +
          (p.witchInfo.canSave ? '<button class="primary" id="act-witch-save" style="margin-top:8px">使用解药救人</button>' : '') +
          (p.witchInfo.canPoison ? '<div class="grid">' + p.selectableSeats.map(s =>
            '<button class="' + (draftTarget === s ? 'selected' : '') + '" data-pick="' + Number(s) + '">毒 ' + Number(s) + '号</button>'
          ).join('') + '</div>' +
          (draftTarget ? '<button class="danger" id="act-witch-poison" style="width:100%;margin-top:8px">确认毒杀 ' + Number(draftTarget) + '号</button>' : '') : '') +
          '<button id="act-witch-skip" style="width:100%;margin-top:8px">今晚不用药</button>';
      } else {
        const activePick = draftTarget !== null ? draftTarget : (p.alreadySubmitted ? p.selectedTargetSeat : null);
        actionHtml =
          (p.kind === "wolf_consensus" ? renderWolfPackHtml(p.wolfTeammates) : '') +
          renderSubmittedBanner(p) +
          '<div class="grid">' +
          p.selectableSeats.map(s =>
            '<button class="' + (activePick === s ? 'selected' : '') + '" data-pick="' + Number(s) + '">' + Number(s) + '号</button>'
          ).join('') + '</div>' +
          '<div class="row" style="margin-top:10px">' +
            (p.canSkip ? '<button id="act-skip" style="flex:1">弃权 / 空过</button>' : '') +
            '<button class="primary" id="act-submit" style="flex:2" ' + (draftTarget === null ? 'disabled' : '') + '>确认提交</button>' +
          '</div>';
      }
    }

    const explodeHtml = view.canSelfExplode
      ? '<div class="card">' +
          '<div class="row"><h1>狼人白天战术</h1><span class="badge">谨慎操作</span></div>' +
          (confirmExplodeArmed
            ? '<p>确认立即拍刀自爆并中断白天？</p>' +
              '<div class="row" style="margin-top:10px">' +
                '<button id="act-explode-cancel" style="flex:1">取消</button>' +
                '<button class="danger" id="act-explode-confirm" style="flex:2">确认拍刀自爆</button>' +
              '</div>'
            : '<button class="danger" id="act-explode-arm" style="width:100%;margin-top:10px">狼人拍刀自爆</button>') +
        '</div>'
      : '';

    root.innerHTML =
      '<div class="card">' +
        '<div class="row"><h1>#' + Number(view.seat) + ' ' + esc(view.nickname) + (view.isSheriff ? ' ★警长' : '') + '</h1>' +
        '<span class="badge">第' + Number(view.day) + '天 · ' + esc(view.phaseLabel) + '</span></div>' +
        '<div class="shield" id="role-shield">' +
          (peekingRole && view.myRoleLabel
            ? '<div class="role-title">' + esc(view.myRoleLabel) + '</div><p>' + esc(view.myRoleHint || '') + '</p>'
            : '<strong>按住此处防窥查看我的底牌</strong><p>松手立即隐藏，防止邻座余光窥牌</p>') +
        '</div>' +
      '</div>' +
      '<div class="card"><h1>当前行动</h1>' + actionHtml +
        (errorMsg ? '<p class="toast">' + esc(errorMsg) + '</p>' : '') +
      '</div>' +
      explodeHtml;

    const shield = document.getElementById("role-shield");
    if (shield) {
      shield.onpointerdown = () => { peekingRole = true; render(); };
      shield.onpointerup = shield.onpointercancel = shield.onpointerleave = () => { if (peekingRole) { peekingRole = false; render(); } };
    }
    root.querySelectorAll("[data-pick]").forEach(btn => {
      btn.onclick = () => { draftTarget = Number(btn.getAttribute("data-pick")); render(); };
    });
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    bind("act-deal", () => sendAction({ action: "confirm_deal" }));
    bind("act-signup", () => sendAction({ action: "sheriff_toggle_signup" }));
    bind("act-drop", () => sendAction({ action: "sheriff_drop_out" }));
    bind("act-seer-done", () => sendAction({ action: "seer_finish" }));
    bind("act-witch-save", () => sendAction({ action: "witch_act", save: true, poisonTargetSeat: null }));
    bind("act-witch-poison", () => sendAction({ action: "witch_act", save: false, poisonTargetSeat: draftTarget }));
    bind("act-witch-skip", () => sendAction({ action: "witch_act", save: false, poisonTargetSeat: null }));
    bind("act-explode-arm", () => { confirmExplodeArmed = true; render(); });
    bind("act-explode-cancel", () => { confirmExplodeArmed = false; render(); });
    bind("act-explode-confirm", () => sendAction({ action: "wolf_self_explode" }));
    bind("act-skip", () => {
      if (!p) return;
      const map = { guard_pick: "guard_pick", wolf_consensus: "wolf_vote", vote_ballot: "cast_vote", hunter_shoot: "hunter_shoot", sheriff_transfer: "sheriff_transfer", white_wolf_drag: "white_wolf_drag" };
      if (map[p.kind]) sendAction({ action: map[p.kind], targetSeat: null });
    });
    bind("act-submit", () => {
      if (!p || draftTarget === null) return;
      const map = { guard_pick: "guard_pick", wolf_consensus: "wolf_vote", seer_check: "seer_check", vote_ballot: "cast_vote", hunter_shoot: "hunter_shoot", sheriff_transfer: "sheriff_transfer", white_wolf_drag: "white_wolf_drag" };
      if (map[p.kind]) sendAction({ action: map[p.kind], targetSeat: draftTarget });
    });
  }

  async function watchLoop() {
    while (true) {
      try {
        const res = await fetch("/api/wait?sinceRev=" + rev + "&timeoutMs=15000");
        if (res.ok) {
          const info = await res.json();
          if (info && info.revision !== rev) await refresh();
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh().then(watchLoop);
})();
</script>
</body>
</html>`;
}
