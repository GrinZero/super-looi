import { t } from "../i18n";
import { effect, Image, signal, Text, View, Scroll } from "nsh";
import { Button, Input } from "nsh/base";
import type { createAppStore } from "../store";
import { ActionIcon } from "./HomeIcons";
import { MijiaBrandIcon } from "./brand-icons";
import { LoadingIndicator, SelectField } from "./Controls";

const REGION_OPTIONS: Array<{ value: string; title: string }> = [
  { value: "cn", title: "中国大陆" },
  { value: "us", title: "United States" },
  { value: "de", title: "Europe (Germany)" },
  { value: "sg", title: "Singapore" },
  { value: "ru", title: "Russia" },
  { value: "i2", title: "India" },
];

export function XiaomiVideoLoginFlow(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const loginState = () => props.store.xiaomiVideoLogin();
  const step = () => loginState().step;

  const accountInput = signal(loginState().account || "");
  const passwordInput = signal("");
  const showPassword = signal(false);
  const regionValue = signal(loginState().region || "cn");

  const captchaInput = signal("");
  const twoFactorInput = signal("");

  const maskedAccount = () => {
    const raw = accountInput().trim() || loginState().account;
    if (!raw) return "";
    if (raw.includes("*")) return raw;
    if (raw.length >= 7) {
      return raw.slice(0, 3) + "****" + raw.slice(-4);
    }
    return raw;
  };

  let lastAttempt = -1;
  effect(() => {
    if (loginState().attempt === lastAttempt) return;
    lastAttempt = loginState().attempt;
    accountInput.set(loginState().account);
    regionValue.set(loginState().region);
    passwordInput.set("");
    captchaInput.set("");
    twoFactorInput.set("");
  });

  effect(() => {
    if (props.store.xiaomiVideoAuth().authorized) {
      passwordInput.set("");
      captchaInput.set("");
      twoFactorInput.set("");
    }
  });
  effect(() => {
    if (loginState().captchaImage) captchaInput.set("");
  });

  const handleCredentialsSubmit = () => {
    props.store.submitVideoCredentials({
      account: accountInput(),
      password: passwordInput(),
      region: regionValue(),
    });
  };

  const handleCaptchaSubmit = () => {
    props.store.submitVideoCaptcha(captchaInput());
  };

  const handleTwoFactorSubmit = () => {
    props.store.submitVideoTwoFactor(twoFactorInput());
  };

  return (
    <View class="flex-1 bg-background" style={{ minHeight: 0 }}>
      {/* Top Navigation Bar */}
      <View class="h-12 border-b border-border px-4 flex-row items-center justify-between bg-card">
        <Button
          testID="video-login-back"
          onPress={() => props.store.cancelXiaomiVideoLogin()}
          class="flex-row items-center gap-1.5 min-h-9 px-2 rounded-lg active:opacity-75"
        >
          <ActionIcon name="back" size={16} tone="foreground" />
          <Text class="text-foreground text-sm font-medium">{t("back")}</Text>
        </Button>

        <Text class="text-foreground text-base font-semibold">连接米家视频</Text>

        <Button
          testID="video-login-cancel"
          onPress={() => props.store.cancelXiaomiVideoLogin()}
          class="min-h-9 px-2 items-center justify-center rounded-lg active:opacity-75"
        >
          <Text class="text-muted-foreground text-sm font-medium">取消</Text>
        </Button>
      </View>

      {/* Main Flow Content (Split Layout: Left Intro / Right Form) */}
      <Scroll class="flex-1" contentClass="p-6 gap-6 items-center">
        <View class="w-full max-w-4xl flex-row items-start gap-8 flex-wrap">
          {/* Left Column: Brand & Instruction */}
          <View class="flex-1 min-w-[280px] gap-4 pt-2">
            <MijiaBrandIcon size={48} />

            <View class="gap-1.5">
              <If when={step() === "credentials"}>
                <Text class="text-foreground text-2xl font-bold">登录米家账号</Text>
                <Text class="text-muted-foreground text-sm leading-relaxed">
                  使用摄像头所属的米家账号登录用于连接摄像头实时画面。
                </Text>
              </If>
              <If when={step() === "captcha"}>
                <Text class="text-foreground text-2xl font-bold">输入图形验证码</Text>
                <Text class="text-muted-foreground text-sm leading-relaxed">
                  按图片输入验证码。
                </Text>
              </If>
              <If when={step() === "two_factor"}>
                <Text class="text-foreground text-2xl font-bold">验证你的账号</Text>
                <Text class="text-muted-foreground text-sm leading-relaxed">
                  {loginState().destination ? `验证码已发送至 ${loginState().destination}。` : "验证码已发送，请查看绑定的手机或邮箱。"}
                </Text>
              </If>
            </View>

            <If when={step() === "continuing"}>
              <Text class="text-foreground text-2xl font-bold">完成账号连接</Text>
              <Text class="text-muted-foreground text-sm">正在读取米家摄像头。</Text>
            </If>
            {/* Region selector for Step 1 */}
            <If when={step() === "credentials"}>
              <View class="flex-row items-center justify-between pt-2">
                <Text class="text-muted-foreground text-sm">地区</Text>
                <View class="w-48">
                  <SelectField
                    accessibilityLabel="地区"
                    items={REGION_OPTIONS}
                    value={regionValue()}
                    onChange={(val) => regionValue.set(val)}
                  />
                </View>
              </View>
            </If>
          </View>

          {/* Right Column: Form Card */}
          <View class="flex-1 min-w-[320px] rounded-2xl border border-border bg-card p-6 gap-4">
            {/* Step 1: Account & Password */}
            <If when={step() === "credentials"}>
              <View class="gap-1.5">
                <Text class="text-muted-foreground text-xs font-medium">米家账号</Text>
                <Input
                  testID="video-login-account-input"
                  value={accountInput()}
                  onChange={(e) => accountInput.set(e.value)}
                  placeholder="手机号 / 邮箱 / 小米 ID"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="h-11 rounded-xl border border-border bg-background px-3.5 text-foreground text-sm focus:border-ring"
                />
              </View>

              <View class="gap-1.5">
                <Text class="text-muted-foreground text-xs font-medium">密码</Text>
                <View class="relative w-full">
                  <Input
                    testID="video-login-password-input"
                    value={passwordInput()}
                    onChange={(e) => passwordInput.set(e.value)}
                    masked={!showPassword()}
                    placeholder="请输入密码"
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="h-11 w-full rounded-xl border border-border bg-background pl-3.5 pr-11 text-foreground text-sm focus:border-ring"
                  />
                  <Button
                    testID="video-login-toggle-password"
                    accessibilityLabel="显示密码"
                    onPress={() => showPassword.update((v) => !v)}
                    class="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-lg active:opacity-75"
                  >
                    <ActionIcon
                      name={showPassword() ? "eye_off" : "eye"}
                      size={16}
                      tone="muted"
                    />
                  </Button>
                </View>
              </View>

              <Button
                testID="video-login-submit-credentials"
                disabled={loginState().busy}
                onPress={() => handleCredentialsSubmit()}
                class="min-h-11 w-full rounded-xl bg-primary items-center justify-center active:opacity-80 mt-2"
              >
                <Text class="text-primary-foreground text-sm font-bold">{loginState().busy ? "正在登录…" : "登录"}</Text>
              </Button>
            </If>

            {/* Step 2: Graphic Captcha */}
            <If when={step() === "captcha"}>
              <View class="py-1">
                <Text class="text-foreground text-sm font-semibold">
                  {maskedAccount()}
                </Text>
              </View>

              <View class="gap-1.5">
                <Text class="text-muted-foreground text-xs font-medium">验证码</Text>
                <View class="flex-row items-center gap-2">
                  <Input
                    testID="video-login-captcha-input"
                    value={captchaInput()}
                    onChange={(e) => captchaInput.set(e.value)}
                    placeholder="输入图片中的字符"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    class="flex-1 h-11 rounded-xl border border-border bg-background px-3 text-foreground text-sm focus:border-ring"
                  />
                  <Image
                    testID="video-login-captcha-image"
                    src={loginState().captchaImage}
                    class="h-10 w-28 rounded-xl"
                  />
                  <Button
                    testID="video-login-refresh-captcha"
                disabled={loginState().busy}
                    accessibilityLabel="换一张验证码"
                    onPress={() => props.store.refreshVideoCaptcha()}
                    class="h-11 px-2.5 rounded-xl border border-border bg-card flex-row items-center gap-1 active:opacity-75"
                  >
                    <ActionIcon name="refresh" size={13} tone="muted" />
                    <Text class="text-muted-foreground text-xs">换一张</Text>
                  </Button>
                </View>
              </View>

              <Button
                testID="video-login-submit-captcha"
                disabled={loginState().busy}
                onPress={() => handleCaptchaSubmit()}
                class="min-h-11 w-full rounded-xl bg-primary items-center justify-center active:opacity-80 mt-2"
              >
                <Text class="text-primary-foreground text-sm font-bold">{loginState().busy ? "正在验证…" : "继续"}</Text>
              </Button>
            </If>

            {/* Step 3: Two Factor (SMS / Email) */}
            <If when={step() === "two_factor"}>
              <View class="gap-1.5">
                <Text class="text-muted-foreground text-xs font-medium">验证码</Text>
                <Input
                  testID="video-login-2fa-input"
                  value={twoFactorInput()}
                  onChange={(e) => twoFactorInput.set(e.value)}
                  placeholder="输入验证码"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class="h-11 rounded-xl border border-border bg-background px-3.5 text-foreground text-sm focus:border-ring"
                />
              </View>

              <View class="flex-row items-center justify-start pt-1">
                <If
                  when={loginState().smsCountdown > 0}
                  else={
                    <Button
                      testID="video-login-resend-sms"
                disabled={loginState().busy}
                      onPress={() => props.store.sendVideoSms()}
                      class="py-1 active:opacity-75"
                    >
                      <Text class="text-verified text-xs font-semibold">重新发送</Text>
                    </Button>
                  }
                >
                  <Text class="text-muted-foreground text-xs">
                    重新发送 ({loginState().smsCountdown} 秒)
                  </Text>
                </If>
              </View>

              <Button
                testID="video-login-submit-2fa"
                disabled={loginState().busy}
                onPress={() => handleTwoFactorSubmit()}
                class="min-h-11 w-full rounded-xl bg-primary items-center justify-center active:opacity-80 mt-2"
              >
                <Text class="text-primary-foreground text-sm font-bold">{loginState().busy ? "正在验证…" : "继续"}</Text>
              </Button>
            </If>
            <If when={loginState().busy}>
              <LoadingIndicator label="正在连接小米账号" />
            </If>
            <If when={Boolean(loginState().error)}>
              <Text testID="video-login-error" class="text-destructive text-xs font-medium">{loginState().error}</Text>
              <If when={loginState().canResume}>
              <Button
                testID="video-login-retry"
                disabled={loginState().busy}
                onPress={() => props.store.resumeVideoLogin()}
                class="min-h-10 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              >
                <Text class="text-foreground text-xs font-semibold">重试当前步骤</Text>
              </Button>
              </If>
            </If>
          </View>
        </View>
      </Scroll>
    </View>
  );
}
