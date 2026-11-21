import { effect, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import type {
  PluginViewContext,
  StageDrawerDetent,
} from "../../../ui/plugins/ui-contracts";
import type { WerewolfCommand, WerewolfPublicState } from "../contracts";
import { readWerewolfState } from "./StageCapsule";
import { WerewolfNightActionBody } from "./StageCanvas";

export function WerewolfStageDrawer(props: {
  ctx: PluginViewContext<WerewolfPublicState, WerewolfCommand>;
  detent: () => StageDrawerDetent;
  requestDetent?: (detent: Exclude<StageDrawerDetent, "closed">) => void;
}) {
  const lanOverride = signal(false);
  let lastPhaseKey = "";

  const st = () => readWerewolfState(props.ctx);
  const loc = () => props.ctx.locale();

  effect(() => {
    const key = `${st().day}:${st().phase}`;
    if (key !== lastPhaseKey) {
      const hadPrev = lastPhaseKey !== "";
      lastPhaseKey = key;
      const wasOverridden = lanOverride();
      lanOverride.set(false);
      if (hadPrev && isLanNightTurn() && (wasOverridden || props.detent() !== "peek")) {
        props.requestDetent?.("peek");
      }
    }
  });

  const isLanNightTurn = () => {
    const p = st().phase;
    const isNightTurn =
      p === "night_guard" ||
      p === "night_wolf" ||
      p === "night_witch" ||
      p === "night_seer";
    return isNightTurn && st().rules.surfaceMode === "lan_companion";
  };

  const showLanDesensitizedBar = () =>
    isLanNightTurn() && !lanOverride() && props.detent() !== "large";

  return (
    <View testID="werewolf-stage-drawer" class="flex-1 min-h-0 gap-1.5">
      <If when={isLanNightTurn()}>
        <If
          when={!showLanDesensitizedBar()}
          else={
            <View
              testID="werewolf-night-lan-peek"
              class="flex-1 flex-row items-center justify-between gap-3"
            >
              <View class="flex-1 min-w-0 gap-0.5">
                <Text class="text-stage-fg text-xs font-semibold">
                  {loc() === "en-US"
                    ? "Night Action via Companion Phones"
                    : "手机副屏夜间行动中 · 请全场保持闭眼"}
                </Text>
                <Text
                  class="text-stage-pill-muted text-xs"
                  style={{ numberOfLines: 1 }}
                >
                  {st().lastJudgeSpeech}
                </Text>
              </View>
              <Button
                testID="werewolf-lan-host-override-btn"
                hitSlop={4}
                onPress={() => {
                  lanOverride.set(true);
                  props.requestDetent?.("large");
                }}
                class="h-9 px-3.5 rounded-full border border-stage-pill-border bg-stage-tile items-center justify-center active:opacity-75 focus-visible:border-stage-pill-fg shrink-0"
              >
                <Text class="text-stage-pill-fg text-xs font-medium">
                  {loc() === "en-US" ? "Host Panel" : "主机代操作"}
                </Text>
              </Button>
            </View>
          }
        >
          <WerewolfNightActionBody
            ctx={props.ctx}
            onCollapseLanOverride={() => {
              lanOverride.set(false);
              props.requestDetent?.("peek");
            }}
          />
        </If>
      </If>
    </View>
  );
}
