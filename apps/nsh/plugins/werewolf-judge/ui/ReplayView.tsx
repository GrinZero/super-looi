import { createMotion, reduceMotion, Scroll, signal, Text, View, type JSX } from "nsh";
import { Button } from "nsh/base";
import { LoadingIndicator } from "../../../ui/Controls";
import { ActionIcon } from "../../../ui/HomeIcons";
import {
  WEREWOLF_ROLE_LABELS,
  isWolfRole,
  type WerewolfAiMvpReview,
  type WerewolfMatchRecord,
  type WerewolfReplayEvent,
  type WerewolfReplaySeat,
  type WerewolfReplayVoteKind,
  type WerewolfReplayVoteOutcome,
} from "../contracts";
import { formatBoardLabel, formatHighlightLabel, type HistoryLocale } from "./HistoryView";
import { WerewolfRoleIcon, WerewolfStageIcon } from "./WerewolfIcons";

type Copy = readonly [chinese: string, english: string];
const copy = (locale: HistoryLocale, label: Copy) => label[locale === "en-US" ? 1 : 0];

const VOTE_LABELS: Record<WerewolfReplayVoteKind, Copy> = {
  sheriff: ["警长投票", "Sheriff vote"],
  sheriff_pk: ["警长 PK 投票", "Sheriff runoff"],
  exile: ["放逐投票", "Elimination vote"],
  exile_pk: ["放逐 PK 投票", "Elimination runoff"],
};

const VOTE_OUTCOMES: Record<WerewolfReplayVoteOutcome, Copy> = {
  elected: ["当选警长", "Elected sheriff"],
  badge_lost: ["警徽流失", "Badge lost"],
  runoff: ["平票，进入 PK", "Tie · runoff"],
  exiled: ["被放逐", "Eliminated"],
  idiot_revealed: ["翻牌免于放逐", "Revealed and survived"],
  no_votes: ["全员弃票，无人出局", "Everyone abstained"],
  tied_again: ["再次平票，无人出局", "Tie · no elimination"],
};

const SPEECH_LABELS = {
  sheriff: ["警上发言安排", "Sheriff speaking order"],
  sheriff_pk: ["警长 PK 发言", "Sheriff runoff speeches"],
  discussion: ["发言顺序", "Speaking order"],
  exile_pk: ["放逐 PK 发言", "Elimination runoff speeches"],
} as const satisfies Record<string, Copy>;

type TextReplayEvent = Extract<WerewolfReplayEvent, { type: "event" | "dawn" }>;

type ReplayRound = {
  readonly key: string;
  readonly day: number;
  readonly kind: "overview" | "deal" | "night" | "day";
};

const OVERVIEW: ReplayRound = { key: "overview", day: 0, kind: "overview" };
const DEAL: ReplayRound = { key: "deal", day: 0, kind: "deal" };

function formatRound(locale: HistoryLocale, round: ReplayRound): string {
  if (round.kind === "overview") return copy(locale, ["整局总结", "Overview"]);
  if (round.kind === "deal") return copy(locale, ["发牌", "Roles"]);
  if (round.kind === "night") return copy(locale, [`第 ${round.day} 夜`, `Night ${round.day}`]);
  return copy(locale, [`第 ${round.day} 天`, `Day ${round.day}`]);
}

function eventRound(event: WerewolfReplayEvent): ReplayRound {
  if (event.round === "deal") return DEAL;
  return { key: `${event.round}-${event.day}`, day: event.day, kind: event.round };
}

function formatSeat(seat: number, seats: readonly WerewolfReplaySeat[], locale: HistoryLocale): string {
  const label = copy(locale, [`${seat} 号`, `Seat ${seat}`]);
  const name = seats.find((player) => player.seat === seat)?.nickname;
  return name ? `${label} ${name}` : label;
}

function EventCard(props: {
  event: TextReplayEvent;
  seats: readonly WerewolfReplaySeat[];
  locale: HistoryLocale;
}) {
  return (
    <View class="rounded-2xl border border-stage-pill-border bg-stage-tile px-4 py-3 gap-1">
      <Text class="text-stage-fg text-base">{props.event.text}</Text>
      <If when={props.event.seats.length > 0}>
        <Text class="text-stage-pill-muted text-sm">
          {props.event.seats.map((seat) => formatSeat(seat, props.seats, props.locale)).join(" · ")}
        </Text>
      </If>
    </View>
  );
}

