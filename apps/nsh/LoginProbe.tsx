import { cleanup, effect, mount, signal, Text, View } from "nsh";
import { MiotLoginBrowser } from "super-looi/native";

/** Isolated simulator smoke: no vault, account consent, microphone or agent. */
function LoginProbe() {
  const state = signal("Testing native login window");
  const browser = new MiotLoginBrowser();
  let alive = true;
  cleanup(() => { alive = false; browser.cancel(); });
  effect(() => {
    void (async () => {
      const redirect = "http://homeassistant.local:8123/api/webhook/software-probe";
      const authorization = "https://account.xiaomi.com/oauth2/authorize?" +
        "response_type=code&state=" + "a".repeat(40) + "&redirect_uri=" + encodeURIComponent(redirect);
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (!alive) return;
      try {
        let rejected = false;
        try { browser.open("https://invalid.example", redirect); } catch { rejected = true; }
        if (!rejected || browser.status() !== "idle") throw new Error("Invalid initial URL accepted");
        browser.open(authorization, redirect);
        const limit = Date.now() + 10000;
        while (alive && !browser.isPresented() && browser.status() === "loading" && Date.now() < limit)
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (!alive) return;
        if (!browser.isPresented()) throw new Error("Native login window not presented: " + browser.status());
        const other = new MiotLoginBrowser();
        rejected = false;
        try { other.open(authorization, redirect); } catch { rejected = true; }
        other.cancel();
        if (!rejected) throw new Error("Concurrent native login accepted");
        if (browser.takeCallback()) throw new Error("Callback invented without authorization");
        await new Promise((resolve) => setTimeout(resolve, 500));
        browser.cancel();
        if (browser.status() !== "idle" || browser.takeCallback()) throw new Error("Cancelled login retained a callback");
        state.set("Native login window verified");
        console.log("PASS native login window: invalid URL rejection, real presentation, single owner, cancel; no account authorization");
      } catch (error) {
        browser.cancel();
        state.set("Native login window failed: " + String(error));
      }
    })();
  });
  return <View class="flex-1 items-center justify-center"><Text>{state()}</Text></View>;
}
mount(LoginProbe);
