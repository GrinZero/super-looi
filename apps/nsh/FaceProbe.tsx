import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { FACE_EXPRESSION_IDS, FACE_EXPRESSION_RECIPES } from "./ui/face-recipes";
import { RobotFace } from "./ui/RobotFace";

function FaceProbe() {
  const index = signal(0);
  const blink = signal(0);
  const current = () => FACE_EXPRESSION_IDS[index()] ?? "neutral";

  return (
    <View class="flex-1 bg-stage-bg justify-between p-4" style={{ minWidth: 640, minHeight: 360 }}>
      <RobotFace
        state={{
          expression: current(),
          gaze: { x: 0.15, y: -0.1 },
          blinkProgress: blink(),
        }}
        shift={{ dx: 1, dy: -1 }}
      />
      <View class="flex-row items-center gap-2">
        <Text class="text-stage-fg text-xs">{`Expression ${index() + 1}/${Object.keys(FACE_EXPRESSION_RECIPES).length}: ${current()}`}</Text>
        <Button
          testID="face-next"
          onPress={() => index.set((index() + 1) % FACE_EXPRESSION_IDS.length)}
        >
          <Text class="text-stage-fg text-xs">Next</Text>
        </Button>
        <Button
          testID="face-blink"
          onPress={() => blink.set(blink() > 0 ? 0 : 1)}
        >
          <Text class="text-stage-fg text-xs">Blink</Text>
        </Button>
      </View>
    </View>
  );
}

mount(FaceProbe);