function BallotCard(props: {
  event: Extract<WerewolfReplayEvent, { type: "ballot" }>;
  seats: readonly WerewolfReplaySeat[];
  locale: HistoryLocale;
  open: boolean;
  onToggle: () => void;
}) {
  const names = (seats: readonly number[]) => seats.map((seat) => formatSeat(seat, props.seats, props.locale));
  const abstained = () => Object.entries(props.event.votes)
    .filter(([, target]) => target === null)
    .map(([seat]) => Number(seat));
  const outcome = () => {
    const label = copy(props.locale, VOTE_OUTCOMES[props.event.outcome]);
    const singleSeat = props.event.seats.length === 1 ? props.event.seats[0] : undefined;
    return singleSeat ? `${formatSeat(singleSeat, props.seats, props.locale)} · ${label}` : label;
  };
  return (
    <View class="rounded-2xl border border-stage-pill-border bg-stage-tile">
      <Button
        testID={`werewolf-replay-ballot-${props.event.kind}-${props.event.day}`}
        accessibilityLabel={`${copy(props.locale, VOTE_LABELS[props.event.kind])} · ${props.open
          ? copy(props.locale, ["收起明细", "Collapse details"])
          : copy(props.locale, ["展开明细", "Expand details"])}`}
        selected={props.open}
        onPress={props.onToggle}
        class="min-h-12 flex-row items-center gap-3 px-4 py-2 rounded-2xl hover:bg-stage-pill-bg active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
      >
        <Text class="flex-1 min-w-0 text-stage-fg font-bold text-base">{copy(props.locale, VOTE_LABELS[props.event.kind])}</Text>
        <Text class="text-face-amber-core text-sm">{outcome()}</Text>
        <WerewolfStageIcon name="chevron_right" tone="stageMuted" size={16} />
      </Button>
      <If when={props.open}>
        <ReplayReveal testID={`werewolf-replay-ballot-detail-${props.event.kind}-${props.event.day}`}>
          <View class="mx-4 pb-3 pt-2 gap-2 border-t border-stage-pill-border">
            <Each of={props.event.tallies} key={(tally) => tally.targetSeat}>
              {(tally) => (
                <View class="flex-row items-start gap-3">
                  <Text class="text-stage-fg font-semibold text-sm">{formatSeat(tally().targetSeat, props.seats, props.locale)}</Text>
                  <Text class="flex-1 min-w-0 text-stage-pill-muted text-sm">← {names(tally().voterSeats).join("、")}</Text>
                  <Text class="text-stage-fg text-sm">{copy(props.locale, [`${tally().weightedVotes} 票`, `${tally().weightedVotes} votes`])}</Text>
                </View>
              )}
            </Each>
            <Text class="text-stage-pill-muted text-sm">
              {copy(props.locale, ["弃票", "Abstained"])} · {names(abstained()).join("、") || copy(props.locale, ["无", "None"])}
            </Text>
          </View>
        </ReplayReveal>
      </If>
    </View>
  );
}

function ReplayReveal(props: { testID?: string; children?: JSX.Element }) {
  const motion = createMotion(reduceMotion() ? {} : { enter: "fadeIn", duration: 150 });
  return <View testID={props.testID} style={{ opacity: motion.opacity }}>{props.children}</View>;
}

function ReviewPanel(props: {
  locale: HistoryLocale;
  review?: WerewolfAiMvpReview;
  onRegenerate?: () => void;
}) {
  const loading = () => props.review?.status === "generating";
  return (
    <View testID="werewolf-mvp-card" class="shrink-0 rounded-2xl border border-stage-amber-border bg-stage-amber-bg px-4 py-3 gap-2">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-face-amber-core text-base font-bold">{copy(props.locale, ["LOOI 点评", "LOOI review"])}</Text>
        <If when={props.onRegenerate && !loading()}>
          <Button
            testID="werewolf-regen-mvp-btn"
            onPress={() => props.onRegenerate?.()}
            class="min-h-11 px-3 rounded-full bg-stage-tile border border-stage-amber-border items-center justify-center active:opacity-75 focus-visible:ring-2 focus-visible:ring-face-amber-edge"
          >
            <Text class="text-face-amber-core font-semibold text-sm">
              {props.review?.status === "ready"
                ? copy(props.locale, ["重新点评", "Regenerate"])
                : copy(props.locale, ["生成点评", "Generate"])}
            </Text>
          </Button>
        </If>
      </View>
      <If when={loading()} else={
        <Text class="text-stage-fg text-sm">
          {props.review?.text ?? props.review?.error ?? copy(props.locale, ["暂无点评", "No review yet"])}
        </Text>
      }>
        <LoadingIndicator stage inline label={copy(props.locale, ["正在生成点评", "Generating review"])} />
      </If>
    </View>
  );
}

