#!/bin/bash
# Download app-side sherpa-onnx models without committing large artifacts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_ROOT="${MODEL_ROOT:-$ROOT_DIR/app-models/sherpa-onnx}"
STREAMING_ASR_DIR="$MODEL_ROOT/asr/streaming-paraformer"
PUNCT_DIR="$MODEL_ROOT/punctuation"
KWS_DIR="$MODEL_ROOT/kws/looi"
SPEAKER_DIR="$MODEL_ROOT/speaker-id/looi"
TMP_DIR="$MODEL_ROOT/.tmp"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$STREAMING_ASR_DIR" "$PUNCT_DIR" "$KWS_DIR" "$SPEAKER_DIR" "$TMP_DIR"

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

echo "Downloading Streaming Paraformer ASR model..."
STREAMING_ASR_ARCHIVE="$TMP_DIR/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2"
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2" \
  "$STREAMING_ASR_ARCHIVE"
tar -xjf "$STREAMING_ASR_ARCHIVE" -C "$TMP_DIR"
STREAMING_ASR_EXTRACTED="$TMP_DIR/sherpa-onnx-streaming-paraformer-bilingual-zh-en"
cp "$STREAMING_ASR_EXTRACTED/encoder.int8.onnx" "$STREAMING_ASR_DIR/encoder.int8.onnx"
cp "$STREAMING_ASR_EXTRACTED/decoder.int8.onnx" "$STREAMING_ASR_DIR/decoder.int8.onnx"
cp "$STREAMING_ASR_EXTRACTED/tokens.txt" "$STREAMING_ASR_DIR/tokens.txt"

echo "Downloading CT-Punc model..."
PUNCT_ARCHIVE="$TMP_DIR/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2"
download_url \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2" \
  "$PUNCT_ARCHIVE"
tar -xjf "$PUNCT_ARCHIVE" -C "$TMP_DIR"
PUNCT_EXTRACTED="$TMP_DIR/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8"
cp "$PUNCT_EXTRACTED/model.int8.onnx" "$PUNCT_DIR/model.int8.onnx"

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

require_file "$STREAMING_ASR_DIR/encoder.int8.onnx"
require_file "$STREAMING_ASR_DIR/decoder.int8.onnx"
require_file "$STREAMING_ASR_DIR/tokens.txt"
require_file "$PUNCT_DIR/model.int8.onnx"
require_file "$KWS_DIR/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/decoder-epoch-12-avg-2-chunk-16-left-64.onnx"
require_file "$KWS_DIR/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
require_file "$KWS_DIR/tokens.txt"
require_file "$KWS_DIR/keywords.txt"
require_file "$SPEAKER_DIR/model.onnx"

echo "Models downloaded under: $MODEL_ROOT"
echo "Keep .env model dirs pointed at app-models/sherpa-onnx/* for local native builds."
