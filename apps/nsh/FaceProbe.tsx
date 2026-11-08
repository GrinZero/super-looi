import {
  cleanup,
  computed,
  effect,
  lifecycle,
  mount,
  Scroll,
  signal,
  Text,
  View,
} from "nsh";
import { Button } from "nsh/base";
import {
  FACE_EXPRESSION_IDS,
  FACE_EXPRESSION_RECIPES,
  type FaceExpression,
} from "./ui/face-recipes";
import { hasAmbientMotion, RobotFace } from "./ui/RobotFace";

const GROUPS = [
  { label: "1 核心语音", start: 0 },
  { label: "2 开心亲昵", start: 12 },
  { label: "3 小脾气", start: 24 },
  { label: "4 日常陪伴", start: 36 },
  { label: "5 Agent", start: 48 },
  { label: "6 底座环境", start: 60 },
] as const;

const FACE_LABELS_ZH: Record<FaceExpression, string> = {
  neutral: "平静陪伴",
  listening: "专注倾听",
  thinking: "深度思考",
  speaking: "自然播报",
  curious: "歪头好奇",
  sleeping: "静息浅眠",
  alarmed: "紧急警觉",
  wake_spark: "唤醒亮眸",
  aha_eureka: "灵光一闪",
  confused: "满脸疑惑",
  interrupted: "急刹住嘴",
  wave_bye: "微笑挥别",
  happy_squint: "弯月开心",
  laughing: "开怀大笑",
  wink: "俏皮眨眼",
  love_eyes: "心心眼",
  shy_blush: "害羞脸红",
  starry_eyed: "崇拜星星眼",
  smug_proud: "小得意",
  kitty_playful: "猫咪卖萌",
  touched_warm: "感动暖心",
  kissy: "飞吻啾咪",
  excited_bounce: "雀跃期待",
  zen_content: "惬意微醺",
  pouty: "委屈巴巴",
  sad_droop: "失落下垂",
  teary_cry: "眼角含泪",
  grumpy_puff: "鼓腮哼气",
  angry_glare: "奶凶瞪眼",
  speechless: "无语凝噎",
  side_eye: "暗中斜视",
  shocked: "瞳孔地震",
  dizzy_spiral: "晕头转向",
  nervous_sweat: "心虚冒汗",
  mischievous: "坏笑搞怪",
  relieved_sigh: "长舒一口气",
  sleepy_drowsy: "困倦打盹",
  yawning: "张嘴哈欠",
  deep_snore: "呼呼酣睡",
  coffee_sip: "早安咖啡",
  munching: "咔嚓吃零食",
  sipping_straw: "吨吨喝奶茶",
  music_vibe: "听歌律动",
  focus_glasses: "学霸眼镜",
  reading_scan: "速读扫视",
  pomodoro_timer: "番茄专注",
  celebrate_party: "撒花庆祝",
  bored_sigh: "百无聊赖",
  coding_terminal: "极客编码",
  searching_radar: "全网检索",
  approval_ask: "乖巧请示",
  task_verified: "搞定收工",
  task_warning: "小故障提醒",
  memory_recall: "翻找记忆",
  memory_saved: "记在心里",
  sync_pulse: "云端同步",
  privacy_shield: "隐私勿扰",
  rate_limited: "排队等待",
  offline_lost: "断网迷茫",
  night_watch: "夜间守夜",
  dock_snap: "咔哒吸合",
  undock_float: "悬空拿起",
  drive_forward: "全速前进",
  turn_peek: "转头探看",
  head_up_sky: "仰望天空",
  head_down_floor: "低头看桌面",
  charging_pulse: "元气充电",
  low_battery: "电量告急",
  fill_light_glow: "补光暖照",
  home_command: "控灯施法",
  weather_sunny: "晴朗暖阳",
  weather_rain_chill: "听雨发呆",
};

