# Synthetic voice fixture

`voice-recall-16k.pcm` is generated speech, not a microphone recording.

- Text: 请调用本机任务，回忆我保存的软件验收码。
- Format: signed PCM16 little-endian, mono, 16000 Hz; 142458 bytes.
- Generated on macOS with `say -v Tingting -r 160`, then converted with `ffmpeg -ar 16000 -ac 1 -f s16le`.

The native voice pipeline test supplies this data in 640-byte packets. It opens native playback only, uses an in-memory credential vault and deletes its uniquely named test memory afterward. Model write approvals are always rejected. This verifies synthetic ASR → shared Agent memory query → provider reply → native PCM playback without opening a microphone.
