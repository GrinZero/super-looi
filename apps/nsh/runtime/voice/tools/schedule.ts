import {
  executeManageQuietHours,
  executeManageSchedule,
  type ScheduleToolEngine,
} from "../../tools/schedule-tools.js";
import type { VoiceToolSchema } from "./types.js";

export type VoiceSchedule = ScheduleToolEngine;

export function createVoiceScheduleTools(schedule: VoiceSchedule, sessionId: string) {
  const manageScheduleSchema: VoiceToolSchema = {
    type: "function",
    name: "manage_schedule",
    description:
      "创建、查询、修改、取消或立即运行定时任务与自动化检查。一次性任务可传 delay_seconds（相对秒数）或 ISO 格式 run_at；间隔任务传 every_seconds（至少 60 秒）；Cron 任务传 5 段 cron_expr。execution_policy 为 check_only（仅只读检查）或 authorized_action（用户明确授权的带操作任务）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "cancel", "run_now"],
          description: "操作类型：create、list、update、cancel 或 run_now。",
        },
        rule_id: {
          type: "string",
          description: "规则 ID（update、cancel、run_now 必填）。",
        },
        title: {
          type: "string",
          description: "规则简短标题（create 必填）。",
        },
        prompt: {
          type: "string",
          description: "触发时在隔离会话中执行的完整指令（create 必填）。",
        },
        trigger_kind: {
          type: "string",
          enum: ["once", "interval", "cron"],
          description: "触发方式：once、interval 或 cron。",
        },
        delay_seconds: {
          type: "string",
          description: "once 相对延迟秒数，例如 '300' 表示 5 分钟后。",
        },
        run_at: {
          type: "string",
          description: "once 绝对触发时间（ISO-8601 字符串）。",
        },
        every_seconds: {
          type: "string",
          description: "interval 固定间隔秒数（整数，至少 60）。",
        },
        cron_expr: {
          type: "string",
          description: "5 段标准 Cron 表达式（分 时 日 月 周），如 '0 9 * * *'。",
        },
        execution_policy: {
          type: "string",
          enum: ["check_only", "authorized_action"],
          description: "权限策略：只读检查传 check_only，需要写操作或控制设备传 authorized_action。",
        },
        dedupe_key: {
          type: "string",
          description: "可选去重键。",
        },
        enabled: {
          type: "string",
          enum: ["true", "false"],
          description: "是否启用（'true' 或 'false'）。",
        },
        state: {
          type: "string",
          enum: [
            "active",
            "running",
            "paused",
            "completed",
            "expired",
            "cancelled",
            "unconfirmed",
          ],
          description: "action=list 时的状态过滤条件。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };

  const manageQuietHoursSchema: VoiceToolSchema = {
    type: "function",
    name: "manage_quiet_hours",
    description:
      "查询、添加、修改、删除或总开关控制勿扰时段。支持跨午夜时间段（如 start_time='23:00'、end_time='08:00'）。用户说某时段别出声时可直接调用。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "update", "remove", "set_enabled"],
          description: "操作类型：list、add、update、remove 或 set_enabled。",
        },
        window_id: {
          type: "string",
          description: "勿扰时段 ID（update、remove 必填）。",
        },
        label: {
          type: "string",
          description: "时段名称，例如 '夜间勿扰'。",
        },
        start_time: {
          type: "string",
          description: "24 小时制本地开始时间 HH:MM，例如 '23:00'。",
        },
        end_time: {
          type: "string",
          description: "24 小时制本地结束时间 HH:MM，例如 '08:00'（早于开始时间表示跨午夜）。",
        },
        days_of_week: {
          type: "string",
          description: "可选适用星期，逗号分隔 0(周日)..6(周六)，如 '1,2,3,4,5'；省略表示每天。",
        },
        enabled: {
          type: "string",
          enum: ["true", "false"],
          description: "set_enabled 时控制总开关；add/update 时控制该时段开关（'true' 或 'false'）。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };

  return [
    {
      schema: manageScheduleSchema,
      execute(args: Record<string, unknown>) {
        return executeManageSchedule(schedule, args, {
          sourceSessionId: sessionId || undefined,
        });
      },
    },
    {
      schema: manageQuietHoursSchema,
      execute(args: Record<string, unknown>) {
        return executeManageQuietHours(schedule, args);
      },
    },
  ] as const;
}
