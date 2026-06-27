#!/bin/bash
# Start llama.cpp server for MiniCPM-V vision inference
# Requires: llama.cpp compiled with Metal, model files downloaded

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

# Paths - adjust these to your local setup
LLAMA_SERVER="${LLAMA_SERVER:-$HOME/tools/llama.cpp/build/bin/llama-server}"
MODEL_DIR="${MODEL_DIR:-$HOME/models/minicpm-v-2.6}"
MODEL="${MODEL_DIR}/ggml-model-Q4_K_M.gguf"
MMPROJ="${MODEL_DIR}/mmproj-model-f16.gguf"

# Check files exist
if [ ! -f "$LLAMA_SERVER" ]; then
  echo "❌ llama-server not found at: $LLAMA_SERVER"
  echo "   Build it: cd ~/tools/llama.cpp && cmake -B build -DGGML_METAL=ON && cmake --build build --config Release"
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo "❌ Model not found at: $MODEL"
  echo "   Download: huggingface-cli download openbmb/MiniCPM-V-2_6-gguf ggml-model-Q4_K_M.gguf --local-dir $MODEL_DIR"
  exit 1
fi

if [ ! -f "$MMPROJ" ]; then
  echo "❌ MMProj not found at: $MMPROJ"
  echo "   Download: huggingface-cli download openbmb/MiniCPM-V-2_6-gguf mmproj-model-f16.gguf --local-dir $MODEL_DIR"
  exit 1
fi

echo "🚀 Starting MiniCPM-V vision server on port 8081..."
exec "$LLAMA_SERVER" \
  --model "$MODEL" \
  --mmproj "$MMPROJ" \
  --port 8081 \
  --host 0.0.0.0 \
  -ngl 99 \
  -c 4096 \
  --threads 8
