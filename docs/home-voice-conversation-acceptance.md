# Home Voice Conversation Acceptance

Updated: 2026-06-28 14:10 CST

## Proven By Current Evidence

- End-to-end implementation path exists: wakeword trigger starts listening, VAD can auto-finish recording, STT output is shown as transcript, LLM SSE tokens update subtitles, sentence chunks feed TTS, evidence images open in an overlay, and state is reset on failures.
- Server LLM calls use `@earendil-works/pi-ai`; direct `openai` SDK dependency was removed from `server/package.json`.
- `/api/llm/generate-response-stream` emits SSE `token` and `done` events.
- Server session APIs exist and are registered:
  - `POST /api/session/touch`
  - `POST /api/session/:id/message`
  - `GET /api/session/list`
  - `GET /api/session/:id/messages`
- Session history is included in streaming LLM context.
- Closed session summaries are written to `sessions.summary` and Mem0 with `category: "session_summary"`.
- Conversation tab is a session history viewer.
- iOS native build succeeds, including `@siteed/sherpa-onnx.rn` and `@siteed/audio-studio` native targets.

## Verification Commands Run

- `pnpm exec tsc --noEmit`
- `pnpm test`
- `pnpm --dir server build`
- `pnpm --dir server test`
- `npx -y react-doctor@latest . --verbose --diff`
- `pnpm exec expo run:ios --device generic --no-bundler --output ./output/ios-build-smoke`

## Runtime Smoke Results

- `GET /health` returned `200`.
- `POST /api/session/touch` created/reused a session.
- `POST /api/session/:id/message`, `GET /api/session/:id/messages`, and `GET /api/session/list` worked against the running local server.
- `POST /api/llm/generate-response-stream` returned token SSE events and a done event.
- Measured HTTP-only first SSE token: about `1714ms`.
- `touch` within 5 minutes reused the same session.

## Needs Device-Level Acceptance

These cannot be fully proven from static tests or HTTP smoke:

- Real microphone wakeword -> VAD -> ASR flow on iOS simulator/device.
- VAD accuracy for natural speech: no mid-sentence cutoff and no >2s wait after a clear stop.
- First TTS playback within 3s of first token on device.
- Perceived subtitle/TTS sync during actual audio playback.
- Long-run resource release behavior for VAD/audio-studio/recording/SSE after repeated real conversations.
