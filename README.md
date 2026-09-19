# Echo Reader

A text-to-speech reader that runs entirely on your machine. Paste text or open a
`.txt`, `.md` or `.pdf` file, press play, and follow along as the current word is
highlighted in time with the voice.

**Nothing leaves this computer, and nothing is fetched from the internet.** Speech
comes from the macOS system voices through the browser's `speechSynthesis` API;
PDF parsing uses `pdf.js` installed from npm and bundled into the app, including
its worker and character maps. After `npm install`, the app never makes a network
request — verified by loading a PDF with the network panel open: every resource
comes from `localhost`.

## Running it

**Double-click `Echo Reader.app`** in this folder. That is all it needs — it starts
a local server and opens the reader in your browser.

The app is a launcher, not a copy of the project: it lives next to `src/` and
`dist/` and depends on them, so keep it in this folder (make an alias or drag it
to the Dock if you want it elsewhere). On first launch it installs dependencies
and builds if that has not happened yet, and it rebuilds automatically whenever
you edit something under `src/`.

The server it starts listens on `127.0.0.1` only, so nothing on your network can
reach it. It stops by itself after six idle hours, or immediately with
`npm run stop`. Launching the app again while it is already running just opens a
new tab.

<details>
<summary>Why a server at all, rather than opening the HTML file?</summary>

Because `file://` is a dead end for this app: browsers block ES modules and web
workers under that origin, so both the app's own code and pdf.js would refuse to
load. A loopback server is the smallest thing that makes the page behave like a
real page while staying entirely on this machine.
</details>

### From the terminal instead

```bash
npm install     # once, needs the network; also vendors pdf.js assets into public/
npm start       # build, serve at http://localhost:4173, open a browser
npm stop        # stop the background server
npm run dev     # development server with hot reload, http://localhost:5173
npm test        # 59 unit and integration tests, no browser required
```

`npm run build` writes `dist/`, a plain folder of static files that any static
server can host (`npx serve dist`, `python3 -m http.server -d dist`, …).

### Sending it to another Mac

```bash
npm run package -- --with-node        # -> "Echo Reader.zip", about 40 MB, nothing to install
npm run package -- --with-node x64    # for an Intel Mac
npm run package                       # smaller, but the other Mac needs Node.js installed
```

The zip holds the launcher, the built site, the tiny server and a read-me — no
sources, no build step, no network on the other side. `--with-node` puts the
official Node binary from nodejs.org inside it. On arrival: unzip, keep the
folder together, double-click `Echo Reader.app`. macOS will say it cannot
verify the app because it is not notarized — on macOS 15 that is *System
Settings › Privacy & Security › Open Anyway*; on older versions, right-click ›
Open. Then allow folder access when asked. The read-me in the zip says the same.

### Rebuilding the launcher

```bash
npm run make-app    # regenerates the icon and "Echo Reader.app"
```

The icon is drawn in `build/icon.svg` and rasterised with headless Chrome, since
macOS has no command-line SVG renderer. Edit the SVG and re-run to change it.

## Using it

| | |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>Esc</kbd> | Stop, or close an open panel |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next sentence |
| <kbd>↑</kbd> <kbd>↓</kbd> | Speed down / up |
| <kbd>O</kbd> <kbd>E</kbd> <kbd>S</kbd> | Open file, edit text, settings |
| Click a word | Start reading from there |

Drag a file anywhere onto the window to open it. Speed runs from 0.5× to 3×.
Voice, speed, theme, type size and highlight style are remembered, as is your
place in the current document (documents under ~400k characters are cached in
`localStorage`; larger ones still work, they are just not restored on reload).

**More voices.** macOS ships a small default set and downloads the good ones on
demand: *System Settings › Accessibility › Spoken Content › System Voice › Manage
Voices*. The "Premium" and "Enhanced" entries are worth the download; they appear
in the app's voice menu after a browser restart. The *Offline voices only* switch
in Settings hides the browser's cloud voices (Chrome's "Google …" entries), which
would otherwise send your text to a server.

## Voices: why some sound like a robot

macOS ships three very different kinds of voice, and the browser lists them all
in one flat array (191 entries on a typical Mac):

