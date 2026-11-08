import { verifyVoiceRuntime } from "../../../apps/nsh/tests/voice-runtime-cases.js";
await verifyVoiceRuntime();
console.log("PASS voice runtime: explicit permission, provider handshake, PCM, mute/barge-in, duplicate tools and late-close isolation");
