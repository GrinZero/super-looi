import { jsonValuesEqual, delay } from "./runtime-utils.js";
import type { HaTransportAdapter } from "../types.js";
import { InMemoryHaTransportAdapter } from "../transports/in-memory-transport.js";
import { transportErrorDetails } from "../transport-error.js";
import type {
  HomeEntityDefinition,
  HomeStateSnapshot,
  HomeControlCommand,
  ActionReceipt,
  JsonObject,
} from "@super-looi/contracts";

export const FORBIDDEN_HIGH_RISK_DOMAINS = new Set([
  "lock",
  "alarm_control_panel",
  "gas",
  "water_heater",
  "garage_door",
  "valve",
  "siren",
]);

export interface TargetDisambiguationResult {
  status: "resolved" | "ambiguous" | "none";
  entity?: HomeEntityDefinition;
  candidates?: HomeEntityDefinition[];
  clarificationPrompt?: string;
}

export interface BatchExecutionResult {
  outcome: "applied" | "noop" | "partial" | "failed";
  receipts: ActionReceipt[];
  failedEntities: Array<{ entityId: string; reason: string }>;
}

export interface HomeGateway {
  listEntities(): Promise<HomeEntityDefinition[]>;
  getState(entityId: string): Promise<HomeStateSnapshot | null>;
  resolveTargets(query: string, roomHint?: string): Promise<TargetDisambiguationResult>;
  executeCommand(command: HomeControlCommand): Promise<ActionReceipt>;
  executeBatch(commands: HomeControlCommand[]): Promise<BatchExecutionResult>;
  readEnvironmentalMetric(metric: "temperature" | "humidity" | "co2" | "pm25"): Promise<{
    source: "sensor";
    entityId: string;
    metric: string;
    value: number;
    unit: string;
    timestamp: string;
  }>;
  reconcileDeviceAndVisualState(entityId: string, visualDescription: string): Promise<{
    entityId: string;
    deviceState: HomeStateSnapshot;
    visualObservation: { description: string; observedAt: string };
    isConsistent: boolean;
    explanation: string;
  }>;
}

export class HomeAssistantGateway implements HomeGateway {
  private readonly entityDefinitions = new Map<string, HomeEntityDefinition>();
  private readonly transport: HaTransportAdapter;

  constructor(options: { transport?: HaTransportAdapter; initialEntities?: HomeEntityDefinition[] } = {}) {
    this.transport = options.transport ?? new InMemoryHaTransportAdapter();

    // Default whitelisted seed entities
    const defaultEntities: HomeEntityDefinition[] = options.initialEntities ?? [
      {
        entity_id: "light.study_ceiling",
        friendly_name: "书房吸顶灯",
        room: "书房",
        domain: "light",
        supported_features: ["turn_on", "turn_off", "brightness", "color_temp"],
        allowed_range: {
          brightness: [1, 255],
          color_temp_kelvin: [2200, 6500],
        },
        is_whitelisted: true,
        max_state_age_ms: 15000,
      },
      {
        entity_id: "light.study_desk",
        friendly_name: "书房台灯",
        room: "书房",
        domain: "light",
        supported_features: ["turn_on", "turn_off", "brightness"],
        allowed_range: {
          brightness: [1, 255],
        },
        is_whitelisted: true,
        max_state_age_ms: 15000,
      },
      {
        entity_id: "switch.desk_fan",
        friendly_name: "书房桌面风扇",
        room: "书房",
        domain: "switch",
        supported_features: ["turn_on", "turn_off"],
        is_whitelisted: true,
        max_state_age_ms: 20000,
      },
      {
        entity_id: "sensor.study_temperature",
        friendly_name: "书房温湿度传感器温度",
        room: "书房",
        domain: "sensor",
        supported_features: ["read"],
        is_whitelisted: true,
        max_state_age_ms: 60000,
      },
      {
        entity_id: "sensor.study_humidity",
        friendly_name: "书房温湿度传感器湿度",
        room: "书房",
        domain: "sensor",
        supported_features: ["read"],
        is_whitelisted: true,
        max_state_age_ms: 60000,
      },
    ];

    for (const ent of defaultEntities) {
      this.entityDefinitions.set(ent.entity_id, ent);
    }
  }

  public registerEntity(entity: HomeEntityDefinition): void {
    this.entityDefinitions.set(entity.entity_id, entity);
  }

