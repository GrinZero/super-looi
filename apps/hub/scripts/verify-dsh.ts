import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-pi-verification-"));
const workspace = path.join(root, "workspace");
const checks: Array<{ name: string; passed: boolean; details?: unknown }> = [];
const settings = () => ({ stateDirectory: path.join(root, "runtime"), workspaceRoot: workspace, deadlineMs: 90000 });
let agent = new PiAgentExecutor(settings());
const taskId = `verify_${randomUUID()}`;
const marker = `PI_${randomUUID()}`;
try {
  const command = `printf %s ${marker} > evidence.txt`;
  const result = await agent.run(
    `请调用 bash 执行这个命令（不改写）：${command}。然后用 read_file 读取 evidence.txt 校验。最后只说完成情况。`,
    { taskId, mode: "text" }
  );
  checks.push({
    name: "in-process-bash-exit-receipt",
    passed: result.executions?.some((item) => item.command === command && item.exitCode === 0) ?? false,
    details: result.executions?.map((item) => ({ exitCode: item.exitCode, timedOut: item.timedOut, aborted: item.aborted })),
  });
  checks.push({
    name: "real-file-readback",
    passed:
      fs.readFileSync(path.join(workspace, "evidence.txt"), "utf8") === marker &&
      !!result.artifacts?.some((item) => item.path === "evidence.txt"),
    details: result.artifacts,
  });
  await agent.close();
  agent = new PiAgentExecutor(settings());
  const restored = await agent.run("不要调用任何工具，只返回上一轮 evidence.txt 中的标记。", {
    taskId,
    resume: true,
    mode: "text",
  });
  checks.push({
    name: "persistent-session-restore",
    passed: restored.answer.includes(marker) && restored.toolCallsCount === 0,
  });

  const questionId = `question_${randomUUID()}`;
  let asked = false;
  await agent.run("请务必使用 ask_user_question 工具让我在蓝色和绿色中选择一个，不要自己决定。收到答案后只复述答案。", {
    taskId: questionId,
    onStep: (step) => {
      if (step.phase !== "awaiting_input") return;
      const pending = agent.getTask(questionId)?.interaction;
      if (!pending) return;
      const questions = pending.details.questions as Array<{ id: string; options?: Array<{ label: string }> }>;
      asked = true;
      agent.respond(questionId, pending.id, {
        answers: questions.map((question) => ({
          id: question.id,
          selected: question.options?.[0] ? [question.options[0].label] : [],
          ...(question.options?.[0] ? {} : { custom: "蓝色" }),
        })),
      });
    },
  });
  checks.push({ name: "native-user-question-roundtrip", passed: asked });

  const approvalId = `approval_${randomUUID()}`;
  const outside = path.join(root, "outside-workspace.txt");
  let approvalRejected = false;
  await agent.run(`请用 bash 执行 printf APPROVAL > ${outside}。若需要授权请请求；如果用户拒绝，立刻停止，不要尝试其他方法。`, {
    taskId: approvalId,
    onStep: (step) => {
      if (step.phase !== "awaiting_approval") return;
      const pending = agent.getTask(approvalId)?.interaction;
      if (pending) {
        approvalRejected = true;
        agent.respond(approvalId, pending.id, { outcome: "rejected" });
      }
    },
  });
  checks.push({ name: "native-approval-rejection", passed: approvalRejected && !fs.existsSync(outside) });

  const cancelId = `cancel_${randomUUID()}`;
  let stop: ReturnType<typeof agent.cancel> | undefined;
  let rejected = false;
  try {
    await agent.run("只调用一次 bash 执行 sleep 20，等待它结束，不要转为后台。", {
      taskId: cancelId,
      onStep: (step) => {
        if (step.phase === "tool_start" && step.toolName === "bash" && !stop) stop = agent.cancel(cancelId);
      },
    });
  } catch {
    rejected = true;
  }
  const stopped = await stop;
  checks.push({
    name: "cancel-closes-owned-runtime-with-honest-state",
    passed: rejected && stopped?.runtimeExited === true && (stopped.state === "unknown" || stopped.state === "cancelled"),
    details: stopped,
  });
} catch (error) {
  checks.push({ name: "verification-completed", passed: false, details: (error as Error).message });
} finally {
  await agent.close();
  const report = {
    runtime: "pi-agent-core@1.5.0",
    node: process.version,
    checks,
    passed: checks.length >= 6 && checks.every((check) => check.passed),
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.DSH_VERIFICATION_REPORT) {
    fs.writeFileSync(process.env.DSH_VERIFICATION_REPORT, JSON.stringify(report, null, 2) + "\n");
  }
  if (!report.passed) process.exitCode = 1;
  if (report.passed) fs.rmSync(root, { recursive: true, force: true });
}
