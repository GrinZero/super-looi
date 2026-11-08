import { mount, signal, Text, View } from "nsh";
import { HomePanel } from "./ui/HomePanel";
import type { HomeConfiguration } from "./generated/looi-runtime.js";
import type { createAppStore } from "./store";

/** Test-only UI fixture. No credentials, network or native login are constructed. */
function HomePanelProbe() {
  const configuration = signal<HomeConfiguration>({
    mode: "disabled", region: "cn", haUrl: "", hasToken: false, hasMiotAccount: true,
  });
  const evidence = signal("No account action");
  const store = {
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
  return <View><Text>{evidence()}</Text><HomePanel open={true} store={store} onClose={() => {}} /></View>;
}
mount(HomePanelProbe);
