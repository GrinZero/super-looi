import { MobileRuntime } from "../../../apps/nsh/runtime/application.js";
import { installFixtureHttp } from "./http-fixture.js";
import { assert, equal } from "./assert.js";

installFixtureHttp();
const oldConfig = {baseUrl:"https://example.invalid/v1",model:"original",apiKey:"test-only"};
let saved = JSON.stringify(oldConfig);
let failWrite = true;
let released = false;
const runtime = new MobileRuntime({
  get: () => saved,
  set: (_key, value) => { if (failWrite) throw new Error("vault unavailable"); saved = value; },
  remove: () => {},
}, () => { released = true; });
let rejected = false;
try { await runtime.configure({...oldConfig,model:"replacement"}); }
catch { rejected = true; }
assert(rejected, "Native vault failure must be reported");
equal(runtime.configuration().model, "original");
equal(JSON.parse(saved).model, "original");
// Exercise the retained executor's public admission path without a network call.
// A closed executor rejects before task creation; a usable one reaches provider setup.
const now = Date.now();
let failure = "";
const nativeFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (_input, init) => {
  requests++;
  equal(JSON.parse(String(init?.body)).model, "original");
  return new Response(JSON.stringify({error:{message:"Intentional offline provider"}}), {status:401,headers:{"content-type":"application/json"}});
};
try {
  await runtime.run("Say OK", {event_id:"vault-failure",ui_session_id:runtime.uiSessionId,kind:"tap",captured_at:new Date(now).toISOString(),expires_at:new Date(now+10000).toISOString()}, () => {});
} catch (error) { failure = String(error); }
finally { globalThis.fetch = nativeFetch; }
assert(requests > 0, "Recovered executor must dispatch using the previous model");
assert(failure.includes("Intentional offline provider"), "Expected controlled provider refusal");
assert(!failure.includes("executor is closed"), "Vault failure left a closed executor");
failWrite = false;
await runtime.configure({...oldConfig,model:"replacement"});
equal(runtime.configuration().model,"replacement");
equal(JSON.parse(saved).model,"replacement");
await runtime.close();
assert(released);
console.log("PASS mobile runtime: failed secure configuration preserves usable prior executor; retry and close");
