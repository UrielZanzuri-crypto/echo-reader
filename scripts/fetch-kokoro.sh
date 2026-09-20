#!/bin/bash
# Fetch the Kokoro model into models for the voice-comparison spike.
# The weights are too large for git, so they are ignored and re-fetched with this.
set -euo pipefail
cd "$(dirname "$0")/.."
B=https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main
M=models/onnx-community/Kokoro-82M-v1.0-ONNX
mkdir -p "$M/onnx" models/kokoro-voices models/ort

for f in config.json tokenizer.json tokenizer_config.json; do curl -fsL "$B/$f" -o "$M/$f"; done
for f in model_quantized.onnx model_fp16.onnx model.onnx; do
  [ -f "$M/onnx/$f" ] || curl -fL --progress-bar "$B/onnx/$f" -o "$M/onnx/$f"
done
for v in af_heart af_bella af_nicole bf_emma am_michael am_puck am_fenrir bm_fable bm_george; do
  curl -fsL "$B/voices/$v.bin" -o "models/kokoro-voices/$v.bin"
done
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.{wasm,mjs} models/ort/
echo "Kokoro assets ready ($(du -sh models | cut -f1))."
