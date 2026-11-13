/** Native class injected by the UI host; runtime tests need no NSH host. */
interface NativeVoiceSocket {
  open(): Promise<void>;
  read(): Promise<{ text?: string | null; bytes?: Uint8Array | null } | null>;
  writeText(text: string): Promise<void>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function connectNativeVoiceSocket(socket: NativeVoiceSocket) {
  try {
    await socket.open();
  } catch (error) {
    void socket.close().catch(() => {});
    throw error;
  }
  return {
    read: async () => {
      const frame = await socket.read();
      return frame?.text ?? frame?.bytes ?? null;
    },
    write: (frame: string | Uint8Array) => typeof frame === "string" ? socket.writeText(frame) : socket.writeBytes(frame),
    close: () => socket.close(),
  };
}
