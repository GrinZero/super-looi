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
- Settings now shows VAD model readiness and provides a device-side VAD diagnostic using the bundled wakeword WAV plus tail silence.
- The VAD diagnostic is shared by Settings and an opt-in boot smoke hook. Set `EXPO_PUBLIC_LOOI_RUN_VAD_SMOKE_ON_BOOT=1` to run the bundled WAV VAD smoke after runtime perceiver startup and log `[Diagnostics] VAD smoke succeeded: ...` or `[Diagnostics] VAD smoke failed: ...`.
- VAD model download now points at the published Sherpa asset `asr-models/silero_vad.onnx`; the prior `vad-models/silero_vad.onnx` URL returned 404.

## Verification Commands Run

- `pnpm exec tsc --noEmit`
- `pnpm test`
- `pnpm --dir server build`
- `pnpm --dir server test`
- `npx -y react-doctor@latest . --verbose --diff`
- `pnpm exec expo run:ios --device generic --no-bundler --output ./output/ios-build-smoke`
- Re-run iOS build-only smoke after VAD diagnostic additions: `0 error(s), and 0 warning(s)`.
- Shared VAD diagnostic boot-smoke patch: `pnpm exec tsc --noEmit` passed.
- Shared VAD diagnostic boot-smoke patch: `npx -y react-doctor@latest . --verbose --diff` exited 0 with existing Settings warnings: sequential awaits at `app/(tabs)/settings.tsx:531` and `app/(tabs)/settings.tsx:623`, plus large `SettingsScreen` at `app/(tabs)/settings.tsx:387`.
- VAD model URL fix and boot smoke: `EXPO_PUBLIC_LOOI_RUN_VAD_SMOKE_ON_BOOT=1 pnpm exec expo run:ios --device "iPhone 17 Pro"` built and launched the dev app; native log showed `[Diagnostics] VAD smoke succeeded: speech=yes | segments=1 | first=0.07-0.84s`.

## Runtime Smoke Results

- `GET /health` returned `200`.
- `POST /api/session/touch` created/reused a session.
- `POST /api/session/:id/message`, `GET /api/session/:id/messages`, and `GET /api/session/list` worked against the running local server.
- `POST /api/llm/generate-response-stream` returned token SSE events and a done event.
- Measured HTTP-only first SSE token: about `1714ms`.
- `touch` within 5 minutes reused the same session.
- iOS simulator boot VAD smoke detected speech from the bundled diagnostic WAV and produced one segment: `0.07-0.84s`.

## Needs Device-Level Acceptance

These cannot be fully proven from static tests or HTTP smoke:

- Real microphone wakeword -> VAD -> ASR flow on iOS simulator/device.
- VAD accuracy for natural speech: no mid-sentence cutoff and no >2s wait after a clear stop.
- First TTS playback within 3s of first token on device.
- Perceived subtitle/TTS sync during actual audio playback.
- Long-run resource release behavior for VAD/audio-studio/recording/SSE after repeated real conversations.

## Remaining Static Review Notes

- React Doctor still reports pre-existing `SettingsScreen` size and sequential-await warnings in existing recording flows. The VAD diagnostic addition compiles and the iOS build passes; broad settings refactor is out of scope for this feature acceptance.