  public replaceEntities(entities: HomeEntityDefinition[]): void {
    this.entityDefinitions.clear();
    for (const entity of entities) this.registerEntity(entity);
  }

  public getTransport(): HaTransportAdapter {
    return this.transport;
  }

  public async listEntities(): Promise<HomeEntityDefinition[]> {
    return Array.from(this.entityDefinitions.values()).filter((e) => e.is_whitelisted);
  }

  public async getState(entityId: string): Promise<HomeStateSnapshot | null> {
    return this.transport.fetchState(entityId);
  }

  public async getStates(): Promise<Array<HomeEntityDefinition & { snapshot: HomeStateSnapshot | null; read_error?: JsonObject }>> {
    const entities = await this.listEntities();
    if (!entities.length) return [];
    if (this.transport.listStates) {
      try {
        const states = new Map((await this.transport.listStates()).map((state) => [state.entity_id, state]));
        return entities.map((entity) => {
          const snapshot = states.get(entity.entity_id) ?? null;
          const error = snapshot?.attributes.read_error;
          return { ...entity, snapshot, ...(error && typeof error === "object" && !Array.isArray(error) ? { read_error: error } : {}) };
        });
      } catch (error) {
        const read_error = transportErrorDetails(error, "home_state_read_failed");
        return entities.map((entity) => ({ ...entity, snapshot: null, read_error }));
      }
    }
    return Promise.all(entities.map(async (entity) => {
      try { return { ...entity, snapshot: await this.getState(entity.entity_id) }; }
      catch (error) { return { ...entity, snapshot: null, read_error: transportErrorDetails(error, "home_state_read_failed") }; }
    }));
  }

  /**
   * Target Disambiguation:
   * When query matches multiple entities (e.g. "书房灯" -> ceiling and desk),
   * returns clarificationPrompt instead of guessing!
   */
  public async resolveTargets(query: string, roomHint?: string): Promise<TargetDisambiguationResult> {
    const q = query.trim().toLowerCase();
    const hint = roomHint?.trim().toLowerCase();

    const directMatches: HomeEntityDefinition[] = [];
    const genericMatches: HomeEntityDefinition[] = [];

    for (const entity of this.entityDefinitions.values()) {
      if (!entity.is_whitelisted) continue;

      const roomMatch = !hint || entity.room?.toLowerCase() === hint;
      if (!roomMatch) continue;

      const direct =
        entity.friendly_name.toLowerCase().includes(q) ||
        entity.entity_id.toLowerCase().includes(q);

      if (direct) {
        directMatches.push(entity);
      }

      const generic =
        (q.includes("灯") && entity.domain === "light") ||
        (q.includes("风扇") && entity.domain === "switch");

      if (generic) {
        genericMatches.push(entity);
      }
    }

    const candidates = directMatches.length > 0 ? directMatches : genericMatches;

    if (candidates.length === 1) {
      return { status: "resolved", entity: candidates[0] };
    }

    if (candidates.length > 1) {
      const names = candidates.map((c) => c.friendly_name).join("和");
      return {
        status: "ambiguous",
        candidates,
        clarificationPrompt: `${candidates[0].room || "该区域"}有${names}，你想调哪一盏？`,
      };
    }

    return {
      status: "none",
      clarificationPrompt: "未找到匹配的智能设备，请确认名称或房间。",
    };
  }

