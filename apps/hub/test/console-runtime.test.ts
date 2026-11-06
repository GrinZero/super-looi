import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import { webcrypto } from "node:crypto";
import { getConsoleHtml } from "../src/console-html.js";
import { AcceptanceRunner } from "../src/acceptance/runner.js";
import { buildApp } from "../src/app.js";

const html = getConsoleHtml();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "console must include its inline behavior");

/** Execute the actual shipped functions, not a reimplementation, with an HTTP boundary. */
function harness(
  fetchImpl: typeof fetch = async () => {
    throw new Error("offline");
  },
  savedPreferences = new Map<string, string>(),
) {
  const elements = new Map<string, any>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const getElement = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: id === "correctionForm",
        textContent: "",
        innerHTML: "",
        value: "",
        className: "",
        isConnected: true,
        dataset: {},
        disabled: false,
        style: { setProperty() {} },
        classList: { add() {}, remove() {} },
        focus() {},
        scrollIntoView() {},
        scrollTop: 0,
        setAttribute() {},
        getBoundingClientRect() {
          return { x: 0, y: 0, width: 100, height: 100 };
        },
      });
    return elements.get(id);
  };
  const context = createContext({
    localStorage: {
      getItem: (key: string) => savedPreferences.get(key) ?? null,
      setItem: (key: string, value: string) => { savedPreferences.set(key, value); },
    },
    document: {
      hidden: false,
      activeElement: { matches: () => false },
      getElementById: getElement,
      querySelectorAll: () => [],
    },
    fetch: fetchImpl,
    AbortController,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    performance,
    console,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  // Event wiring is covered by browser smoke; all production state and action functions run here.
  const functionSource = script!.slice(0, script!.indexOf('$("faceHit").addEventListener'));
  new Script(functionSource, { filename: "console-inline.js" }).runInContext(context);
  return {
    context,
    timers,
    element: getElement,
    run: (source: string) => new Script(source).runInContext(context),
  };
}

describe("Presence v2.1 inline console runtime", () => {
  it("shows the wake guide until quick actions are used, and remembers dismissal after reload", () => {
    const saved = new Map<string, string>();
    const first = harness(undefined, saved);
    first.run("renderFace()");
    assert.equal(first.element("wakeBar").hidden, false);
    first.run('openSheet("lab"); closeSheet(); renderFace()');
    assert.equal(first.element("wakeBar").hidden, false);
    first.context.document.activeElement = first.element("wakeBar");
    first.run('openSheet("quick"); closeSheet(); renderFace()');
    assert.equal(first.element("wakeBar").hidden, true);
    assert.equal(first.run('returnFocus === $("faceHit")'), true);
    const reloaded = harness(undefined, saved);
    reloaded.run("renderFace()");
    assert.equal(reloaded.element("wakeBar").hidden, true);
  });

  it("keeps quick actions usable when preference storage is unavailable", () => {
    const h = harness();
    h.run('localStorage.setItem = () => { throw new Error("blocked"); }; openSheet("quick"); closeSheet(); renderFace()');
    assert.equal(h.element("wakeBar").hidden, true);
    assert.equal(h.run("state.sheet"), null);
  });

  it("parses the complete emitted script and emits no emoji glyphs", () => {
    assert.doesNotThrow(() => new Script(script!));
    assert.equal(/[\p{Extended_Pictographic}\uFE0F]/u.test(html), false);
    assert.ok(html.includes("prefers-reduced-motion"));
    assert.ok(html.includes('role="dialog"'));
  });

  it("validates the real 48-case report and rejects forged counts, missing cases and nonzero gates", async () => {
    const h = harness();
    const report = await new AcceptanceRunner().runFullSuite();
    h.context.report = JSON.parse(JSON.stringify(report));
    assert.equal(h.run("validReport(report)"), true);
    assert.equal(h.run("validReport({...report, cases:report.cases.slice(1)})"), false);
    assert.equal(h.run("validReport({...report, totalScore:999})"), false);
    assert.equal(
      h.run("validReport({...report, hardGates:{...report.hardGates, unauthorizedActions:1}})"),
      false,
    );
    assert.equal(
      h.run("validReport({...report, cases:[...report.cases.slice(0,47),report.cases[0]]})"),
      false,
    );
    assert.equal(
      h.run("validReport({...report, totalScore:48, cases:report.cases.map(c=>({...c,score:1}))})"),
      false,
    );
  });

  it("never reports stopped without verified termination evidence, including transport failure", async () => {
    const response = {
      receipt: { status: "verified" },
      event: {
        state: "cancelled",
        cancellation: { phase: "confirmed", termination_evidence_ids: [] as string[] },
      },
    };
    const h = harness(async () => new Response(JSON.stringify(response), { status: 200 }));
    await h.run("cancelTask('test')");
    assert.equal(h.run("state.cancels.test"), "unknown");
    response.event.cancellation.termination_evidence_ids = ["exit-proof"];
    await h.run("cancelTask('test')");
    assert.equal(h.run("state.cancels.test"), undefined);
    assert.match(h.element("toast").textContent, /已确认停止/);
    h.context.fetch = async () => {
      throw new Error("transport lost");
    };
    await h.run("cancelTask('test')");
    assert.equal(h.run("state.cancels.test"), "unknown");
    assert.match(h.element("toast").textContent, /结果待核实/);
    h.run(
      "delete state.cancels.test; state.taskEvents.test={state:'cancelled', cancellation:{phase:'pending'}}",
    );
    assert.equal(h.run("taskState({task_id:'test'})"), "unknown");
  });

  it("rejects HTTP failures instead of treating a resolved fetch as success", async () => {
    const h = harness(
      async () => new Response(JSON.stringify({ error: "approval expired" }), { status: 400 }),
    );
    await assert.rejects(h.run("api('/api/tasks/test/approve', {})"), /approval expired/);
  });

  it("escapes server content and strips emoji before inserting markup", () => {
    const h = harness();
    h.context.untrusted = '<img src=x onerror="alert(1)">\u{1F440}';
    assert.equal(h.run("esc(untrusted)"), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("marks an unhealthy gateway offline and prevents cached state from enabling controls", async () => {
    const h = harness();
    h.run(
      `state.homeHealthy=false;state.homeMode='simulation';state.snapshots=[{entity_id:'light.study_ceiling',state:'on',last_updated:new Date().toISOString(),attributes:{brightness:180}}];`,
    );
    const card = h.run(
      `homeCard({entity_id:'light.study_ceiling',supported_features:['brightness','color_temp']},'吸顶灯','light')`,
    );
    assert.match(card, /网关离线不可用/);
    assert.match(card, /<button disabled/);
    assert.match(card, /<input disabled/);
    assert.doesNotMatch(card, /tag green/);
    h.run("renderCabin()");
    assert.match(h.element("connections").innerHTML, /网关离线不可用/);
    await assert.rejects(h.run("homeCommand('light.study_ceiling','turn_on')"), /网关离线不可用/);
  });

  it("loads real read-only schemas and records a clearly marked app-context simulation snapshot", async () => {
    const app = buildApp();
    await app.ready();
    const requests: Array<{ url: string; payload: any }> = [];
    const h = harness(async (input, init) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, payload });
      const response = await app.inject({
        method: init?.method === "POST" ? "POST" : "GET",
        url,
        payload,
      });
      return new Response(response.body, { status: response.statusCode });
    });
    try {
      await h.run("refresh()");
      assert.equal(h.run("state.homeMode"), "simulation");
      assert.equal(h.run("state.entities.length > 0"), true);
      await h.run("recordSimulationSnapshot()");
      const event = requests.find((r) => r.url === "/api/memory/events")?.payload;
      assert.equal(event.source_kind, "app_context");
      assert.equal(event.payload.simulation, true);
      assert.match(event.content_hash, /^[a-f0-9]{64}$/);
      const response = await app.inject({ method: "GET", url: "/api/memory/claims" });
      const claim = response.json().claims[0];
      assert.equal(claim.object.simulation, true);
      assert.equal(claim.source_kind, "app_context");
      assert.match(claim.object.target, /仿真/);
      assert.match(h.element("toast").textContent, /非相机抓拍/);
    } finally {
      await app.close();
    }
  });
});

describe("Presence v3.0 humanized console behavior", () => {
  it("resolves each explicit memory location independently and never invents an unknown location", () => {
    const h = harness();
    const scenes = [
      ["键盘左侧", "keyboard_left"],
      ["显示器右侧", "monitor_right"],
      ["书架第二层", "bookshelf"],
      ["右侧抽屉", "drawer_right"],
    ];
    const coordinates = new Set<string>();
    for (const [location, key] of scenes) {
      h.context.location = location;
      // The same item can move: its title must never override an explicit location.
      const target = h.run("resolveMemorySceneTarget(location, '钥匙')");
      assert.equal(target.key, key);
      assert.ok(Number.isFinite(target.cx) && Number.isFinite(target.cy));
      coordinates.add(`${target.cx},${target.cy}`);
      h.run(`state.claims=[{claim_id:'selected',object:{target:'钥匙',location},status:'observed',source_kind:'passive_observation',evidence_ids:[],source_availability:'retained',revision:1}];state.selected='selected';renderMemories()`);
      assert.match(h.element("memoryInspector").innerHTML, new RegExp(`cx="${target.cx}" cy="${target.cy}"`));
      assert.match(h.element("memoryInspector").innerHTML, /观察时间/);
      assert.match(h.element("memoryInspector").innerHTML, /认识边界/);
    }
    assert.equal(coordinates.size, 4);
    for (const location of ["", "未知", "客厅沙发下面"]) {
      h.context.location = location;
      const target = h.run("resolveMemorySceneTarget(location, '钥匙')");
      assert.equal(target.key, null);
      assert.equal(target.cx, null);
      assert.equal(target.cy, null);
    }
  });

  it("humanizes provenance and smart-home rules without exposing raw JSON or executing server markup", () => {
    const h = harness();
    for (const [source, label] of [
      ["authenticated_user_statement", "主人亲口确认"],
      ["active_look_capture", "视觉抓拍 + 语音"],
      ["passive_observation", "桌面视觉观察"],
      ["pattern_inference", "近期习惯推断"],
    ]) {
      h.context.source = source;
      assert.equal(h.run("humanSource(source)"), label);
    }
    assert.equal(h.run("humanWorkspace('ws_godot_island')"), "Godot 海岛工程");
    h.run(`state.rules=[{rule_id:'rule',entity_id:'light.study_ceiling',status:'active',condition:'context == "web_study"',desired_state:{service:'turn_on',color_temp_kelvin:4000}}];renderTasks()`);
    const rules = h.element("rulesList").innerHTML;
    assert.match(rules, /书房吸顶灯/);
    assert.match(rules, /学习/);
    assert.match(rules, /开启/);
    assert.match(rules, /4000/);
    assert.doesNotMatch(rules, /\{(?:&quot;|")service/);
    assert.doesNotMatch(rules, /context ==/);
    h.context.untrusted = '<img src=x onerror="alert(1)">';
    h.run(`state.rules=[{rule_id:untrusted,entity_id:untrusted,status:'active',condition:untrusted,desired_state:{service:untrusted,color_temp_kelvin:untrusted}}];state.tasks=[{task_id:untrusted,intent:untrusted,workspace_id:untrusted}];renderTasks();state.proposals=[{proposal_id:untrusted,explanation:untrusted,suggested_state:{service:untrusted}}];renderHome();state.claims=[{claim_id:untrusted,object:{target:untrusted,location:untrusted},status:'observed',source_kind:untrusted,evidence_ids:[untrusted],revision:1}];renderMemories()`);
    for (const id of ["rulesList", "taskList", "homeProposals", "memoryList", "memoryInspector"]) {
      assert.doesNotMatch(h.element(id).innerHTML, /<img\b/);
      assert.doesNotMatch(h.element(id).innerHTML, /(?:data-[\w-]+)="[^"<>]*<|\sonerror="alert/);
    }
  });

  it("only calls cancellation safe after exit evidence and distinguishes pending, too-late and unknown", () => {
    const h = harness();
    assert.match(h.run("cancellationBanner({state:'cancelling',cancellation:{phase:'pending'}}, 'cancelling')"), /已请求取消/);
    assert.match(h.run("cancellationBanner({state:'cancelled',cancellation:{phase:'confirmed',termination_evidence_ids:['exit-proof']}}, 'cancelled')"), /已安全中止/);
    assert.match(h.run("cancellationBanner({state:'succeeded',cancellation:{phase:'too_late',completion_evidence_ids:['completion-proof']}}, 'succeeded')"), /不可安全撤回/);
    for (const event of [
      { state: "cancelled", cancellation: { phase: "confirmed", termination_evidence_ids: [] } },
      // An unverified action receipt keeps the effective task state unknown even
      // when its accompanying event claims a confirmed exit.
      { state: "cancelled", cancellation: { phase: "confirmed", termination_evidence_ids: ["unverified-proof"] } },
      { state: "cancelled", cancellation: { phase: "pending" } },
      { state: "unknown", cancellation: { phase: "unknown" } },
    ]) {
      h.context.event = event;
      const banner = h.run("cancellationBanner(event, 'unknown')");
      assert.match(banner, /待核实/);
      assert.doesNotMatch(banner, /已安全中止/);
    }
    assert.doesNotMatch(h.run("cancellationBanner({state:'succeeded',cancellation:{phase:'not_requested'}}, 'succeeded')"), /已安全中止|不可安全撤回|已请求取消/);
    assert.equal(h.run("cancellationBanner({state:'unknown',cancellation:{phase:'not_requested'}}, 'unknown')"), "");
    assert.match(h.run("cancellationBanner({state:'unknown',cancellation:{phase:'not_requested'}}, 'unknown', true)"), /待核实/);
  });

  it("keeps the 48-case details collapsed until explicitly opened and preserves real report results", async () => {
    const h = harness();
    h.run("renderReport()");
    assert.equal(h.run("state.reportExpanded"), false);
    assert.equal(h.element("reportDetails").hidden, true);
    assert.doesNotMatch(h.element("reportSummary").textContent, /48\s*\/\s*48/);
    h.context.report = JSON.parse(JSON.stringify(await new AcceptanceRunner().runFullSuite()));
    h.run("state.report={...report, cases:report.cases.slice(1)};renderReport()");
    assert.doesNotMatch(h.element("reportSummary").textContent, /48\s*\/\s*48/);
    assert.doesNotMatch(h.run("quickCount('cabin')"), /48\/48/);
    h.run("state.report=report;renderReport()");
    assert.equal(h.element("reportDetails").hidden, true);
    assert.match(h.element("reportSummary").textContent, /48\s*\/\s*48/);
    h.run("toggleReportDetails()");
    assert.equal(h.run("state.reportExpanded"), true);
    assert.equal(h.element("reportDetails").hidden, false);
    for (const group of "ABCDEFGH") {
      for (let i = 1; i <= 6; i++) assert.ok(h.element("reportDetails").innerHTML.includes(`${group}0${i}`));
    }
    h.run("renderReport()");
    assert.equal(h.element("reportDetails").hidden, false);
    h.run("toggleReportDetails()");
    assert.equal(h.element("reportDetails").hidden, true);
  });
});


describe("Phase 8 console interaction regressions", () => {
  it("only arms the quick drawer for 7.5 seconds and keeps SimLab open", () => {
    const h = harness();
    h.run('openSheet("lab")');
    assert.equal(h.timers.size, 0);
    h.run("armDrawer()");
    assert.equal(h.timers.size, 0);
    h.run('openSheet("quick")');
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 7500);
    assert.match(h.element("sheetSub").textContent, /7\.5.*支持下滑收起/);
    h.run("armDrawer()");
    assert.equal(h.timers.size, 1, "activity replaces the quick timer");
    h.run('openSheet("lab"); armDrawer()');
    assert.equal(h.timers.size, 0, "switching to SimLab clears the quick timer");
    h.run('openSheet("quick")');
    [...h.timers.values()][0].callback();
    assert.equal(h.run("state.sheet"), null);
    assert.equal(h.element("sheetBackdrop").hidden, true);
    assert.equal(h.timers.size, 0);
  });

  it("preserves the live brightness input during dragging and renders deferred readings afterward", () => {
    const h = harness();
    h.run(`state.space='home';state.homeHealthy=true;state.homeMode='simulation';
      state.entities=[{entity_id:'light.study_ceiling',supported_features:['brightness']}];
      state.snapshots=[{entity_id:'light.study_ceiling',state:'on',attributes:{brightness:51}}];renderSpaces()`);
    const before = h.element("homeGrid").innerHTML;
    assert.match(before, /value="20"/);
    h.run("draggingSlider=true;state.snapshots[0].attributes.brightness=204;renderSpaces()");
    assert.equal(h.element("homeGrid").innerHTML, before);
    h.run("draggingSlider=false;renderSpaces()");
    assert.match(h.element("homeGrid").innerHTML, /value="80"/);
    assert.notEqual(h.element("homeGrid").innerHTML, before);
  });

  it("closes memory correction on space changes and keeps other spaces rendering", async () => {
    const h = harness();
    h.run(`refreshBusy=true;state.space='memories';
      state.claims=[{claim_id:'memory',object:{target:'钥匙',location:'键盘左侧'},status:'observed',evidence_ids:[],revision:1}];
      state.selected='memory';state.homeHealthy=true;state.homeMode='simulation';
      state.entities=[{entity_id:'light.study_ceiling',supported_features:['brightness']}];
      state.snapshots=[{entity_id:'light.study_ceiling',state:'on',attributes:{brightness:51}}];
      state.tasks=[{task_id:'task',intent:'检查产物'}];state.taskEvents.task={state:'running'};renderSpaces()`);
    for (const space of ["home", "tasks", "cabin"]) {
      h.run("switchSpace('memories')");
      await h.run("memoryAction('correct')");
      assert.equal(h.element("correctionForm").hidden, false);
      h.context.document.activeElement.id = "correctLocation";
      h.run(`switchSpace('${space}')`);
      assert.equal(h.element("correctionForm").hidden, true, `${space} closes correction`);
      if (space === "home") assert.match(h.element("homeGrid").innerHTML, /value="20"/);
      if (space === "tasks") assert.match(h.element("taskList").innerHTML, /检查产物/);
      if (space === "cabin") assert.match(h.element("connections").innerHTML, /本机中枢/);
    }
    // Even a stale form flag cannot lock a different space during a refresh.
    h.run("switchSpace('home');$('correctionForm').hidden=false;state.snapshots[0].attributes.brightness=204;renderSpaces()");
    assert.match(h.element("homeGrid").innerHTML, /value="80"/);
    h.run("switchSpace('tasks');$('correctionForm').hidden=false;draggingSlider=true;state.tasks[0].intent='产物已更新';renderSpaces()");
    assert.match(h.element("taskList").innerHTML, /产物已更新/);
  });

  it("focuses and reveals memory correction, and lets the user cancel without a request", async () => {
    const h = harness();
    let focused = false;
    let scrolled = false;
    h.element("correctLocation").focus = () => { focused = true; };
    h.element("correctionForm").scrollIntoView = (options: { block: string }) => {
      assert.equal(focused, true, "focus precedes scrolling");
      assert.equal(options.block, "nearest");
      scrolled = true;
    };
    h.run(`state.claims=[{claim_id:'memory',object:{target:'钥匙'},status:'observed',evidence_ids:[],revision:1}];
      state.selected='memory';renderMemories()`);
    assert.match(h.element("memoryInspector").innerHTML, /type="button" data-memory="cancel-correct">取消/);
    await h.run("memoryAction('correct')");
    assert.equal(scrolled, true);
    assert.equal(h.element("correctionForm").hidden, false);
    await h.run("memoryAction('cancel-correct')");
    assert.equal(h.element("correctionForm").hidden, true);
  });

  it("auto-focuses urgent approval once and preserves a manual task-pane choice", () => {
    const h = harness();
    let scrollCount = 0;
    h.element("taskTabs").scrollIntoView = (options: { block: string; behavior: string }) => {
      assert.equal(options.block, "start");
      assert.equal(options.behavior, "smooth");
      scrollCount += 1;
    };
    h.run("renderTasks()");
    assert.equal(h.run("state.autoFocusedApproval"), false);
    assert.equal(h.run("state.mobileTaskPane"), "tasks");
    h.run(`state.tasks=[{task_id:'urgent',intent:'检查高危命令'}];
      state.taskEvents.urgent={state:'awaiting_approval',summary:'git push --force'};renderTasks()`);
    assert.equal(h.run("state.autoFocusedApproval"), true);
    assert.equal(h.run("state.mobileTaskPane"), "decisions");
    assert.equal(h.element("tasksSpace").dataset.pane, "decisions");
    assert.equal(scrollCount, 0, "background approval focus does not scroll");
    const panel = h.element("approvalPanel").innerHTML;
    assert.ok(panel.indexOf('class="mono command-box"') < panel.indexOf('data-approve='));
    assert.ok(panel.indexOf('data-approve=') < panel.indexOf('授权边界'));
    h.run("setMobileTaskPane('tasks');renderTasks();renderTasks()");
    assert.equal(h.run("state.mobileTaskPane"), "tasks");
    assert.equal(h.element("tasksSpace").dataset.pane, "tasks");
    h.run("state.taskEvents.urgent.state='succeeded';renderTasks()");
    assert.equal(h.run("state.autoFocusedApproval"), false);
    h.run("state.taskEvents.urgent.state='awaiting_approval';renderTasks()");
    assert.equal(h.run("state.mobileTaskPane"), "decisions", "a new approval episode refocuses");
    assert.equal(scrollCount, 0, "polling and default pane changes preserve scroll position");
    h.run("setMobileTaskPane('tasks', true)");
    assert.equal(scrollCount, 1, "an explicit pane choice reveals the task tabs");
  });

  it("dismisses only deliberate downward sheet drags and resets cancelled or short gestures", () => {
    const h = harness();
    h.context.surface = { closest: () => null };
    h.context.control = { closest: () => ({}) };
    h.context.dragEvent = { cancelable: true, preventDefault() {} };
    h.run('openSheet("lab");startSheetDrag({clientX:0,clientY:0},control,1)');
    assert.equal(h.run("sheetDrag"), null, "interactive controls keep their gestures");
    h.run('startSheetDrag({clientX:0,clientY:0},surface,1);moveSheetDrag({clientX:80,clientY:70},dragEvent,1);finishSheetDrag(false,1)');
    assert.equal(h.run("state.sheet"), "lab", "horizontal gestures do not dismiss");
    h.element("sheet").scrollTop = 20;
    h.run('startSheetDrag({clientX:0,clientY:0},surface,1);moveSheetDrag({clientX:0,clientY:80},dragEvent,1);finishSheetDrag(false,1)');
    assert.equal(h.run("state.sheet"), "lab", "scrollable content keeps scrolling");
    h.element("sheet").scrollTop = 0;
    h.run('startSheetDrag({clientX:0,clientY:0},surface,1);moveSheetDrag({clientX:0,clientY:40},dragEvent,1)');
    assert.equal(h.element("sheet").style.transform, "translateY(40px)");
    h.run("finishSheetDrag(false,1)");
    assert.equal(h.run("state.sheet"), "lab");
    assert.equal(h.element("sheet").style.transform, "translateY(0)");
    h.run('startSheetDrag({clientX:0,clientY:0},surface,"touch");moveSheetDrag({clientX:0,clientY:90},dragEvent,"touch");finishSheetDrag(true,"touch")');
    assert.equal(h.run("state.sheet"), "lab", "touch cancellation does not dismiss");
    assert.equal(h.timers.size, 0);
    h.run('startSheetDrag({clientX:0,clientY:0},surface,1);moveSheetDrag({clientX:0,clientY:65},dragEvent,1);finishSheetDrag(false,1)');
    assert.equal(h.run("state.sheet"), null);
    h.run('openSheet("lab")');
    assert.equal(h.element("sheet").style.transform, "translateY(0)");
  });

  it("blocks ambient swipes during motion, privacy, an open sheet or from safety controls", () => {
    const h = harness();
    h.context.swipeStart = { target: { closest: () => null }, touches: [{ clientY: 100 }] };
    h.context.swipeEnd = { changedTouches: [{ clientY: 20 }] };
    for (const guard of ["state.motion=true", "state.privacy=true", "state.sheet='lab'"]) {
      h.run("state.motion=false;state.privacy=false;state.sheet=null;" + guard + ";startAmbientSwipe(swipeStart);finishAmbientSwipe(swipeEnd)");
      assert.notEqual(h.run("state.sheet"), "quick");
    }
    h.run("state.sheet=null;state.privacy=false;state.motion=false;startAmbientSwipe(swipeStart);state.motion=true;finishAmbientSwipe(swipeEnd)");
    assert.equal(h.run("state.sheet"), null, "motion beginning mid-swipe also blocks opening");
    h.context.swipeStart.target.closest = () => ({});
    h.run("state.motion=false;startAmbientSwipe(swipeStart);finishAmbientSwipe(swipeEnd)");
    assert.equal(h.run("state.sheet"), null);
    h.context.swipeStart.target.closest = () => null;
    h.run("startAmbientSwipe(swipeStart);finishAmbientSwipe(swipeEnd)");
    assert.equal(h.run("state.sheet"), "quick");
  });

  it("switches mobile panes while keeping both memory and task panels populated", () => {
    const h = harness();
    h.run(`state.claims=[{claim_id:'memory',object:{target:'钥匙',location:'键盘左侧'},status:'observed',evidence_ids:[],revision:1}];
      state.tasks=[{task_id:'task',intent:'检查产物'}];state.taskEvents.task={state:'awaiting_approval'};
      renderMemories();renderTasks();setMemoryPane('inspector');setMobileTaskPane('decisions')`);
    assert.equal(h.element("memoriesSpace").dataset.pane, "inspector");
    assert.equal(h.element("tasksSpace").dataset.pane, "decisions");
    assert.match(h.element("memoryList").innerHTML, /钥匙/);
    assert.match(h.element("memoryInspector").innerHTML, /返回记忆列表/);
    assert.match(h.element("taskList").innerHTML, /检查产物/);
    assert.match(h.element("approvalPanel").innerHTML, /检查产物/);
    assert.equal(h.element("pendingApprovalBadge").hidden, false);
    assert.match(h.element("pendingApprovalBadge").textContent, /1 待审批/);
    h.run("setMemoryPane('list');setMobileTaskPane('tasks');state.tasks=[];renderTasks()");
    assert.equal(h.element("memoryInspector").innerHTML.includes("钥匙"), true);
    assert.equal(h.element("pendingApprovalBadge").hidden, true);
  });

  it("opens a selected acceptance group and returns to the full report on toggle", async () => {
    const h = harness();
    h.run('selectReportGroup("A")');
    assert.equal(h.run("state.reportExpanded"), false);
    h.context.report = JSON.parse(JSON.stringify(await new AcceptanceRunner().runFullSuite()));
    h.run('state.report=report;selectReportGroup("B")');
    assert.equal(h.run("state.reportExpanded"), true);
    assert.equal(h.element("reportDetails").hidden, false);
    assert.match(h.element("reportDetails").innerHTML, /B01/);
    assert.doesNotMatch(h.element("reportDetails").innerHTML, /A01/);
    assert.match(h.element("acceptanceGrid").innerHTML, /data-group="B"[^>]+aria-pressed="true"/);
    h.run("toggleReportDetails();toggleReportDetails()");
    assert.match(h.element("reportDetails").innerHTML, /A01/);
    assert.match(h.element("reportDetails").innerHTML, /H06/);
  });
});
