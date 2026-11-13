import type { MessageKey } from "../i18n";
import { MOSS_DEFAULT_VOICE_ID } from "../voice-defaults";
export { MOSS_DEFAULT_VOICE_ID };

export type VoiceProviderId = "doubao" | "moss" | "openai";

export const VOICE_PROVIDERS: ReadonlyArray<{
  id: VoiceProviderId;
  label: string;
  docsUrl: string;
}> = [
  {
    id: "doubao", label: "@looi:runtimeDoubao",
    docsUrl: "https://docs.volcengine.com/docs/doubao-voice/end-to-endreal-time-speech-large-model-api-access-document?lang=zh",
  },
  {
    id: "moss", label: "MOSS-Live",
    docsUrl: "https://platform.moss.cn/docs/scenarios/moss-live/",
  },
  {
    id: "openai", label: "OpenAI",
    docsUrl: "https://developers.openai.com/api/docs/guides/realtime",
  },
];

export function voiceProviderLabel(providerId: string): string {
  const matched = VOICE_PROVIDERS.find((item) => item.id === providerId);
  return matched ? matched.label : providerId || "@looi:runtimeDoubao";
}

/** Seeduplex presets from https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh.
 * Keep the jupiter voices recognizable for configurations saved before the 2.0 picker. */
export const DOUBAO_DEFAULT_VOICE_ID = "zh_female_vv_jupiter_bigtts";

export const DOUBAO_VOICES: ReadonlyArray<{
  id: string;
  name: MessageKey;
  group: "voiceRecommendedPresets" | "voiceMorePresets" | "voiceClassicPresets";
}> = [
  { id: "zh_female_vv_uranus_bigtts", name: "voiceNameVivi2", group: "voiceRecommendedPresets" },
  { id: "zh_female_xiaohe_uranus_bigtts", name: "voiceNameXiaohe2", group: "voiceRecommendedPresets" },
  { id: "zh_male_m191_uranus_bigtts", name: "voiceNameYunzhou2", group: "voiceRecommendedPresets" },
  { id: "zh_male_taocheng_uranus_bigtts", name: "voiceNameXiaotian2", group: "voiceRecommendedPresets" },
  { id: "zh_female_tuanzi_uranus_bigtts", name: "voiceNameTuanzi2", group: "voiceMorePresets" },
  { id: "zh_male_liufei_uranus_bigtts", name: "voiceNameLiufei2", group: "voiceMorePresets" },
  { id: "zh_female_sophie_uranus_bigtts", name: "voiceNameSophie2", group: "voiceMorePresets" },
  { id: "zh_female_linjianvhai_uranus_bigtts", name: "voiceNameGirlNextDoor2", group: "voiceMorePresets" },
  { id: "zh_male_shaonianzixin_uranus_bigtts", name: "voiceNameZixin2", group: "voiceMorePresets" },
  { id: "zh_male_wennuanahu_uranus_bigtts", name: "voiceNameAhu2", group: "voiceMorePresets" },
  { id: "zh_female_gaolengyujie_uranus_bigtts", name: "voiceNameCoolLady2", group: "voiceMorePresets" },
  { id: "zh_female_zhixingnv_uranus_bigtts", name: "voiceNameIntellectualLady2", group: "voiceMorePresets" },
  { id: DOUBAO_DEFAULT_VOICE_ID, name: "voiceNameViviClassic", group: "voiceClassicPresets" },
  { id: "zh_female_xiaohe_jupiter_bigtts", name: "voiceNameXiaoheClassic", group: "voiceClassicPresets" },
  { id: "zh_male_yunzhou_jupiter_bigtts", name: "voiceNameYunzhouClassic", group: "voiceClassicPresets" },
  { id: "zh_male_xiaotian_jupiter_bigtts", name: "voiceNameXiaotianClassic", group: "voiceClassicPresets" },
];

export function doubaoVoicePreset(voiceId: string) {
  return DOUBAO_VOICES.find((voice) => voice.id === (voiceId || DOUBAO_DEFAULT_VOICE_ID));
}

export const MOSS_VOICES: ReadonlyArray<{
  id: string;
  name: MessageKey;
  group: "voiceRecommendedPresets" | "voiceMorePresets" | "voiceClassicPresets";
}> = [
  { id: MOSS_DEFAULT_VOICE_ID, name: "voiceNameNuannuan", group: "voiceRecommendedPresets" },
  { id: "6cc93520-3207-4f7a-bca9-2d560b9c306b", name: "voiceNameMumu", group: "voiceRecommendedPresets" },
];

export function mossVoicePreset(voiceId: string) {
  return MOSS_VOICES.find((voice) => voice.id === (voiceId || MOSS_DEFAULT_VOICE_ID));
}

export const OPENAI_DEFAULT_VOICE_ID = "marin";

export const OPENAI_VOICES: ReadonlyArray<{
  id: string;
  name: MessageKey;
  group: "voiceRecommendedPresets" | "voiceMorePresets" | "voiceClassicPresets";
}> = [
  { id: OPENAI_DEFAULT_VOICE_ID, name: "voiceNameMarin", group: "voiceRecommendedPresets" },
  { id: "cedar", name: "voiceNameCedar", group: "voiceRecommendedPresets" },
  { id: "alloy", name: "voiceNameAlloy", group: "voiceMorePresets" },
  { id: "ash", name: "voiceNameAsh", group: "voiceMorePresets" },
  { id: "ballad", name: "voiceNameBallad", group: "voiceMorePresets" },
  { id: "coral", name: "voiceNameCoral", group: "voiceMorePresets" },
  { id: "sage", name: "voiceNameSage", group: "voiceMorePresets" },
  { id: "shimmer", name: "voiceNameShimmer", group: "voiceMorePresets" },
  { id: "verse", name: "voiceNameVerse", group: "voiceMorePresets" },
];

export function openaiVoicePreset(voiceId: string) {
  return OPENAI_VOICES.find((voice) => voice.id === (voiceId || OPENAI_DEFAULT_VOICE_ID));
}

export function defaultVoiceIdForProvider(providerId: string): string {
  if (providerId === "moss") return MOSS_DEFAULT_VOICE_ID;
  if (providerId === "openai") return OPENAI_DEFAULT_VOICE_ID;
  return DOUBAO_DEFAULT_VOICE_ID;
}

export function voicePresetsForProvider(providerId: string) {
  if (providerId === "moss") return MOSS_VOICES;
  if (providerId === "openai") return OPENAI_VOICES;
  return DOUBAO_VOICES;
}

export function voicePresetForProvider(providerId: string, voiceId: string) {
  if (providerId === "moss") return mossVoicePreset(voiceId);
  if (providerId === "openai") return openaiVoicePreset(voiceId);
  return doubaoVoicePreset(voiceId);
}
