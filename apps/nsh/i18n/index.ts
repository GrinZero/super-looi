import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/zh.js";
import i18next from "i18next";
import { extraEn, extraZh } from "./extra-catalog";
import { en, zh } from "./catalog";
import { runtimeEn, runtimeZh } from "./runtime-catalog";

export type AppLocale = "zh-CN" | "en-US";
export type LanguagePreference = "system" | AppLocale;
export type MessageKey = keyof typeof zh | keyof typeof runtimeZh | keyof typeof extraZh | "taskCount" | "recoveryCount";

export function resolveLocale(preference: LanguagePreference, systemLocale: string): AppLocale {
  if (preference !== "system") return preference;
  return /^en(?:-|$)/i.test(systemLocale) ? "en-US" : "zh-CN";
}

const engine = i18next.createInstance();
void engine.init({
  initAsync: false,
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  resources: { "zh-CN": { translation: { ...zh, ...runtimeZh, ...extraZh } }, "en-US": { translation: { ...en, ...runtimeEn, ...extraEn } } },
  interpolation: { escapeValue: false },
});

// The single app store owns preference and system-locale reactivity.
let readLocale: () => AppLocale = () => "zh-CN";
export function bindLocale(reader: () => AppLocale): void { readLocale = reader; }
export function t(key: MessageKey, parameters?: Record<string, unknown>): string {
  return String(engine.t(key, { ...parameters, lng: readLocale() }));
}
export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(readLocale(), options).format(new Date(value));
}
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(readLocale()).format(value);
}

/** Runtime messages carry a stable identifier; user/model text remains untouched. */
export function translateMessage(value: string): string {
  if (!value.startsWith("@looi:")) return Object.hasOwn(extraZh, value) ? t(value as MessageKey) : value;
  const separator = value.indexOf("|");
  return separator < 0 ? t(value.slice(6) as MessageKey) : t(value.slice(6, separator) as MessageKey, JSON.parse(value.slice(separator + 1)));
}