| Kind | Examples | What it is | Sound |
|---|---|---|---|
| **Vocalizer (Nuance)** | Samantha, Aaron, Daniel, Karen, Moira, Tessa | Recorded-speech synthesis; ships in a *compact* tier, with **Enhanced** and **Premium** tiers to download | Good, and the downloads are noticeably better |
| **Eloquence** | Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy, Shelley — in every language | A 1990s formant synthesiser added in macOS 14 for screen-reader users who want speed over naturalness | The "crashed robot" |
| **Novelty** | Zarvox, Trinoids, Bells, Bubbles, Cellos, Bad News… | 1990s Mac toys | Deliberately silly |

Echo Reader hides the last two kinds unless *Show all voices* is switched on in
Settings, and the speaker button beside the voice menu previews the selection.
For the best voices: *System Settings › Accessibility › Spoken Content › System
Voice › Manage Voices…*, download the Enhanced or Premium versions of the ones
you like, then restart the browser. Safari also exposes the Siri voices; Chrome
does not.

## Focus tools

Four features for reading with a wandering mind, chosen for the strength of the
evidence behind them rather than popularity. All in Settings › Focus.

- **Background noise** (white / pink / brown, <kbd>N</kbd>). Moderate broadband
  noise improves attention and memory in people with inattentive ADHD
  (Söderlund et al., 2007, 2010; replicated since — the "stochastic resonance"
  effect). Generated with the Web Audio API, no audio files, still offline.
  Pink and brown are the same idea with less hiss.
- **Dimming** (<kbd>F</kbd>): everything except the current sentence or
  paragraph fades. The same idea as Immersive Reader's Line Focus: less visual
  crowding, less re-reading. On PDF pages the fade is drawn per text run, so
  figures stay exactly as they are.
- **"Still reading?" check-ins** every 3, 5 or 10 minutes. Thought-probe studies
  (Smallwood & Schooler) show that being asked catches mind-wandering that goes
  unnoticed otherwise. Answer with <kbd>Enter</kbd> or a tap; no answer for 12 s
  and reading pauses, resuming from the start of the sentence — so the voice
  never reads on to an empty room.
- **Pause when you switch away.** Same failure, caught earlier: leaving the tab
  or window pauses, and play picks up from the start of the sentence.

Not included, deliberately: binaural beats (meta-analyses find small,
inconsistent effects) and "bionic" bold-prefix reading (a 2,000-participant
study found no benefit).

## How it works

Four modules do the real work, and the whole design rests on one invariant: the
document is normalized **once** into a canonical string, and from then on every
part of the app addresses text by character offsets into that string. The renderer
draws from those offsets and the speech engine reports positions in the same
coordinate space, which is what makes the highlight line up.

| File | Responsibility |
|---|---|
| `src/lib/normalize.js` | Raw input → one canonical string. Line endings, invisible characters, de-hyphenation of words broken across lines, un-wrapping of hard-wrapped paragraphs. |
| `src/lib/segmenter.js` | Canonical string → paragraphs, sentences, words, speech chunks — all as `{start, end}` ranges. |
| `src/lib/engine.js` | `speechSynthesis` wrapper: queueing, transport, position reporting. |
| `src/lib/reader.js` | Rendering and highlight painting. |
| `src/lib/importers.js` | `.txt` / `.md` reading and PDF text extraction. |
| `src/main.js` | Wiring, settings, keyboard, drag and drop. |
| `scripts/serve.mjs` | The loopback static server, no dependencies. |
| `scripts/launcher.sh` | What `Echo Reader.app` actually runs. |

### The tricky part: keeping the highlight on the right word

The Web Speech API is implemented inconsistently across browsers and voices, so
`engine.js` works around each failure mode explicitly:

- **Long utterances get truncated.** Chrome silently stops after roughly 15
  seconds of audio. Text is therefore split into chunks of at most 180 characters,
  broken at sentence ends and then at clause punctuation, and queued one utterance
  at a time. `boundary.charIndex` is relative to the utterance, so it is rebased
  onto the document using the chunk's own start offset.

