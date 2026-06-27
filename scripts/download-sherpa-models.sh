#!/bin/bash
# Download app-side sherpa-onnx models without committing large artifacts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_ROOT="${MODEL_ROOT:-$ROOT_DIR/app-models/sherpa-onnx}"
SENSEVOICE_DIR="$MODEL_ROOT/asr/sensevoice"
KWS_DIR="$MODEL_ROOT/kws/looi"
SPEAKER_DIR="$MODEL_ROOT/speaker-id/looi"
TMP_DIR="$MODEL_ROOT/.tmp"

cleanup() {
  rm -rf "$TMP_DIR" "$SENSEVOICE_DIR/.cache"
}
trap cleanup EXIT

mkdir -p "$SENSEVOICE_DIR" "$KWS_DIR" "$SPEAKER_DIR" "$TMP_DIR"

if command -v hf >/dev/null 2>&1; then
  HF_DOWNLOAD=(hf download)
elif command -v huggingface-cli >/dev/null 2>&1; then
  HF_DOWNLOAD=(huggingface-cli download)
else
  echo "Hugging Face CLI is required. Install with: pip install -U huggingface_hub"
  exit 1
fi

require_file() {
  local path="$1"
  if [ ! -s "$path" ]; then
    echo "Required model file is missing or empty: $path" >&2
    exit 1
  fi
}

download_url() {
  local url="$1"
  local output="$2"
  if [ -s "$output" ]; then
    return
  fi
  curl -L --fail --retry 3 --retry-delay 2 "$url" -o "$output"
}

echo "Downloading SenseVoice STT model..."
"${HF_DOWNLOAD[@]}" \
  csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 \
  model.int8.onnx tokens.txt \
  --local-dir "$SENSEVOICE_DIR"

echo "Downloading KWS zipformer model..."
KWS_ARCHIVE="$TMP_DIR/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2"
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2" \
  "$KWS_ARCHIVE"
tar -xjf "$KWS_ARCHIVE" -C "$TMP_DIR"
KWS_EXTRACTED="$TMP_DIR/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile"
cp "$KWS_EXTRACTED/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
  "$KWS_DIR/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
cp "$KWS_EXTRACTED/decoder-epoch-12-avg-2-chunk-16-left-64.onnx" \
  "$KWS_DIR/decoder-epoch-12-avg-2-chunk-16-left-64.onnx"
cp "$KWS_EXTRACTED/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
  "$KWS_DIR/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
cp "$KWS_EXTRACTED/tokens.txt" "$KWS_DIR/tokens.txt"

if [ ! -f "$KWS_DIR/keywords.txt" ]; then
  cat > "$KWS_DIR/keywords_raw.txt" <<'EOF'
嘿魔戈 @HEY_MOGE
EOF

  if command -v sherpa-onnx-cli >/dev/null 2>&1; then
    sherpa-onnx-cli text2token \
      --tokens "$KWS_DIR/tokens.txt" \
      --tokens-type ppinyin \
      "$KWS_DIR/keywords_raw.txt" \
      "$KWS_DIR/keywords.txt"
  else
    echo "KWS model downloaded, but keywords.txt still needs sherpa-onnx-cli."
    echo "Install sherpa-onnx-cli and run:"
    echo "  sherpa-onnx-cli text2token --tokens \"$KWS_DIR/tokens.txt\" --tokens-type ppinyin \"$KWS_DIR/keywords_raw.txt\" \"$KWS_DIR/keywords.txt\""
  fi
fi

echo "Downloading Speaker ID model..."
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
  "$SPEAKER_DIR/model.onnx"

require_file "$SENSEVOICE_DIR/model.int8.onnx"
require_file "$SENSEVOICE_DIR/tokens.txt"
require_file "$KWS_DIR/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/decoder-epoch-12-avg-2-chunk-16-left-64.onnx"
require_file "$KWS_DIR/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/tokens.txt"
require_file "$KWS_DIR/keywords.txt"
require_file "$SPEAKER_DIR/model.onnx"

echo "Models downloaded under: $MODEL_ROOT"
echo "Keep .env model dirs pointed at app-models/sherpa-onnx/* for local native builds."
