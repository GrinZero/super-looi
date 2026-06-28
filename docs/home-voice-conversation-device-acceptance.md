# Physical Device Voice Acceptance Runbook

Use this when a physical iOS device is connected. The simulator path is already covered; this runbook closes the remaining physical microphone/playback gap.

## Preconditions

- Local server reachable from the device using `EXPO_PUBLIC_LOOI_SERVER_URL`.
- Required environment variables loaded from `.env`.
- VAD, STT, TTS, KWS, and speaker-id models downloaded in the app.
- Device microphone and speaker are usable in a normal room.

## Single Conversation Acceptance

For the scripted flow, connect the device and run:

```sh
pnpm voice:accept-device -- "<physical device name>"
```

The script starts the local server, runs Expo with live acceptance tracing, writes a timestamped log under `output/voice-device-acceptance/`, and stops the server afterward. Set `LOOI_ACCEPTANCE_REPEAT=1` for a single run, or keep the default `3` for repeated acceptance.

For a manual run:

1. Start the server:

   ```sh
   pnpm --dir server dev
   ```

2. In a second terminal, run the app on the physical device:

   ```sh
   EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 \
   pnpm exec expo run:ios --device "<physical device name>"
   ```

3. Enroll owner voice in Settings if needed.

4. From the main screen, trigger wakeword/button listening and speak one normal request, for example:

   ```text
   黑魔哥，请看一下今天的天气，然后简单回答我。
   ```

5. Accept only if one trace contains:

   ```text
   wakeword
   recording-started
   vad-speech
   vad-end
   recording-stopped
   speaker-verified isOwner=true
   stt transcriptLength>0
   first-token
   first-tts
   assistant
   cleanup isListening=false isProcessing=false
   ```

6. Check timing:

   - `firstTokenAfterSttMs <= 2000`
   - `firstTtsAfterTokenMs <= 3000`
   - VAD does not cut off mid-sentence.
   - VAD stops within about 2 seconds after a clear stop.

7. Confirm by observation:

   - User transcript appears on the main-screen overlay.
   - LOOI response streams as subtitles.
   - TTS starts while subtitles are visible.
   - Spoken response matches the displayed assistant text.
   - UI returns to idle without a stuck listening/processing state.

## Repeated Resource Acceptance

Run a repeated boot acceptance after owner voice is enrolled:

```sh
EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE=1 \
EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT=1 \
EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT=3 \
pnpm exec expo run:ios --device "<physical device name>"
```

For each prompt, speak a short normal request. Accept only if all three trace ids finish with:

```text
assistant
cleanup isListening=false isProcessing=false
```

No trace should leave the app stuck in listening, processing, or speaking. Server logs should show the matching session touch, user message append, streaming response, and assistant message append for accepted turns.

## Cleanup

- Stop Metro and the server.
- Confirm no server remains on port 8080:

  ```sh
  lsof -nP -iTCP:8080 -sTCP:LISTEN || true
  ```

- Record the trace ids, timing fields, and any observed playback issues in `docs/home-voice-conversation-acceptance.md`.
