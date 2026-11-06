/** Cordis around-dispatch extension. Reads canonical results, never parses tool prose. */
export const RECEIPTS_PLUGIN = `
export const name = 'looi-command-receipts';
export const inject = ['tools'];
export function apply(ctx, config) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (exec.name === 'bash' && !result.isError && result.value?.kind === 'foreground') {
      const value = result.value;
      const response = await fetch(config.url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: exec.callId, command: exec.arguments.command, exitCode: value.exitCode,
          signal: value.signal, timedOut: value.timedOut, aborted: value.aborted }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Command readback was not accepted by Hub');
    }
    return result;
  });
}
`;
