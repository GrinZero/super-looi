import { List, Scroll, Text, View } from "nsh";
import { Button, Menu, MenuItem } from "nsh/base";
import { formatDate } from "../../../i18n";
import type { PluginFailure } from "../../../runtime/plugins/shared-types";
import { ActionIcon, type ActionIconName } from "../../../ui/HomeIcons";
import {
  WEREWOLF_PRESET_LABELS,
  type WerewolfMatchHighlight,
  type WerewolfMatchSummary,
} from "../contracts";
import { WerewolfRoleIcon, WerewolfStageIcon } from "./WerewolfIcons";

export const WEREWOLF_HISTORY_TITLE = { "zh-CN": "历史对局", "en-US": "Match History" };

export type HistoryLocale = keyof typeof WEREWOLF_HISTORY_TITLE;
export type HistoryOrigin = "settings" | "lobby" | "terminal";

const HISTORY_BACK_LABELS: Record<HistoryOrigin, Record<HistoryLocale, string>> = {
  settings: { "zh-CN": "返回插件设置", "en-US": "Back to Plugin Settings" },
  lobby: { "zh-CN": "返回大厅", "en-US": "Back to Lobby" },
  terminal: { "zh-CN": "返回终局", "en-US": "Back to Results" },
};

const HIGHLIGHTS = {
  peaceful_night: { icon: "moon", "zh-CN": "平安夜", "en-US": "Peaceful night" },
  day_tie: { icon: "swap", "zh-CN": "平票进 PK", "en-US": "Elimination vote runoff" },
  sheriff_tie: { icon: "swap", "zh-CN": "警长平票进 PK", "en-US": "Sheriff vote runoff" },
  badge_transfer: { icon: "shield", "zh-CN": "警徽移交", "en-US": "Sheriff badge transfer" },
} satisfies Record<WerewolfMatchHighlight["kind"], Record<HistoryLocale, string> & { icon: ActionIconName }>;

function MatchBoardIcon(props: { preset: WerewolfMatchSummary["presetId"] }) {
  return (
    <If when={props.preset === "6p_joy"} else={
      <If when={props.preset === "12p_guard"} else={
        <View class="relative w-6 h-6 shrink-0">
          <View class="absolute right-1 top-1 w-3 h-4 rounded-sm border border-stage-fg" style={{ rotate: 18 }} />
          <View class="absolute left-1 top-1 w-3 h-4 rounded-sm border border-stage-fg bg-stage-tile" style={{ rotate: -13 }} />
        </View>
      }>
        <WerewolfRoleIcon role="guard" tone="stageFg" size={24} />
      </If>
    }>
      <WerewolfStageIcon name="potion_bottle" tone="stageFg" size={24} />
    </If>
  );
}

export function formatBoardLabel(match: WerewolfMatchSummary, locale: HistoryLocale): string {
  if (match.presetId !== "custom") return WEREWOLF_PRESET_LABELS[match.presetId][locale];
  return locale === "en-US" ? `${match.playerCount}P Custom Board` : `${match.playerCount} 人自定义局`;
}

export function formatHighlightLabel(highlight: WerewolfMatchHighlight, locale: HistoryLocale): string {
  const day = highlight.day;
  const round = highlight.kind === "peaceful_night"
    ? locale === "en-US" ? `Night ${day}` : `第 ${day} 夜`
    : locale === "en-US" ? `Day ${day}` : `第 ${day} 天`;
  return `${round} · ${HIGHLIGHTS[highlight.kind][locale]}`;
}

