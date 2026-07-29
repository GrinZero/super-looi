import { useCallback, useReducer, useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  Switch,
  useColorScheme,
  Pressable,
} from "react-native";
import * as Calendar from "expo-calendar/legacy";
import * as FileSystem from "expo-file-system/legacy";
import { useUserStore } from "@/src/store/user";
import { checkServerHealth, observeService } from "@/src/server-api/client";
import { createObservation } from "@/src/core/observation";
import { cameraPerceiver } from "@/src/perceivers/camera-perceiver";
import { calendarPerceiver } from "@/src/perceivers/calendar-perceiver";
import { useConversationStore } from "@/src/store/conversation";
import {
  feedSamplesSequentially,
  loadPcm16WavAssetSamples,
} from "@/src/voice/diagnostic-audio";
import { runVadDiagnosticSmoke } from "@/src/voice/vad-diagnostic";
import { reminderScheduler } from "@/src/reminder/reminder-scheduler";
import { checkAllSherpaModelReadiness, type SherpaModelCheck } from "@/src/voice/sherpa-models";
import {
  downloadMissingSherpaModels,
  type SherpaModelDownloadProgress,
} from "@/src/voice/sherpa-model-download";
import { DeviceShell } from "@/src/ui/DeviceShell";
import { looiTheme } from "@/src/ui/looi-theme";
import {
  clearSavedLooiRobot,
  connectSelectedLooiRobot,
  getSavedLooiRobot,
  scanLooiRobotCandidates,
  type LooiRobotCandidate,
  type SavedLooiRobot,
} from "@/src/device-tools/looi-robot-autoconnect";

const CALENDAR_SMOKE_TITLE = "Phase 1 真实日历提醒诊断";
const CALENDAR_SMOKE_CALENDAR_TITLE = "LOOI Phase 1 Diagnostics";
const KWS_DIAGNOSTIC_AUDIO = require("@/assets/diagnostics/hey-moge.wav");
const KWS_DIAGNOSTIC_CHUNK_SIZE = 1600;
const KWS_DIAGNOSTIC_TAIL_SILENCE_SAMPLES = 16000;

type SherpaModelStatus = {
  asr: SherpaModelCheck;
  streamingAsr: SherpaModelCheck;
  punctuation: SherpaModelCheck;
  kws: SherpaModelCheck;
  speaker: SherpaModelCheck;
  vad: SherpaModelCheck;
};

type Preferences = ReturnType<typeof useUserStore.getState>["preferences"];
type KwsDiagnosticResult = {
  detected?: boolean;
  keyword?: string;
};

type RobotSettingsState = {
  saved: SavedLooiRobot | null;
  candidates: LooiRobotCandidate[];
  scanning: boolean;
  connectingId: string | null;
  connected: boolean;
  result: string | null;
  error: string | null;
};

type SpeakerEnrollmentSummaryState = {
  enrolled: boolean;
  sampleCount: number;
  templateLimit: number;
  updatedAt?: string;
};

async function getVoiceServices() {
  const [{ sttService }, { speakerIdService }] = await Promise.all([
    import("@/src/voice/stt"),
    import("@/src/voice/speaker-id"),
  ]);

  return { sttService, speakerIdService };
}

async function getLiveSampleRecorder() {
  const { liveSampleRecorder } = await import("@/src/voice/live-sample-recorder");
  return liveSampleRecorder;
}

async function getKwsServices() {
  const [{ sherpaVoiceAdapter }, { kwsAudioFeeder }] = await Promise.all([
    import("@/src/voice/sherpa-adapter"),
    import("@/src/voice/kws-audio-feeder"),
  ]);

  return { sherpaVoiceAdapter, kwsAudioFeeder };
}

type SettingsUiState = {
  enrollment: {
    recording: boolean;
    saving: boolean;
    error: string | null;
  };
  voiceSmoke: {
    recording: boolean;
    running: boolean;
    result: string | null;
    error: string | null;
  };
  speakerVerify: {
    recording: boolean;
    running: boolean;
    result: string | null;
    error: string | null;
  };
  kwsSmoke: {
    running: boolean;
    result: string | null;
    error: string | null;
  };
  vadSmoke: {
    running: boolean;
    result: string | null;
    error: string | null;
  };
  visualSmoke: {
    running: boolean;
    result: string | null;
    error: string | null;
  };
  calendarSmoke: {
    running: boolean;
    result: string | null;
    error: string | null;
  };
  models: {
    status: SherpaModelStatus | null;
    checking: boolean;
    downloading: boolean;
    downloadProgress: SherpaModelDownloadProgress | null;
    error: string | null;
  };
  speakerSummary: {
    status: SpeakerEnrollmentSummaryState | null;
  };
};

type SettingsUiAction =
  | { type: "enrollment/start-recording" }
  | { type: "enrollment/start-saving" }
  | { type: "enrollment/saved" }
  | { type: "enrollment/failed"; error: string }
  | { type: "voice-smoke/start-recording" }
  | { type: "voice-smoke/start-running" }
  | { type: "voice-smoke/succeeded"; result: string }
  | { type: "voice-smoke/failed"; error: string }
  | { type: "speaker-verify/start-recording" }
  | { type: "speaker-verify/start-running" }
  | { type: "speaker-verify/succeeded"; result: string }
  | { type: "speaker-verify/failed"; error: string }
  | { type: "kws-smoke/start-running" }
  | { type: "kws-smoke/succeeded"; result: string }
  | { type: "kws-smoke/failed"; error: string }
  | { type: "vad-smoke/start-running" }
  | { type: "vad-smoke/succeeded"; result: string }
  | { type: "vad-smoke/failed"; error: string }
  | { type: "visual-smoke/start-running" }
  | { type: "visual-smoke/succeeded"; result: string }
  | { type: "visual-smoke/failed"; error: string }
  | { type: "calendar-smoke/start-running" }
  | { type: "calendar-smoke/succeeded"; result: string }
  | { type: "calendar-smoke/failed"; error: string }
  | { type: "models/checking" }
  | { type: "models/checked"; status: SherpaModelStatus }
  | { type: "models/failed"; error: string }
  | { type: "models/download-started" }
  | { type: "models/download-progress"; progress: SherpaModelDownloadProgress }
  | { type: "models/download-succeeded"; status: SherpaModelStatus }
  | { type: "models/download-failed"; error: string }
  | { type: "speaker-summary/loaded"; status: SpeakerEnrollmentSummaryState };

const initialSettingsUiState: SettingsUiState = {
  enrollment: {
    recording: false,
    saving: false,
    error: null,
  },
  voiceSmoke: {
    recording: false,
    running: false,
    result: null,
    error: null,
  },
  speakerVerify: {
    recording: false,
    running: false,
    result: null,
    error: null,
  },
  kwsSmoke: {
    running: false,
    result: null,
    error: null,
  },
  vadSmoke: {
    running: false,
    result: null,
    error: null,
  },
  visualSmoke: {
    running: false,
    result: null,
    error: null,
  },
  calendarSmoke: {
    running: false,
    result: null,
    error: null,
  },
  models: {
    status: null,
    checking: false,
    downloading: false,
    downloadProgress: null,
    error: null,
  },
  speakerSummary: {
    status: null,
  },
};

const initialRobotSettingsState: RobotSettingsState = {
  saved: null,
  candidates: [],
  scanning: false,
  connectingId: null,
  connected: false,
  result: null,
  error: null,
};

