/** Presentation-only translations. Raw contracts and evidence remain unchanged. */
export function humanizeMemorySource(source: string): string {
  const sources: Record<string, string> = {
    authenticated_user_statement: "主人亲口确认", active_look_capture: "视觉抓拍 + 语音",
    passive_observation: "桌面视觉观察", pattern_inference: "近期习惯推断", inferred: "近期习惯推断",
    camera_frame: "桌面视觉观察", vision_description: "画面内容记录", audio_segment: "声音片段记录",
    asr_transcript: "语音转写记录", app_context: "应用使用记录", home_state: "家居状态回读",
    self_event: "机器人活动记录", runner_event: "任务执行记录",
  };
  return sources[source] ?? "来源待核实";
}

export interface EpistemicBadge {
  label: string;
  color: string;
  description: string;
}

export function humanizeEpistemicStatus(status: string): EpistemicBadge {
  const statuses: Record<string, EpistemicBadge> = {
    confirmed: { label: "已确认事实", color: "#4ADE80", description: "主人已确认这条记录" },
    observed: { label: "观察记录", color: "#28D5FF", description: "依据当时观察，不排除之后已被移动" },
    inferred: { label: "模型推测", color: "#F3C56B", description: "依据近期规律推测，仍待主人确认" },
    candidate: { label: "待确认", color: "#F3C56B", description: "线索尚待核实，暂不作为事实" },
    retracted: { label: "已撤回", color: "#FA8E86", description: "原记录已撤回，不再作为当前事实" },
    superseded: { label: "已更新", color: "#9BB0C4", description: "已有更新的记录，请以新记录为准" },
  };
  return statuses[status] ?? { label: "状态待核实", color: "#F3C56B", description: "暂时无法确认这条记录的状态" };
}

export function humanizeEntityId(entityId: string): string {
  const entities: Record<string, string> = {
    "light.study_ceiling": "书房吸顶灯", "light.study_desk": "书房台灯", "fan.study_fresh_air": "书房新风系统",
    "sensor.study_co2": "书房二氧化碳", "sensor.study_temperature": "书房温度", "sensor.study_humidity": "书房湿度",
    "sensor.study_illuminance": "书房光照", "sensor.study_presence": "书房在场状态",
  };
  if (entities[entityId]) return entities[entityId];
  if (entityId.startsWith("sensor.study_")) return "书房环境传感器";
  if (!entityId.trim()) return "家居设备";
  return /[\u3400-\u9fff]/u.test(entityId) ? entityId : "家居设备";
}

