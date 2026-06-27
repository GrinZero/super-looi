#!/bin/bash
# Download MiniCPM-V 2.6 GGUF models
MODEL_DIR="${MODEL_DIR:-$HOME/models/minicpm-v-2.6}"
mkdir -p "$MODEL_DIR"

echo "📥 Downloading MiniCPM-V 2.6 Q4_K_M (~4.7GB)..."
huggingface-cli download openbmb/MiniCPM-V-2_6-gguf ggml-model-Q4_K_M.gguf --local-dir "$MODEL_DIR"

echo "📥 Downloading mmproj (~0.6GB)..."
huggingface-cli download openbmb/MiniCPM-V-2_6-gguf mmproj-model-f16.gguf --local-dir "$MODEL_DIR"

echo "✅ Models downloaded to: $MODEL_DIR"
