import { useCallback, useReducer, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  Switch,
  ScrollView,
  useColorScheme,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Calendar from "expo-calendar/legacy";
import { useUserStore } from "@/src/store/user";
import { checkServerHealth, observeService } from "@/src/server-api/client";
import { createObservation } from "@/src/core/observation";
import { cameraPerceiver } from "@/src/perceivers/camera-perceiver";
import { calendarPerceiver } from "@/src/perceivers/calendar-perceiver";
import { useConversationStore } from "@/src/store/conversation";
import { speakerIdService } from "@/src/voice/speaker-id";
import { sttService } from "@/src/voice/stt";
import { sherpaVoiceAdapter } from "@/src/voice/sherpa-adapter";
import { reminderScheduler } from "@/src/reminder/reminder-scheduler";
import type { SherpaModelCheck } from "@/src/voice/sherpa-models";

const CALENDAR_SMOKE_TITLE = "Phase 1 真实日历提醒诊断";
const CALENDAR_SMOKE_CALENDAR_TITLE = "LOOI Phase 1 Diagnostics";

type SherpaModelStatus = {
  asr: SherpaModelCheck;
  kws: SherpaModelCheck;
  speaker: SherpaModelCheck;
};

type Preferences = ReturnType<typeof useUserStore.getState>["preferences"];

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
    error: string | null;
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
  | { type: "visual-smoke/start-running" }
  | { type: "visual-smoke/succeeded"; result: string }
  | { type: "visual-smoke/failed"; error: string }
  | { type: "calendar-smoke/start-running" }
  | { type: "calendar-smoke/succeeded"; result: string }
  | { type: "calendar-smoke/failed"; error: string }
  | { type: "models/checking" }
  | { type: "models/checked"; status: SherpaModelStatus }
  | { type: "models/failed"; error: string };

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
    error: null,
  },
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
        models: { status: action.status, checking: false, error: null },
      };
    case "models/failed":
      return {
        ...state,
        models: { ...state.models, checking: false, error: action.error },
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
    running: visualSmokeRunning,
    result: visualSmokeResult,
    error: visualSmokeError,
  } = uiState.visualSmoke;
  const {
    running: calendarSmokeRunning,
    result: calendarSmokeResult,
    error: calendarSmokeError,
  } = uiState.calendarSmoke;
  const { status: modelStatus, checking: checkingModels, error: modelError } = uiState.models;
  const addConversationMessage = useConversationStore((state) => state.addMessage);

  const checkConnection = useCallback(async () => {
    const connected = await checkServerHealth();
    setServerConnected(connected);
  }, [setServerConnected]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  const checkSherpaModels = useCallback(async () => {
    dispatchUi({ type: "models/checking" });

    try {
      const status = await sherpaVoiceAdapter.checkModelReadiness();
      dispatchUi({ type: "models/checked", status });
    } catch (error) {
      console.error("[Settings] Failed to check sherpa models:", error);
      dispatchUi({ type: "models/failed", error: "模型检查失败" });
    }
  }, []);

  useEffect(() => {
    checkSherpaModels();
  }, [checkSherpaModels]);

  useEffect(() => {
    speakerIdService
      .refreshEnrollmentStatus()
      .then(setVoiceEnrolled)
      .catch(() => setVoiceEnrolled(false));
  }, [setVoiceEnrolled]);

  const startEnrollment = useCallback(async () => {
    if (enrolling || savingEnrollment) return;

    dispatchUi({ type: "enrollment/start-recording" });
    setVoiceState("listening");

    try {
      await sttService.startRecording();
    } catch (error) {
      console.error("[Settings] Failed to start speaker enrollment:", error);
      dispatchUi({ type: "enrollment/failed", error: "录音启动失败" });
      setVoiceState("sleeping");
    }
  }, [enrolling, savingEnrollment, setVoiceState]);

  const finishEnrollment = useCallback(async () => {
    if (!enrolling) return;

    dispatchUi({ type: "enrollment/start-saving" });
    setVoiceState("verifying");

    try {
      const audioUri = await sttService.stopRecording();
      await speakerIdService.enrollFromFile(audioUri);
      setVoiceEnrolled(true);
      dispatchUi({ type: "enrollment/saved" });
    } catch (error) {
      console.error("[Settings] Failed to save speaker enrollment:", error);
      dispatchUi({ type: "enrollment/failed", error: "声纹保存失败" });
      setVoiceEnrolled(false);
    } finally {
      await sttService.resumeWakewordFeederIfPaused();
      setVoiceState("sleeping");
    }
  }, [enrolling, setVoiceEnrolled, setVoiceState]);

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
      const audioUri = await sttService.stopRecording();
      await speakerIdService.enrollFromFile(audioUri);
      const verified = await speakerIdService.verifyFile(audioUri);
      const transcript = await sttService.transcribeFile(audioUri);
      setVoiceEnrolled(true);
      const result = [
        `audio=${audioUri}`,
        `speaker=${verified ? "pass" : "fail"}`,
        `stt=${transcript || "(empty)"}`,
      ].join(" | ");
      console.log(`[Settings] Voice smoke succeeded: ${result}`);
      dispatchUi({ type: "voice-smoke/succeeded", result });
    } catch (error) {
      console.error("[Settings] Voice smoke failed:", error);
      dispatchUi({ type: "voice-smoke/failed", error: "语音诊断失败" });
    } finally {
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
      await sttService.startRecording();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      dispatchUi({ type: "speaker-verify/start-running" });
      setVoiceState("verifying");
      const audioUri = await sttService.stopRecording();
      const enrolled = await speakerIdService.refreshEnrollmentStatus();
      const verified = enrolled ? await speakerIdService.verifyFile(audioUri) : false;
      setVoiceEnrolled(enrolled);
      const result = [
        `audio=${audioUri}`,
        `enrolled=${enrolled ? "yes" : "no"}`,
        `speaker=${verified ? "pass" : "fail"}`,
      ].join(" | ");
      console.log(`[Settings] Speaker verify succeeded: ${result}`);
      dispatchUi({ type: "speaker-verify/succeeded", result });
    } catch (error) {
      console.error("[Settings] Speaker verify failed:", error);
      dispatchUi({ type: "speaker-verify/failed", error: "声纹验证失败" });
    } finally {
      await sttService.resumeWakewordFeederIfPaused();
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
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? "#111827" : "#F9FAFB" }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <ProfileSection
          isDark={isDark}
          name={name}
          voiceEnrolled={voiceEnrolled}
          enrolling={enrolling}
          savingEnrollment={savingEnrollment}
          enrollmentError={enrollmentError}
          smokeRecording={smokeRecording}
          smokeRunning={smokeRunning}
          smokeResult={smokeResult}
          smokeError={smokeError}
          speakerVerifyRecording={speakerVerifyRecording}
          speakerVerifyRunning={speakerVerifyRunning}
          speakerVerifyResult={speakerVerifyResult}
          speakerVerifyError={speakerVerifyError}
          startEnrollment={startEnrollment}
          finishEnrollment={finishEnrollment}
          startVoiceSmoke={startVoiceSmoke}
          finishVoiceSmoke={finishVoiceSmoke}
          runSpeakerVerify={runSpeakerVerify}
        />

        <VoiceModelsSection
          isDark={isDark}
          modelStatus={modelStatus}
          checkingModels={checkingModels}
          modelError={modelError}
          checkSherpaModels={checkSherpaModels}
        />

        <VisualMemorySection
          isDark={isDark}
          running={visualSmokeRunning}
          result={visualSmokeResult}
          error={visualSmokeError}
          runVisualSmoke={runVisualSmoke}
        />

        <CalendarReminderSection
          isDark={isDark}
          running={calendarSmokeRunning}
          result={calendarSmokeResult}
          error={calendarSmokeError}
          runCalendarSmoke={runCalendarSmoke}
          runRealCalendarSmoke={runRealCalendarSmoke}
        />

        <ServerSection
          isDark={isDark}
          serverConnected={serverConnected}
          checkConnection={checkConnection}
        />

        <FeaturesSection
          isDark={isDark}
          preferences={preferences}
          updatePreferences={updatePreferences}
        />

        {/* Version */}
        <View style={styles.versionContainer}>
          <Text style={[styles.versionText, { color: isDark ? "#6B7280" : "#9CA3AF" }]}>
            LOOI v1.0.0 · Phase 1 Memory Loop MVP
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ModelStatusRow({
  label,
  status,
  isDark,
}: {
  label: string;
  status: SherpaModelCheck;
  isDark: boolean;
}) {
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHeader}>
        <Text style={[styles.label, { color: isDark ? "#D1D5DB" : "#374151" }]}>
          {label}
        </Text>
        <Text style={[styles.value, { color: status.ready ? "#10B981" : "#EF4444" }]}>
          {status.ready ? "已就绪" : "缺文件"}
        </Text>
      </View>
      {!status.ready ? (
        <Text style={[styles.modelMissingText, { color: isDark ? "#FCA5A5" : "#B91C1C" }]}>
          {status.missingFiles.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

function ProfileSection({
  isDark,
  name,
  voiceEnrolled,
  enrolling,
  savingEnrollment,
  enrollmentError,
  smokeRecording,
  smokeRunning,
  smokeResult,
  smokeError,
  speakerVerifyRecording,
  speakerVerifyRunning,
  speakerVerifyResult,
  speakerVerifyError,
  startEnrollment,
  finishEnrollment,
  startVoiceSmoke,
  finishVoiceSmoke,
  runSpeakerVerify,
}: {
  isDark: boolean;
  name: string;
  voiceEnrolled: boolean;
  enrolling: boolean;
  savingEnrollment: boolean;
  enrollmentError: string | null;
  smokeRecording: boolean;
  smokeRunning: boolean;
  smokeResult: string | null;
  smokeError: string | null;
  speakerVerifyRecording: boolean;
  speakerVerifyRunning: boolean;
  speakerVerifyResult: string | null;
  speakerVerifyError: string | null;
  startEnrollment: () => void;
  finishEnrollment: () => void;
  startVoiceSmoke: () => void;
  finishVoiceSmoke: () => void;
  runSpeakerVerify: () => void;
}) {
  const disabled = smokeRunning || speakerVerifyRunning || enrolling || savingEnrollment;

  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>个人信息</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        <View style={styles.row}>
          <Text style={[styles.label, { color: labelColor(isDark) }]}>称呼</Text>
          <Text style={[styles.value, { color: valueColor(isDark) }]}>{name}</Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: labelColor(isDark) }]}>声纹</Text>
          <Text style={[styles.value, { color: valueColor(isDark) }]}>
            {voiceEnrolled ? "已注册" : "未注册"}
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
            {savingEnrollment ? "保存中..." : enrolling ? "松开完成" : "按住录入本次会话声纹"}
          </Text>
        </Pressable>
        {enrollmentError ? <Text style={styles.errorText}>{enrollmentError}</Text> : null}
        <Pressable
          style={[styles.checkButton, disabled && styles.disabledButton]}
          onPressIn={startVoiceSmoke}
          onPressOut={finishVoiceSmoke}
          disabled={disabled}
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
          style={[styles.checkButton, disabled && styles.disabledButton]}
          onPress={runSpeakerVerify}
          disabled={disabled}
        >
          <Text style={styles.checkButtonText}>
            {speakerVerifyRunning
              ? "验证中..."
              : speakerVerifyRecording
              ? "录音中..."
              : "验证已注册声纹"}
          </Text>
        </Pressable>
        {speakerVerifyResult ? (
          <Text style={styles.smokeResultText}>{speakerVerifyResult}</Text>
        ) : null}
        {speakerVerifyError ? <Text style={styles.errorText}>{speakerVerifyError}</Text> : null}
      </View>
    </View>
  );
}

