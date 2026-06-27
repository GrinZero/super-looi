# Phase 1 Sherpa Model Assets

App-side sherpa models are large and are not committed. Keep local copies under:

- `app-models/sherpa-onnx/asr/sensevoice/`
- `app-models/sherpa-onnx/kws/looi/`
- `app-models/sherpa-onnx/speaker-id/looi/`

Run:

```bash
bash scripts/download-sherpa-models.sh
```

Tooling used for the current local download:

```bash
python3 -m venv .venv-sherpa-tools
.venv-sherpa-tools/bin/python -m pip install -U pip huggingface_hub sherpa-onnx sentencepiece pypinyin
PATH="$PWD/.venv-sherpa-tools/bin:$PATH" bash scripts/download-sherpa-models.sh
```

Expected files:

- SenseVoice: `model.int8.onnx`, `tokens.txt`
- KWS: `encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`, `decoder-epoch-12-avg-2-chunk-16-left-64.onnx`, `joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`, `tokens.txt`, `keywords.txt`
- Speaker ID: `model.onnx`

The script downloads SenseVoice from Hugging Face and the mobile KWS/Speaker assets from the official `k2-fsa/sherpa-onnx` GitHub releases.

`@siteed/sherpa-onnx.rn` expects `keywordsFile` to be relative to `modelDir`, so `EXPO_PUBLIC_SHERPA_KEYWORDS_FILE` must stay `keywords.txt`.

Runtime model dirs match `@siteed/sherpa-onnx.rn`'s ArchiveService convention under device `documentDirectory/sherpa-onnx/`:

- `sherpa-onnx/asr/sensevoice`
- `sherpa-onnx/kws/looi`
- `sherpa-onnx/speaker-id/looi`

Before device validation, copy `app-models/sherpa-onnx/` into the app document directory so the final device paths contain:

- `<documentDirectory>/sherpa-onnx/asr/sensevoice/model.int8.onnx`
- `<documentDirectory>/sherpa-onnx/asr/sensevoice/tokens.txt`
- `<documentDirectory>/sherpa-onnx/kws/looi/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`
- `<documentDirectory>/sherpa-onnx/kws/looi/decoder-epoch-12-avg-2-chunk-16-left-64.onnx`
- `<documentDirectory>/sherpa-onnx/kws/looi/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`
- `<documentDirectory>/sherpa-onnx/kws/looi/tokens.txt`
- `<documentDirectory>/sherpa-onnx/kws/looi/keywords.txt`
- `<documentDirectory>/sherpa-onnx/speaker-id/looi/model.onnx`

The Settings page now has a "语音模型" check that reads those exact device paths and reports missing files before native ASR/KWS/Speaker initialization.

Android debug push workflow:

```bash
adb shell run-as com.anonymous.superlooiapp mkdir -p files
tar -C app-models -cf - sherpa-onnx | adb exec-out run-as com.anonymous.superlooiapp tar -C files -xf -
```

iOS simulator workflow after a successful iOS build:

```bash
APP_CONTAINER="$(xcrun simctl get_app_container booted com.anonymous.superlooiapp data)"
rsync -a app-models/sherpa-onnx "$APP_CONTAINER/Documents/"
```

Device validation is still required for iOS and Android. A green Settings model check only proves file placement; it does not prove ASR/KWS/Speaker behavior.
