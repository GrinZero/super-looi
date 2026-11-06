import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StudyHomeDemo } from "../src/ui/home-demo.js";

describe("Study home local demonstration safety", () => {
  it("verifies color temperature and brightness from readback even while already on", async () => {
    const demo = new StudyHomeDemo();
    const result = await demo.execute("light.study_ceiling", { on: true, kelvin: 3000, brightness: 255 });
    assert.equal(result.status, "verified");
    assert.equal(result.snapshot?.kelvin, 3000);
    assert.equal(result.snapshot?.brightness, 255);
  });

  it("rejects lock and bounds before transport access and preserves state offline", async () => {
    const demo = new StudyHomeDemo();
    assert.equal((await demo.execute("lock.front_door", { on: false })).status, "rejected");
    assert.equal((await demo.execute("light.study_ceiling", { brightness: 256 })).status, "rejected");
    assert.equal(demo.getCommandCount(), 0);
    demo.setHealthy(false);
    assert.equal((await demo.execute("light.study_ceiling", { on: false })).status, "unverified");
    assert.equal(demo.getSnapshot("light.study_ceiling").on, true);
  });

  it("does not claim verified when the gateway disappears before readback", async () => {
    const demo = new StudyHomeDemo();
    const result = demo.execute("light.study_ceiling", { on: false });
    demo.setHealthy(false);
    assert.equal((await result).status, "unverified");
  });

  it("third adjustment creates only a proposal and requires explicit confirmation", () => {
    const demo = new StudyHomeDemo();
    const proposal = demo.recordThirdAdjustment();
    assert.equal(proposal.count, 3);
    assert.equal(proposal.status, "proposed");
    assert.throws(() => demo.confirmProposal(""));
    const rule = demo.confirmProposal("user_click_confirm_rule");
    assert.equal(rule.status, "confirmed");
    assert.equal(rule.confirmedBy, "user_click_confirm_rule");
  });
});
