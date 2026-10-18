# Third-party notices

Echo Reader's own code is under the MIT license (`LICENSE`). The built app —
`dist/` and the zip made by `npm run package` — also contains the components
below, each under its own license. Full texts are in `licenses/`.

| Component | Used for | License |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Opening and drawing PDFs | Apache-2.0 |
| pdf.js standard fonts | Fallback fonts for PDFs that do not embed theirs | Foxit: BSD-style (`licenses/Foxit-fonts.txt`); Liberation: SIL OFL 1.1 (`licenses/Liberation-fonts-OFL.txt`) |
| [kokoro-js](https://github.com/hexgrad/kokoro) | Running the neural voices | Apache-2.0 |
| [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | Model runtime glue | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Running the model (WebGPU / WASM) | MIT |
| [phonemizer.js](https://github.com/xenova/phonemizer.js) | Text → phonemes for the neural voices | Apache-2.0 for the wrapper; it embeds eSpeak NG, see below |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng), compiled to WebAssembly inside phonemizer.js | Pronunciation rules and dictionaries | **GPL-3.0-or-later** (`licenses/GPL-3.0.txt`) |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model and voices (ONNX export by [onnx-community](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) | The neural voices — only in packages built with `--with-voices`, otherwise fetched by `npm run fetch-kokoro` | Apache-2.0 |
| [Node.js](https://nodejs.org) | Runs the local server — only in packages built with `--with-node` | MIT (with the notices in Node's own `LICENSE`) |

## About eSpeak NG and the GPL

eSpeak NG is licensed under the GNU GPL, version 3 or later, and it is compiled
into the neural-voice bundle (`kokoro-worker-*.js`). Anyone who passes on a
built copy of Echo Reader therefore passes it on under the GPL's terms as
well: the recipient may use, study, change and share it, and the complete
source code is available — Echo Reader's in this repository, and eSpeak NG's at
<https://github.com/espeak-ng/espeak-ng> (as packaged by phonemizer.js at
<https://github.com/xenova/phonemizer.js>). Echo Reader's own MIT-licensed code
is compatible with this.

## Not bundled

The macOS system voices (Samantha, Daniel, the Siri voices and so on) belong to
Apple and are not part of Echo Reader. The app only asks the browser to use the
voices already installed on the Mac.
