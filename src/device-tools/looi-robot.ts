import { LooiRobot, type LooiMoveDirection, type LooiTransport } from "@sourcebug/looi-sdk";

type LooiRuntimeState = {
  robot: LooiRobot | null;
  transport: LooiTransport | null;
  connected: boolean;
};

const state: LooiRuntimeState = {
  robot: null,
  transport: null,
  connected: false,
};

/**
 * Bind the platform-specific LOOI BLE transport.
 *
 * The SDK now lives in this monorepo as `packages/looi-sdk`; this hook keeps
 * Expo native BLE concerns outside prebuild output so they can be added via a
 * config plugin or another runtime module later.
 */
export function configureLooiRobotTransport(transport: LooiTransport): void {
  state.transport = transport;
  state.robot = new LooiRobot(transport);
  state.connected = false;
}

async function getRobot(): Promise<LooiRobot> {
  if (!state.robot) {
    throw new Error("LOOI transport is not configured. Bind a LooiTransport before using robot tools.");
  }
  if (!state.connected) {
    await state.robot.connect();
    state.connected = true;
  }
  return state.robot;
}

export async function moveLooi(direction: string, durationMs = 800, speed = 50) {
  const robot = await getRobot();
  const normalizedDirection = normalizeMoveDirection(direction);

  if (normalizedDirection === "stop") {
    await robot.stop();
    return { ok: true, direction: normalizedDirection, durationMs: 0, speed };
  }

  robot.startMoveLoop(normalizedDirection);
  await delay(Math.max(0, durationMs));
  robot.stopMoveLoop();
  return { ok: true, direction: normalizedDirection, durationMs, speed };
}

export async function setLooiLight(enabled: boolean) {
  const robot = await getRobot();
  await robot.setLight(enabled);
  return { ok: true, enabled };
}

export async function setLooiHead(direction: string) {
  const robot = await getRobot();
  await robot.setHead(direction);
  return { ok: true, direction };
}

function normalizeMoveDirection(direction: string): LooiMoveDirection {
  switch (direction) {
    case "forward":
    case "back":
    case "left":
    case "right":
    case "stop":
      return direction;
    case "backward":
      return "back";
    default:
      throw new Error(`Unsupported LOOI move direction: ${direction}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
