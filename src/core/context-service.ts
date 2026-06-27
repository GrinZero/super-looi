import { Observation, MemoryCategory } from "./observation";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemoryResult {
  id: string;
  memory: string;
  metadata?: {
    category?: MemoryCategory;
    source?: string;
    timestamp?: string;
    evidenceUri?: string;
  };
  score?: number;
}

export type UserIntent = "store" | "search" | "remind" | "chat";

/**
 * ContextService — thin wrapper over server API for memory operations
 */
export interface ContextService {
  /** Store an observation as memory */
  remember(messages: Message[], metadata: Observation["metadata"]): Promise<void>;

  /** Semantic search for memories */
  search(query: string, filters?: { category?: MemoryCategory }): Promise<MemoryResult[]>;

  /** Get all memories with optional category filter */
  getAll(filters?: { category?: MemoryCategory }): Promise<MemoryResult[]>;
}

/**
 * LLMService — intent classification and response generation
 */
export interface LLMService {
  /** Classify user intent from transcript */
  classifyIntent(transcript: string): Promise<UserIntent>;

  /** Generate response based on intent, context, and facts */
  generateResponse(
    intent: UserIntent,
    context: { facts: MemoryResult[]; transcript: string }
  ): Promise<string>;
}

/**
 * VisionService — visual understanding via local server
 */
export interface VisionService {
  /** Describe an image/video */
  describe(imageBase64: string, prompt?: string): Promise<string>;
}

export interface VoiceVisualResult {
  response: string;
  evidenceUri: string;
  description: string;
  remembered: boolean;
}

export interface ObserveService {
  /** Store a joint voice + camera observation */
  voiceVisual(
    transcript: string,
    imageBase64: string,
    metadata: Observation["metadata"]
  ): Promise<VoiceVisualResult>;
}
