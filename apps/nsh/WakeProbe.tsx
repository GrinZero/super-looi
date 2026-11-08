import { cleanup, effect, mount, signal, Text, View } from "nsh";
import { VoiceAudio } from "super-looi/native";

function WakeProbe() {
  const result = signal("Loading local wake model");
  const audio = new VoiceAudio();
  cleanup(() => audio.stop());
  effect(() => {
    void (async () => {
      try {
        let permission = audio.status().permission;
        if (permission !== "granted") permission = audio.requestPermission();
        const until = Date.now() + 12000;
        while (permission === "undetermined" && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          permission = audio.status().permission;
        }
        if (permission !== "granted") throw new Error("Microphone permission unavailable");
        audio.setCaptureMode("kws");
        const standby = audio.status();
        if (standby.state !== "running" || standby.captureMode !== "kws" || !standby.kwsReady)
          throw new Error("KWS model did not load: " + standby.error);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (audio.drainCapture().length) throw new Error("Standby copied PCM to JavaScript");
        audio.setCaptureMode("conversation");
        audio.playReadyCue();
        const live = audio.status();
        if (live.state !== "running" || live.captureMode !== "conversation" || live.muted || live.queuedPlaybackMs > 0)
          throw new Error("Conversation capture did not reuse audio");
        audio.setCaptureMode("kws");
        if (!audio.status().kwsReady) throw new Error("KWS worker was lost after conversation");
        audio.stop();
        result.set("Native wake pipeline verified");
      } catch (error) {
        audio.stop();
        result.set("Native wake pipeline failed: " + String(error));
      }
    })();
  });
  return <View class="flex-1 items-center justify-center"><Text>{result()}</Text></View>;
}
mount(WakeProbe);
