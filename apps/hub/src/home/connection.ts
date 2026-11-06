import type { FastifyInstance } from "fastify";
import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import { HomeAssistantGateway } from "./gateway.js";
import { HomeAssistantRestTransport } from "./rest-transport.js";
import { readHomeRegistry, type HomeEntityMetadata } from "./registry.js";

/** Only simple light/fan/switch controls and read-only sensors are initially exposed. */
const supportedDomains = new Set(["light", "fan", "switch", "sensor", "binary_sensor"]);

export function createHomeConnection(env: NodeJS.ProcessEnv = process.env) {
  const transport = new HomeAssistantRestTransport({ url: env.HA_URL, token: env.HA_TOKEN });
  const allowed = new Set((env.HA_ALLOWED_ENTITIES ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const gateway = new HomeAssistantGateway({ transport, initialEntities: [] });
  let snapshots: HomeStateSnapshot[] = [];
  let lastAttempt = 0;
  let refreshing: Promise<void> | null = null;
  let metadata = new Map<string, HomeEntityMetadata>();
  let registryAt = 0;

  function definition(state: HomeStateSnapshot): HomeEntityDefinition {
    const domain = state.entity_id.split(".")[0] as HomeEntityDefinition["domain"];
    const { power_control, control_restricted, ...details } = metadata.get(state.entity_id) ?? {};
    const modes = state.attributes.supported_color_modes;
    const features = !control_restricted && ["light", "fan", "switch"].includes(domain) && (domain !== "switch" || power_control !== false) ? ["turn_on", "turn_off"] : ["read"];
    const ranges: Record<string, [number, number]> = {};
    if (domain === "light" && Array.isArray(modes) && modes.some((mode) => !["onoff", "unknown"].includes(String(mode)))) {
      features.push("brightness"); ranges.brightness = [1, 255];
    }
    const min = state.attributes.min_color_temp_kelvin;
    const max = state.attributes.max_color_temp_kelvin;
    if (domain === "light" && Array.isArray(modes) && modes.includes("color_temp") && typeof min === "number" && typeof max === "number" && min > 0 && max >= min) {
      features.push("color_temp"); ranges.color_temp_kelvin = [min, max];
    }
    return {
      entity_id: state.entity_id, domain,
      ...details,
      friendly_name: String(state.attributes.friendly_name ?? state.entity_id),
      supported_features: features, allowed_range: ranges,
      is_whitelisted: allowed.has("*") || allowed.has(state.entity_id),
      max_state_age_ms: 15000,
    };
  }

  async function refresh(force = false) {
    if (refreshing) {
      await refreshing;
      if (force) return refresh(true);
      return;
    }
    if (!force && Date.now() - lastAttempt < 5000) return;
    lastAttempt = Date.now();
    refreshing = (async () => {
      try {
        const states = await transport.listStates();
        if (env.HA_INTEGRATION) {
          if (Date.now() - registryAt > 60000) {
            metadata = await readHomeRegistry(env.HA_URL!, env.HA_TOKEN!, env.HA_INTEGRATION);
            registryAt = Date.now();
          }
          snapshots = states.filter((state) => metadata.has(state.entity_id));
        } else snapshots = states;
        transport.setDiscoveryAvailable(true);
        gateway.replaceEntities(snapshots.map(definition));
      } catch (error) {
        if (error instanceof Error && error.message === "ha_registry_unavailable") transport.setDiscoveryAvailable(false);
        // No demo fallback or replay after losing a real gateway.
        snapshots = [];
        gateway.replaceEntities([]);
      }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  function register(app: FastifyInstance) {
    app.get("/home-setup", async (_req, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接米家 · LOOI</title><style>body{margin:0;background:#03070d;color:#edf5fc;font:16px/1.8 system-ui}main{max-width:680px;margin:auto;padding:48px 24px}h1{font-size:28px}a{color:#28d5ff}li{margin:20px 0}p{color:#a6b6c8}code{color:#edf5fc}</style><main><h1>连接你的米家设备</h1><p>完成一次账号授权，设备列表就会自动同步到 LOOI。</p><ol><li>在运行家居服务的主机上打开 <a href="http://homeassistant.local:8123">Home Assistant</a>；首次使用时完成初始设置。</li><li>进入「设置 → 设备与服务 → 添加集成」，搜索 <strong>Xiaomi Home</strong>，按页面指引登录小米账号。</li><li>选择与你米家 App 一致的地区，导入希望连接的家庭与设备。</li><li>在 Home Assistant 的个人资料「安全」页创建长期访问令牌，将令牌填入项目 <code>.env</code> 的 <code>HA_TOKEN</code>，重启 Hub。</li><li>返回 LOOI 的家居页，点击「刷新」。开关与调光会等待设备状态回读。</li></ol><p>目前 LOOI 可控制灯、风扇、开关并读取传感器；其他品类先显示状态。具体设备支持范围以小米官方集成的导入结果为准。</p></main></html>`));
    app.addHook("onRequest", async (req) => {
      if (req.url.startsWith("/api/home/") || req.url.startsWith("/api/console/status")) await refresh(req.url.startsWith("/api/home/connection"));
    });
    app.get("/api/home/connection", async () => ({
      transportMode: "home_assistant", ...transport.getStatus(),
      deviceCount: new Set(snapshots.map((s) => metadata.get(s.entity_id)?.device_id).filter(Boolean)).size || undefined,
      entities: snapshots.filter((s) => supportedDomains.has(s.entity_id.split(".")[0])).map((state) => ({ ...definition(state), snapshot: state })),
      readOnlyEntities: snapshots.filter((s) => !supportedDomains.has(s.entity_id.split(".")[0]))
        .map((snapshot) => ({ ...definition(snapshot), controllable: false, snapshot })),
    }));
  }
  return { gateway, transport, refresh, register };
}