function settingsUiReducer(
  state: SettingsUiState,
  action: SettingsUiAction
): SettingsUiState {
  switch (action.type) {
    case "enrollment/start-recording":
      return {
        ...state,
        enrollment: { recording: true, saving: false, error: null },
      };
    case "enrollment/start-saving":
      return {
        ...state,
        enrollment: { recording: false, saving: true, error: null },
      };
    case "enrollment/saved":
      return {
        ...state,
        enrollment: { recording: false, saving: false, error: null },
      };
    case "enrollment/failed":
      return {
        ...state,
        enrollment: { recording: false, saving: false, error: action.error },
      };
    case "voice-smoke/start-recording":
      return {
        ...state,
        voiceSmoke: { recording: true, running: false, result: null, error: null },
      };
    case "voice-smoke/start-running":
      return {
        ...state,
        voiceSmoke: { recording: false, running: true, result: null, error: null },
      };
    case "voice-smoke/succeeded":
      return {
        ...state,
        voiceSmoke: { recording: false, running: false, result: action.result, error: null },
      };
    case "voice-smoke/failed":
      return {
        ...state,
        voiceSmoke: { recording: false, running: false, result: null, error: action.error },
      };
    case "speaker-verify/start-recording":
      return {
        ...state,
        speakerVerify: { recording: true, running: false, result: null, error: null },
      };
    case "speaker-verify/start-running":
      return {
        ...state,
        speakerVerify: { recording: false, running: true, result: null, error: null },
      };
    case "speaker-verify/succeeded":
      return {
        ...state,
        speakerVerify: { recording: false, running: false, result: action.result, error: null },
      };
    case "speaker-verify/failed":
      return {
        ...state,
        speakerVerify: { recording: false, running: false, result: null, error: action.error },
      };
    case "kws-smoke/start-running":
      return {
        ...state,
        kwsSmoke: { running: true, result: null, error: null },
      };
    case "kws-smoke/succeeded":
      return {
        ...state,
        kwsSmoke: { running: false, result: action.result, error: null },
      };
    case "kws-smoke/failed":
      return {
        ...state,
        kwsSmoke: { running: false, result: null, error: action.error },
      };
    case "vad-smoke/start-running":
      return {
        ...state,
        vadSmoke: { running: true, result: null, error: null },
      };
    case "vad-smoke/succeeded":
      return {
        ...state,
        vadSmoke: { running: false, result: action.result, error: null },
      };
    case "vad-smoke/failed":
      return {
        ...state,
        vadSmoke: { running: false, result: null, error: action.error },
      };
    case "visual-smoke/start-running":
      return {
        ...state,
        visualSmoke: { running: true, result: null, error: null },
      };
    case "visual-smoke/succeeded":
      return {
        ...state,
        visualSmoke: { running: false, result: action.result, error: null },
      };
    case "visual-smoke/failed":
      return {
        ...state,
        visualSmoke: { running: false, result: null, error: action.error },
      };
    case "calendar-smoke/start-running":
      return {
        ...state,
        calendarSmoke: { running: true, result: null, error: null },
      };
    case "calendar-smoke/succeeded":
      return {
        ...state,
        calendarSmoke: { running: false, result: action.result, error: null },
      };
    case "calendar-smoke/failed":
      return {
        ...state,
        calendarSmoke: { running: false, result: null, error: action.error },
      };
    case "models/checking":
      return {
        ...state,
        models: { ...state.models, checking: true, error: null },
      };
    case "models/checked":
      return {
        ...state,
        models: {
          ...state.models,
          status: action.status,
          checking: false,
          error: null,
        },
      };
    case "models/failed":
      return {
        ...state,
        models: { ...state.models, checking: false, error: action.error },
      };
    case "models/download-started":
      return {
        ...state,
        models: {
          ...state.models,
          downloading: true,
          downloadProgress: null,
          error: null,
        },
      };
    case "models/download-progress":
      return {
        ...state,
        models: {
          ...state.models,
          downloading: true,
          downloadProgress: action.progress,
          error: null,
        },
      };
    case "models/download-succeeded":
      return {
        ...state,
        models: {
          status: action.status,
          checking: false,
          downloading: false,
          downloadProgress: null,
          error: null,
        },
      };
    case "models/download-failed":
      return {
        ...state,
        models: {
          ...state.models,
          checking: false,
          downloading: false,
          error: action.error,
        },
      };
    case "speaker-summary/loaded":
      return {
        ...state,
        speakerSummary: { status: action.status },
      };
    default:
      return state;
  }
}

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const {
    preferences,
    updatePreferences,
    serverConnected,
    setServerConnected,
    name,
    voiceEnrolled,
    setVoiceEnrolled,
    setVoiceState,
  } = useUserStore();
  const [uiState, dispatchUi] = useReducer(settingsUiReducer, initialSettingsUiState);
  const { recording: enrolling, saving: savingEnrollment, error: enrollmentError } =
    uiState.enrollment;
  const {
    recording: smokeRecording,
    running: smokeRunning,
    result: smokeResult,
    error: smokeError,
  } = uiState.voiceSmoke;
  const {
    recording: speakerVerifyRecording,
    running: speakerVerifyRunning,
    result: speakerVerifyResult,
    error: speakerVerifyError,
  } = uiState.speakerVerify;
  const {
    running: kwsSmokeRunning,
    result: kwsSmokeResult,
    error: kwsSmokeError,
  } = uiState.kwsSmoke;
  const {
    running: vadSmokeRunning,
    result: vadSmokeResult,
    error: vadSmokeError,
  } = uiState.vadSmoke;
  const {
    running: visualSmokeRunning,
    result: visualSmokeResult,
    error: visualSmokeError,
  } = uiState.visualSmoke;
  const {
    running: calendarSmokeRunning,
    result: calendarSmokeResult,
    error: calendarSmokeError,
  } = uiState.calendarSmoke;
  const {
    status: modelStatus,
    checking: checkingModels,
    downloading: downloadingModels,
    downloadProgress: modelDownloadProgress,
    error: modelError,
  } = uiState.models;
  const speakerSummary = uiState.speakerSummary.status;
  const addConversationMessage = useConversationStore((state) => state.addMessage);
  const [robotState, setRobotState] = useState<RobotSettingsState>(initialRobotSettingsState);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);

  const checkConnection = useCallback(async () => {
    const connected = await checkServerHealth();
    setServerConnected(connected);
  }, [setServerConnected]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  useEffect(() => {
    let cancelled = false;
    getSavedLooiRobot()
      .then((saved) => {
        if (!cancelled) {
          setRobotState((state) => ({ ...state, saved }));
        }
      })
      .catch((error) => {
        console.warn("[Settings] Failed to load saved LOOI robot:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scanRobots = useCallback(async () => {
    if (robotState.scanning || robotState.connectingId) return;

    setRobotState((state) => ({
      ...state,
      scanning: true,
      result: null,
      error: null,
    }));

    try {
      const candidates = await scanLooiRobotCandidates();
      setRobotState((state) => ({
        ...state,
        candidates,
        scanning: false,
        result: candidates.length > 0 ? `发现 ${candidates.length} 台 LOOI` : "未发现 LOOI，可重试",
        error: null,
      }));
    } catch (error) {
      console.error("[Settings] LOOI robot scan failed:", error);
      setRobotState((state) => ({
        ...state,
        scanning: false,
        result: null,
        error: error instanceof Error ? error.message : "机器人扫描失败",
      }));
    }
  }, [robotState.connectingId, robotState.scanning]);

  const connectRobot = useCallback(async (candidate: LooiRobotCandidate) => {
    if (robotState.scanning || robotState.connectingId) return;

    setRobotState((state) => ({
      ...state,
      connectingId: candidate.id,
      result: null,
      error: null,
    }));

    try {
      const robot = { id: candidate.id, name: candidate.name };
      await connectSelectedLooiRobot(robot);
      setRobotState((state) => ({
        ...state,
        saved: robot,
        candidates: state.candidates.map((item) => ({
          ...item,
          selected: item.id === candidate.id,
        })),
        connectingId: null,
        connected: true,
        result: `${candidate.name} 已连接并完成握手`,
        error: null,
      }));
    } catch (error) {
      console.error("[Settings] LOOI robot connect failed:", error);
      setRobotState((state) => ({
        ...state,
        connectingId: null,
        connected: false,
        result: null,
        error: error instanceof Error ? error.message : "机器人连接失败",
      }));
    }
  }, [robotState.connectingId, robotState.scanning]);

  const forgetRobot = useCallback(async () => {
    if (robotState.scanning || robotState.connectingId) return;

    try {
      await clearSavedLooiRobot();
      setRobotState((state) => ({
        ...state,
        saved: null,
        candidates: state.candidates.map((candidate) => ({ ...candidate, selected: false })),
        connected: false,
        result: "已清除已选机器人",
        error: null,
      }));
    } catch (error) {
      console.error("[Settings] Failed to forget LOOI robot:", error);
      setRobotState((state) => ({
        ...state,
        error: error instanceof Error ? error.message : "清除机器人失败",
      }));
    }
  }, [robotState.connectingId, robotState.scanning]);

  const checkSherpaModels = useCallback(async () => {
    if (uiState.models.downloading) return;
    dispatchUi({ type: "models/checking" });

    try {
      const status = await checkAllSherpaModelReadiness();
      dispatchUi({ type: "models/checked", status });
    } catch (error) {
      console.error("[Settings] Failed to check sherpa models:", error);
      dispatchUi({ type: "models/failed", error: "模型检查失败" });
    }
  }, [uiState.models.downloading]);

  const downloadSherpaModels = useCallback(async () => {
    if (uiState.models.downloading || uiState.models.checking) return;

    dispatchUi({ type: "models/download-started" });
    try {
      const status = await downloadMissingSherpaModels((progress) => {
        dispatchUi({ type: "models/download-progress", progress });
      });
      dispatchUi({ type: "models/download-succeeded", status });
    } catch (error) {
      console.error("[Settings] Sherpa model download failed:", error);
      dispatchUi({
        type: "models/download-failed",
        error: error instanceof Error ? error.message : "模型下载失败",
      });
    }
  }, [uiState.models.checking, uiState.models.downloading]);

  useEffect(() => {
    checkSherpaModels();
  }, [checkSherpaModels]);

  const refreshSpeakerSummary = useCallback(async () => {
    const { speakerIdService } = await getVoiceServices();
    const service = speakerIdService as typeof speakerIdService & {
      getEnrollmentSummary?: () => Promise<{
        enrolled: boolean;
        sampleCount: number;
        templateLimit: number;
        updatedAt?: string;
      }>;
    };
    if (service.getEnrollmentSummary) {
      const summary = await service.getEnrollmentSummary();
      const status = {
        enrolled: summary.enrolled,
        sampleCount: summary.sampleCount,
        templateLimit: summary.templateLimit,
        updatedAt: summary.updatedAt,
      };
      dispatchUi({ type: "speaker-summary/loaded", status });
      setVoiceEnrolled(summary.enrolled);
      return;
    }

    const enrolled = await speakerIdService.getStoredEnrollmentStatus();
    dispatchUi({
      type: "speaker-summary/loaded",
      status: {
        enrolled,
        sampleCount: enrolled ? 1 : 0,
        templateLimit: 1,
      },
    });
    setVoiceEnrolled(enrolled);
  }, [setVoiceEnrolled]);

  useEffect(() => {
    let cancelled = false;
    refreshSpeakerSummary().catch(() => {
      if (!cancelled) {
        setVoiceEnrolled(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSpeakerSummary, setVoiceEnrolled]);

  const startEnrollment = useCallback(async () => {
    if (enrolling || savingEnrollment) return;

    dispatchUi({ type: "enrollment/start-recording" });
    setVoiceState("listening");

    try {
      const liveSampleRecorder = await getLiveSampleRecorder();
      await liveSampleRecorder.start();
    } catch (error) {
      console.error("[Settings] Failed to start speaker enrollment:", error);
      await getLiveSampleRecorder()
        .then((recorder) => recorder.cancel())
        .catch(() => undefined);
      dispatchUi({ type: "enrollment/failed", error: "录音启动失败" });
      setVoiceState("sleeping");
    }
  }, [enrolling, savingEnrollment, setVoiceState]);

  const finishEnrollment = useCallback(async () => {
    if (!enrolling) return;

    dispatchUi({ type: "enrollment/start-saving" });
    setVoiceState("verifying");

    try {
      const [{ speakerIdService }, liveSampleRecorder] = await Promise.all([
        getVoiceServices(),
        getLiveSampleRecorder(),
      ]);
      const samples = await liveSampleRecorder.stop();
      const service = speakerIdService as typeof speakerIdService & {
        appendEnrollmentSample?: (
          sample: { samples: number[]; durationMs: number; quality: { ok: boolean; durationMs: number; energyMean: number } },
          options?: { promptId?: string }
        ) => Promise<unknown>;
      };
      const quality = buildSettingsEnrollmentQuality(samples);
      if (!quality.ok) {
        throw new Error(quality.reason === "too-short" ? "声纹样本太短" : "声纹样本太轻");
      }
      if (voiceEnrolled && service.appendEnrollmentSample) {
        await service.appendEnrollmentSample(
          {
            samples,
            durationMs: quality.durationMs,
            quality,
          },
          { promptId: "settings-append" }
        );
      } else {
        await speakerIdService.enroll(samples, {
          source: "settings-append",
          promptId: "settings-initial",
          durationMs: quality.durationMs,
          quality,
        });
      }
      setVoiceEnrolled(true);
      await refreshSpeakerSummary();
      dispatchUi({ type: "enrollment/saved" });
    } catch (error) {
      console.error("[Settings] Failed to save speaker enrollment:", error);
      dispatchUi({ type: "enrollment/failed", error: "声纹保存失败" });
      setVoiceEnrolled(false);
    } finally {
      await getLiveSampleRecorder()
        .then((recorder) => recorder.cancel())
        .catch(() => undefined);
      setVoiceState("sleeping");
    }
  }, [enrolling, refreshSpeakerSummary, setVoiceEnrolled, setVoiceState, voiceEnrolled]);

  const clearVoiceEnrollment = useCallback(async () => {
    if (
      enrolling ||
      savingEnrollment ||
      smokeRecording ||
      smokeRunning ||
      speakerVerifyRecording ||
      speakerVerifyRunning
    ) {
      return;
    }

    try {
      const { speakerIdService } = await getVoiceServices();
      await speakerIdService.clearEnrollment();
      setVoiceEnrolled(false);
      await refreshSpeakerSummary();
    } catch (error) {
      console.error("[Settings] Failed to clear speaker enrollment:", error);
    }
  }, [
    enrolling,
    refreshSpeakerSummary,
    savingEnrollment,
    setVoiceEnrolled,
    smokeRecording,
    smokeRunning,
    speakerVerifyRecording,
    speakerVerifyRunning,
  ]);

  const startVoiceSmoke = useCallback(async () => {
    if (
      smokeRecording ||
      smokeRunning ||
      speakerVerifyRecording ||
      speakerVerifyRunning ||
      enrolling ||
      savingEnrollment
    ) return;

    dispatchUi({ type: "voice-smoke/start-recording" });
    setVoiceState("listening");

    try {
      const { sttService } = await getVoiceServices();
      await sttService.startRecording();
    } catch (error) {
      console.error("[Settings] Failed to start voice smoke:", error);
      dispatchUi({ type: "voice-smoke/failed", error: "诊断录音启动失败" });
      setVoiceState("sleeping");
    }
  }, [
    enrolling,
    savingEnrollment,
    setVoiceState,
    smokeRecording,
    smokeRunning,
    speakerVerifyRecording,
    speakerVerifyRunning,
  ]);

  const finishVoiceSmoke = useCallback(async () => {
    if (!smokeRecording) return;

    dispatchUi({ type: "voice-smoke/start-running" });
    setVoiceState("verifying");

    try {
      const { sttService, speakerIdService } = await getVoiceServices();
      const audioUri = await sttService.stopRecording();
      await speakerIdService.enrollFromFile(audioUri);
      const verified = await speakerIdService.verifyFile(audioUri);
      const transcript = await sttService.transcribeFile(audioUri);
      const audioSummary = await getAudioFileSummary(audioUri);
      setVoiceEnrolled(true);
      const result = [
        `audio=${audioSummary}`,
        `speaker=${verified ? "pass" : "fail"}`,
        `stt=${transcript || "(empty)"}`,
      ].join(" | ");
      console.log(`[Settings] Voice smoke succeeded: ${result}`);
      dispatchUi({ type: "voice-smoke/succeeded", result });
    } catch (error) {
      console.error("[Settings] Voice smoke failed:", error);
      dispatchUi({ type: "voice-smoke/failed", error: "语音诊断失败" });
    } finally {
      const { sttService } = await getVoiceServices();
      await sttService.resumeWakewordFeederIfPaused();
      setVoiceState("sleeping");
    }
  }, [setVoiceEnrolled, setVoiceState, smokeRecording]);

  const runSpeakerVerify = useCallback(async () => {
    if (
      smokeRecording ||
      smokeRunning ||
      speakerVerifyRecording ||
      speakerVerifyRunning ||
      enrolling ||
      savingEnrollment
    ) return;

    dispatchUi({ type: "speaker-verify/start-recording" });
    setVoiceState("listening");

    try {
      const [{ speakerIdService }, liveSampleRecorder] = await Promise.all([
        getVoiceServices(),
        getLiveSampleRecorder(),
      ]);
      // Enrollment status only reads stored state (and lazily loads the
      // speaker model) — independent of the live recording, so it can run
      // concurrently with record/wait/stop instead of adding to that chain.
      const enrollmentStatusPromise = speakerIdService.refreshEnrollmentStatus();
      await liveSampleRecorder.start();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      dispatchUi({ type: "speaker-verify/start-running" });
      setVoiceState("verifying");
      const samples = await liveSampleRecorder.stop();
      const enrolled = await enrollmentStatusPromise;
      const [verified, nonOwnerVerified] = enrolled
        ? await Promise.all([
            speakerIdService.verifySamples(samples, "diagnostic-owner"),
            speakerIdService.verifyDiagnosticNonOwner(),
          ])
        : [false, false];
      if (nonOwnerVerified) {
        throw new Error("Diagnostic non-owner sample was accepted");
      }
      setVoiceEnrolled(enrolled);
      const result = [
        `samples=${samples.length}`,
        `enrolled=${enrolled ? "yes" : "no"}`,
        `owner=${verified ? "pass" : "fail"}`,
        `nonOwner=${nonOwnerVerified ? "accept" : "reject"}`,
      ].join(" | ");
      console.log(`[Settings] Speaker verify succeeded: ${result}`);
      dispatchUi({ type: "speaker-verify/succeeded", result });
    } catch (error) {
      console.error("[Settings] Speaker verify failed:", error);
      dispatchUi({ type: "speaker-verify/failed", error: "声纹验证失败" });
    } finally {
      await getLiveSampleRecorder()
        .then((recorder) => recorder.cancel())
        .catch(() => undefined);
      setVoiceState("sleeping");
    }
  }, [
    enrolling,
    savingEnrollment,
    setVoiceEnrolled,
    setVoiceState,
    smokeRecording,
    smokeRunning,
    speakerVerifyRecording,
    speakerVerifyRunning,
  ]);

  const runVisualSmoke = useCallback(async () => {
    if (visualSmokeRunning) return;

    dispatchUi({ type: "visual-smoke/start-running" });

    try {
      const latestFrame = cameraPerceiver.getLatestFrame();
      if (!latestFrame) {
        throw new Error("No camera frame buffered");
      }

      const transcript = "记住这个放这了";
      addConversationMessage({ role: "user", content: transcript });
      const observation = createObservation(transcript, "voice+camera", "placement");
      const result = await observeService.voiceVisual(
        transcript,
        latestFrame,
        observation.metadata
      );

      addConversationMessage({
        role: "assistant",
        content: result.response,
        evidenceUri: result.evidenceUri,
      });
      const summary = [
        `remembered=${result.remembered ? "yes" : "no"}`,
        `response=${result.response}`,
        `evidence=${result.evidenceUri}`,
        `description=${result.description}`,
      ].join(" | ");
      console.log(`[Settings] Visual smoke succeeded: ${summary}`);
      dispatchUi({ type: "visual-smoke/succeeded", result: summary });
    } catch (error) {
      console.error("[Settings] Visual smoke failed:", error);
      dispatchUi({ type: "visual-smoke/failed", error: "视觉记忆诊断失败" });
    }
  }, [addConversationMessage, visualSmokeRunning]);

  const runKwsSmoke = useCallback(async () => {
    if (kwsSmokeRunning) return;

    dispatchUi({ type: "kws-smoke/start-running" });

    const { sherpaVoiceAdapter, kwsAudioFeeder } = await getKwsServices();
    const shouldRestoreFeeder = kwsAudioFeeder.isRunning && preferences.wakeWordEnabled;
    try {
      const [{ samples, sampleRate }] = await Promise.all([
        loadPcm16WavAssetSamples(KWS_DIAGNOSTIC_AUDIO),
        sherpaVoiceAdapter.initializeKws(),
      ]);
      if (kwsAudioFeeder.isRunning) {
        await kwsAudioFeeder.stop();
      }
      await sherpaVoiceAdapter.resetKwsStream();
      const result = await runKwsDiagnosticSamples(samples, sampleRate, (chunk) =>
        sherpaVoiceAdapter.acceptKwsSamples(chunk, sampleRate)
      );
      const summary = [
        `detected=${result.detected ? "yes" : "no"}`,
        `keyword=${result.keyword || "(empty)"}`,
        `samples=${samples.length}`,
        `sampleRate=${sampleRate}`,
      ].join(" | ");
      console.log(`[Settings] KWS smoke succeeded: ${summary}`);
      dispatchUi({ type: "kws-smoke/succeeded", result: summary });
    } catch (error) {
      console.error("[Settings] KWS smoke failed:", error);
      dispatchUi({ type: "kws-smoke/failed", error: "唤醒词诊断失败" });
    } finally {
      await sherpaVoiceAdapter.resetKwsStream().catch(() => undefined);
      if (shouldRestoreFeeder) {
        await kwsAudioFeeder.start().catch((error) => {
          console.warn("[Settings] Failed to restore KWS feeder after smoke:", error);
        });
      }
    }
  }, [kwsSmokeRunning, preferences.wakeWordEnabled]);

  const runVadSmoke = useCallback(async () => {
    if (vadSmokeRunning) return;

    dispatchUi({ type: "vad-smoke/start-running" });

    try {
      const { summary: smokeSummary } = await runVadDiagnosticSmoke();
      const segment = smokeSummary.firstSegment;
      const summary = [
        `speech=${smokeSummary.speechDetected ? "yes" : "no"}`,
        `segments=${smokeSummary.segmentCount}`,
        segment ? `first=${segment.startTime?.toFixed(2)}-${segment.endTime?.toFixed(2)}s` : null,
        `samples=${smokeSummary.samples}`,
        `sampleRate=${smokeSummary.sampleRate}`,
      ].filter(Boolean).join(" | ");
      console.log(`[Settings] VAD smoke succeeded: ${summary}`);
      dispatchUi({ type: "vad-smoke/succeeded", result: summary });
    } catch (error) {
      console.error("[Settings] VAD smoke failed:", error);
      dispatchUi({ type: "vad-smoke/failed", error: "VAD 诊断失败" });
    }
  }, [vadSmokeRunning]);

  const runCalendarSmoke = useCallback(async () => {
    if (calendarSmokeRunning) return;

    dispatchUi({ type: "calendar-smoke/start-running" });

    try {
      const result = await reminderScheduler.processCalendarObservation(
        createObservation(
          "日历事件：「Phase 1 提醒诊断」将在 1 分钟后开始，地点：本机测试",
          "calendar",
          "calendar"
        )
      );
      if (!result) {
        throw new Error("Calendar reminder returned no result");
      }

      const summary = [
        `notification=${result.notificationId}`,
        `spoke=${result.spoke ? "yes" : "no"}`,
        result.ttsError ? `ttsError=${result.ttsError}` : null,
        `response=${result.response}`,
      ].filter(Boolean).join(" | ");
      console.log(`[Settings] Calendar smoke succeeded: ${summary}`);
      dispatchUi({ type: "calendar-smoke/succeeded", result: summary });
    } catch (error) {
      console.error("[Settings] Calendar smoke failed:", error);
      dispatchUi({ type: "calendar-smoke/failed", error: "日历提醒诊断失败" });
    }
  }, [calendarSmokeRunning]);

  const runRealCalendarSmoke = useCallback(async () => {
    if (calendarSmokeRunning) return;

    dispatchUi({ type: "calendar-smoke/start-running" });

    let unsubscribe: (() => void) | undefined;
    try {
      const eventId = await createCalendarSmokeEvent();
      const observed = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe?.();
          reject(new Error("Calendar smoke observation timed out"));
        }, 20_000);
        unsubscribe = calendarPerceiver.onObservation((observation) => {
          if (!observation.content.includes(CALENDAR_SMOKE_TITLE)) return;
          clearTimeout(timeout);
          unsubscribe?.();
          resolve(observation.content);
        });
      });

      const emitted = await calendarPerceiver.checkNow();
      const content = await observed;
      const summary = [
        `event=${eventId}`,
        `emitted=${emitted}`,
        `observed=${content}`,
      ].join(" | ");
      console.log(`[Settings] Real calendar smoke succeeded: ${summary}`);
      dispatchUi({ type: "calendar-smoke/succeeded", result: summary });
    } catch (error) {
      unsubscribe?.();
      console.error("[Settings] Real calendar smoke failed:", error);
      dispatchUi({ type: "calendar-smoke/failed", error: "真实日历事件诊断失败" });
    }
  }, [calendarSmokeRunning]);

  return (
    <DeviceShell title="设置" eyebrow="DEVICE PANEL">
      <View style={styles.summaryGrid}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>主人身份</Text>
          <Text style={styles.summaryValue}>{voiceEnrolled ? "声纹已注册" : "等待声纹"}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>服务器</Text>
          <Text style={[styles.summaryValue, serverConnected ? styles.okText : styles.errorTone]}>
            {serverConnected ? "已连接" : "未连接"}
          </Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>模型</Text>
          <Text style={[
            styles.summaryValue,
            modelStatus && isAllVoiceModelsReady(modelStatus) ? styles.okText : styles.warnText,
          ]}>
            {modelStatus ? (isAllVoiceModelsReady(modelStatus) ? "已就绪" : "待安装") : "未检查"}
          </Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>机器人</Text>
          <Text style={[styles.summaryValue, robotState.connected ? styles.okText : styles.warnText]}>
            {robotState.connected ? "已连接" : robotState.saved ? "已选择" : "未选择"}
          </Text>
        </View>
      </View>

      <SectionTitle isDark={isDark}>常用设置</SectionTitle>
      <View style={styles.capabilityGrid}>
        <ProfileSection
          isDark={isDark}
          name={name}
          voiceEnrolled={voiceEnrolled}
          speakerSummary={speakerSummary}
          enrolling={enrolling}
          savingEnrollment={savingEnrollment}
          enrollmentError={enrollmentError}
          startEnrollment={startEnrollment}
          finishEnrollment={finishEnrollment}
          clearVoiceEnrollment={clearVoiceEnrollment}
        />

        <VoiceModelsSection
          isDark={isDark}
          modelStatus={modelStatus}
          checkingModels={checkingModels}
          downloadingModels={downloadingModels}
          downloadProgress={modelDownloadProgress}
          modelError={modelError}
          checkSherpaModels={checkSherpaModels}
          downloadSherpaModels={downloadSherpaModels}
        />
      </View>

      <View style={styles.capabilityGrid}>
        <RobotSection
          isDark={isDark}
          robotState={robotState}
          scanRobots={scanRobots}
          connectRobot={connectRobot}
          forgetRobot={forgetRobot}
        />

        <ServerSection
          isDark={isDark}
          serverConnected={serverConnected}
          checkConnection={checkConnection}
        />
      </View>

      <View style={styles.capabilityGrid}>
        <FeaturesSection
          isDark={isDark}
          preferences={preferences}
          updatePreferences={updatePreferences}
        />
      </View>

      <AdvancedDiagnosticsSection
        isDark={isDark}
        expanded={diagnosticsExpanded}
        setExpanded={setDiagnosticsExpanded}
        smokeRecording={smokeRecording}
        smokeRunning={smokeRunning}
        smokeResult={smokeResult}
        smokeError={smokeError}
        speakerVerifyRecording={speakerVerifyRecording}
        speakerVerifyRunning={speakerVerifyRunning}
        speakerVerifyResult={speakerVerifyResult}
        speakerVerifyError={speakerVerifyError}
        kwsSmokeRunning={kwsSmokeRunning}
        kwsSmokeResult={kwsSmokeResult}
        kwsSmokeError={kwsSmokeError}
        vadSmokeRunning={vadSmokeRunning}
        vadSmokeResult={vadSmokeResult}
        vadSmokeError={vadSmokeError}
        visualSmokeRunning={visualSmokeRunning}
        visualSmokeResult={visualSmokeResult}
        visualSmokeError={visualSmokeError}
        calendarSmokeRunning={calendarSmokeRunning}
        calendarSmokeResult={calendarSmokeResult}
        calendarSmokeError={calendarSmokeError}
        startVoiceSmoke={startVoiceSmoke}
        finishVoiceSmoke={finishVoiceSmoke}
        runSpeakerVerify={runSpeakerVerify}
        runKwsSmoke={runKwsSmoke}
        runVadSmoke={runVadSmoke}
        runVisualSmoke={runVisualSmoke}
        runCalendarSmoke={runCalendarSmoke}
        runRealCalendarSmoke={runRealCalendarSmoke}
        disabled={enrolling || savingEnrollment}
        modelStatus={modelStatus}
      />

        {/* Version */}
        <View style={styles.versionContainer}>
          <Text style={styles.versionText}>
            LOOI v1.0.0 · Phase 1 Memory Loop MVP
          </Text>
        </View>
    </DeviceShell>
  );
}

function ModelStatusRow({
  label,
  status,
  isDark: _isDark,
}: {
  label: string;
  status: SherpaModelCheck;
  isDark: boolean;
}) {
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHeader}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, status.ready ? styles.okText : styles.errorTone]}>
          {status.ready ? "已就绪" : "缺文件"}
        </Text>
      </View>
      {!status.ready ? (
        <Text style={styles.modelMissingText}>{status.missingFiles.join(", ")}</Text>
      ) : null}
    </View>
  );
}

