> 2026-11-05 更正：本文记录历史原型。自研 `MinimalAgentLoop` 已被官方 DSH SDK/runtime 替换；当前实现与实际验证范围以 [官方引擎接入报告](dsh-engine-integration.md) 为准。

# Phase 11: 极简真实可用语音 Personal Agent 闭环（做减法）

## 1. 核心目标与设计原则

围绕“做减法，让 Super-LOOI 真实可用”，本阶段聚焦打通用户最核心的两大真实体验：

1. **说话唤醒与自然实时全双工对话（像 Codex Live 一样丝滑）**
   - 对接字节跳动豆包端到端全双工实时对话 V3 协议（`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`），模型 `1.2.6.1`，音色 `zh_female_vv_jupiter_bigtts`，开启 `vadSmoothMs: 2500` 服务端平滑 VAD。
   - 双端（Mobile 与 Hub Web）支持真实 16kHz 单声道 PCM 麦克风上行、24kHz 音频流播放、真实 RMS 振幅包络驱动 LOOI 大脸声波与嘴型、以及随时打断（`barge_in` -> `response.cancel`）。
2. **零心智负担的 Personal Agent（复刻 `dsh` 最基础的 ReAct Agent Loop）**
   - 无需用户手动点选复杂分类或审批表单，只保留最本质的 `LLM + bash + read_file + write_file + memory` 工具闭环。
   - 语音对话中说“记住我把钥匙放在抽屉里”自动落盘持久化并同步至回忆册；说“帮我看看当前目录有什么”自动调起 `MinimalAgentLoop` 执行真实命令并通过豆包全双工语音自然口播结果。

---

## 2. 核心架构与实现落点

### 2.1 零心智持久化个人记忆 (`apps/hub/src/agent/personal-memory.ts`)
- **`PersonalMemoryStore`**：基于本地 JSON 文件 (`data/personal-memory.json`) 持久化存储个人事实与备忘，重启不丢失。
- **自动去重与覆盖**：当同一主体（`subject`）的位置或状态更新时，自动原地覆盖并更新时间戳。
- **系统提示词注入**：自动生成 `<personal_memory>` 上下文块，在每次豆包语音会话建立和 Agent Loop 执行时动态注入。
- **双向同步**：每次新增或更新记忆时，自动同步写入 `MemoryLedgerService`，使得 Mobile 与 Web 回忆册立即可见。

### 2.2 极简 DSH ReAct Agent Loop (`apps/hub/src/agent/agent-loop.ts`)
- **`MinimalAgentLoop`**：对接 `.env` 中的 OpenAI 兼容接口（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），实现标准多步 Tool Calling 循环（默认上限 8 步）：
  - `bash`：通过 `/bin/zsh -lc` 在工作区执行真实 Shell 命令（带超时保护与输出截断）。
  - `read_file` / `write_file`：直接读写工作区文件（采用 `path.relative` 严格防范越界访问）。
  - `memory`：支持 `remember` / `recall` / `forget` 操作持久化记忆。
- **实时微状态 (`onStep`)**：在工具执行期间通过 `/ws/voice` 实时向客户端推送 `agent_status` 帧，大脸字幕柔和显示 `Agent · 正在执行命令...`，不打断陪伴感。

### 2.3 豆包 Duplex V3 全双工桥接 (`apps/hub/src/voice/doubao-engine.ts` & `apps/hub/src/app.ts`)
- **协议对齐**：
  - 20ms / 640B 自校正节拍器持续发送 `input_audio_buffer.append`。
  - 麦克风开关发送 `input_audio_unmute.commit` / `input_audio_mute.commit`。
  - 工具调用拦截 `response.function_call_arguments.done`，执行 `remember_fact`、`recall_memory`、`run_agent_task`，并通过 `speech_text_buffer.commit` (`speak_text`) 触发豆包实时语音合成口播。
- **语音意图直通与并发保护**：对用户口述的“记住...”自动持久化，对包含路径/文件/命令/工作区查询的口述自动触发 `MinimalAgentLoop` 并口播答案，并通过 `agentBusy` + `turnToolHandled` + `AbortController` 杜绝并发重复执行。

### 2.4 Mobile 与 Web 客户端真实语音与记忆同步 (`apps/mobile/src/runtime/live-voice-client.ts` & `apps/hub/src/console-html.ts`)
- **Mobile (`LiveVoiceClient`)**：
  - 使用模拟器已预链接的 `@siteed/audio-studio` 采集 16kHz 单声道音频流，使用 `expo-file-system` + `expo-audio` 播放 24kHz WAV 回复（自动清理历史缓存 WAV 文件），并按 100ms 真实 PCM16 RMS 振幅包络驱动 LOOI 大脸声波。
  - 首屏右上角提供一键 `LIVE 对话` 胶囊与内联 `对话` 输入框，启动时自动从 `/api/agent/memories` 同步真实持久化记忆至回忆册。
- **Hub Web (`console-html.ts`)**：
  - 接入浏览器 `navigator.mediaDevices.getUserMedia` (16kHz PCM16 上行) 与 `AudioContext` (24kHz PCM16 实时播放队列)，并在隐私休眠、断连与页面卸载时自动释放麦克风与音频上下文。

---

## 3. 实测验证与独立 Review 结果

1. **全工作区编译与自动化测试**：
   - `pnpm typecheck`：4/4 包零错误通过。
   - `pnpm test`：`contracts` (5/5)、`looi-driver` (10/10)、`hub` (16 suites, 72/72)、`mobile` (24 suites, 126/126) 全部 100% 通过。
   - `pnpm build`：4/4 包全部构建通过。
2. **豆包 Duplex V3 + GPT-4o Agent Loop 真网联调**：
   - 实测连接 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` 与 `LLM_BASE_URL` (`gpt-4o`)，成功完成“记住我的树莓派放在书房抽屉第二层并查看当前目录文件”复合指令，落盘 `data/personal-memory.json` 并下发 182KB 24kHz 真实语音流。
3. **子 Agent 独立 Review 闭环**：
   - 修复了 `resolveWorkspacePath` 同级目录前缀绕过问题、Web 隐私暂停/断连麦克风释放、`/ws/voice` 快慢脑并发锁与 `AbortController` 中断、以及 Mobile 临时 WAV 缓存文件清理。
4. **iOS 模拟器 (`iPhone 16e`) 实机验证截图**：
   - 首屏 LIVE 对话入口：`docs/artifacts/phase11/sim-face-live.png`
   - 回忆册真实 Hub 记忆同步：`docs/artifacts/phase11/sim-memories-synced.png`
