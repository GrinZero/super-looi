import { locale, mount, signal, View } from "nsh";
import { bindLocale, resolveLocale } from "./i18n";
import { ActionButton } from "./ui/Controls";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import type { HomeDashboardModel } from "./generated/looi-runtime.js";
import type { createAppStore } from "./store";

function HomeLoadingProbe() {
  bindLocale(() => resolveLocale("system", locale()));
  const loading = signal(true);
  const empty: HomeDashboardModel = {
    homeName: "我的家", totalAppliances: 0, activeAppliances: 0,
    rooms: [], allAppliances: [],
  };
  const dashboard = signal(empty);
  const store = {
    homeConfiguration: () => ({ mode: "external_ha", region: "cn", haUrl: "", hasToken: true, hasMiotAccount: false }),
    homeDashboard: () => dashboard(),
    homeSubView: () => "devices",
    homeOverviewCollapsed: () => false,
    homeLoading: () => loading(),
    homeConnection: () => undefined,
  } as unknown as ReturnType<typeof createAppStore>;
  return (
    <View class="flex-1">
      <View class="flex-row">
        <ActionButton label="Finish loading" onPress={() => {
          dashboard.set({ ...empty, rooms: [{
            id: "living-room", name: "测试客厅", totalCount: 0, activeCount: 0,
            navSummary: "", environment: [], appliances: [],
            roomPowerEntities: { turnOnIds: [], turnOffIds: [] },
          }] });
          loading.set(false);
        }} />
        <ActionButton label="Refresh devices" onPress={() => loading.set(true)} />
        <ActionButton label="Finish empty" onPress={() => { dashboard.set(empty); loading.set(false); }} />
      </View>
      <HomeSpaceView store={store} />
    </View>
  );
}
mount(HomeLoadingProbe);
