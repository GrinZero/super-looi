import { computed, createMotion, effect, signal, View, type JSX } from "nsh";

/** Builds a page on its first visit, then keeps its drafts and scroll position. */
export function RetainedPage(props: { active: boolean; children?: JSX.Element }) {
  const active = computed(() => props.active);
  const visited = signal(active());
  const motion = createMotion();

  effect(() => {
    if (!active()) {
      motion.reset();
      return;
    }
    visited.set(true);
    void motion.play({
      keyframes: { opacity: [0.92, 1], translateY: [8, 0] },
      duration: 160,
      easing: "easeOut",
    });
  });

  return (
    <If when={visited()}>
      <View
        class="flex-1 min-h-0 min-w-0"
        style={{
          display: active() ? "flex" : "none",
          opacity: motion.opacity,
          translate: [0, motion.translateY],
        }}
      >
        {props.children}
      </View>
    </If>
  );
}
