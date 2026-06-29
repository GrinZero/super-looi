import { Type, type TSchema } from "@earendil-works/pi-ai";
import { getDeviceToolDefinitions } from "../device-tools/registry.js";

export interface ToolDefinition<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  execute: (args: Record<string, any>) => unknown | Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool: get_current_time
// ---------------------------------------------------------------------------

const getCurrentTime: ToolDefinition = {
  name: "get_current_time",
  description: "获取当前的日期和时间",
  parameters: Type.Object({}),
  execute: () => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "long",
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    return {
      datetime: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`,
      timezone: "Asia/Shanghai",
      weekday: get("weekday"),
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map([
  [getCurrentTime.name, getCurrentTime],
]);

/** Tool definitions suitable for passing into Context.tools */
export function getToolDefinitions(): Array<{ name: string; description: string; parameters: TSchema }> {
  return [...TOOL_REGISTRY.values(), ...getDeviceToolDefinitions()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

/** Execute a tool by name. Throws if tool is unknown. */
export async function executeTool(name: string, args: Record<string, any>): Promise<unknown> {
  const tool = TOOL_REGISTRY.get(name) ?? getDeviceToolDefinitions().find((item) => item.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(args);
}
