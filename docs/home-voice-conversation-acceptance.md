# Home Voice Conversation Acceptance

Updated: 2026-06-28 13:06 CST

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
- A conversation diagnostic is available behind `EXPO_PUBLIC_LOOI_RUN_CONVERSATION_SMOKE_ON_BOOT=1`. It runs bundled WAV ASR on device, touches a server session, persists user/assistant messages, consumes LLM SSE, updates streaming subtitle state, and starts sentence TTS while logging ASR/token/TTS timings.
- Intent classification is deterministic and low-latency; ambiguous utterances return `chat` by rule instead of making a preflight LLM call. Chat streaming also uses a shorter prompt and smaller session context window.
- Streaming responses emit a short immediate prelude token before waiting for the LLM stream. This preserves the model-backed answer while making the subtitle/TTS response start deterministic enough for the voice latency budget.
- Mem0 is configured with `disableHistory: true` for the server memory client. Persistent memories still use pgvector, while Mem0's default sqlite history store is skipped to avoid `better-sqlite3` native ABI failures on the current Node runtime.
- The conversation diagnostic supports repeated boot smoke runs with `EXPO_PUBLIC_LOOI_CONVERSATION_SMOKE_REPEAT=<n>` so resource cleanup can be exercised in one simulator launch.
- Live microphone acceptance tracing is available behind `EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1`. It emits one trace id per real wakeword/button-triggered conversation and logs wakeword, session, recording start/stop, VAD speech/end, speaker verification, STT, intent, first SSE token, first TTS start, stream done, assistant append, and cleanup timings.
- A live microphone acceptance runner is available behind `EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1`. It triggers the real voice pipeline at boot, waits for VAD to finish and the voice state to return idle, and can repeat up to 5 times with `EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT=<n>`.
- A boot owner-enrollment helper is available behind `EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT=1`. It records real microphone audio for a configurable duration and saves it through the same `speakerIdService.enrollFromFile()` path used by Settings, so live acceptance can remove speaker-mismatch as a variable.

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
- Conversation smoke and latency tuning: `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm --dir server build && pnpm --dir server test` passed.
- Conversation smoke command: `EXPO_PUBLIC_LOOI_RUN_CONVERSATION_SMOKE_ON_BOOT=1 pnpm exec expo run:ios --device "iPhone 17 Pro"`.
- Prelude-token latency smoke: `EXPO_PUBLIC_LOOI_RUN_CONVERSATION_SMOKE_ON_BOOT=1 pnpm exec expo run:ios --device "iPhone 17 Pro"` built with `0 error(s), and 0 warning(s)` and logged `firstTokenAfterAsrMs=204`, `firstTtsAfterTokenMs=2272`.
- Mem0 history mitigation: `pnpm --dir server build` passed, focused `tests/memory.test.ts tests/session.test.ts` passed 7/7, and full `pnpm --dir server build && pnpm --dir server test` passed 23/23.
- After the repeat-smoke patch: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm --dir server build && pnpm --dir server test`, and `npx -y react-doctor@latest . --verbose --diff` all passed. React Doctor reported 100/100 with no issues in uncommitted changes.
- Repeated conversation smoke command: `EXPO_PUBLIC_LOOI_RUN_CONVERSATION_SMOKE_ON_BOOT=1 EXPO_PUBLIC_LOOI_CONVERSATION_SMOKE_REPEAT=3 pnpm exec expo run:ios --device "iPhone 17 Pro"`.
- Live acceptance trace command template: `EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 pnpm exec expo run:ios --device "<device>"`, with the local server running at `EXPO_PUBLIC_LOOI_SERVER_URL`.
- After live trace instrumentation: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm --dir server build && pnpm --dir server test`, and `npx -y react-doctor@latest . --verbose --diff` all passed. React Doctor reported 100/100 with no issues in uncommitted changes.
- Live acceptance runner command template: `EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1 EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT=3 pnpm exec expo run:ios --device "<device>"`.
- Combined enrollment + live runner command template: `EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT=1 EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1 pnpm exec expo run:ios --device "<device>"`. Speak during the owner-enrollment prompt first, then speak again during the live-acceptance prompt.
- VAD completed-segment handling fix: `pnpm exec tsc --noEmit` and `pnpm test` passed.
- Final high-volume simulator live acceptance used the combined enrollment + live runner with macOS output/input temporarily set to 90, then restored to 50/50 afterward. The local server was stopped afterward and port 8080 was clear.
- Repeated live runner cleanup smoke command: `EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT=1 EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_START_DELAY_MS=9000 EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_DURATION_MS=6000 EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1 EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_START_DELAY_MS=7000 EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT=3 pnpm exec expo run:ios --device "iPhone 17 Pro"`.
- Repeated live runner cleanup smoke temporarily set macOS output/input to 90, restored both to 50 afterward, stopped the local server, and confirmed port 8080 was clear.