export function WerewolfReplayView(props: {
  locale: HistoryLocale;
  match: WerewolfMatchRecord;
  review?: WerewolfAiMvpReview;
  onRegenerate?: () => void;
  pluginDisabled?: boolean;
}) {
  const activeRound = signal(OVERVIEW);
  const expanded = signal<ReadonlySet<string>>(new Set());
  const replay = () => props.match.replay;
  const seats = () => replay()?.seats ?? [];
  const rounds = () => {
    if (!replay()) return [OVERVIEW];
    const found = new Map<string, ReplayRound>();
    for (const event of replay()?.events ?? []) {
      const round = eventRound(event);
      if (round.kind !== "deal") found.set(round.key, round);
    }
    return [OVERVIEW, DEAL, ...Array.from(found.values()).sort(
      (a, b) => a.day - b.day || Number(a.kind === "day") - Number(b.kind === "day"),
    )];
  };
  const events = () => (replay()?.events ?? []).filter((event) => eventRound(event).key === activeRound().key);
  const highlights = () => (replay()?.events ?? [])
    .flatMap((event) => (
      (event.type === "event" || event.type === "dawn") && event.visibility === "public" && event.highlight
        ? [{ event, highlight: { kind: event.highlight, day: event.day } }]
        : []
    )).slice(-3);
  const dawnEvents = () => events().filter((event): event is TextReplayEvent => event.type === "dawn");
  const nightActions = () => events().filter(
    (event): event is TextReplayEvent => event.type === "event" && event.visibility === "postgame",
  );
  const toggle = (key: string) => {
    const next = new Set(expanded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded.set(next);
  };
  const t = (label: Copy) => copy(props.locale, label);
  const isGoodWinner = () => props.match.winner === "good";

  return (
    <View testID="werewolf-replay-view" class="flex-1 min-h-0 flex-row gap-3 px-4 py-3">
      <Scroll class="w-40 shrink-0 min-h-0 rounded-2xl border border-stage-pill-border bg-stage-panel" contentClass="gap-1.5 p-2">
        <Each of={rounds()} key={(round) => round.key}>
          {(round) => (
            <Button
              testID={`werewolf-replay-round-${round().key}`}
              selected={activeRound().key === round().key}
              onPress={() => activeRound.set(round())}
              class={`min-h-11 px-3 rounded-xl flex-row items-center gap-2 border active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge ${activeRound().key === round().key
                ? "bg-stage-amber-bg border-stage-amber-border"
                : "bg-stage-tile border-stage-pill-border hover:bg-stage-pill-bg"}`}
            >
              <ActionIcon name={round().kind === "night" ? "moon" : round().kind === "day" ? "sun" : "shield"} tone="stageFg" size={17} />
              <Text class={activeRound().key === round().key ? "text-face-amber-core text-sm font-bold" : "text-stage-fg text-sm font-medium"}>
                {formatRound(props.locale, round())}
              </Text>
            </Button>
          )}
        </Each>
      </Scroll>
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-stage-pill-border bg-stage-panel">
        <Each of={[activeRound()]} key={(round) => round.key}>
          {(round) => {
            const motion = createMotion(reduceMotion() ? {} : { enter: "fadeIn", duration: 150 });
            return (
              <Scroll testID="werewolf-replay-content" class="flex-1 min-h-0" contentClass="p-4 gap-3" style={{ opacity: motion.opacity }}>
                <If when={round().kind === "overview"}>
                  <View class="gap-1 shrink-0">
                    <Text role="header" class={isGoodWinner() ? "text-face-sage-core text-2xl font-bold" : "text-face-rose-core text-2xl font-bold"}>
                      {isGoodWinner() ? t(["好人阵营获胜", "Good wins"]) : t(["狼人阵营获胜", "Werewolves win"])}
                    </Text>
                    <Text class="text-stage-pill-muted text-sm">
                      {formatBoardLabel(props.match, props.locale)} · {formatRound(props.locale, { key: "", kind: "day", day: props.match.day })}
                    </Text>
                    <If when={replay()?.winReason}><Text class="text-stage-fg text-base">{replay()?.winReason}</Text></If>
                  </View>
                  <If when={!replay()}>
                    <Text class="text-stage-pill-muted text-base">
                      {props.pluginDisabled
                        ? t(["启用狼人杀插件后可读取完整复盘", "Enable the Werewolf plugin to read full replays"])
                        : t(["该局仅保存了摘要", "Only the match summary was saved"])}
                    </Text>
                    <If when={props.match.highlight}>
                      {(highlight) => <Text class="text-stage-fg text-base">{formatHighlightLabel(highlight(), props.locale)}</Text>}
                    </If>
                  </If>
                  <If when={replay()?.partialTimeline}>
                    <Text class="text-stage-pill-muted text-sm">
                      {t(["轮次记录从恢复主持时开始", "The timeline starts when hosting resumed"])}
                    </Text>
                  </If>
                  <If when={highlights().length > 0}>
                    <Text role="header" class="text-stage-fg text-lg font-bold">{t(["名场面", "Highlights"])}</Text>
                    <View class="flex-row flex-wrap gap-2">
                      <Each of={highlights()} key={({ event }) => event.sequence}>
                        {(item) => (
                          <Button
                            testID={`werewolf-replay-highlight-${item().highlight.kind}-${item().event.sequence}`}
                            onPress={() => activeRound.set(eventRound(item().event))}
                            class="min-h-11 px-3 py-2 rounded-xl flex-row gap-2 items-center border border-stage-pill-border bg-stage-tile hover:bg-stage-pill-bg active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
                          >
                            <Text class="text-stage-fg text-sm font-semibold">
                              {formatHighlightLabel(item().highlight, props.locale)}
                            </Text>
                            <WerewolfStageIcon name="chevron_right" tone="stageMuted" size={16} />
                          </Button>
                        )}
                      </Each>
                    </View>
                  </If>
                  <If when={Boolean(replay())}>
                    <ReviewPanel locale={props.locale} review={props.review ?? replay()?.review} onRegenerate={props.onRegenerate} />
                  </If>
                </If>

                <If when={round().kind === "deal"}>
                  <Text role="header" class="text-stage-fg text-xl font-bold">{t(["本局座位与身份", "Seats and roles"])}</Text>
                  <View class="grid grid-cols-2 gap-2">
                    <Each of={seats()} key={(seat) => seat.seat}>
                      {(seat) => (
                        <View class="rounded-xl border border-stage-pill-border bg-stage-tile p-3 flex-row gap-2 items-center">
                          <WerewolfRoleIcon size={22} role={seat().role} tone={isWolfRole(seat().role) ? "rose" : "sage"} />
                          <View class="flex-1 min-w-0 gap-0.5">
                            <Text class="text-stage-fg text-sm font-bold">{formatSeat(seat().seat, seats(), props.locale)}</Text>
                            <Text class="text-stage-pill-muted text-sm">
                              {WEREWOLF_ROLE_LABELS[seat().role][props.locale]} · {seat().alive
                                ? t(["存活至终局", "Survived"])
                                : t([`第 ${seat().deathDay} 天出局`, `Out on day ${seat().deathDay}`])}
                              {seat().isSheriff ? t([" · 警长", " · Sheriff"]) : ""}
                            </Text>
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>

                <If when={round().kind === "night"}>
                  <Text role="header" class="text-stage-fg text-xl font-bold">{formatRound(props.locale, round())}</Text>
                  <Each of={dawnEvents()} key={(event) => event.sequence}>
                    {(event) => <EventCard event={event()} seats={seats()} locale={props.locale} />}
                  </Each>
                  <If when={nightActions().length > 0}>
                    <Button
                      testID={`werewolf-replay-open-${round().key}`}
                      selected={expanded().has(round().key)}
                      onPress={() => toggle(round().key)}
                      class="min-h-11 self-start px-4 rounded-xl border border-stage-amber-border bg-stage-amber-bg hover:bg-stage-pill-bg items-center justify-center active:opacity-75 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-face-amber-edge"
                    >
                      <Text class="text-face-amber-core text-sm font-bold">{expanded().has(round().key) ? t(["收起这一夜", "Hide night actions"]) : t(["翻开这一夜", "Reveal this night"])}</Text>
                    </Button>
                    <If when={expanded().has(round().key)}>
                      <ReplayReveal testID={`werewolf-replay-actions-${round().key}`}>
                        <View class="gap-2">
                          <Each of={nightActions()} key={(event) => event.sequence}>
                            {(event) => <EventCard event={event()} seats={seats()} locale={props.locale} />}
                          </Each>
                        </View>
                      </ReplayReveal>
                    </If>
                  </If>
                </If>

                <If when={round().kind === "day"}>
                  <Text role="header" class="text-stage-fg text-xl font-bold">{formatRound(props.locale, round())}</Text>
                  <Each of={events()} key={(event) => event.sequence}>
                    {(event) => {
                      const item = event();
                      if (item.type === "ballot") {
                        const key = `ballot-${item.sequence}`;
                        return <BallotCard event={item} seats={seats()} locale={props.locale} open={expanded().has(key)} onToggle={() => toggle(key)} />;
                      }
                      if (item.type === "speaking_order") {
                        return (
                          <View class="rounded-2xl border border-stage-pill-border bg-stage-tile px-4 py-3 gap-1">
                            <Text class="text-stage-fg text-sm font-bold">{t(SPEECH_LABELS[item.kind])}</Text>
                            <Text class="text-stage-pill-muted text-sm">{item.seats.map((seat) => formatSeat(seat, seats(), props.locale)).join(" → ")}</Text>
                          </View>
                        );
                      }
                      return <EventCard event={item} seats={seats()} locale={props.locale} />;
                    }}
                  </Each>
                </If>
              </Scroll>
            );
          }}
        </Each>
      </View>
    </View>
  );
}