function VoiceModelsSection({
  isDark,
  modelStatus,
  checkingModels,
  modelError,
  checkSherpaModels,
}: {
  isDark: boolean;
  modelStatus: SherpaModelStatus | null;
  checkingModels: boolean;
  modelError: string | null;
  checkSherpaModels: () => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>语音模型</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        {modelStatus ? (
          <>
            <ModelStatusRow label="SenseVoice" status={modelStatus.asr} isDark={isDark} />
            <ModelStatusRow label="唤醒词 KWS" status={modelStatus.kws} isDark={isDark} />
            <ModelStatusRow label="声纹 Speaker" status={modelStatus.speaker} isDark={isDark} />
          </>
        ) : (
          <Text style={[styles.value, { color: valueColor(isDark) }]}>
            {checkingModels ? "检查中..." : "未检查"}
          </Text>
        )}
        {modelError ? <Text style={styles.errorText}>{modelError}</Text> : null}
        <Pressable
          style={[styles.checkButton, checkingModels && styles.disabledButton]}
          onPress={checkSherpaModels}
          disabled={checkingModels}
        >
          <Text style={styles.checkButtonText}>
            {checkingModels ? "检查中..." : "重新检测模型"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ServerSection({
  isDark,
  serverConnected,
  checkConnection,
}: {
  isDark: boolean;
  serverConnected: boolean;
  checkConnection: () => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>服务器</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        <View style={styles.row}>
          <Text style={[styles.label, { color: labelColor(isDark) }]}>本地服务器</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: serverConnected ? "#10B981" : "#EF4444" },
              ]}
            />
            <Text style={[styles.value, { color: valueColor(isDark) }]}>
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

function VisualMemorySection({
  isDark,
  running,
  result,
  error,
  runVisualSmoke,
}: {
  isDark: boolean;
  running: boolean;
  result: string | null;
  error: string | null;
  runVisualSmoke: () => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>视觉记忆</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        <Pressable
          style={[styles.checkButton, running && styles.disabledButton]}
          onPress={runVisualSmoke}
          disabled={running}
        >
          <Text style={styles.checkButtonText}>
            {running ? "诊断中..." : "测试视觉记忆 + 证据图"}
          </Text>
        </Pressable>
        {result ? <Text style={styles.smokeResultText}>{result}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </View>
  );
}

function CalendarReminderSection({
  isDark,
  running,
  result,
  error,
  runCalendarSmoke,
  runRealCalendarSmoke,
}: {
  isDark: boolean;
  running: boolean;
  result: string | null;
  error: string | null;
  runCalendarSmoke: () => void;
  runRealCalendarSmoke: () => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>日历提醒</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        <Pressable
          style={[styles.checkButton, running && styles.disabledButton]}
          onPress={runCalendarSmoke}
          disabled={running}
        >
          <Text style={styles.checkButtonText}>
            {running ? "诊断中..." : "测试通知 + 语音提醒"}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.checkButton, running && styles.disabledButton]}
          onPress={runRealCalendarSmoke}
          disabled={running}
        >
          <Text style={styles.checkButtonText}>
            {running ? "诊断中..." : "创建真实日历事件测试"}
          </Text>
        </Pressable>
        {result ? <Text style={styles.smokeResultText}>{result}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
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
    color: "#6D28D9",
    entityType: Calendar.EntityTypes.EVENT,
    source,
    ownerAccount: CALENDAR_SMOKE_CALENDAR_TITLE,
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
  });
}

function FeaturesSection({
  isDark,
  preferences,
  updatePreferences,
}: {
  isDark: boolean;
  preferences: Preferences;
  updatePreferences: (prefs: Partial<Preferences>) => void;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle isDark={isDark}>功能开关</SectionTitle>
      <View style={[styles.card, { backgroundColor: cardColor(isDark) }]}>
        <PreferenceSwitch
          isDark={isDark}
          label="语音回复"
          value={preferences.ttsEnabled}
          onValueChange={(value) => updatePreferences({ ttsEnabled: value })}
        />
        <PreferenceSwitch
          isDark={isDark}
          label="摄像头"
          value={preferences.cameraEnabled}
          onValueChange={(value) => updatePreferences({ cameraEnabled: value })}
        />
        <PreferenceSwitch
          isDark={isDark}
          label="日历提醒"
          value={preferences.calendarEnabled}
          onValueChange={(value) => updatePreferences({ calendarEnabled: value })}
        />
        <PreferenceSwitch
          isDark={isDark}
          label="唤醒词"
          value={preferences.wakeWordEnabled}
          onValueChange={(value) => updatePreferences({ wakeWordEnabled: value })}
        />
      </View>
    </View>
  );
}

function PreferenceSwitch({
  isDark,
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
      <Text style={[styles.label, { color: labelColor(isDark) }]}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}

function SectionTitle({ isDark, children }: { isDark: boolean; children: string }) {
  return (
    <Text style={[styles.sectionTitle, { color: valueColor(isDark) }]}>
      {children}
    </Text>
  );
}

function cardColor(isDark: boolean): string {
  return isDark ? "#1F2937" : "#FFFFFF";
}

function labelColor(isDark: boolean): string {
  return isDark ? "#D1D5DB" : "#374151";
}

function valueColor(isDark: boolean): string {
  return isDark ? "#F9FAFB" : "#111827";
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 8 },
  card: { borderRadius: 12, padding: 16, gap: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 15 },
  value: { fontSize: 15, fontWeight: "500" },
  modelRow: { gap: 4 },
  modelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modelMissingText: { fontSize: 12, lineHeight: 16 },
  checkButton: {
    backgroundColor: "#6D28D9",
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  checkButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "500" },
  enrollButton: {
    backgroundColor: "#6D28D9",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  enrollButtonActive: { backgroundColor: "#EF4444" },
  disabledButton: { opacity: 0.6 },
  enrollButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  errorText: { color: "#EF4444", fontSize: 13 },
  smokeResultText: { color: "#10B981", fontSize: 12, lineHeight: 18 },
  versionContainer: { alignItems: "center", paddingVertical: 24 },
  versionText: { fontSize: 13 },
});