export function humanizeRuleCondition(condition: string): string {
  const clean = condition.trim();
  if (/^context\s*==\s*["']web_study["']$/u.test(clean)) return "进入书房学习时";
  if (/^context\s*==\s*["'](?:sleep|bedtime)["']$/u.test(clean)) return "准备休息时";
  if (!clean) return "满足约定条件时";
  return /[\u3400-\u9fff]/u.test(clean) && !/[{}]|==/u.test(clean) ? clean : "满足已设定的条件时";
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function humanizeDesiredState(value: unknown): string {
  const state = record(value);
  if (!state) return typeof value === "string" && /[\u3400-\u9fff]/u.test(value) && !/[{}]/u.test(value) ? value : "执行已约定的设备动作";
  const service = state.service;
  const off = service === "turn_off" || state.on === false;
  if (off) return "自动关闭";
  const on = service === "turn_on" || state.on === true;
  if (service !== undefined && !on && service !== "set_temperature" && service !== "set_brightness") return "执行已约定的设备动作";
  const details: string[] = [];
  const kelvin = state.color_temp_kelvin ?? state.kelvin;
  if (typeof kelvin === "number" && Number.isFinite(kelvin) && kelvin > 0) {
    const tone = kelvin <= 3300 ? "暖光" : kelvin <= 4500 ? "自然白光" : "冷白光";
    details.push(`${kelvin}K ${tone}`);
  }
  const brightness = state.brightness;
  if (typeof brightness === "number" && Number.isFinite(brightness) && brightness >= 0 && brightness <= 255) details.push(`亮度 ${Math.round(brightness / 255 * 100)}%`);
  if (details.length) return `${on ? "自动开启并调至" : "自动调至"} ${details.join("，")}`;
  return on ? "自动开启" : "执行已约定的设备动作";
}

export interface HumanizableRule {
  entity_id?: string;
  condition?: string;
  desired_state?: unknown;
  title?: string;
  conditionDescription?: string;
}

export interface HumanizedRule { title: string; description: string }

export function humanizeSmartHomeRule(rule: HumanizableRule): HumanizedRule {
  const entity = humanizeEntityId(rule.entity_id ?? "");
  const condition = humanizeRuleCondition(rule.condition ?? rule.conditionDescription ?? "");
  const action = humanizeDesiredState(rule.desired_state ?? rule.title);
  return { title: `${entity} · ${condition}${action}`, description: `当${condition} → ${action}` };
}

/** Existing hand-authored commitments keep their prose; machine payloads use the same rule translator. */
export function humanizeCommitment(commitment: HumanizableRule): HumanizedRule {
  if (commitment.entity_id || commitment.desired_state !== undefined) return humanizeSmartHomeRule(commitment);
  const title = commitment.title ?? "日常约定";
  return {
    title: record(title) ? humanizeDesiredState(title) : /[\u3400-\u9fff]/u.test(title) && !/[{}]|==/u.test(title) ? title : "日常约定",
    description: humanizeRuleCondition(commitment.condition ?? commitment.conditionDescription ?? ""),
  };
}

/** Public presentation API shared by the task ledger and home rules. */
export function humanizeCommitmentRule(commitment: HumanizableRule): HumanizedRule {
  return humanizeCommitment(commitment);
}

export function humanizeWorkspaceId(workspaceId: string): string {
  const workspaces: Record<string, string> = { ws_godot_island: "Godot 海岛工程", "/workspaces/super-looi-demo": "LOOI 演示工程" };
  return workspaces[workspaceId] ?? (/[\u3400-\u9fff]/u.test(workspaceId) ? workspaceId : "项目工作区");
}

export function humanizeTaskSummary(summary: string): string {
  const success = /^Task succeeded with (\d+) verified artifacts?\.?$/iu.exec(summary.trim());
  if (success) return `任务已完成 · ${success[1]} 项产物已回读核验`;
  if (/^High-risk command requires user approval\b/iu.test(summary)) return "检测到高危命令，等待主人单次授权";
  const known: Record<string, string> = { "Compiling assets": "正在整理并编译项目资源", "HTML5 build ready": "网页构建已准备好", "Export done": "导出已完成" };
  if (known[summary]) return known[summary];
  if (record(summary) || /[{}]|==/u.test(summary)) return "任务详情已记录，可查看当前执行阶段";
  const statuses: Record<string, string> = {
    awaiting_approval: "等待单次授权", running: "执行中", queued: "排队中", cancelling: "请求取消中",
    cancelled: "已确认进程退出", unknown: "结果待核实", succeeded: "执行已报告完成，产物以回读核验为准", failed: "执行失败",
  };
  if (statuses[summary.trim()]) return statuses[summary.trim()]!;
  if (!/[\u3400-\u9fff]/u.test(summary)) return "任务详情已记录，可查看当前执行阶段";
  const translated = summary.replace(/\b(awaiting_approval|running|queued|cancelling|cancelled|unknown|succeeded|failed)\b/gu, (status) => statuses[status]!);
  return /[\u3400-\u9fff]/u.test(translated) ? translated : "任务详情已记录，可查看当前执行阶段";
}

export function humanizeArtifactId(artifactId: string): string {
  const artifacts: Record<string, string> = { art_checklist: "道路与阶梯核查清单", art_app: "Godot 构建产物包", "reports/collision-review.md": "楼梯碰撞核查报告" };
  return artifacts[artifactId] ?? (/[\u3400-\u9fff]/u.test(artifactId) ? artifactId : "任务产物");
}

export type MemorySceneZone = "keyboard_left" | "monitor_right" | "bookshelf" | "drawer_right";
export interface MemorySceneTarget { xPercent: number; yPercent: number; zone: MemorySceneZone }

/** Anchors are normalized illustration positions, never measured camera coordinates. */
export function resolveMemorySceneTarget(whereText: string, itemTitle = ""): MemorySceneTarget {
  const location = whereText.trim().toLowerCase();
  if (/抽屉|drawer/u.test(location)) return { xPercent: /左|left/u.test(location) ? 18 : 87, yPercent: 81, zone: "drawer_right" };
  if (/书架|书柜|bookshelf|shelf/u.test(location)) return { xPercent: /右|right/u.test(location) ? 85 : 15, yPercent: /下|bottom/u.test(location) ? 44 : 25, zone: "bookshelf" };
  if (/键盘.*左|左.*键盘|keyboard.*left|left.*keyboard/u.test(location)) return { xPercent: 19, yPercent: 71, zone: "keyboard_left" };
  if (/杯垫|coaster/u.test(location)) return { xPercent: 86, yPercent: 69, zone: "monitor_right" };
  if (/显示器|屏幕|monitor|screen/u.test(location)) return { xPercent: /左|left/u.test(location) ? 21 : 79, yPercent: /后|behind/u.test(location) ? 36 : 49, zone: "monitor_right" };
  if (/右|right/u.test(location)) return { xPercent: 79, yPercent: 71, zone: "monitor_right" };
  if (/左|left/u.test(location)) return { xPercent: 19, yPercent: 71, zone: "keyboard_left" };
  // A title only supplies a schematic fallback when the record has no specific location.
  if (/充电线|数据线|线缆|抽屉|cable|drawer/u.test(itemTitle.toLowerCase())) return { xPercent: 87, yPercent: 81, zone: "drawer_right" };
  if (/耳机|airpods|earbuds/u.test(itemTitle.toLowerCase())) return { xPercent: 79, yPercent: 49, zone: "monitor_right" };
  if (/书|笔记|book/u.test(itemTitle.toLowerCase())) return { xPercent: 15, yPercent: 25, zone: "bookshelf" };
  if (/杯|cup|mug/u.test(itemTitle.toLowerCase())) return { xPercent: 86, yPercent: 69, zone: "monitor_right" };
  return { xPercent: 19, yPercent: 71, zone: "keyboard_left" };
}
