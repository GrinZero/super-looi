import { mount, signal, Text, View } from "nsh";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import type { HomeConfiguration } from "./generated/looi-runtime.js";
import type { createAppStore } from "./store";

/** Test-only UI fixture. No credentials, network or native login are constructed. */
function HomePanelProbe() {
  const configuration = signal<HomeConfiguration>({
    mode: "disabled", region: "cn", haUrl: "", hasToken: false, hasMiotAccount: true,
  });
  const evidence = signal("No account action");
  const store = {
    ready: () => true,
    busy: () => false,
    homeConfiguration: () => configuration(), homeConnection: () => undefined,
    homeDevices: () => ({}), homeLoggingIn: () => false, cancelHomeLogin() {},
    async configureHome(value: Partial<HomeConfiguration>) { configuration.set({ ...configuration(), ...value }); },
    async connectHome() { evidence.set(`Read devices: ${configuration().mode}/${configuration().region}`); },
    async logoutMiot() {
      evidence.set(`Logged out: ${configuration().region}`);
      configuration.set({ ...configuration(), hasMiotAccount: false });
    },
  } as unknown as ReturnType<typeof createAppStore>;
  return <View class="flex-1"><Text>{evidence()}</Text><HomeSpaceView store={store} modeTab="direct_miot" /></View>;
}
mount(HomePanelProbe);