const GAZE_PRESETS = [
  { label: "视线:正", x: 0, y: 0 },
  { label: "视线:右上", x: 0.72, y: 0.45 },
  { label: "视线:左上", x: -0.72, y: 0.45 },
  { label: "视线:看下", x: 0, y: -0.65 },
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function FaceProbe() {
  const index = signal(0);
  const blink = signal(0);
  const gazeIdx = signal(0);
  const autoPlay = signal(false);
  const hudOpen = signal(true);

  const blinkTimers: Array<ReturnType<typeof setTimeout>> = [];
  const clearBlink = () => {
    while (blinkTimers.length > 0) {
      const id = blinkTimers.pop();
      if (id !== undefined) clearTimeout(id);
    }
  };
  cleanup(clearBlink);

  effect(() => {
    if (!autoPlay() || lifecycle() !== "active") return;
    const id = setInterval(() => {
      index.set((index() + 1) % FACE_EXPRESSION_IDS.length);
    }, 1800);
    return () => clearInterval(id);
  });

  const playBlink = () => {
    clearBlink();
    blink.set(1);
    blinkTimers.push(
      setTimeout(() => {
        blink.set(0);
      }, 105),
    );
  };

  const current = () => FACE_EXPRESSION_IDS[index()] ?? "neutral";
  const currentGroup = computed(() => Math.floor(index() / 12));
  const currentGaze = () => GAZE_PRESETS[gazeIdx()] ?? GAZE_PRESETS[0];
  const groupItems = computed(() => {
    const start = currentGroup() * 12;
    return FACE_EXPRESSION_IDS.slice(start, start + 12).map((id, offset) => ({
      id,
      idx: start + offset,
    }));
  });

  return (
    <View
      class="flex-1 bg-stage-bg justify-between"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <RobotFace
        state={{
          expression: current(),
          gaze: { x: currentGaze().x, y: currentGaze().y },
          blinkProgress: blink(),
        }}
        shift={{ dx: 0, dy: 0 }}
      />

      <If
        when={hudOpen()}
        else={
          <View class="flex-1 items-end justify-start p-3">
            <Button
              testID="face-hud-show"
              onPress={() => hudOpen.set(true)}
              class="h-8 px-3 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
            >
              <Text class="text-stage-muted text-xs">
                {`#${pad2(index() + 1)} ${FACE_LABELS_ZH[current()]} · 展开控制`}
              </Text>
            </Button>
          </View>
        }
      >
        <View class="flex-1 justify-between px-3.5 py-2.5">
          {/* Top Bar */}
          <View class="flex-row flex-wrap items-center justify-between gap-1.5">
            <View class="rounded-full border border-stage-pill-border bg-stage-pill-bg px-3 py-1 flex-row items-center gap-2">
              <Text class="text-stage-pill-fg text-xs font-semibold">
                {`#${pad2(index() + 1)} ${FACE_LABELS_ZH[current()]}${hasAmbientMotion(current()) ? " · 动态" : ""}`}
              </Text>
              <Text class="text-stage-muted text-xs">
                {`Expression ${index() + 1}/${Object.keys(FACE_EXPRESSION_RECIPES).length}: ${current()}`}
              </Text>
            </View>

            <View class="flex-row flex-wrap items-center gap-1.5">
              <Button
                testID="face-prev"
                onPress={() =>
                  index.set(
                    (index() - 1 + FACE_EXPRESSION_IDS.length) %
                      FACE_EXPRESSION_IDS.length,
                  )
                }
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs">上一项</Text>
              </Button>
              <Button
                testID="face-next"
                onPress={() =>
                  index.set((index() + 1) % FACE_EXPRESSION_IDS.length)
                }
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs">下一项</Text>
              </Button>
              <Button
                testID="face-autoplay"
                selected={autoPlay()}
                onPress={() => autoPlay.set(!autoPlay())}
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs">
                  {autoPlay() ? "停止轮播" : "自动轮播"}
                </Text>
              </Button>
              <Button
                testID="face-blink"
                onPress={playBlink}
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs">眨眼</Text>
              </Button>
              <Button
                testID="face-gaze"
                onPress={() =>
                  gazeIdx.set((gazeIdx() + 1) % GAZE_PRESETS.length)
                }
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-pill-fg text-xs">
                  {currentGaze().label}
                </Text>
              </Button>
              <Button
                testID="face-hud-hide"
                onPress={() => hudOpen.set(false)}
                class="h-8 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center active:opacity-75"
              >
                <Text class="text-stage-muted text-xs">纯享</Text>
              </Button>
            </View>
          </View>

          {/* Bottom Group & 12-Expression Selector Dock */}
          <View class="gap-1.5">
            <View class="flex-row items-center gap-1.5">
              {GROUPS.map((g, gIdx) => (
                <Button
                  testID={`face-group-${gIdx + 1}`}
                  selected={currentGroup() === gIdx}
                  onPress={() => index.set(g.start)}
                  class={
                    currentGroup() === gIdx
                      ? "h-7 px-2.5 rounded-full border border-stage-pill-fg bg-stage-pill-bg items-center justify-center"
                      : "h-7 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center opacity-75"
                  }
                >
                  <Text
                    class={
                      currentGroup() === gIdx
                        ? "text-stage-pill-fg text-xs font-semibold"
                        : "text-stage-muted text-xs"
                    }
                  >
                    {g.label}
                  </Text>
                </Button>
              ))}
            </View>

            <Scroll
              horizontal={true}
              scrollbar={false}
              class="h-8"
              contentClass="flex-row items-center gap-1.5 h-8 pr-3"
            >
              <Each of={groupItems()} key={(item) => item.id}>
                {(item) => {
                  const selected = () => index() === item().idx;
                  return (
                    <Button
                      testID={`face-pick-${item().id}`}
                      selected={selected()}
                      onPress={() => index.set(item().idx)}
                      class={
                        selected()
                          ? "h-7 px-2.5 rounded-full border border-stage-pill-fg bg-stage-pill-bg items-center justify-center"
                          : "h-7 px-2.5 rounded-full border border-stage-pill-border bg-stage-pill-bg items-center justify-center opacity-80"
                      }
                    >
                      <Text
                        class={
                          selected()
                            ? "text-stage-pill-fg text-xs font-semibold"
                            : "text-stage-muted text-xs"
                        }
                      >
                        {`${pad2(item().idx + 1)} ${FACE_LABELS_ZH[item().id]}`}
                      </Text>
                    </Button>
                  );
                }}
              </Each>
            </Scroll>
          </View>
        </View>
      </If>
    </View>
  );
}

mount(FaceProbe);
