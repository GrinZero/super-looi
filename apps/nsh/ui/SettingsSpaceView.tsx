import { t, type LanguagePreference } from "../i18n";
import { Scroll, Text, View, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { AppearancePreference, TaskApprovalMode, createAppStore } from "../store";
import { SelectField } from "./Controls";

export function SettingsSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const appearanceOptions: Array<{
    id: AppearancePreference;
    testID: string;
    label: () => string;
  }> = [
    {
      id: "system",
      testID: "appearance-system",
      label: () => t("systemDefault"),
    },
    {
      id: "light",
      testID: "appearance-light",
      label: () => t("appearanceOptionLight"),
    },
    {
      id: "dark",
      testID: "appearance-dark",
      label: () => t("appearanceOptionDark"),
    },
  ];

  const languageItems = (): Array<{
    value: LanguagePreference;
    title: string;
  }> => [
    { value: "system", title: t("systemDefault") },
    { value: "zh-CN", title: "简体中文" },
    { value: "en-US", title: "English" },
  ];

  const approvalOptions: Array<{
    id: TaskApprovalMode;
    title: "taskApprovalAsk" | "taskApprovalLocalAuto" | "taskApprovalYolo";
    description: "taskApprovalAskDescription" | "taskApprovalLocalAutoDescription" | "taskApprovalYoloDescription";
  }> = [
    { id: "ask", title: "taskApprovalAsk", description: "taskApprovalAskDescription" },
    { id: "local_auto", title: "taskApprovalLocalAuto", description: "taskApprovalLocalAutoDescription" },
    { id: "yolo", title: "taskApprovalYolo", description: "taskApprovalYoloDescription" },
  ];

  const effectiveAppearanceLabel = () =>
    props.store.appearance() === "dark"
      ? t("appearanceOptionDark")
      : t("appearanceOptionLight");

  const effectiveLanguageLabel = () =>
    props.store.effectiveLocale() === "en-US" ? "English" : "简体中文";

  const renderAppearanceCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="border-b border-border pb-2.5 gap-1">
        <Text class="text-foreground text-sm font-semibold" role="header">
          {t("appearance")}
        </Text>
        <Text class="text-muted-foreground text-xs">
          {t("appearanceDescription")}
        </Text>
      </View>

      <View class="flex-row gap-2">
        <Each of={appearanceOptions} key={(option) => option.id}>
          {(option) => {
            const selected = () => props.store.appearanceMode() === option().id;
            return (
              <Button
                testID={option().testID}
                selected={selected()}
                onPress={() => props.store.setAppearance(option().id)}
                class={
                  selected()
                    ? "flex-1 min-h-12 px-3 rounded-xl bg-primary border border-transparent items-center justify-center active:opacity-75 focus:border-ring"
                    : "flex-1 min-h-12 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75 focus:border-ring"
                }
              >
                <Text
                  class={
                    selected()
                      ? "text-primary-foreground text-sm font-semibold"
                      : "text-foreground text-sm font-medium"
                  }
                  style={{ numberOfLines: 1 }}
                >
                  {option().label()}
                </Text>
              </Button>
            );
          }}
        </Each>
      </View>

      <Text class="text-muted-foreground text-xs">
        {t("currentlyActive", { value: effectiveAppearanceLabel() })}
      </Text>
    </View>
  );

  const renderLanguageCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="border-b border-border pb-2.5 gap-1">
        <Text class="text-foreground text-sm font-semibold" role="header">
          {t("language")}
        </Text>
        <Text class="text-muted-foreground text-xs">
          {t("languageDescription")}
        </Text>
      </View>

      <SelectField
        testID="language-select"
        accessibilityLabel={t("language")}
        items={languageItems()}
        value={props.store.languagePreference()}
        onChange={(next) => {
          void props.store.setLanguagePreference(next);
        }}
      />

      <Text class="text-muted-foreground text-xs">
        {t("currentlyActive", { value: effectiveLanguageLabel() })}
      </Text>
    </View>
  );

  const renderTaskApprovalCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="border-b border-border pb-2.5 gap-1">
        <Text class="text-foreground text-sm font-semibold" role="header">
          {t("taskApprovalMode")}
        </Text>
        <Text class="text-muted-foreground text-xs">
          {t("taskApprovalModeDescription")}
        </Text>
      </View>
      <View class="gap-2">
        <Each of={approvalOptions} key={(option) => option.id}>
          {(option) => {
            const selected = () => props.store.taskApprovalMode() === option().id;
            return (
              <Button
                testID={`task-approval-${option().id}`}
                selected={selected()}
                onPress={() => props.store.setTaskApprovalMode(option().id)}
                class={selected()
                  ? "min-h-16 rounded-xl border border-primary bg-primary/10 p-3 gap-1 active:opacity-75 focus:border-ring"
                  : "min-h-16 rounded-xl border border-border bg-muted p-3 gap-1 active:opacity-75 focus:border-ring"}
              >
                <Text class="text-foreground text-sm font-semibold">{t(option().title)}</Text>
                <Text class="text-muted-foreground text-xs">{t(option().description)}</Text>
              </Button>
            );
          }}
        </Each>
      </View>
    </View>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          {renderAppearanceCard()}
          {renderLanguageCard()}
          {renderTaskApprovalCard()}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3 min-h-0">
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-2">
            {renderAppearanceCard()}
          </Scroll>
        </View>
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-2">
            {renderLanguageCard()}
            {renderTaskApprovalCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
