import { RealtimeAgent, RealtimeSession, tool, backgroundResult, OpenAIRealtimeWebSocket } from '@openai/agents-realtime';
import { RuntimeEventEmitter } from '@openai/agents-core/_shims';
import { z } from 'zod';
const results: Array<{
    name: string;
    details?: unknown;
}> = [];
function check(value: unknown, name: string, details?: unknown) {
    if (!value)
        throw new Error(`PROBE_FAILED ${name}: ${JSON.stringify(details)}`);
    results.push({ name, ...(details === undefined ? {} : { details }) });
}
async function settleUntil(condition: () => boolean) {
    for (let i = 0; i < 100 && !condition(); i++)
        await new Promise(resolve => setTimeout(resolve, 1));
}
class FixtureTransport extends RuntimeEventEmitter<any> {
    status = 'disconnected';
    muted = false;
    config: any;
    writes: any[] = [];
    toolOutputs: any[] = [];
    audioBytes = 0;
    interrupts = 0;
    getDefaultAudioFormat() { return 'pcm16'; }
    async connect(options: any) { this.config = options.initialSessionConfig; this.status = 'connected'; this.emit('connection_change', 'connected'); }
    sendEvent(event: any) { this.writes.push(event); }
    requestResponse(response?: any) { this.writes.push({ kind: 'requestResponse', response }); }
    sendMessage(message: any, other: any, options?: any) { this.writes.push({ kind: 'message', message, other, options }); }
    addImage(image: string, options?: any) { this.writes.push({ kind: 'image', image, options }); }
    sendAudio(audio: ArrayBuffer) { this.audioBytes += audio.byteLength; }
    updateSessionConfig(config: any) { this.config = { ...this.config, ...config }; }
    close() { this.status = 'disconnected'; this.emit('connection_change', 'disconnected'); }
    mute(value: boolean) { this.muted = value; }
    sendFunctionCallOutput(call: any, output: string, startResponse: boolean) { this.toolOutputs.push({ callId: call.callId, output, startResponse }); }
    interrupt() { this.interrupts++; this.emit('audio_interrupted'); }
    resetHistory(_old: any[], next: any[]) { for (const item of next)
        this.emit('item_update', item); }
    sendMcpResponse() { throw new Error('MCP is outside this probe'); }
}
let calls = 0, pendingStarted = 0, deliver: (value: string) => void = () => { };
const agent = new RealtimeAgent({ name: 'LooiResearch', instructions: 'Fixture only', tools: [
        tool({ name: 'add', description: 'Add two fixture integers', parameters: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => { calls++; return { sum: a + b }; } }),
        tool({ name: 'fail_default', description: 'Controlled tool failure', parameters: z.object({}), execute: async () => { throw Object.assign(new Error('fixture permission rejected'), { code: 'EACCES', stage: 'fixture.read' }); } }),
        tool({ name: 'fail_detail', description: 'Controlled structured tool failure', parameters: z.object({}), errorFunction: (_context, error: any) => JSON.stringify({ stage: error.stage, code: error.code, reason: error.message, cause: { code: error.cause?.code, message: error.cause?.message } }), execute: async () => { throw Object.assign(new Error('fixture permission rejected', { cause: Object.assign(new Error('fixture native read denied'), { code: 'EPERM' }) }), { code: 'EACCES', stage: 'fixture.read' }); } }),
        tool({ name: 'pending', description: 'Controlled pending fixture', parameters: z.object({}), execute: async () => { pendingStarted++; const answer = await new Promise<string>(resolve => { deliver = resolve; }); return backgroundResult(answer); } }),
    ] });