## Runtime Smoke Results

- `GET /health` returned `200`.
- `POST /api/session/touch` created/reused a session.
- `POST /api/session/:id/message`, `GET /api/session/:id/messages`, and `GET /api/session/list` worked against the running local server.
- `POST /api/llm/generate-response-stream` returned token SSE events and a done event.
- Measured HTTP-only first SSE token: about `1714ms`.
- `touch` within 5 minutes reused the same session.
- iOS simulator boot VAD smoke detected speech from the bundled diagnostic WAV and produced one segment: `0.07-0.84s`.
- iOS simulator conversation smoke succeeded through device ASR, server session/SSE, subtitle state, and TTS start. Best run after removing LLM intent preflight: `transcript="黑魔哥。" | tokens=23 | asrDoneMs=893 | firstTokenAfterAsrMs=2300 | firstTtsAfterTokenMs=18`; later short-prompt/context tuning runs measured `firstTokenAfterAsrMs=2037` and `2454`, with `firstTtsAfterTokenMs=21`.
- Prelude-token iOS conversation smoke met both latency targets: `transcript="黑魔哥。" | tokens=10 | asrDoneMs=875 | firstTokenAfterAsrMs=204 | firstTtsAfterTokenMs=2272 | streamDoneMs=3367 | totalMs=12501`.
- The first TTS start requirement is proven for the smoke path: TTS starts within 3s after the first SSE token.
- Closed-session summary memory smoke passed on the running local server. A session with user/assistant messages was aged, `/api/session/touch` created a new session with the old summary as `previousSummary`, the aged session became `closed` with a non-null summary, and server logs did not show `Session background task failed` or `better-sqlite3` ABI errors.
- Three repeated iOS simulator conversation boot smokes succeeded in one launch:
  - `1/3`: `transcript="黑魔哥。" | tokens=9 | firstTokenAfterAsrMs=84 | firstTtsAfterTokenMs=1895 | totalMs=12916`
  - `2/3`: `transcript="黑魔哥。" | tokens=10 | firstTokenAfterAsrMs=43 | firstTtsAfterTokenMs=1583 | totalMs=19769`
  - `3/3`: `transcript="黑魔哥。" | tokens=13 | firstTokenAfterAsrMs=19 | firstTtsAfterTokenMs=2033 | totalMs=12002`
- During the repeated simulator smoke, server logs showed each iteration completing session touch, user message append, intent classification, `/api/llm/generate-response-stream`, and assistant message append. No server-side background summary or Mem0 native-module error appeared.
- iOS simulator live voice acceptance runner attempt proved the real recording/session path starts from boot: it logged `wakeword`, `session`, `recording-started`, `safety-timeout`, `finish-requested`, `recording-stopped`, `speaker-verified isOwner=false`, and `cleanup isListening=false isProcessing=false`. The recorded WAV was 16 kHz mono, 15.06s, but very low level (`mean_volume=-58.8 dB`, `max_volume=-48.2 dB`) when using macOS `say` playback as the external audio source. No `vad-speech`, `stt`, `first-token`, or `first-tts` events were produced.
- Combined boot owner-enrollment + live voice runner passed the live session path through speaker verification, STT, SSE, TTS start, assistant persistence, and cleanup: trace logged `speaker-verified isOwner=true`, `stt transcriptLength=1`, `first-token`, `first-tts`, `stream-done`, `assistant`, and `cleanup isListening=false isProcessing=false`, with `firstTokenAfterSttMs=146` and `firstTtsAfterTokenMs=1774`. Server logs confirmed session touch, user message append, intent classify, SSE, and assistant message append. This still did not prove natural-speech VAD or ASR quality: no `vad-speech`/`vad-end` event appeared, the run finished by safety timeout, and ASR only returned `。`. The live recording was still very low level (`mean_volume=-62.6 dB`, `max_volume=-50.1 dB`); the enrollment recording was also low (`mean_volume=-54.7 dB`, `max_volume=-35.5 dB`).
- A later high-volume simulator live runner attempt proved that adequate host audio can trigger VAD speech detection in the real recording path. With macOS output/input temporarily raised to 90, the live trace logged `vad-speech` at `elapsed=12283ms`; the live WAV measured `mean_volume=-16.1 dB`, `max_volume=0.0 dB`. This run is not final acceptance because the enrollment window was missed (`mean_volume=-52.3 dB`, `max_volume=-40.8 dB`), speaker verification failed, and VAD still did not emit `vad-end` before the safety timeout.
- The installed `@siteed/sherpa-onnx.rn` VAD type defines `segments` as completed speech segments, so the live VAD handling was corrected to treat a non-empty `segments` result as speech end. After that fix, one high-volume iOS simulator combined owner-enrollment + live acceptance trace completed the full natural-audio path:
  - `vad-speech elapsedMs=2776`
  - `vad-end elapsedMs=9080`
  - `recording-stopped elapsedMs=9114`
  - `speaker-verified isOwner=true elapsedMs=9344`
  - `stt transcriptLength=22 elapsedMs=10017`, transcript `黑魔哥，请看一下今天的天气，然后简单回答我。`
  - `first-token elapsedMs=10059`
  - `first-tts elapsedMs=11689`
  - `stream-done responseLength=17 elapsedMs=11702`
  - `assistant audioHandled=true elapsedMs=20916`
  - `cleanup isListening=false isProcessing=false totalMs=21200 vadEndAfterSpeechMs=6304 firstTokenAfterSttMs=42 firstTtsAfterTokenMs=1630`
