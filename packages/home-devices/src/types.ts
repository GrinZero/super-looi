import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";

export type HomeSourceId = "direct_miot" | "external_ha" | "simulation";

export type TileSpan = "1x1" | "2x1" | "2x2";

export type ApplianceArchetype =
  | "vision_security"
  | "cycle_appliance"
  | "climate"
  | "lighting_power"
  | "media"
  | "sensor_pet";

export type ApplianceIconKind =
  | "camera"
  | "lock"
  | "bell"
  | "cooker"
  | "washer"
  | "dishwasher"
  | "microwave"
  | "vacuum"
  | "kettle"
  | "ac"
  | "fan"
  | "purifier"
  | "dehumidifier"
  | "blanket"
  | "light"
  | "switch_gang"
  | "plug"
  | "tv"
  | "speaker"
  | "feeder"
  | "waterer"
  | "sensor"
  | "router";

export interface RawHomeEntityRecord extends HomeEntityDefinition {
  source?: HomeSourceId;
  device_model?: string;
  original_name?: string;
  snapshot?: HomeStateSnapshot | null;
}

export interface PowerCapability {
  entityId: string;
  domain: string;
  isOn: boolean;
  controllable: boolean;
}

export interface MultiGangChannel {
  id: string;
  label: string;
  entityId: string;
  domain: string;
  isOn: boolean;
  controllable: boolean;
}

export interface MultiGangCapability {
  channels: MultiGangChannel[];
}

export interface ThermostatCapability {
  entityId: string;
  domain: string;
  currentTemp?: number;
  targetTemp: number;
  minTemp: number;
  maxTemp: number;
  step: number;
  unit: string;
  controllable: boolean;
}

export interface ModeOption {
  value: string;
  label: string;
}

export interface ModeBarCapability {
  entityId: string;
  domain: string;
  service: string;
  parameterKey: string;
  currentMode: string;
  currentLabel: string;
  options: ModeOption[];
  controllable: boolean;
}

export interface CycleTaskCapability {
  stageLabel: string;
  stages: string[];
  activeStageIndex: number;
  remainingMinutes?: number;
  keepWarmMinutes?: number;
  progressPercent?: number;
  temperatureCelsius?: number;
  targetTempCelsius?: number;
  recipeLabel?: string;
  isRunning: boolean;
  subStatus?: string;
}

export interface VacuumConsumableMetric {
  id: string;
  label: string;
  percent: number;
  remainingHours?: number;
  resetAction?: ApplianceActionTrigger;
}

export type VacuumStatusCode =
  | "cleaning"
  | "returning"
  | "charging"
  | "docked"
  | "paused"
  | "drying"
  | "washing"
  | "dust_collecting"
  | "error"
  | "idle";

export interface VacuumCapability {
  statusCode: VacuumStatusCode;
  statusLabel: string;
  chargingLabel?: string;
  batteryPercent?: number;
  cleaningAreaSqm?: number;
  cleaningMinutes?: number;
  totalCleanCount?: number;
  totalCleanAreaSqm?: number;
  totalCleanHours?: number;
  waterBoxInstalled?: boolean;
  mopModeBar?: ModeBarCapability;
  consumables: VacuumConsumableMetric[];
}

export interface ApplianceActionTrigger {
  id: string;
  label: string;
  entityId: string;
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
  tone?: "primary" | "default" | "destructive";
  iconKey?: "play" | "pause" | "stop" | "dock" | "dust" | "wash" | "dry" | "locate" | "dispense" | "refresh" | "power";
}

export interface VisionStreamCapability {
  playbackKind?: "hls" | "p2p_pending" | "unsupported";
  cameraOn?: boolean;
  streamActive: boolean;
  statusText: string;
  resolutionBadge?: string;
  lastMotionText?: string;
  storageStatusText?: string;
  storageUsedPercent?: number;
  streamEntityId?: string;
  stopEntityId?: string;
  ptzActions: ApplianceActionTrigger[];
  featureToggles: Array<{
    id: string;
    label: string;
    entityId: string;
    domain: string;
    isOn: boolean;
    controllable: boolean;
  }>;
  modeSelectors?: Array<{
    id: string;
    label: string;
    capability: ModeBarCapability;
  }>;
}

export interface SecurityEventsCapability {
  readOnly: boolean;
  lockState?: string;
  doorState?: string;
  batteryPercent?: number;
  events: Array<{ time: string; label: string }>;
}

export interface DimmerCapability {
  entityId: string;
  brightnessPercent?: number;
  colorTempKelvin?: number;
  colorTempRange?: [number, number];
  controllable: boolean;
}

export interface TelemetryMetric {
  key: string;
  label: string;
  value: string;
  numericValue?: number;
  unit?: string;
}

export interface ApplianceCapabilities {
  power?: PowerCapability;
  multiGang?: MultiGangCapability;
  thermostat?: ThermostatCapability;
  modeBar?: ModeBarCapability;
  fanLevel?: ModeBarCapability;
  cycleTask?: CycleTaskCapability;
  vacuum?: VacuumCapability;
  actions?: ApplianceActionTrigger[];
  visionStream?: VisionStreamCapability;
  securityEvents?: SecurityEventsCapability;
  dimmer?: DimmerCapability;
  auxiliaryToggles?: Array<{
    id: string;
    label: string;
    entityId: string;
    domain: string;
    isOn: boolean;
    controllable: boolean;
  }>;
  telemetry: TelemetryMetric[];
}

export interface HomeAppliance {
  id: string;
  deviceId: string;
  source: HomeSourceId;
  sourceLabel: string;
  name: string;
  room: string;
  homeName?: string;
  model?: string;
  archetype: ApplianceArchetype;
  icon: ApplianceIconKind;
  defaultSpan: TileSpan;
  span: TileSpan;
  order: number;
  online: boolean;
  isActive: boolean;
  statusBadge: string;
  conciseSubtitle: string;
  capabilities: ApplianceCapabilities;
  entityIds: string[];
}

export interface RoomEnvironmentMetric {
  key: "temperature" | "humidity" | "co2" | "pm25" | "tvoc" | "occupancy" | "power";
  label: string;
  value: string;
  numericValue?: number;
}

export interface HomeRoomSection {
  id: string;
  name: string;
  totalCount: number;
  activeCount: number;
  navSummary: string;
  environment: RoomEnvironmentMetric[];
  appliances: HomeAppliance[];
  roomPowerEntities: {
    turnOnIds: string[];
    turnOffIds: string[];
  };
}

export interface HomeApplianceLayoutItem {
  span?: TileSpan;
  order?: number;
}

export interface HomeLayoutPreferences {
  version: 1;
  appliances: Record<string, HomeApplianceLayoutItem>;
}

export interface HomeDashboardModel {
  homeName: string;
  totalAppliances: number;
  activeAppliances: number;
  rooms: HomeRoomSection[];
  allAppliances: HomeAppliance[];
}
