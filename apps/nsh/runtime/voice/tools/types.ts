export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string" }>;
    required?: string[];
    additionalProperties: false;
  };
};

export interface VoiceToolHost {
  send(value: unknown, generation: number): Promise<void>;
  current(generation: number): boolean;
  requestTask(prompt: string): Promise<string>;
  beginFarewell(): void;
  endSession(): void;
  taskFinished(generation: number): void;
  fail(message: string): void;
}

export type VoiceToolContext = VoiceToolHost & {
  reply(callId: string, output: unknown, generation: number): Promise<void>;
};