  /**
   * Executes a control command with explicit target state, whitelist checks,
   * fresh noop detection, and readback verification.
   */
  public async executeCommand(command: HomeControlCommand): Promise<ActionReceipt> {
    const nowIso = new Date().toISOString();
    const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const receiptId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 1. High-risk domain check (STRICT SECURITY BOUNDARY)
    const domain = command.domain || command.entity_id.split(".")[0];
    if (FORBIDDEN_HIGH_RISK_DOMAINS.has(domain)) {
      return {
        schema_version: "0.2",
        receipt_id: receiptId,
        action_id: actionId,
        task_id: null,
        receipt_seq: 1,
        executor_id: "home_assistant_gateway",
        recorded_at: nowIso,
        status: "rejected",
        reason_code: "forbidden_high_risk_domain",
        readbacks: [],
      };
    }

    // 2. Whitelist check
    const definition = this.entityDefinitions.get(command.entity_id);
    if (!definition || !definition.is_whitelisted) {
      return {
        schema_version: "0.2",
        receipt_id: receiptId,
        action_id: actionId,
        task_id: null,
        receipt_seq: 1,
        executor_id: "home_assistant_gateway",
        recorded_at: nowIso,
        status: "rejected",
        reason_code: "entity_not_whitelisted",
        readbacks: [],
      };
    }

    // 3. No-Toggle Discipline (Reject non-idempotent toggle)
    if (command.service === "toggle") {
      return {
        schema_version: "0.2",
        receipt_id: receiptId,
        action_id: actionId,
        task_id: null,
        receipt_seq: 1,
        executor_id: "home_assistant_gateway",
        recorded_at: nowIso,
        status: "rejected",
        reason_code: "non_idempotent_toggle_forbidden",
        readbacks: [],
      };
    }

    const allowedServices = new Set([
      "turn_on",
      "turn_off",
      "set_temperature",
      "set_hvac_mode",
      "set_fan_mode",
      "set_swing_mode",
      "set_preset_mode",
      "set_percentage",
      "oscillate",
      "set_direction",
      "select_option",
      "set_value",
      "press",
      "send_message",
    ]);
    const isExtendedService = [
      "set_temperature",
      "set_hvac_mode",
      "set_fan_mode",
      "set_swing_mode",
      "set_preset_mode",
      "set_percentage",
      "oscillate",
      "set_direction",
      "select_option",
      "set_value",
      "press",
      "send_message",
    ].includes(command.service);

    if (domain !== definition.domain || domain !== command.entity_id.split(".")[0]
      || !allowedServices.has(command.service)
      || !definition.supported_features.includes(command.service)
      || !command.service_data || typeof command.service_data !== "object" || Array.isArray(command.service_data)
      || (!isExtendedService && Object.entries(command.service_data).some(([key, value]) =>
        !["brightness", "color_temp_kelvin"].includes(key)
        || domain !== "light" || command.service !== "turn_on"
        || !definition.supported_features.includes(key === "color_temp_kelvin" ? "color_temp" : key)
        || typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)))) {
      return { schema_version: "0.2", receipt_id: receiptId, action_id: actionId, task_id: null,
        receipt_seq: 1, executor_id: "home_assistant_gateway", recorded_at: nowIso,
        status: "rejected", reason_code: "unsupported_home_command", readbacks: [] };
    }

    // 4. Parameter bounds check (e.g. brightness within allowed range)
    if (definition.allowed_range && command.service_data) {
      for (const [key, range] of Object.entries(definition.allowed_range)) {
        if (typeof command.service_data[key] === "number") {
          const val = command.service_data[key] as number;
          if (val < range[0] || val > range[1]) {
            return {
              schema_version: "0.2",
              receipt_id: receiptId,
              action_id: actionId,
              task_id: null,
              receipt_seq: 1,
              executor_id: "home_assistant_gateway",
              recorded_at: nowIso,
              status: "rejected",
              reason_code: `parameter_out_of_range:${key}`,
              readbacks: [],
            };
          }
        }
      }
    }

