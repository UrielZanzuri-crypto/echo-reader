/**
 * Persistence. Settings and the last document live in localStorage so the app
 * reopens where you left off -- no server, no network, no account.
 */

const SETTINGS_KEY = 'tts-reader:settings:v1'
const DOCUMENT_KEY = 'tts-reader:document:v1'
/** Documents larger than this are not cached; localStorage quota is ~5 MB. */
const MAX_CACHED_CHARS = 400_000

export const DEFAULT_SETTINGS = {
  voiceURI: '',
  rate: 1,
  pitch: 1,
  volume: 1,
  localVoicesOnly: true,
  highlightMode: 'both', // 'word' | 'sentence' | 'both' | 'off'
  autoScroll: true,
  theme: 'system', // 'system' | 'light' | 'dark' | 'sepia'
  fontSize: 20,
  lineHeight: 1.7,
  fontFamily: 'serif', // 'serif' | 'sans' | 'mono'
  columnWidth: 68,
  pdfView: 'page', // 'page' | 'text' -- how PDFs open
  showAllVoices: false, // include Eloquence and novelty voices in the menu
  // Focus tools
  noise: 'off', // 'off' | 'white' | 'pink' | 'brown'
  noiseVolume: 0.35,
  focusMode: 'off', // 'off' | 'sentence' | 'paragraph' -- dim everything else
  checkpointMinutes: 5, // 0 disables the "still reading?" prompts
  pauseWhenAway: true,
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    // Merge so settings added in a later version get their defaults.
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* private mode or full quota: settings simply do not persist */
  }
}

export function loadDocument() {
  try {
    const raw = localStorage.getItem(DOCUMENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.text === 'string' && parsed.text ? parsed : null
  } catch {
    return null
  }
}

export function saveDocument(doc) {
  try {
    if (!doc || !doc.text || doc.text.length > MAX_CACHED_CHARS) {
      localStorage.removeItem(DOCUMENT_KEY)
      return
    }
    localStorage.setItem(
      DOCUMENT_KEY,
      JSON.stringify({ text: doc.text, title: doc.title || '', charIndex: doc.charIndex || 0 })
    )
  } catch {
    /* over quota: skip caching, the app still works */
  }
}

export function clearDocument() {
  try {
    localStorage.removeItem(DOCUMENT_KEY)
  } catch {
    /* ignore */
  }
}