function ProfileSection({
  isDark: _isDark,
  name,
  voiceEnrolled,
  speakerSummary,
  enrolling,
  savingEnrollment,
  enrollmentError,
  startEnrollment,
  finishEnrollment,
  clearVoiceEnrollment,
}: {
  isDark: boolean;
  name: string;
  voiceEnrolled: boolean;
  speakerSummary: SpeakerEnrollmentSummaryState | null;
  enrolling: boolean;
  savingEnrollment: boolean;
  enrollmentError: string | null;
  startEnrollment: () => void;
  finishEnrollment: () => void;
  clearVoiceEnrollment: () => void;
}) {
  const disabled = enrolling || savingEnrollment;

  return (
    <View style={styles.section}>
      <SectionTitle isDark={_isDark}>主人身份 / 声纹</SectionTitle>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>称呼</Text>
          <Text style={styles.value}>{name}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>声纹</Text>
          <Text style={[styles.value, voiceEnrolled ? styles.okText : styles.warnText]}>
            {voiceEnrolled ? "已注册" : "未注册"}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>样本</Text>
          <Text style={styles.value}>
            {speakerSummary ? `${speakerSummary.sampleCount}/${speakerSummary.templateLimit}` : "--"}
          </Text>
        </View>
        <Pressable
          style={[
            styles.enrollButton,
            enrolling && styles.enrollButtonActive,
            savingEnrollment && styles.disabledButton,
          ]}
          onPressIn={startEnrollment}
          onPressOut={finishEnrollment}
          disabled={savingEnrollment}
        >
          <Text style={styles.enrollButtonText}>
            {savingEnrollment
              ? "保存中..."
              : enrolling
                ? "松开完成"
                : voiceEnrolled
                  ? "按住追加声纹样本"
                  : "按住录入声纹"}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.checkButton,
            styles.dangerOutlineButton,
            (disabled || !voiceEnrolled) && styles.disabledButton,
          ]}
          onPress={clearVoiceEnrollment}
          disabled={disabled || !voiceEnrolled}
        >
          <Text style={[styles.checkButtonText, styles.dangerButtonText]}>
            清除声纹
          </Text>
        </Pressable>
        {enrollmentError ? <Text style={styles.errorText}>{enrollmentError}</Text> : null}
      </View>
    </View>
  );
}

