import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolApprovalPolicy,
  type ToolApprovalContext,
} from "../src/agent/tool-approval.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "looi-approval-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  const context: ToolApprovalContext = {
    callId: "call-1", toolName: "write_file", arguments: { path: "new.txt", content: "hello" },
    sessionId: "session-1", workspaceRoot, approvalMode: "ask",
  };
  return { root, context, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("built-in aliases preserve ask, local_auto and yolo decisions", () => {
  const f = fixture();
  const policy = createToolApprovalPolicy({ requireApprovalForAllWrites: true });
  try {
    for (const toolName of ["read", "read_file", "write", "write_file"]) {
      for (const approvalMode of ["ask", "local_auto", "yolo"] as const) {
        for (const outside of [false, true]) {
          const path = outside ? join(f.root, "outside.txt") : "new.txt";
          const details = policy({ ...f.context, toolName, approvalMode, arguments: { path, content: "hello" } });
          const writing = toolName.startsWith("write");
          const expected = approvalMode === "ask" ? writing || outside :
            approvalMode === "local_auto" && writing && outside;
          assert.equal(!!details, expected, `${toolName}/${approvalMode}/${outside}`);
          if (details) {
            assert.equal(details.operation, writing ? "write" : "read");
            assert.equal(details.path, path);
          }
        }
      }
    }
    for (const approvalMode of ["ask", "local_auto", "yolo"] as const) {
      assert.equal(!!policy({ ...f.context, toolName: "bash", approvalMode, arguments: { command: "printf hello" } }), approvalMode === "ask");
    }
    assert.equal(createToolApprovalPolicy()({ ...f.context }), undefined);
  } finally { f.close(); }
});

test("write details resolve external symlinks and describe overwrites", () => {
  const f = fixture();
  const policy = createToolApprovalPolicy();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "existing.txt"), "old");
    symlinkSync(outside, join(f.context.workspaceRoot, "linked"));
    for (const [path, willOverwrite] of [["linked/existing.txt", true], ["linked/new.txt", false]] as const) {
      assert.deepEqual(policy({ ...f.context, arguments: { path, content: "hello" } }), {
        callId: "call-1", toolName: "write_file", sessionId: "session-1",
        operation: "write", path, content: "hello", willOverwrite,
      });
    }
  } finally { f.close(); }
});

test("registered rules add tools and replace individual defaults while retaining required approvals", () => {
  const f = fixture();
  let evaluations = 0;
  const policy = createToolApprovalPolicy({
    approvalRequiredTools: ["control_home_device"],
    toolApprovalRules: {
      move_body(context) {
        evaluations++;
        assert.equal(context.workspaceRoot, f.context.workspaceRoot);
        return context.arguments.speed === 10 ? { operation: "move", speed: 10 } : undefined;
      },
      bash: () => undefined,
      control_home_device: () => undefined,
    },
  });
  try {
    assert.deepEqual(policy({ ...f.context, toolName: "move_body", arguments: { speed: 10 } }), {
      callId: "call-1", toolName: "move_body", sessionId: "session-1", operation: "move", speed: 10,
    });
    assert.equal(policy({ ...f.context, toolName: "move_body", arguments: { speed: 1 } }), undefined);
    assert.equal(policy({ ...f.context, toolName: "move_body", approvalMode: "yolo" }), undefined);
    assert.equal(evaluations, 2);
    assert.equal(policy({ ...f.context, toolName: "bash", arguments: { command: "sudo echo hello" } }), undefined);
    const required = policy({ ...f.context, toolName: "control_home_device", approvalMode: "local_auto" });
    assert.deepEqual(required?.arguments, f.context.arguments);
    assert.equal(policy({ ...f.context, toolName: "unregistered" }), undefined);
  } finally { f.close(); }
});
