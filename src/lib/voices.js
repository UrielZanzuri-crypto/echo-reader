/**
 * Voice classification and ordering.
 *
 * macOS ships three very different kinds of voice and speechSynthesis lists them
 * all in one flat array. Two of the kinds sound awful for listening to a book,
 * and they make up most of the list:
 *
 *  - Eloquence (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy, Shelley, in
 *    every language): a 1990s formant synthesiser added in macOS 14 for screen
 *    reader users who want speed over naturalness. The "crashed robot".
 *  - Novelty voices (Zarvox, Trinoids, Bells, Bubbles, ...): 1990s Mac toys.
 *  - Everything else is a Nuance Vocalizer voice (Samantha, Daniel, Karen, ...).
 *    Those come in compact, Enhanced and Premium tiers; the better tiers have to
 *    be downloaded in System Settings and all report as `localService`.
 *
 * The app hides the first two groups unless asked to show everything.
 */

const ELOQUENCE = new Set(['eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley'])

const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news',
  'jester', 'junior', 'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
  'fred', 'kathy', 'ralph', 'hysterical', 'pipe organ', 'deranged',
])

/** "Eddy (English (UK))" -> "eddy"; "Bad News" -> "bad news". */
export function baseName(name) {
  return String(name || '')
    .replace(/\s*\(.*$/, '')
    .trim()
    .toLowerCase()
}

/** @returns {'natural' | 'eloquence' | 'novelty'} */
export function classifyVoice(voice) {
  const base = baseName(voice?.name)
  if (ELOQUENCE.has(base)) return 'eloquence'
  if (NOVELTY.has(base)) return 'novelty'
  return 'natural'
}

/** Voices worth offering by default: natural ones, or all when the user asks. */
export function filterVoices(voices, { localOnly = true, showAll = false } = {}) {
  let list = voices || []
  if (!showAll) list = list.filter((v) => classifyVoice(v) === 'natural')
  const local = list.filter((v) => v.localService)
  // Fall back to the full list if this browser reports no local voices at all,
  // otherwise the dropdown would be empty and nothing could be spoken.
  if (localOnly && local.length) list = local
  return list
}

/** Rank: exact UI language first, then same base language, then everything else. */
export function languageRank(voice, uiLang) {
  const want = String(uiLang || 'en-US').toLowerCase().replace('_', '-')
  const lang = String(voice?.lang || '').toLowerCase().replace('_', '-')
  if (lang === want) return 0
  if (lang.split('-')[0] === want.split('-')[0]) return 1
  return 2
}

/** Downloaded Premium/Enhanced voices outrank the compact ones they replace. */
export function qualityRank(voice) {
  const name = String(voice?.name || '').toLowerCase()
  if (/premium/.test(name)) return 0
  if (/enhanced/.test(name)) return 1
  if (/siri/.test(name)) return 0
  return 2
}

export function sortVoices(voices, uiLang) {
  return [...voices].sort(
    (a, b) =>
      languageRank(a, uiLang) - languageRank(b, uiLang) ||
      String(a.lang || '').localeCompare(String(b.lang || '')) ||
      qualityRank(a) - qualityRank(b) ||
      String(a.name || '').localeCompare(String(b.name || ''))
  )
}

/** One sentence that shows off prosody, numbers and a question. */
export const PREVIEW_SENTENCE =
  'Reading along at 9.30 in the morning, does this voice sound right to you?'
