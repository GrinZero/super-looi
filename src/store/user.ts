import { create } from "zustand";

export type VoiceState = "sleeping" | "verifying" | "listening" | "processing" | "speaking";

interface UserState {
  /** User profile ID */
  profileId: string | null;

  /** User display name */
  name: string;

  /** Whether voice enrollment is complete */
  voiceEnrolled: boolean;

  /** Current voice pipeline state */
  voiceState: VoiceState;

  /** Server connection status */
  serverConnected: boolean;

  /** User preferences */
  preferences: {
    language: string;
    ttsEnabled: boolean;
    cameraEnabled: boolean;
    calendarEnabled: boolean;
    wakeWordEnabled: boolean;
  };

  // Actions
  setProfile: (id: string, name: string) => void;
  setVoiceEnrolled: (enrolled: boolean) => void;
  setVoiceState: (state: VoiceState) => void;
  setServerConnected: (connected: boolean) => void;
  updatePreferences: (prefs: Partial<UserState["preferences"]>) => void;
}

export const useUserStore = create<UserState>((set) => ({
  profileId: null,
  name: "主人",
  voiceEnrolled: false,
  voiceState: "sleeping",
  serverConnected: false,
  preferences: {
    language: "zh-CN",
    ttsEnabled: true,
    cameraEnabled: true,
    calendarEnabled: true,
    wakeWordEnabled: true,
  },

  setProfile: (profileId, name) => set({ profileId, name }),
  setVoiceEnrolled: (voiceEnrolled) => set({ voiceEnrolled }),
  setVoiceState: (voiceState) => set({ voiceState }),
  setServerConnected: (serverConnected) => set({ serverConnected }),
  updatePreferences: (prefs) =>
    set((state) => ({
      preferences: { ...state.preferences, ...prefs },
    })),
}));
