import type { MessageKey } from "../i18n";

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