- **`cancel()` is racy.** It fires `end` on the utterance it kills, and a `speak()`
  issued in the same task is often dropped. Every utterance carries a generation
  token so stale events are ignored, and restarts are deferred one macrotask.

- **A voice's idea of "a word" is not the reader's.** macOS reports
  `Dr. E. M. Whitfield` and `9.30 a.m.` as *single* boundary events with a
  `charLength` covering the whole run. Highlighting the word token under
  `charIndex` would leave four words unhighlighted while they were being spoken, so
  the engine highlights exactly the reported span, and falls back to the word token
  only when `charLength` is missing (Safari).

- **Some voices never fire `boundary` at all**, and some fire only `sentence`
  events. A position estimator runs as a fallback, driven by the clock and
  calibrated against the speed the voice actually achieved on previous chunks. Real
  boundary events act as anchors and shut the estimator off as soon as one arrives.

- **Playback stalls.** A watchdog notices when the engine has gone quiet without
  firing `end` and restarts from the last known word, giving up after three
  attempts rather than looping.

- **`pause()` is sometimes a no-op.** The engine checks 350 ms later whether the
  pause actually took, and if not, cancels and re-speaks from the current word on
  resume.

### Painting the highlight

Where the browser supports the **CSS Custom Highlight API** (Chrome 105+, Safari
17.2+), the active ranges are painted without touching the DOM at all — about
0.01 ms per repaint, which matters at 3× where the marker moves eight times a
second. Older browsers fall back to injecting spans into the one paragraph that
contains the active sentence. Both paths were checked against a 580,000-character
document (1,800 paragraphs, 113,000 words): it loads in well under a second and
repaints in 0.01 ms / 0.14 ms respectively.

### PDFs as pages

A PDF opens as its real pages — figures, columns, fonts — drawn by pdf.js onto
a canvas per page, rendered lazily as they scroll into reach. The highlight is
painted on top: every text run on a page comes with its coordinates, and the
extractor records which slice of the canonical text each run produced, so the
marker for a span is just the boxes of the runs it touches, clipped horizontally
in proportion to their characters. Clicking a run starts reading from there.
The **Pages / Plain text** button (or <kbd>V</kbd>) switches to the text view,
which is also what a PDF falls back to after a reload, since only the text is
cached.

Two-column pages are put into reading order by looking at the horizontal
extents of consecutive lines: narrow lines that fall into separate bands form a
block of columns, each emitted whole before the next; a line that spans the page
ends the block. This works whether or not the columns share baselines.

### Text extraction

`.txt` files are checked for hard wrapping — if most lines stop around column 70
without ending a sentence, the line breaks are treated as wraps and folded away so
sentences are not read as fragments. `.md` files have their syntax stripped so
headings and emphasis are not pronounced.

PDFs have no notion of a line, let alone a paragraph: pdf.js hands back positioned
glyph runs. `pageToText()` groups runs by baseline, orders them left to right,
inserts spaces where the horizontal gap is wider than the glyphs explain, and
promotes a vertical gap wider than the page's line pitch to a paragraph break. The
pitch is estimated with the lower quartile of the gaps rather than the median,
because paragraph gaps are the minority but are large enough to drag a median up
and hide every break on a short page.

### Testing

`npm test` runs 47 tests on Node's built-in runner — no browser, no test
framework. The segmenter tests cover the cases that break naive sentence splitting
(`Dr.`, `J. R. R. Tolkien`, `3.50`, `example.com`, `"Stop!"`, `...`). The engine
tests run the real engine against a fake `speechSynthesis` that can impersonate a
voice with full boundary data, one without `charLength`, or one that reports
nothing at all, and check chunk sequencing, pause/resume, seeking, mid-playback
rate changes and cancellation. The server tests check that it serves the pdf.js
assets with types the browser will accept, refuses to serve anything outside
`dist/`, and survives the malformed request paths that a browser really does
send.

The browser-only paths — real voices, highlighting, PDF loading, drag and drop —
were verified by hand in Chrome on macOS.

### Poking at it from the console

The app leaves its internals reachable for debugging:

```js
echoReader.engine.play(0)          // start from the top
echoReader.engine.span             // the range being spoken right now
echoReader.document.model.sentences // all sentence ranges
```
