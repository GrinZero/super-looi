export const performance = globalThis.performance ?? { now: () => Date.now() };
export default { performance };