const transport = new FixtureTransport();
const session = new RealtimeSession(agent, { transport, tracingDisabled: true, config: { audio: { input: { format: 'pcm16' }, output: { format: 'pcm16' } } } });
let receivedBytes = 0, interrupted = 0, stopped = 0, nativeQueuedMs = 0;
const errors: unknown[] = [];
session.on('error', event => errors.push(event.error));
session.on('audio', event => { receivedBytes += event.data.byteLength; nativeQueuedMs += event.data.byteLength / 48; });
session.on('audio_interrupted', () => { interrupted++; nativeQueuedMs = 0; });
session.on('audio_stopped', () => { stopped++; });
await session.connect({ apiKey: 'offline-fixture-no-key' });
check(transport.status === 'connected' && transport.config.tools.length === 4, 'custom_transport_connect_and_tools');
session.sendAudio(new ArrayBuffer(640));
check(transport.audioBytes === 640, 'pcm_input_forwarded');
const user: any = { itemId: 'u1', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: '你好' }] };
transport.emit('item_update', user);
transport.emit('item_update', { ...user, content: [{ type: 'input_audio', transcript: '你好，完整问题' }] });
check(session.history.length === 1 && (session.history[0] as any).content[0].transcript === '你好，完整问题', 'history_revisions_replace_item');
transport.emit('turn_started', { type: 'response_started', providerData: { response: { id: 'r1' } } });
transport.emit('audio', { type: 'audio', responseId: 'r1', data: new ArrayBuffer(4800) });
transport.emit('*', { action: 'input.speech.started' });
check(receivedBytes === 4800 && interrupted === 0, 'raw_moss_vad_does_not_force_interruption');
transport.emit('audio_done');
check(stopped === 1 && nativeQueuedMs === 100, 'audio_stopped_is_generation_done_not_player_drained', { stopped, nativeQueuedMs });
session.interrupt();
check(interrupted === 1 && transport.interrupts === 1 && nativeQueuedMs === 0, 'manual_interruption_forwarded');
const call: any = { type: 'function_call', callId: 'c1', responseId: 'r1', name: 'add', arguments: '{"a":2,"b":3}' };
transport.emit('function_call', call);
await settleUntil(() => transport.toolOutputs.some(item => item.callId === 'c1'));
check(calls === 1 && JSON.parse(transport.toolOutputs.find(item => item.callId === 'c1').output).sum === 5, 'sdk_executes_tool_and_returns_result');
transport.emit('function_call', call);
await new Promise(resolve => setTimeout(resolve, 10));
check(calls === 1, 'duplicate_call_does_not_reexecute_tool', { calls });
transport.emit('function_call', { type: 'function_call', callId: 'c2', responseId: 'r2', name: 'pending', arguments: '{}' });
await settleUntil(() => pendingStarted === 1);
check(!transport.toolOutputs.some(item => item.callId === 'c2'), 'background_result_waits_for_execute_promise');
transport.emit('audio', { type: 'audio', responseId: 'r2', data: new ArrayBuffer(960) });
check(receivedBytes === 5760, 'audio_keeps_flowing_during_pending_tool');
deliver('background fixture finished');
await settleUntil(() => transport.toolOutputs.some(item => item.callId === 'c2'));
check(transport.toolOutputs.some(item => item.callId === 'c2' && item.startResponse === false), 'background_result_suppresses_followup_generation');
transport.emit('function_call', { type: 'function_call', callId: 'e1', responseId: 're', name: 'fail_default', arguments: '{}' });
transport.emit('function_call', { type: 'function_call', callId: 'e2', responseId: 're', name: 'fail_detail', arguments: '{}' });
await settleUntil(() => transport.toolOutputs.some(item => item.callId === 'e1') && transport.toolOutputs.some(item => item.callId === 'e2'));
check(transport.toolOutputs.find(item => item.callId === 'e1')?.output === 'An error occurred while running the tool.', 'default_tool_error_is_generic');
const failure = JSON.parse(transport.toolOutputs.find(item => item.callId === 'e2').output);
check(failure.stage === 'fixture.read' && failure.code === 'EACCES' && failure.reason === 'fixture permission rejected' && failure.cause.code === 'EPERM' && failure.cause.message === 'fixture native read denied', 'custom_error_function_preserves_stage_code_reason_cause', failure);
const original = Object.assign(new Error('fixture read rejected'), { code: 'EACCES', stage: 'fixture.read' });
transport.emit('error', { type: 'error', error: original });
check(errors[0] === original, 'transport_failure_preserves_original_error');
session.sendMessage('A background result is ready.');
check(transport.writes.some(item => item.kind === 'message'), 'proactive_message_is_transport_operation');
transport.emit('function_call', { type: 'function_call', callId: 'late', responseId: 'r3', name: 'pending', arguments: '{}' });
await settleUntil(() => pendingStarted === 2);
session.close();
deliver('late result after close');
await new Promise(resolve => setTimeout(resolve, 10));
check(pendingStarted === 2 && !transport.toolOutputs.some(item => item.callId === 'late'), 'late_tool_result_not_delivered_after_close');
check(errors.length === 1, 'no_unexpected_session_errors', { errors: errors.map(error => String(error)) });
const socketWrites: any[] = [];
const injectedSocket: any = { send: (raw: string) => socketWrites.push(JSON.parse(raw)), addEventListener: () => { }, close: () => { } };
const openAiTransport = new OpenAIRealtimeWebSocket({ createWebSocket: async () => injectedSocket, skipOpenEventListeners: true });
openAiTransport.on('error', event => { throw event.error; });
await openAiTransport.connect({ apiKey: 'ek_offline_fixture', initialSessionConfig: { tracing: null } });
check(openAiTransport.status === 'connected' && socketWrites.some(item => item.type === 'session.update'), 'openai_upstream_transport_accepts_injected_socket');
openAiTransport.sendAudio(new ArrayBuffer(960));
check(socketWrites.some(item => item.type === 'input_audio_buffer.append' && typeof item.audio === 'string'), 'openai_upstream_encodes_audio_with_injected_socket');
let muteFailure = '';
try {
    openAiTransport.mute(true);
}
catch (error) {
    muteFailure = String(error);
}
check(muteFailure.includes('Mute is not supported'), 'openai_websocket_requires_app_owned_mute');
openAiTransport.close();
console.log('SDK_PROBE_RESULTS ' + JSON.stringify({ sdk: '0.22.0', network: 'offline', tests: results.length, results }));
