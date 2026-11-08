import { mount, Text, View } from "nsh";
import { bindLocale, formatDate, formatNumber, t } from "./i18n";
import { locale } from "nsh";
import { resolveLocale } from "./i18n";
function I18nProbe() {
  bindLocale(() => resolveLocale("system", locale()));
  return <View>
    <Text>{t("taskCount", { count: 1 })}</Text>
    <Text>{t("taskCount", { count: 2 })}</Text>
    <Text>{formatDate("2026-11-08T12:00:00Z", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}</Text>
    <Text>{formatNumber(12345)}</Text>
  </View>;
}
mount(I18nProbe);
