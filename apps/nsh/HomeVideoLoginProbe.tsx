import { mount, signal, Text, View } from "nsh";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import type { HomeConfiguration } from "./generated/looi-runtime.js";
import type { createAppStore, HomeSubView, XiaomiVideoAuthState, XiaomiVideoLoginState } from "./store";

function HomeVideoLoginProbe() {
  const configuration = signal<HomeConfiguration>({
    mode: "direct_miot",
    region: "cn",
    haUrl: "",
    hasToken: false,
    hasMiotAccount: true,
    enabledSources: {
      direct_miot: true,
      external_ha: false,
      simulation: false,
    },
  });
  const subView = signal<HomeSubView>("services");
  const videoAuth = signal<XiaomiVideoAuthState>({
    authorized: false,
    account: "",
    cameraCount: 0,
  });
  const videoLogin = signal<XiaomiVideoLoginState>({
    step: "credentials",
    account: "13800138000",
    region: "cn",
    error: null,
    busy: false,
    captchaCode: "",
    captchaHint: "A7K9",
    smsCountdown: 0,
  });

  const store = {
    ready: () => true,
    busy: () => false,
    homeConfiguration: () => configuration(),
    homeConnection: () => ({ healthy: true, connectionId: "test-c1" }),
    homeDevices: () => ({}),
    homeDashboard: () => ({
      homeName: "我的家",
      totalAppliances: 6,
      activeAppliances: 2,
      rooms: [],
      allAppliances: [],
    }),
    homeLoggingIn: () => false,
    cancelHomeLogin() {},
    homeLoading: () => false,
    homeSubView: () => subView(),
    setHomeSubView: (v: HomeSubView) => subView.set(v),
    xiaomiVideoAuth: () => videoAuth(),
    xiaomiVideoLogin: () => videoLogin(),
    startXiaomiVideoLogin: () => {
      videoLogin.set({
        step: "credentials",
        account: "13800138000",
        region: "cn",
        error: null,
        busy: false,
        captchaCode: "",
        captchaHint: "A7K9",
        smsCountdown: 0,
      });
      subView.set("video_login");
    },
    cancelXiaomiVideoLogin: () => {
      subView.set("services");
    },
    submitVideoCredentials: (params: { account: string; password?: string; region?: string }) => {
      if (!params.account.trim()) {
        videoLogin.update((s) => ({ ...s, error: "请输入米家账号" }));
        return;
      }
      videoLogin.update((s) => ({
        ...s,
        account: params.account.trim(),
        step: "captcha",
        error: null,
        captchaHint: "A7K9",
      }));
    },
    refreshVideoCaptcha: () => {
      videoLogin.update((s) => ({ ...s, captchaHint: "9X2M", error: null }));
    },
    submitVideoCaptcha: (code: string) => {
      if (code.trim().toUpperCase() !== videoLogin().captchaHint) {
        videoLogin.update((s) => ({ ...s, error: "验证码不正确，请重新输入。" }));
        return;
      }
      videoLogin.update((s) => ({ ...s, step: "two_factor", error: null, smsCountdown: 42 }));
    },
    sendVideoSms: () => {
      videoLogin.update((s) => ({ ...s, smsCountdown: 60 }));
    },
    submitVideoTwoFactor: (code: string) => {
      if (!code || code.trim().length < 4) {
        videoLogin.update((s) => ({ ...s, error: "请输入有效的验证码" }));
        return;
      }
      videoAuth.set({
        authorized: true,
        account: "138****8000",
        cameraCount: 3,
      });
      subView.set("services");
    },
    disconnectXiaomiVideo: () => {
      videoAuth.set({ authorized: false, account: "", cameraCount: 0 });
    },
    setHomeSourceEnabled: async () => {},
    configureHome: async () => {},
    connectHome: async () => {},
    logoutMiot: async () => {},
  } as unknown as ReturnType<typeof createAppStore>;

  return (
    <View class="flex-1 bg-background">
      <HomeSpaceView store={store} modeTab="direct_miot" />
    </View>
  );
}

mount(HomeVideoLoginProbe);
