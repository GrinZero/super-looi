import { expect, open, test } from "nsh/test";

test("Xiaomi video login flow traverses credentials, captcha, 2fa, and returns to services with authorized camera state", async () => {
  const app = await open("./HomeVideoLoginProbe.tsx");

  // 1. Initial services view: Mijia direct selected
  expect(app.texts()).toContain("米家直连");
  expect(app.texts()).toContain("摄像头视频");
  expect(app.texts()).toContain("视频未连接");
  expect(app.texts()).toContain("连接视频···");

  // 2. Click "连接视频···" to open the separate video login page
  await app.press("home-miot-connect-video-btn");
  expect(app.texts()).toContain("连接米家视频");
  expect(app.texts()).toContain("登录米家账号");
  expect(app.texts()).toContain("使用摄像头所属的米家账号登录用于连接摄像头实时画面。");

  // 3. Submit credentials -> moves to captcha
  await app.press("video-login-submit-credentials");
  expect(app.texts()).toContain("输入图形验证码");
  expect(app.texts()).toContain("按图片输入验证码。");
  expect(app.texts()).toContain("A7K9");

  // 4. Test captcha refresh
  await app.press("video-login-refresh-captcha");
  expect(app.texts()).toContain("9X2M");

  // 5. Submit wrong captcha
  await app.press("video-login-submit-captcha");
  expect(app.texts()).toContain("验证码不正确，请重新输入。");

  // 6. Fill correct captcha
  await app.type("video-login-captcha-input", "9X2M");
  await app.press("video-login-submit-captcha");

  // 7. Step 3: Two-factor verification
  expect(app.texts()).toContain("验证你的账号");
  expect(app.texts()).toContain("重新发送 (42 秒)");

  // 8. Submit 2FA code
  await app.type("video-login-2fa-input", "123456");
  await app.press("video-login-submit-2fa");

  // 9. Returns to services view with authorized camera state!
  expect(app.texts()).toContain("视频已授权");
  expect(app.texts()).toContain("已关联 3 台摄像头。");
  expect(app.texts()).toContain("查看摄像头");
});
