import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { HomeSpaceView } from "./ui/HomeSpaceView";
import { VideoAccount, type XiaomiVideoLoginState, type XiaomiVideoAuthState } from "./runtime/video-account";
import type { NativeCamera } from "./runtime/camera";
import type { createAppStore, HomeSubView } from "./store";

/** The production controller drives this screen; only the native network boundary is a fixture. */
function HomeVideoLoginProbe() {
  const subView = signal<HomeSubView>("services");
  const login = signal<XiaomiVideoLoginState>({step:"credentials",attempt:0,account:"",region:"cn",error:null,busy:false,canResume:false,captchaImage:"",destination:"",smsCountdown:0});
  const auth = signal<XiaomiVideoAuthState>({authorized:false,account:"",cameraCount:0});
  const request = signal("");
  let complete: ((reply: string) => void) | undefined;
  let submissions = 0;
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const pending = (name: string) => { request.set(name); return new Promise<string>(resolve => { complete = resolve; }); };
  const native = {
    cancelLogin() {},
    login: (account: string, password: string, region: string) => pending(`${account}:${password.length}:${region}`),
    submit: (answer: string) => pending(`answer:${answer}`),
    refreshCaptcha: () => pending("refresh-captcha"),
    resendTicket: () => pending("resend-ticket"),
    resumeLogin: () => pending("resume-login"),
    logout: async () => {},
  } as NativeCamera;
  const account = new VideoAccount({
    native: () => native,
    onChange: () => { login.set({...account.login}); auth.set({...account.auth}); },
    onAuthorized: () => subView.set("services"),
  });
  const store = {
    ready: () => true, busy: () => false,
    homeConfiguration: () => ({mode:"direct_miot",region:"cn",haUrl:"",hasToken:false,hasMiotAccount:true,enabledSources:{direct_miot:true,external_ha:false,simulation:false}}),
    homeConnection: () => ({healthy:true,connectionId:"test-c1"}),
    homeDevices: () => ({}),
    homeDashboard: () => ({homeName:"我的家",totalAppliances:6,activeAppliances:2,rooms:[],allAppliances:[]}),
    homeLoggingIn: () => false, cancelHomeLogin() {}, homeLoading: () => false,
    homeSubView: () => subView(), setHomeSubView: (value: HomeSubView) => subView.set(value),
    xiaomiVideoAuth: () => auth(), xiaomiVideoLogin: () => login(),
    startXiaomiVideoLogin: () => { account.start("cn"); subView.set("video_login"); },
    cancelXiaomiVideoLogin: () => { account.cancel(); subView.set("services"); },
    submitVideoCredentials: (params: {account:string;password?:string;region?:string}) => account.credentials(params),
    submitVideoCaptcha: (answer: string) => account.answer(answer),
    submitVideoTwoFactor: (answer: string) => account.answer(answer),
    refreshVideoCaptcha: () => account.refreshCaptcha(), sendVideoSms: () => account.resend(),
    resumeVideoLogin: () => account.resume(), disconnectXiaomiVideo: () => account.disconnect(),
    setHomeSourceEnabled: async () => {}, configureHome: async () => {}, connectHome: async () => {}, logoutMiot: async () => {},
  } as unknown as ReturnType<typeof createAppStore>;
  return <View class="flex-1 bg-background">
    <Text>{request()}</Text>
    <Button testID="complete-video-request" onPress={() => {
      submissions++;
      const reply = submissions === 1 ? {state:"signed_out",error:"camera_login_network"}
        : submissions === 2 ? {state:"captcha",image}
        : submissions === 3 ? {state:"captcha",image}
        : submissions === 4 ? {state:"verification",destination:"a***@example.com",sentAt:Date.now()}
        : submissions === 5 ? {state:"verification",destination:"a***@example.com",error:"camera_verification_rejected"}
        : {state:"ready",devices:[{did:"one"},{did:"two"}]};
      complete?.(JSON.stringify(reply)); complete = undefined;
    }}><Text>Complete native request</Text></Button>
    <HomeSpaceView store={store} modeTab="direct_miot" />
  </View>;
}
mount(HomeVideoLoginProbe);