function MatchHistoryCard(props: {
  match: WerewolfMatchSummary;
  locale: HistoryLocale;
  busy: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const day = (date: number) => props.locale === "en-US" ? `Day ${date}` : `第 ${date} 天`;

  return (
    <View
      testID={`werewolf-history-match-${props.match.id}`}
      class="flex-row items-center rounded-2xl border border-stage-pill-border bg-stage-tile"
    >
      <Button
        testID="werewolf-history-open-record"
        disabled={props.busy}
        onPress={props.onOpen}
        class="flex-1 min-w-0 min-h-23 flex-row items-center gap-4 rounded-2xl px-4 py-3 hover:bg-stage-pill-bg active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
      >
        <View class="w-24 shrink-0 gap-0.5">
          <Text class="text-stage-fg text-lg font-semibold" style={{ fontVariant: ["tabular-nums"] }}>
            {formatDate(props.match.endedAtMs, { month: "short", day: "numeric" })}
          </Text>
          <Text class="text-stage-pill-muted text-base" style={{ fontVariant: ["tabular-nums"] }}>
            {formatDate(props.match.endedAtMs, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
          </Text>
        </View>

        <View class="flex-[1.2] min-w-0 self-stretch justify-center gap-1.5 border-l border-stage-pill-border pl-4">
          <View class="flex-row items-center gap-2">
            <View accessibilityElementsHidden>
              <MatchBoardIcon preset={props.match.presetId} />
            </View>
            <Text class="text-stage-fg text-lg font-bold flex-1 min-w-0">
              {formatBoardLabel(props.match, props.locale)}
            </Text>
          </View>
          <View class="flex-row flex-wrap items-center gap-2">
            <View class={props.match.winner === "good"
              ? "rounded-lg bg-face-sage-core px-2.5 py-1"
              : "rounded-lg bg-face-rose-core px-2.5 py-1"}>
              <Text class="text-stage-bg text-sm font-bold">
                {props.match.winner === "good"
                  ? props.locale === "en-US" ? "Good wins" : "好人获胜"
                  : props.locale === "en-US" ? "Werewolves win" : "狼人获胜"}
              </Text>
            </View>
            <View class="rounded-lg border border-stage-pill-border px-2.5 py-1">
              <Text class="text-stage-fg text-sm font-semibold">{day(props.match.day)}</Text>
            </View>
          </View>
        </View>

        <If when={props.match.highlight}>
          {(highlight) => (
            <View class="flex-1 min-w-0 self-stretch flex-row items-center gap-2.5 border-l border-stage-pill-border pl-4">
              <View accessibilityElementsHidden>
                <ActionIcon name={HIGHLIGHTS[highlight().kind].icon} tone="stageFg" size={24} />
              </View>
              <Text class="text-stage-fg text-base font-semibold flex-1 min-w-0">
                {formatHighlightLabel(highlight(), props.locale)}
              </Text>
            </View>
          )}
        </If>
        <WerewolfStageIcon name="chevron_right" tone="stageMuted" size={18} />
      </Button>
      <If when={Boolean(props.onDelete)}>
        <View class="shrink-0 pr-2">
          <Menu
            offset={5}
            popupClass="min-w-36 rounded-xl border border-stage-pill-border bg-stage-panel p-1 shadow-lg"
            trigger={
              <View
                testID="werewolf-history-record-menu"
                accessibilityLabel={props.locale === "en-US" ? "Match actions" : "对局记录操作"}
                class="w-11 h-11 rounded-xl items-center justify-center hover:bg-stage-pill-bg active:opacity-75 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
              >
                <WerewolfStageIcon name="more_dots" tone="stageMuted" size={20} />
              </View>
            }
          >
            <MenuItem
              testID="werewolf-history-delete-action"
              disabled={props.busy}
              class="min-h-11 rounded-lg px-3 justify-center hover:bg-stage-pill-bg focus-visible:bg-stage-pill-bg"
              onSelect={() => props.onDelete?.()}
            >
              <Text class="text-face-rose-core text-sm font-semibold">
                {props.locale === "en-US" ? "Delete Record…" : "删除记录…"}
              </Text>
            </MenuItem>
          </Menu>
        </View>
      </If>
    </View>
  );
}

function HistoryIllustration() {
  return (
    <View class="relative w-40 h-32 shrink-0 pointer-events-none" accessibilityElementsHidden>
      <View
        class="absolute left-5 top-7 w-14 h-20 items-center justify-center rounded-xl border-2 border-stage-pill-muted bg-stage-bg"
        style={{ rotate: -16 }}
      >
        <WerewolfRoleIcon role="werewolf" tone="stageMuted" size={28} />
      </View>
      <View
        class="absolute left-14 top-10 w-14 h-20 items-center justify-center rounded-xl border-2 border-stage-pill-muted bg-stage-bg"
        style={{ rotate: 9 }}
      >
        <WerewolfRoleIcon role="werewolf" tone="stageMuted" size={29} />
      </View>
      <View class="absolute right-2 top-0 rounded-full bg-stage-bg">
        <WerewolfStageIcon name="clock" tone="amber" size={56} strokeWidth={1.35} />
      </View>
    </View>
  );
}

export function WerewolfHistoryHeader(props: {
  backLabel: string;
  title: string;
  subtitle?: string;
  testID: string;
  onBack: () => void;
}) {
  return (
    <View class="min-h-14 shrink-0 flex-row items-center gap-3 border-b border-stage-pill-border mx-4">
      <Button
        testID={props.testID}
        accessibilityLabel={props.backLabel}
        onPress={props.onBack}
        class="w-11 h-11 shrink-0 rounded-xl items-center justify-center hover:bg-stage-pill-bg active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
      >
        <WerewolfStageIcon name="chevron_left" tone="stageFg" size={24} />
      </Button>
      <Text class="text-stage-fg text-xl font-bold flex-1" role="header">{props.title}</Text>
      <Text class="text-stage-pill-muted text-sm">{props.subtitle}</Text>
    </View>
  );
}

export function WerewolfHistoryView(props: {
  locale: HistoryLocale;
  origin: HistoryOrigin;
  records: readonly WerewolfMatchSummary[];
  loadError: PluginFailure | null;
  busy: boolean;
  canDelete: boolean;
  onOpen: (match: WerewolfMatchSummary) => void;
  onDelete: (match: WerewolfMatchSummary) => void;
  onBack: () => void;
}) {
  const isEnglish = () => props.locale === "en-US";
  const backLabel = () => HISTORY_BACK_LABELS[props.origin][props.locale];

  return (
    <View class="flex-1 min-h-0">
      <WerewolfHistoryHeader
        testID="werewolf-history-header-back"
        backLabel={backLabel()}
        title={WEREWOLF_HISTORY_TITLE[props.locale]}
        subtitle={isEnglish() ? "Werewolf" : "狼人杀"}
        onBack={props.onBack}
      />

      <If
        when={props.records.length > 0}
        else={
          <Scroll class="flex-1 min-h-0" contentClass="grow items-center justify-center px-4 py-4">
            <View class="items-center gap-4">
              <HistoryIllustration />
              <View class="items-center gap-1.5">
                <Text class="text-stage-fg text-2xl font-bold text-center" role="header">
                  {props.loadError
                    ? isEnglish() ? "Could not load match history" : "读取对局记录失败"
                    : isEnglish() ? "No matches yet" : "还没有对局记录"}
                </Text>
                <Text class="text-stage-pill-muted text-base text-center">
                  {props.loadError
                    ? `[${props.loadError.stage} · ${props.loadError.code}] ${props.loadError.reason}`
                    : isEnglish()
                      ? "Finish a match, then come back to review it."
                      : "完成一局后，就能回来复盘"}
                </Text>
              </View>
              <Button
                testID="werewolf-history-back"
                onPress={props.onBack}
                class="min-h-11 min-w-44 px-6 rounded-xl bg-eye-core items-center justify-center active:opacity-75 focus-visible:ring-2 focus-visible:ring-face-amber-edge focus-visible:ring-offset-2 focus-visible:ring-offset-stage-bg"
              >
                <Text class="text-stage-bg text-base font-semibold">{backLabel()}</Text>
              </Button>
            </View>
          </Scroll>
        }
      >
        <List
          testID="werewolf-history-list"
          class="flex-1 min-h-0"
          contentClass="px-4 py-3 gap-3"
          each={props.records}
          keyExtractor={(match) => match.id}
          estimatedItemSize={104}
        >
          {(match) => (
            <MatchHistoryCard
              match={match()}
              locale={props.locale}
              busy={props.busy}
              onOpen={() => props.onOpen(match())}
              onDelete={props.canDelete ? () => props.onDelete(match()) : undefined}
            />
          )}
        </List>
      </If>
    </View>
  );
}