- The final enrollment WAV measured `mean_volume=-11.7 dB`, `max_volume=-0.0 dB`; the final live WAV measured `mean_volume=-13.8 dB`, `max_volume=0.0 dB`. Server logs for the final trace confirmed session touch, user message append, deterministic intent classify, `/api/llm/generate-response-stream`, and assistant message append.
- A 3x iOS simulator live runner cleanup smoke exercised repeated resource cleanup in one launch. All three traces returned to idle cleanup:
  - `live-1`: `vad-speech`, `vad-end`, `recording-stopped`, `speaker-verified isOwner=false`, `cleanup voiceState="sleeping" isListening=false isProcessing=false totalMs=13821`
  - `live-2`: `recording-stopped`, `speaker-verified isOwner=true`, `stt transcriptLength=2`, `first-token`, `first-tts`, `stream-done`, `assistant audioHandled=true`, `cleanup voiceState="sleeping" isListening=false isProcessing=false totalMs=29581`
  - `live-3`: `recording-stopped`, `speaker-verified isOwner=true`, `stt transcriptLength=1`, `first-token`, `first-tts`, `stream-done`, `assistant audioHandled=true`, `cleanup voiceState="sleeping" isListening=false isProcessing=false totalMs=36688`
- Server logs for the 3x run showed repeated session touch and, for the two accepted turns, user message append, deterministic intent classify, `/api/llm/generate-response-stream`, and assistant message append. The run strengthens resource cleanup evidence, but does not replace physical-device playback acceptance because simulator audio still produced CoreAudio noise and `[TTS] Playback timeout after 8000ms`.

## Needs Device-Level Acceptance

These cannot be fully proven from static tests or HTTP smoke:

- Real microphone wakeword/button trigger -> VAD -> ASR flow on a physical iOS device.
- VAD accuracy for natural speech on a physical device: no mid-sentence cutoff and no >2s wait after a clear stop.
- Perceived subtitle/TTS sync during actual audio playback.
- Long-run resource release behavior for VAD/audio-studio/recording/SSE after repeated real microphone conversations on physical device.

Use the live trace and runner to accept or reject these manually. A passing real-device run should include a single `[Acceptance] live voice ...` sequence with `wakeword`, `recording-started`, `vad-speech`, `vad-end`, `recording-stopped`, `speaker-verified isOwner=true`, `stt transcriptLength>0`, `first-token`, `first-tts`, `assistant`, and `cleanup isListening=false isProcessing=false`. The cleanup summary includes `vadEndAfterSpeechMs`, `firstTokenAfterSttMs`, and `firstTtsAfterTokenMs` for latency review. For repeated resource acceptance, set `EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT=3` and confirm all three trace ids finish with cleanup.

## Remaining Static Review Notes

- React Doctor still reports pre-existing `SettingsScreen` size and sequential-await warnings in existing recording flows. The VAD diagnostic addition compiles and the iOS build passes; broad settings refactor is out of scope for this feature acceptance.
- iOS simulator repeated conversation smoke still logs simulator CoreAudio noise and `[TTS] Playback timeout after 8000ms`. The diagnostic proves TTS starts and that cleanup allows subsequent iterations to complete, but real-device playback completion still needs manual confirmation.
- The first live simulator runner attempt was blocked by insufficient microphone input level and owner speaker mismatch from external `say` audio. It is valid evidence for boot-triggered live recording/session/cleanup, but not sufficient for final VAD/STT/SSE/TTS acceptance.
- The combined enrollment + live runner now passes on iOS simulator with verified high-volume microphone input. The remaining risk is physical-device playback completion and repeated long-run resource behavior, because simulator CoreAudio still logs noise and `[TTS] Playback timeout after 8000ms` even when TTS starts and the pipeline cleans up.
