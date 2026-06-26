import { create } from "zustand";
import { MemoryResult, UserIntent } from "../core/context-service";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  intent?: UserIntent;
  memories?: MemoryResult[];
  evidenceUri?: string;
}

interface ConversationState {
  messages: ChatMessage[];
  isProcessing: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  currentTranscript: string;

  // Actions
  addMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => void;
  setProcessing: (processing: boolean) => void;
  setListening: (listening: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  setCurrentTranscript: (transcript: string) => void;
  clearMessages: () => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  messages: [],
  isProcessing: false,
  isListening: false,
  isSpeaking: false,
  currentTranscript: "",

  addMessage: (message) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          ...message,
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
        },
      ],
    })),

  setProcessing: (isProcessing) => set({ isProcessing }),
  setListening: (isListening) => set({ isListening }),
  setSpeaking: (isSpeaking) => set({ isSpeaking }),
  setCurrentTranscript: (currentTranscript) => set({ currentTranscript }),
  clearMessages: () => set({ messages: [] }),
}));