    // Transports may quantize to the closest supported hardware step, after policy validation.
    const targetData = this.transport.normalizeServiceData?.(command.entity_id, command.service_data) ?? command.service_data;
    if (!isExtendedService && (Object.keys(targetData).length !== Object.keys(command.service_data).length
      || Object.keys(command.service_data).some((key) => {
        const value = targetData[key];
        const range = definition.allowed_range?.[key];
        return typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)
          || (range && (value < range[0] || value > range[1]));
      }))) {
      return { schema_version: "0.2", receipt_id: receiptId, action_id: actionId, task_id: null,
        receipt_seq: 1, executor_id: "home_assistant_gateway", recorded_at: nowIso,
        status: "rejected", reason_code: "unsupported_home_command", readbacks: [] };
    }
    // State and requested attributes must both match, including on-to-on adjustments.
    let current: HomeStateSnapshot | null = null;
    let preReadError: JsonObject | undefined;
    const fetchState = () => this.transport.fetchState(command.entity_id, Object.keys(targetData));
    try { current = await fetchState(); }
    catch (error) { preReadError = transportErrorDetails(error, "home_state_read_failed"); }
    const failureReceipt = (error: JsonObject, stage: "write" | "readback", acknowledged: boolean): ActionReceipt => ({
      schema_version: "0.2", receipt_id: receiptId, action_id: actionId, task_id: null,
      receipt_seq: 1, executor_id: "home_assistant_gateway", recorded_at: new Date().toISOString(),
      status: "unverified", reason_code: String(error.code), readbacks: [],
      diagnostics: { stage, write_acknowledged: acknowledged, error,
        ...(preReadError ? { before_write_error: preReadError } : {}) },
    });
    const targetState =
      command.service === "turn_on"
        ? "on"
        : command.service === "turn_off"
          ? "off"
          : command.service === "set_hvac_mode" && typeof targetData.hvac_mode === "string"
            ? targetData.hvac_mode
            : command.service === "select_option" && typeof targetData.option === "string"
              ? targetData.option
              : command.service === "set_value" && targetData.value !== undefined
                ? String(targetData.value)
                : command.service === "set_percentage" && typeof targetData.percentage === "number"
                  ? (targetData.percentage > 0 ? "on" : "off")
                  : command.service === "set_preset_mode" && typeof targetData.preset_mode === "string"
                    ? targetData.preset_mode
                    : command.service === "oscillate" && typeof targetData.oscillating === "boolean"
                      ? String(targetData.oscillating)
                      : command.service === "set_direction" && typeof targetData.direction === "string"
                        ? targetData.direction
                        : command.service === "set_fan_mode" && typeof targetData.fan_mode === "string"
                          ? targetData.fan_mode
                          : command.service === "set_swing_mode" && typeof targetData.swing_mode === "string"
                            ? targetData.swing_mode
                            : undefined;
    const matchesTarget = (snapshot: HomeStateSnapshot): boolean => {
      if (command.service === "press" || command.service === "send_message") {
        if (snapshot.attributes.has_status_criterion === false) {
          return false;
        }
        if (snapshot.attributes.has_status_criterion === true) {
          const relatedStatus = String(snapshot.attributes.related_status ?? "");
          const expectedList = Array.isArray(snapshot.attributes.expected_statuses)
            ? snapshot.attributes.expected_statuses.map((item) => String(item))
            : [];
          if (expectedList.length > 0) {
            return expectedList.includes(relatedStatus);
          }
          const prevRelated = String(current?.attributes.related_status ?? "");
          return relatedStatus !== "unavailable" && relatedStatus !== prevRelated;
        }
        return !current || snapshot.state !== current.state || snapshot.last_updated !== current.last_updated;
      }
      if (command.service === "set_temperature") {
        return jsonValuesEqual(snapshot.attributes.temperature, targetData.temperature);
      }
      if (command.service === "set_percentage") {
        return jsonValuesEqual(snapshot.attributes.percentage, targetData.percentage);
      }
      if (command.service === "set_preset_mode") {
        return jsonValuesEqual(snapshot.attributes.preset_mode, targetData.preset_mode);
      }
      if (command.service === "oscillate") {
        return jsonValuesEqual(snapshot.attributes.oscillating, targetData.oscillating);
      }
      if (command.service === "set_direction") {
        return jsonValuesEqual(snapshot.attributes.direction, targetData.direction);
      }
      if (command.service === "set_fan_mode") {
        return jsonValuesEqual(snapshot.attributes.fan_mode, targetData.fan_mode);
      }
      if (command.service === "set_swing_mode") {
        return jsonValuesEqual(snapshot.attributes.swing_mode, targetData.swing_mode);
      }
      if (command.service === "set_value") {
        const snapNum = Number(snapshot.state);
        const targetNum = Number(targetState);
        if (Number.isFinite(snapNum) && Number.isFinite(targetNum)) {
          return Math.abs(snapNum - targetNum) < 1e-6;
        }
        return snapshot.state === targetState;
      }
      if (command.service === "set_hvac_mode" || command.service === "select_option") {
        return snapshot.state === targetState;
      }
      if (domain === "climate" && command.service === "turn_on") {
        return snapshot.state !== "off" && snapshot.state !== "unavailable";
      }
      return (
        snapshot.state === targetState &&
        Object.entries(targetData).every(
          ([key, value]) => key === "entity_id" || jsonValuesEqual(snapshot.attributes[key], value),
        )
      );
    };

    // 5. Fresh No-op check
    if (current && targetState && matchesTarget(current)) {
      const stateAgeMs = Date.now() - new Date(current.last_updated).getTime();
      const maxAgeMs = definition.max_state_age_ms || 15000;

      if (stateAgeMs >= -5000 && stateAgeMs <= maxAgeMs) {
        return {
          schema_version: "0.2",
          receipt_id: receiptId,
          action_id: actionId,
          task_id: null,
          receipt_seq: 1,
          executor_id: "home_assistant_gateway",
          recorded_at: nowIso,
          status: "verified",
          outcome: "noop",
          readbacks: [
            {
              kind: "device_state",
              evidence_ids: [`readback_${Date.now()}`],
              observed_at: current.last_updated,
              received_at: nowIso,
              state_version: "fresh_cached",
              value: { state: current.state, attributes: current.attributes },
            },
          ],
        };
      }
    }

    // 6. Execute command via transport
    let callResult;
    try { callResult = await this.transport.callService(domain, command.service, {
      ...targetData,
      entity_id: command.entity_id,
    }); } catch (error) {
      return failureReceipt(transportErrorDetails(error, "home_service_call_failed"), "write", false);
    }

    if (!callResult.success) {
      return failureReceipt({ ...callResult.diagnostics, code: callResult.error ?? "home_service_call_failed" }, "write", false);
    }

    // 7. Verify readback state
    const readback = (snapshot: HomeStateSnapshot, version: string) => ({
      kind: "device_state" as const, evidence_ids: [`readback_${Date.now()}`],
      observed_at: snapshot.last_updated, received_at: new Date().toISOString(), state_version: version,
      value: { state: snapshot.state, attributes: snapshot.attributes },
    });
    const diagnostics: JsonObject = { write_acknowledged: true,
      ...(callResult.diagnostics ? { write: callResult.diagnostics } : {}),
      ...(preReadError ? { before_write_error: preReadError } : {}) };
    try {
      if ((command.service === "press" || command.service === "send_message") && current?.attributes.has_status_criterion === false) {
        const after = await fetchState();
        return {
          schema_version: "0.2",
          receipt_id: receiptId,
          action_id: actionId,
          task_id: null,
          receipt_seq: 1,
          executor_id: "home_assistant_gateway",
          recorded_at: nowIso,
          status: "unverified",
          reason_code: "action_accepted_no_state_criterion",
          diagnostics,
          readbacks: after
            ? [
                {
                  kind: "device_state",
                  evidence_ids: [`readback_accepted_${Date.now()}`],
                  observed_at: after.last_updated,
                  received_at: nowIso,
                  state_version: "accepted_without_state_criterion",
                  value: { state: after.state, attributes: after.attributes },
                },
              ]
            : [],
        };
      }
      const deadline = Date.now() + Math.max(0, Math.min(command.timeout_ms ?? 2000, 5000));
      let after = await fetchState();
      const verified = (snapshot: HomeStateSnapshot | null): boolean => {
        if (!snapshot || !matchesTarget(snapshot)) return false;
        const age = Date.now() - Date.parse(snapshot.last_updated);
        return age >= -5000 && age <= (definition.max_state_age_ms ?? 15000)
          && (!current || snapshot.last_updated !== current.last_updated || snapshot.state !== current.state
            || !jsonValuesEqual(snapshot.attributes, current.attributes));
      };
      while (!verified(after) && this.transport.isHealthy() && Date.now() < deadline) {
        await delay(Math.min(200, deadline - Date.now()));
        after = await fetchState();
      }
      if (after && verified(after)) {
        return {
          schema_version: "0.2",
          receipt_id: receiptId,
          action_id: actionId,
          task_id: null,
          receipt_seq: 1,
          executor_id: "home_assistant_gateway",
          recorded_at: nowIso,
          status: "verified",
          outcome: "applied",
          diagnostics,
          readbacks: [
            {
              kind: "device_state",
              evidence_ids: [`readback_applied_${Date.now()}`],
              observed_at: after.last_updated,
              received_at: nowIso,
              state_version: "verified_readback",
              value: { state: after.state, attributes: after.attributes },
            },
          ],
        };
      }

      const reason = after
        ? (command.service === "press" && after.attributes.has_status_criterion === true ? "action_accepted_state_unverified" : "readback_mismatch")
        : Date.now() >= deadline ? "readback_timeout" : "readback_unavailable";
      return {
        schema_version: "0.2",
        receipt_id: receiptId,
        action_id: actionId,
        task_id: null,
        receipt_seq: 1,
        executor_id: "home_assistant_gateway",
        recorded_at: nowIso,
        status: "unverified",
        reason_code: reason,
        diagnostics: { ...diagnostics, stage: "readback", error: { code: reason }, target: { state: targetState ?? null, data: targetData as JsonObject } },
        readbacks: after ? [readback(after, "unmatched_readback")] : [],
      };
    } catch (error) {
      const receipt = failureReceipt(transportErrorDetails(error, "home_state_read_failed"), "readback", true);
      receipt.diagnostics = { ...diagnostics, ...receipt.diagnostics };
      return receipt;
    }
  }

  /**
   * Batch execution for scenes or multi-device actions.
   * If some succeed and some fail, returns outcome: "partial" with detailed failed entities!
   */
  public async executeBatch(commands: HomeControlCommand[]): Promise<BatchExecutionResult> {
    const receipts: ActionReceipt[] = [];
    const failedEntities: Array<{ entityId: string; reason: string }> = [];

    for (const cmd of commands) {
      const receipt = await this.executeCommand(cmd);
      receipts.push(receipt);
      if (receipt.status === "rejected" || receipt.status === "failed" || receipt.status === "unverified") {
        failedEntities.push({
          entityId: cmd.entity_id,
          reason: receipt.reason_code || receipt.status,
        });
      }
    }

    let outcome: BatchExecutionResult["outcome"] = "applied";
    const allNoop = receipts.every((r) => r.outcome === "noop");
    const allApplied = receipts.every((r) => r.status === "verified" && r.outcome === "applied");
    const allFailed = receipts.every((r) => r.status !== "verified");

    if (allNoop) {
      outcome = "noop";
    } else if (allApplied) {
      outcome = "applied";
    } else if (allFailed) {
      outcome = "failed";
    } else {
      outcome = "partial";
    }

    return {
      outcome,
      receipts,
      failedEntities,
    };
  }

  /**
   * Environmental Metric Reading:
   * STRICT REQUIREMENT: Can ONLY be read from verified sensor entities with timestamp!
   */
  public async readEnvironmentalMetric(metric: "temperature" | "humidity" | "co2" | "pm25"): Promise<{
    source: "sensor";
    entityId: string;
    metric: string;
    value: number;
    unit: string;
    timestamp: string;
  }> {
    // Find matching whitelisted sensor entity
    const entity = Array.from(this.entityDefinitions.values()).find(
      (e) => e.domain === "sensor" && e.is_whitelisted && e.entity_id.includes(metric)
    );

    if (!entity) {
      throw new Error(`No whitelisted sensor entity found for metric '${metric}'. Vision estimation is strictly forbidden.`);
    }

    const state = await this.transport.fetchState(entity.entity_id);
    if (!state) {
      throw new Error(`Sensor '${entity.entity_id}' is offline or has no state report.`);
    }

    const numVal = state.state.trim() ? Number(state.state) : NaN;
    if (!Number.isFinite(numVal)) throw new Error(`Sensor '${entity.entity_id}' has no valid numeric reading.`);
    const unit = String(state.attributes.unit_of_measurement || (metric === "temperature" ? "°C" : "%"));

    return {
      source: "sensor",
      entityId: entity.entity_id,
      metric,
      value: numVal,
      unit,
      timestamp: state.last_updated,
    };
  }

  /**
   * Reconciles physical device state with VLM visual observation:
   * Preserves both sources honestly; never overwrites physical state with visual guess!
   */
  public async reconcileDeviceAndVisualState(
    entityId: string,
    visualDescription: string
  ): Promise<{
    entityId: string;
    deviceState: HomeStateSnapshot;
    visualObservation: { description: string; observedAt: string };
    isConsistent: boolean;
    explanation: string;
  }> {
    const devState = await this.transport.fetchState(entityId);
    if (!devState) {
      throw new Error(`Entity '${entityId}' not found.`);
    }

    const now = new Date().toISOString();
    const isDeviceOn = devState.state === "on";
    const isVisualDark = /dark|dim|off|黑|暗/i.test(visualDescription);

    const isConsistent = isDeviceOn ? !isVisualDark : isVisualDark;

    let explanation = `设备遥测状态为 ${devState.state}，画面观测与其相符。`;
    if (!isConsistent) {
      if (isDeviceOn && isVisualDark) {
        explanation = `书房灯设备已回报开启，但镜头画面仍偏暗（可能受遮挡或曝光影响）。`;
      } else {
        explanation = `设备已回报关闭，但画面中仍有亮光（可能来自窗外或显示器）。`;
      }
    }

    return {
      entityId,
      deviceState: devState,
      visualObservation: {
        description: visualDescription,
        observedAt: now,
      },
      isConsistent,
      explanation,
    };
  }
}
