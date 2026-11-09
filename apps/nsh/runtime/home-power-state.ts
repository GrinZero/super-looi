import type { HomeAppliance, HomeDashboardModel } from "@super-looi/home-devices";

type PowerCommand = { entity_id: string; domain: string; service: string };
type PowerUpdate = { isOn: boolean };

function projectAppliance(appliance: HomeAppliance, updates: Map<string, PowerUpdate>): HomeAppliance {
  const caps = appliance.capabilities;
  const powerUpdate = caps.power && updates.get(caps.power.entityId);
  const channelUpdate = caps.multiGang?.channels.some((channel) => updates.has(channel.entityId));
  const auxiliaryUpdate = caps.auxiliaryToggles?.some((toggle) => updates.has(toggle.entityId));
  if (!powerUpdate && !channelUpdate && !auxiliaryUpdate) return appliance;

  const capabilities = { ...caps };
  let { isActive, statusBadge, conciseSubtitle } = appliance;
  if (powerUpdate && caps.power) {
    capabilities.power = { ...caps.power, isOn: powerUpdate.isOn };
    isActive = powerUpdate.isOn;
    statusBadge = isActive ? "已开启" : "已关闭";
    if (appliance.icon === "light") {
      conciseSubtitle = !isActive ? "已关闭" : caps.dimmer?.brightnessPercent !== undefined
        ? `亮度 ${caps.dimmer.brightnessPercent}%` : "照明开启";
    } else if (appliance.icon === "plug") {
      const watts = caps.telemetry.find((metric) => metric.key === "power");
      conciseSubtitle = watts ? `${isActive ? "供电中" : "待机"} · ${watts.value}` : isActive ? "供电中" : "已关闭";
    } else if (conciseSubtitle === appliance.statusBadge) {
      conciseSubtitle = statusBadge;
    }
  }
  if (channelUpdate && caps.multiGang) {
    const channels = caps.multiGang.channels.map((channel) => {
      const update = updates.get(channel.entityId);
      return update ? { ...channel, isOn: update.isOn } : channel;
    });
    capabilities.multiGang = { channels };
    const count = channels.filter((channel) => channel.isOn).length;
    isActive = count > 0;
    statusBadge = `${count}/${channels.length} 开启`;
    conciseSubtitle = count > 0 ? `已开 ${count} 路` : "全部关闭";
  }
  if (auxiliaryUpdate) {
    capabilities.auxiliaryToggles = caps.auxiliaryToggles!.map((toggle) => {
      const update = updates.get(toggle.entityId);
      return update ? { ...toggle, isOn: update.isOn } : toggle;
    });
  }
  return { ...appliance, capabilities, isActive, statusBadge, conciseSubtitle };
}

function projectDashboard(dashboard: HomeDashboardModel, updates: Map<string, PowerUpdate>): HomeDashboardModel {
  if (updates.size === 0) return dashboard;
  const rooms = dashboard.rooms.map((room) => {
    const appliances = room.appliances.map((appliance) => projectAppliance(appliance, updates));
    const activeCount = appliances.filter((appliance) => appliance.isActive).length;
    const roomPowerEntities = { turnOnIds: [] as string[], turnOffIds: [] as string[] };
    for (const appliance of appliances) {
      if (appliance.archetype !== "lighting_power") continue;
      const switches = appliance.capabilities.multiGang?.channels ?? [appliance.capabilities.power];
      for (const power of switches) {
        if (power?.controllable) roomPowerEntities[power.isOn ? "turnOffIds" : "turnOnIds"].push(power.entityId);
      }
    }
    const temperature = room.environment.find((metric) => metric.key === "temperature");
    return { ...room, appliances, activeCount, roomPowerEntities,
      navSummary: [temperature?.value, `${activeCount}/${appliances.length} 开启`].filter(Boolean).join(" · ") };
  });
  const allAppliances = rooms.flatMap((room) => room.appliances);
  return { ...dashboard, rooms, allAppliances,
    activeAppliances: allAppliances.filter((appliance) => appliance.isActive).length };
}

/** Owns the readback snapshot and temporary power intents shared by cards and details. */
export class HomePowerState {
  private pending = new Map<string, PowerUpdate>();
  private connectionId: string | null = null;

  constructor(private dashboard: HomeDashboardModel, private publish: (dashboard: HomeDashboardModel) => void) {}

  replaceDashboard(dashboard: HomeDashboardModel, connectionId: string | null): void {
    if (this.connectionId !== connectionId) this.pending.clear();
    this.connectionId = connectionId;
    this.dashboard = dashboard;
    this.emit();
  }

  private emit(): void {
    this.publish(projectDashboard(this.dashboard, this.pending));
  }

  async control<T extends { receipt: { status: string } }>(
    command: PowerCommand,
    execute: () => Promise<T>,
    refresh: () => Promise<boolean>,
  ): Promise<T> {
    const connectionId = this.connectionId;
    const isPowerCommand = command.service === "turn_on" || command.service === "turn_off";
    const controllable = this.dashboard.allAppliances.some((appliance) => {
      const caps = appliance.capabilities;
      return [caps.power, ...(caps.multiGang?.channels ?? []), ...(caps.auxiliaryToggles ?? [])]
        .some((power) => power?.entityId === command.entity_id && power.domain === command.domain && power.controllable);
    });
    const update = isPowerCommand && controllable ? { isOn: command.service === "turn_on" } : undefined;
    if (update) {
      this.pending.set(command.entity_id, update);
      this.emit();
    }
    const clear = () => {
      if (update && this.pending.get(command.entity_id) === update) {
        this.pending.delete(command.entity_id);
        this.emit();
      }
    };
    let verified = false;
    let refreshed = false;
    try {
      const result = await execute();
      if (connectionId !== this.connectionId) return result;
      verified = result.receipt.status === "verified";
      if (!verified) clear();
      refreshed = await refresh();
      return result;
    } finally {
      // Keep verified readback when an older poll finished but the subsequent fresh read failed.
      if (verified && !refreshed && update && connectionId === this.connectionId) {
        this.dashboard = projectDashboard(this.dashboard, new Map([[command.entity_id, update]]));
        this.emit();
      }
      clear();
    }
  }
}
