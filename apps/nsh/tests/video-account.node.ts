import assert from "node:assert/strict";
import { test } from "node:test";
import { VideoAccount } from "../runtime/video-account.js";
import type { NativeCamera } from "../runtime/camera.js";

function fixture() {
  const calls: Array<[string, ...string[]]> = [];
  let result = { state: "signed_out" } as Record<string, unknown>;
  let pending: (() => Promise<string>) | undefined;
  let authorized = 0;
  const reply = () => pending ? pending() : Promise.resolve(JSON.stringify(result));
  const native = {
    initialize: reply,
    login: (username: string, password: string, region: string) => { calls.push(["login", username, password, region]); return reply(); },
    submit: (answer: string) => { calls.push(["submit", answer]); return reply(); },
    refreshCaptcha: () => { calls.push(["refresh"]); return reply(); },
    resendTicket: () => { calls.push(["resend"]); return reply(); },
    resumeLogin: () => { calls.push(["resume"]); return reply(); },
    cancelLogin: () => { calls.push(["cancel"]); },
    logout: async () => { calls.push(["logout"]); },
  } as NativeCamera;
  const account = new VideoAccount({ native: () => native, onChange() {}, onAuthorized() { authorized++; } });
  return { account, calls, result: (value: Record<string, unknown>) => { result = value; }, pending: (value: () => Promise<string>) => { pending = value; }, authorized: () => authorized };
}

test("credentials, CAPTCHA, verification and camera count come from native responses", async () => {
  const f = fixture();
  f.result({ state: "captcha", image: "data:image/jpeg;base64,server-image" });
  await f.account.credentials({ account: "test-account", password: "test-password", region: "cn" });
  assert.deepEqual(f.calls[0], ["login", "test-account", "test-password", "cn"]);
  assert.equal(f.account.login.captchaImage, "data:image/jpeg;base64,server-image");
  assert.equal(f.account.auth.authorized, false);
  f.result({ state: "verification", destination: "a***@example.com", sentAt: Date.now() });
  await f.account.answer("server-captcha-answer");
  assert.equal(f.account.login.destination, "a***@example.com");
  assert.equal(f.account.login.step, "two_factor");
  assert.equal(f.account.login.smsCountdown, 60);
  f.result({ state: "verification", error: "camera_verification_rejected" });
  await f.account.answer("123456");
  assert.equal(f.account.auth.authorized, false);
  assert.match(f.account.login.error!, /不正确/);
  f.result({ state: "ready", devices: [{ did: "one" }, { did: "two" }] });
  await f.account.answer("654321");
  assert.equal(f.account.auth.authorized, true);
  assert.equal(f.account.auth.cameraCount, 2);
  assert.equal(f.authorized(), 1);
  f.account.cancel();
});

test("refresh, resend and redirect retry use different native operations", async () => {
  const f = fixture();
  f.result({ state: "captcha", image: "server-image" });
  await f.account.refreshCaptcha();
  f.result({ state: "verification", error: "camera_verification_send_failed" });
  await f.account.resend();
  assert.equal(f.account.login.smsCountdown, 0);
  f.result({ state: "continuing", error: "camera_login_network" });
  await f.account.resume();
  assert.deepEqual(f.calls.map(call => call[0]), ["refresh", "resend", "resume"]);
  assert.equal(f.account.auth.authorized, false);
});

test("network failures preserve the challenge and never authorize typed codes locally", async () => {
  const f = fixture();
  f.result({ state: "verification", destination: "server-recipient" });
  await f.account.credentials({ account: "user", password: "secret" });
  f.pending(async () => { throw new Error("camera_login_network"); });
  await f.account.answer("123456");
  assert.equal(f.account.login.step, "two_factor");
  assert.equal(f.account.login.destination, "server-recipient");
  assert.equal(f.account.auth.authorized, false);
  assert.equal(f.account.login.busy, false);
});

test("cancel ignores a late success and does not navigate or authorize", async () => {
  const f = fixture();
  let finish!: (value: string) => void;
  f.pending(() => new Promise(resolve => { finish = resolve; }));
  const attempt = f.account.credentials({ account: "user", password: "secret" });
  assert.equal(f.account.login.busy, true);
  f.account.cancel();
  finish(JSON.stringify({ state: "ready", devices: [{ did: "one" }] }));
  await attempt;
  assert.equal(f.account.auth.authorized, false);
  assert.equal(f.authorized(), 0);
  assert.equal(f.account.login.busy, false);
  assert.equal(f.calls.at(-1)?.[0], "cancel");
});

test("restoration and logout reflect the persisted native account", async () => {
  const f = fixture();
  f.result({ state: "ready", devices: [] });
  await f.account.initialize();
  assert.equal(f.account.auth.authorized, true);
  assert.equal(f.account.auth.cameraCount, 0);
  assert.equal(f.authorized(), 0);
  await f.account.disconnect();
  assert.equal(f.account.auth.authorized, false);
  assert.equal(f.calls.at(-1)?.[0], "logout");
});

test("native persistence errors cannot become an authorized state", async () => {
  const f = fixture();
  f.result({ state: "ready", devices: [{ did: "one" }], error: "Keychain write unavailable (-34018)" });
  await f.account.credentials({ account: "user", password: "secret" });
  assert.equal(f.account.auth.authorized, false);
  assert.equal(f.authorized(), 0);
  assert.match(f.account.login.error!, /Keychain/);
});