function VoiceModelsSection({
  isDark: _isDark,
  modelStatus,
  checkingModels,
  downloadingModels,
  downloadProgress,
  modelError,
  checkSherpaModels,
  downloadSherpaModels,
}: {
  isDark: boolean;
  modelStatus: SherpaModelStatus | null;
  checkingModels: boolean;
  downloadingModels: boolean;
  downloadProgress: SherpaModelDownloadProgress | null;
  modelError: string | null;
  checkSherpaModels: () => void;
  downloadSherpaModels: () => void;
}) {
  const hasMissingModels = modelStatus
    ? !modelStatus.streamingAsr.ready ||
      !modelStatus.punctuation.ready ||
      !modelStatus.kws.ready ||
      !modelStatus.speaker.ready ||
      !modelStatus.vad.ready
    : false;
  const progressPercent = downloadProgress
    ? Math.round(downloadProgress.progress * 100)
    : 0;
  const controlsDisabled = checkingModels || downloadingModels;

  return (
    <View style={styles.section}>
      <SectionTitle isDark={_isDark}>语音模型 / KWS</SectionTitle>
      <View style={styles.card}>
        {modelStatus ? (
          <>
            <ModelStatusRow
              label="Streaming Paraformer"
              status={modelStatus.streamingAsr}
              isDark={_isDark}
            />
            <ModelStatusRow label="CT-Punc 标点" status={modelStatus.punctuation} isDark={_isDark} />
            <ModelStatusRow label="唤醒词 KWS" status={modelStatus.kws} isDark={_isDark} />
            <ModelStatusRow label="声纹 Speaker" status={modelStatus.speaker} isDark={_isDark} />
            <ModelStatusRow label="端点检测 VAD" status={modelStatus.vad} isDark={_isDark} />
          </>
        ) : (
          <Text style={styles.value}>{checkingModels ? "检查中..." : "未检查"}</Text>
        )}
        {hasMissingModels ? (
          <Text style={styles.modelHintText}>
            缺少模型时流式语音识别、标点恢复、声纹和唤醒词不可用。可直接从官方源下载到本机。
          </Text>
        ) : null}
        {downloadingModels && downloadProgress ? (
          <Text style={styles.smokeResultText}>
            {downloadProgress.label} · {progressPercent}%
          </Text>
        ) : null}
        {modelError ? <Text style={styles.errorText}>{modelError}</Text> : null}
        <Pressable
          style={[styles.checkButton, controlsDisabled && styles.disabledButton]}
          onPress={checkSherpaModels}
          disabled={controlsDisabled}
        >
          <Text style={styles.checkButtonText}>
            {checkingModels ? "检查中..." : "重新检测模型"}
          </Text>
        </Pressable>
        {hasMissingModels ? (
          <Pressable
            style={[styles.checkButton, controlsDisabled && styles.disabledButton]}
            onPress={downloadSherpaModels}
            disabled={controlsDisabled}
          >
            <Text style={styles.checkButtonText}>
              {downloadingModels ? "下载中..." : "下载语音模型"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function RobotSection({
  isDark: _isDark,
  robotState,
  scanRobots,
  connectRobot,
  forgetRobot,
}: {
  isDark: boolean;
  robotState: RobotSettingsState;
  scanRobots: () => void;
  connectRobot: (candidate: LooiRobotCandidate) => void;
  forgetRobot: () => void;
}) {
  const busy = robotState.scanning || Boolean(robotState.connectingId);
  const savedName = robotState.saved?.name ?? "未选择";

  return (
    <View style={styles.section}>
      <SectionTitle isDark={_isDark}>LOOI 机器人</SectionTitle>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>已选机器人</Text>
          <Text style={[styles.value, robotState.saved ? styles.okText : styles.warnText]}>
            {savedName}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>连接</Text>
          <Text style={[styles.value, robotState.connected ? styles.okText : styles.warnText]}>
            {robotState.connected ? "已握手" : "未连接"}
          </Text>
        </View>
        <Pressable
          style={[styles.checkButton, busy && styles.disabledButton]}
          onPress={scanRobots}
          disabled={busy}
        >
          <Text style={styles.checkButtonText}>
            {robotState.scanning ? "搜索中..." : "搜索 / 重试"}
          </Text>
        </Pressable>
        {robotState.candidates.length > 0 ? (
          <View style={styles.robotList}>
            {robotState.candidates.map((candidate) => {
              const connecting = robotState.connectingId === candidate.id;
              return (
                <Pressable
                  key={candidate.id}
                  style={[
                    styles.robotCandidate,
                    candidate.selected && styles.robotCandidateSelected,
                    busy && !connecting && styles.disabledButton,
                  ]}
                  onPress={() => connectRobot(candidate)}
                  disabled={busy && !connecting}
                >
                  <View style={styles.robotCandidateText}>
                    <Text style={styles.value}>{candidate.name}</Text>
                    <Text style={styles.label}>{candidate.id}</Text>
                  </View>
                  <Text style={[styles.value, candidate.selected ? styles.okText : styles.warnText]}>
                    {connecting ? "连接中" : candidate.selected ? "已选" : candidate.rssi ?? "--"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {robotState.saved ? (
          <Pressable
            style={[styles.checkButton, styles.dangerOutlineButton, busy && styles.disabledButton]}
            onPress={forgetRobot}
            disabled={busy}
          >
            <Text style={[styles.checkButtonText, styles.dangerButtonText]}>清除选择</Text>
          </Pressable>
        ) : null}
        {robotState.result ? <Text style={styles.smokeResultText}>{robotState.result}</Text> : null}
        {robotState.error ? <Text style={styles.errorText}>{robotState.error}</Text> : null}
      </View>
    </View>
  );
}

function ServerSection({
  isDark: _isDark,
  serverConnected,
  checkConnection,
}: {
  isDark: boolean;
  serverConnected: boolean;
  checkConnection: () => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={_isDark}>服务器连接</SectionTitle>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>本地服务器</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: serverConnected ? looiTheme.ok : looiTheme.danger },
              ]}
            />
            <Text style={styles.value}>
              {serverConnected ? "已连接" : "未连接"}
            </Text>
          </View>
        </View>
        <Pressable style={styles.checkButton} onPress={checkConnection}>
          <Text style={styles.checkButtonText}>重新检测</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AdvancedDiagnosticsSection({
  isDark: _isDark,
  expanded,
  setExpanded,
  smokeRecording,
  smokeRunning,
  smokeResult,
  smokeError,
  speakerVerifyRecording,
  speakerVerifyRunning,
  speakerVerifyResult,
  speakerVerifyError,
  kwsSmokeRunning,
  kwsSmokeResult,
  kwsSmokeError,
  vadSmokeRunning,
  vadSmokeResult,
  vadSmokeError,
  visualSmokeRunning,
  visualSmokeResult,
  visualSmokeError,
  calendarSmokeRunning,
  calendarSmokeResult,
  calendarSmokeError,
  startVoiceSmoke,
  finishVoiceSmoke,
  runSpeakerVerify,
  runKwsSmoke,
  runVadSmoke,
  runVisualSmoke,
  runCalendarSmoke,
  runRealCalendarSmoke,
  disabled,
  modelStatus,
}: {
  isDark: boolean;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  smokeRecording: boolean;
  smokeRunning: boolean;
  smokeResult: string | null;
  smokeError: string | null;
  speakerVerifyRecording: boolean;
  speakerVerifyRunning: boolean;
  speakerVerifyResult: string | null;
  speakerVerifyError: string | null;
  kwsSmokeRunning: boolean;
  kwsSmokeResult: string | null;
  kwsSmokeError: string | null;
  vadSmokeRunning: boolean;
  vadSmokeResult: string | null;
  vadSmokeError: string | null;
  visualSmokeRunning: boolean;
  visualSmokeResult: string | null;
  visualSmokeError: string | null;
  calendarSmokeRunning: boolean;
  calendarSmokeResult: string | null;
  calendarSmokeError: string | null;
  startVoiceSmoke: () => void;
  finishVoiceSmoke: () => void;
  runSpeakerVerify: () => void;
  runKwsSmoke: () => void;
  runVadSmoke: () => void;
  runVisualSmoke: () => void;
  runCalendarSmoke: () => void;
  runRealCalendarSmoke: () => void;
  disabled: boolean;
  modelStatus: SherpaModelStatus | null;
}) {
  const voiceDisabled = disabled || smokeRunning || speakerVerifyRunning;
  return (
    <View style={styles.sectionWide}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(!expanded)}
        style={styles.diagnosticsHeader}
      >
        <Text style={styles.sectionTitle}>高级诊断</Text>
        <Text style={styles.value}>{expanded ? "收起" : "展开"}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.card}>
          <Pressable
            style={[styles.checkButton, voiceDisabled && styles.disabledButton]}
            onPressIn={startVoiceSmoke}
            onPressOut={finishVoiceSmoke}
            disabled={voiceDisabled}
          >
            <Text style={styles.checkButtonText}>
              {smokeRunning
                ? "诊断中..."
                : smokeRecording
                  ? "松开运行语音诊断"
                  : "按住测试声纹 + STT"}
            </Text>
          </Pressable>
          {smokeResult ? <Text style={styles.smokeResultText}>{smokeResult}</Text> : null}
          {smokeError ? <Text style={styles.errorText}>{smokeError}</Text> : null}

          <Pressable
            style={[styles.checkButton, voiceDisabled && styles.disabledButton]}
            onPress={runSpeakerVerify}
            disabled={voiceDisabled}
          >
            <Text style={styles.checkButtonText}>
              {speakerVerifyRunning
                ? "验证中..."
                : speakerVerifyRecording
                  ? "录音中..."
                  : "验证已注册声纹"}
            </Text>
          </Pressable>
          {speakerVerifyResult ? <Text style={styles.smokeResultText}>{speakerVerifyResult}</Text> : null}
          {speakerVerifyError ? <Text style={styles.errorText}>{speakerVerifyError}</Text> : null}

          <Pressable
            style={[
              styles.checkButton,
              (kwsSmokeRunning || !modelStatus?.kws.ready) && styles.disabledButton,
            ]}
            onPress={runKwsSmoke}
            disabled={kwsSmokeRunning || !modelStatus?.kws.ready}
          >
            <Text style={styles.checkButtonText}>
              {kwsSmokeRunning ? "诊断中..." : "测试唤醒词音频"}
            </Text>
          </Pressable>
          {kwsSmokeResult ? <Text style={styles.smokeResultText}>{kwsSmokeResult}</Text> : null}
          {kwsSmokeError ? <Text style={styles.errorText}>{kwsSmokeError}</Text> : null}

          <Pressable
            style={[
              styles.checkButton,
              (vadSmokeRunning || !modelStatus?.vad.ready) && styles.disabledButton,
            ]}
            onPress={runVadSmoke}
            disabled={vadSmokeRunning || !modelStatus?.vad.ready}
          >
            <Text style={styles.checkButtonText}>
              {vadSmokeRunning ? "诊断中..." : "测试 VAD 端点检测"}
            </Text>
          </Pressable>
          {vadSmokeResult ? <Text style={styles.smokeResultText}>{vadSmokeResult}</Text> : null}
          {vadSmokeError ? <Text style={styles.errorText}>{vadSmokeError}</Text> : null}

          <Pressable
            style={[styles.checkButton, visualSmokeRunning && styles.disabledButton]}
            onPress={runVisualSmoke}
            disabled={visualSmokeRunning}
          >
            <Text style={styles.checkButtonText}>
              {visualSmokeRunning ? "诊断中..." : "测试视觉记忆 + 证据图"}
            </Text>
          </Pressable>
          {visualSmokeResult ? <Text style={styles.smokeResultText}>{visualSmokeResult}</Text> : null}
          {visualSmokeError ? <Text style={styles.errorText}>{visualSmokeError}</Text> : null}

          <Pressable
            style={[styles.checkButton, calendarSmokeRunning && styles.disabledButton]}
            onPress={runCalendarSmoke}
            disabled={calendarSmokeRunning}
          >
            <Text style={styles.checkButtonText}>
              {calendarSmokeRunning ? "诊断中..." : "测试通知 + 语音提醒"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.checkButton, calendarSmokeRunning && styles.disabledButton]}
            onPress={runRealCalendarSmoke}
            disabled={calendarSmokeRunning}
          >
            <Text style={styles.checkButtonText}>
              {calendarSmokeRunning ? "诊断中..." : "创建真实日历事件测试"}
            </Text>
          </Pressable>
          {calendarSmokeResult ? <Text style={styles.smokeResultText}>{calendarSmokeResult}</Text> : null}
          {calendarSmokeError ? <Text style={styles.errorText}>{calendarSmokeError}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

async function createCalendarSmokeEvent(): Promise<string> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== "granted") {
    throw new Error("Calendar permission not granted");
  }

  const calendarId = await getOrCreateCalendarSmokeCalendar();
  const startDate = new Date(Date.now() + 60_000);
  const endDate = new Date(startDate.getTime() + 5 * 60_000);
  const eventId = await Calendar.createEventAsync(calendarId, {
    title: CALENDAR_SMOKE_TITLE,
    startDate,
    endDate,
    location: "本机测试",
    notes: `Created by LOOI diagnostics at ${new Date().toISOString()}`,
  });
  console.log(`[Settings] Created calendar smoke event: ${eventId}`);
  return eventId;
}

async function runKwsDiagnosticSamples(
  samples: number[],
  sampleRate: number,
  acceptSamples: (chunk: number[]) => Promise<KwsDiagnosticResult>
) {
  const paddedSamples = samples.concat(new Array(KWS_DIAGNOSTIC_TAIL_SILENCE_SAMPLES).fill(0));
  return feedSamplesSequentially(
    paddedSamples,
    KWS_DIAGNOSTIC_CHUNK_SIZE,
    acceptSamples,
    (result) => Boolean(result.detected)
  );
}

function isAllVoiceModelsReady(status: SherpaModelStatus): boolean {
  return Boolean(
    status.streamingAsr.ready &&
      status.punctuation.ready &&
      status.kws.ready &&
      status.speaker.ready &&
      status.vad.ready
  );
}

function buildSettingsEnrollmentQuality(samples: number[]): {
  ok: boolean;
  durationMs: number;
  energyMean: number;
  reason?: "too-short" | "too-quiet";
} {
  const durationMs = Math.round((samples.length / 16000) * 1000);
  const energyMean = samples.length
    ? samples.reduce((sum, sample) => sum + Math.abs(sample), 0) / samples.length
    : 0;
  if (durationMs < 1800) {
    return { ok: false, durationMs, energyMean, reason: "too-short" };
  }
  if (energyMean < 0.008) {
    return { ok: false, durationMs, energyMean, reason: "too-quiet" };
  }
  return { ok: true, durationMs, energyMean };
}

async function getAudioFileSummary(audioUri: string): Promise<string> {
  const info = await FileSystem.getInfoAsync(audioUri);
  const size = info.exists ? info.size ?? 0 : 0;
  return size > 0 ? `${Math.round(size / 1024)}KB` : "unavailable";
}

async function getOrCreateCalendarSmokeCalendar(): Promise<string> {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find(
    (calendar) => calendar.title === CALENDAR_SMOKE_CALENDAR_TITLE && calendar.allowsModifications
  );
  if (existing) {
    return existing.id;
  }

  const source = { type: "LOCAL", name: CALENDAR_SMOKE_CALENDAR_TITLE, isLocalAccount: true };
  return Calendar.createCalendarAsync({
    title: CALENDAR_SMOKE_CALENDAR_TITLE,
    name: CALENDAR_SMOKE_CALENDAR_TITLE,
    color: looiTheme.cyan,
    entityType: Calendar.EntityTypes.EVENT,
    source,
    ownerAccount: CALENDAR_SMOKE_CALENDAR_TITLE,
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
  });
}

function FeaturesSection({
  isDark: _isDark,
  preferences,
  updatePreferences,
}: {
  isDark: boolean;
  preferences: Preferences;
  updatePreferences: (prefs: Partial<Preferences>) => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={_isDark}>功能开关</SectionTitle>
      <View style={styles.card}>
        <PreferenceSwitch
          isDark={_isDark}
          label="语音回复"
          value={preferences.ttsEnabled}
          onValueChange={(value) => updatePreferences({ ttsEnabled: value })}
        />
        <PreferenceSwitch
          isDark={_isDark}
          label="摄像头"
          value={preferences.cameraEnabled}
          onValueChange={(value) => updatePreferences({ cameraEnabled: value })}
        />
        <PreferenceSwitch
          isDark={_isDark}
          label="日历提醒"
          value={preferences.calendarEnabled}
          onValueChange={(value) => updatePreferences({ calendarEnabled: value })}
        />
        <PreferenceSwitch
          isDark={_isDark}
          label="唤醒词"
          value={preferences.wakeWordEnabled}
          onValueChange={(value) => updatePreferences({ wakeWordEnabled: value })}
        />
      </View>
    </View>
  );
}

function PreferenceSwitch({
  isDark: _isDark,
  label,
  value,
  onValueChange,
}: {
  isDark: boolean;
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.label}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: "rgba(140, 155, 173, 0.28)", true: "rgba(40, 213, 255, 0.42)" }}
        thumbColor={value ? looiTheme.cyan : looiTheme.muted}
      />
    </View>
  );
}

function SectionTitle({ isDark: _isDark, children }: { isDark: boolean; children: string }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

const styles = StyleSheet.create({
  summaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 14,
  },
  summaryCard: {
    flexGrow: 1,
    flexBasis: 180,
    minHeight: 84,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
    padding: 16,
    justifyContent: "space-between",
  },
  summaryLabel: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  summaryValue: {
    color: looiTheme.text,
    fontSize: 18,
    fontWeight: "700",
  },
  capabilityGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
  },
  section: {
    flexGrow: 1,
    flexBasis: 320,
    marginBottom: 14,
  },
  sectionWide: {
    marginBottom: 14,
  },
  sectionTitle: {
    color: looiTheme.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  diagnosticsHeader: {
    minHeight: 54,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  card: {
    minHeight: 160,
    borderRadius: 22,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 14,
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 2,
    gap: 12,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  label: {
    color: looiTheme.muted,
    fontSize: 14,
  },
  value: {
    color: looiTheme.text,
    fontSize: 14,
    fontWeight: "700",
  },
  okText: {
    color: looiTheme.ok,
  },
  warnText: {
    color: looiTheme.warn,
  },
  errorTone: {
    color: looiTheme.danger,
  },
  modelRow: {
    gap: 4,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(84, 167, 255, 0.14)",
  },
  modelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  modelMissingText: {
    color: looiTheme.danger,
    fontSize: 12,
    lineHeight: 16,
  },
  modelHintText: {
    color: looiTheme.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  checkButton: {
    minHeight: 40,
    backgroundColor: "rgba(40, 213, 255, 0.1)",
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  checkButtonText: {
    color: looiTheme.text,
    fontSize: 14,
    fontWeight: "700",
  },
  dangerOutlineButton: {
    backgroundColor: "rgba(255, 92, 122, 0.08)",
    borderColor: "rgba(255, 92, 122, 0.42)",
  },
  dangerButtonText: {
    color: looiTheme.danger,
  },
  enrollButton: {
    minHeight: 42,
    backgroundColor: "rgba(40, 213, 255, 0.14)",
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  enrollButtonActive: {
    backgroundColor: "rgba(255, 92, 122, 0.16)",
    borderColor: looiTheme.danger,
  },
  disabledButton: { opacity: 0.6 },
  enrollButtonText: {
    color: looiTheme.text,
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: {
    color: looiTheme.danger,
    fontSize: 13,
  },
  smokeResultText: {
    color: looiTheme.ok,
    fontSize: 12,
    lineHeight: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(77, 231, 180, 0.24)",
    backgroundColor: "rgba(77, 231, 180, 0.07)",
    padding: 10,
  },
  robotList: {
    gap: 8,
  },
  robotCandidate: {
    minHeight: 58,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(40, 213, 255, 0.06)",
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  robotCandidateSelected: {
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(77, 231, 180, 0.08)",
  },
  robotCandidateText: {
    flex: 1,
    gap: 4,
  },
  versionContainer: { alignItems: "center", paddingVertical: 24 },
  versionText: {
    color: looiTheme.muted,
    fontSize: 13,
  },
});
