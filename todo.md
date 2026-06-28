# Todo

- End-to-end latency requirements need device/server runtime measurement after implementation:
  - first reply token <= 2s after ASR returns was met in HTTP smoke (~1714ms), but iOS conversation smoke is still slightly over budget after optimization (`firstTokenAfterAsrMs=2037-2454`).
  - first TTS playback <= 3s after first token is met in iOS conversation smoke (`firstTtsAfterTokenMs=18-21`).
- Run one live microphone main-screen conversation on iOS simulator/device to confirm wakeword -> VAD -> ASR -> SSE -> TTS behavior with natural audio.
- Run repeated live conversations to check long-run VAD/audio-studio/recording/SSE resource release.
