/**
 * Spoken form: what the voice should say for a piece of text, and how to map
 * positions in what it says back to positions in the text.
 *
 * Equations are the case that needs this. The display must stay "E = mc²" and
 * "σ_x ≤ 3 − 2", but the voice should say "E equals m c squared" and "sigma sub x
 * less than or equal to three minus two". Both engines already address the
 * document by character offset, so every replacement is recorded as a span and
 * `toSource()` turns a position in the spoken text back into one in the source.
 * Outside those spans the two strings are identical, character for character.
 *
 * Nothing here depends on an engine: it is a pure function over strings.
 */

const GREEK = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta',
  η: 'eta', θ: 'theta', ϑ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', µ: 'mu',
  ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', ϱ: 'rho', σ: 'sigma', ς: 'sigma',
  τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  // Capitals that do not look like Latin letters are worth calling out as such.
  Γ: 'capital gamma', Δ: 'capital delta', Θ: 'capital theta', Λ: 'capital lambda',
  Ξ: 'capital xi', Π: 'capital pi', Σ: 'capital sigma', Φ: 'capital phi', Ψ: 'capital psi',
  Ω: 'capital omega',
  Α: 'alpha', Β: 'beta', Ε: 'epsilon', Ζ: 'zeta', Η: 'eta', Ι: 'iota', Κ: 'kappa', Μ: 'mu',
  Ν: 'nu', Ο: 'omicron', Ρ: 'rho', Τ: 'tau', Υ: 'upsilon', Χ: 'chi',
}

const SYMBOLS = {
  '=': 'equals', '≠': 'not equal to', '≈': 'approximately', '≃': 'approximately', '≅': 'congruent to',
  '≡': 'identical to', '≤': 'less than or equal to', '≥': 'greater than or equal to',
  '⩽': 'less than or equal to', '⩾': 'greater than or equal to', '≪': 'much less than',
  '≫': 'much greater than', '±': 'plus or minus', '∓': 'minus or plus', '×': 'times',
  '·': 'dot', '⋅': 'dot', '∘': 'composed with', '÷': 'divided by', '→': 'goes to', '⟶': 'goes to',
  '←': 'from', '↔': 'if and only if', '⇒': 'implies', '⇔': 'if and only if', '∝': 'proportional to',
  '∈': 'in', '∉': 'not in', '⊂': 'subset of', '⊆': 'subset of', '∪': 'union', '∩': 'intersection',
  '∀': 'for all', '∃': 'there exists', '∞': 'infinity', '∂': 'partial', '∇': 'del', '∆': 'delta',
  '∑': 'sum', '∏': 'product', '∫': 'integral', '∬': 'double integral', '∮': 'contour integral',
  '√': 'square root of', '∛': 'cube root of', 'ħ': 'h bar', 'ℏ': 'h bar', '°': 'degrees',
  '‖': 'norm', '∥': 'parallel to', '⊥': 'perpendicular to', '⊗': 'tensor', '⊕': 'direct sum',
  '†': 'dagger', '∅': 'empty set', 'ℓ': 'ell', '∼': 'similar to', '~': 'approximately',
  '%': 'percent', '‰': 'per mille', '−': 'minus', '∓': 'minus or plus',
}

const TEX = {
  alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', epsilon: 'epsilon', varepsilon: 'epsilon',
  zeta: 'zeta', eta: 'eta', theta: 'theta', vartheta: 'theta', iota: 'iota', kappa: 'kappa',
  lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', pi: 'pi', rho: 'rho', varrho: 'rho', sigma: 'sigma',
  tau: 'tau', upsilon: 'upsilon', phi: 'phi', varphi: 'phi', chi: 'chi', psi: 'psi', omega: 'omega',
  Gamma: 'capital gamma', Delta: 'capital delta', Theta: 'capital theta', Lambda: 'capital lambda',
  Xi: 'capital xi', Pi: 'capital pi', Sigma: 'capital sigma', Phi: 'capital phi', Psi: 'capital psi',
  Omega: 'capital omega',
  sum: 'sum', prod: 'product', int: 'integral', oint: 'contour integral', partial: 'partial',
  nabla: 'del', infty: 'infinity', pm: 'plus or minus', mp: 'minus or plus', times: 'times',
  cdot: 'dot', leq: 'less than or equal to', le: 'less than or equal to', geq: 'greater than or equal to',
  ge: 'greater than or equal to', neq: 'not equal to', ne: 'not equal to', approx: 'approximately',
  equiv: 'identical to', propto: 'proportional to', hbar: 'h bar', sqrt: 'square root of',
  rightarrow: 'goes to', to: 'goes to', leftarrow: 'from', in: 'in', forall: 'for all', exists: 'there exists',
  langle: 'bra', rangle: 'ket', dagger: 'dagger', ell: 'ell',
}

const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', 'ⁿ': 'n', 'ⁱ': 'i' }
const SUBSCRIPT = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n', 'ₖ': 'k', 'ₘ': 'm' }

const NUMBER_WORDS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' }

/** How to say an exponent: "squared", "cubed", "to the power of minus one". */
function powerWords(exp) {
  const e = exp.trim()
  if (e === '2') return 'squared'
  if (e === '3') return 'cubed'
  const spoken = e.replace(/^-/, 'minus ').replace(/^\+/, 'plus ')
  return `to the power of ${spellShort(spoken)}`
}

/** Single digits are safer as words for a subscript ("sub two", not "sub 2 .5"). */
function spellShort(s) {
  return /^\d$/.test(s) ? NUMBER_WORDS[s] : s
}

const WORD_CHAR = /[\p{L}\p{N}]/u
const CLOSERS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '”', '’'])

/**
 * @param {string} text
 * @param {{math?: boolean}} [options] math=false returns the identity mapping
 * @returns {{text: string, spans: {src:[number,number], out:[number,number]}[],
 *   toSource(i:number): number, toSourceEnd(i:number): number}}
 */
export function toSpoken(text, options = {}) {
  const { math = true } = options
  if (!math || !text) return identity(text)

  let out = ''
  const spans = []
  let pendingSpace = false

  const literal = (ch) => {
    if (pendingSpace && !/\s/.test(ch) && !CLOSERS.has(ch)) {
      out += ' '
      spans[spans.length - 1].out[1] = out.length
    }
    pendingSpace = false
    out += ch
  }

  /** Replace source [i, j) with `word`, keeping the words apart from their neighbours. */
  const replace = (i, j, word) => {
    let piece = word
    if (out.length && !/[\s([{"'\u201C\u2018]$/.test(out)) piece = ' ' + piece
    const outStart = out.length
    out += piece
    spans.push({ src: [i, j], out: [outStart, out.length] })
    pendingSpace = true
  }

  /** Record a substitution that must not be padded with spaces (𝑥𝑦 -> xy). */
  const substitute = (i, j, str) => {
    const outStart = out.length
    out += str
    spans.push({ src: [i, j], out: [outStart, out.length] })
    pendingSpace = false
  }

  const n = text.length
  let i = 0
  while (i < n) {
    const cp = text.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const len = ch.length
    const prev = i > 0 ? text[i - 1] : ''
    const next = i + len < n ? text[i + len] : ''

    // Characters the phonemiser would spell out as "letter 1d465": mathematical
    // italics/bold/script (𝑥 𝛼 𝐸), ligatures (ﬁ), full-width forms. NFKC folds them
    // to the plain letter, which then goes through the Greek table like any other.
    if (cp > 0x2fff && !GREEK[ch] && !SYMBOLS[ch] && !SUPERSCRIPT[ch] && !SUBSCRIPT[ch]) {
      const folded = ch.normalize('NFKC')
      if (folded !== ch && folded) {
        if (GREEK[folded]) replace(i, i + len, GREEK[folded])
        else substitute(i, i + len, folded)
        i += len
        continue
      }
      // Private-use glyphs from symbol fonts have no sound worth making.
      if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) {
        substitute(i, i + len, '')
        i += len
        continue
      }
    }

    // \alpha, \sum ... (pasted TeX)
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(text.slice(i, i + 16))
      if (m && TEX[m[1]]) {
        replace(i, i + m[0].length, TEX[m[1]])
        i += m[0].length
        continue
      }
    }

    // Exponents: ^2, ^{n+1}, and Unicode superscripts.
    if (ch === '^') {
      const m = /^\^(?:\{([^}]{1,24})\}|([A-Za-z0-9+\-]{1,6}))/.exec(text.slice(i, i + 32))
      if (m) {
        replace(i, i + m[0].length, powerWords(m[1] ?? m[2]))
        i += m[0].length
        continue
      }
    }
    if (SUPERSCRIPT[ch]) {
      let j = i
      let exp = ''
      while (j < n && SUPERSCRIPT[text[j]]) exp += SUPERSCRIPT[text[j++]]
      replace(i, j, powerWords(exp))
      i = j
      continue
    }

    // Subscripts: _x, _{ij}, and Unicode subscripts.
    if (ch === '_' && WORD_CHAR.test(prev || '')) {
      const m = /^_(?:\{([^}]{1,24})\}|([A-Za-z0-9+\-]{1,6}))/.exec(text.slice(i, i + 32))
      if (m) {
        replace(i, i + m[0].length, `sub ${spellShort(m[1] ?? m[2])}`)
        i += m[0].length
        continue
      }
    }
    if (SUBSCRIPT[ch]) {
      let j = i
      let sub = ''
      while (j < n && SUBSCRIPT[text[j]]) sub += SUBSCRIPT[text[j++]]
      replace(i, j, `sub ${spellShort(sub)}`)
      i = j
      continue
    }

    // Dirac notation: ⟨ψ| and |ψ⟩.
    if (ch === '⟨' || ch === '<') {
      const m = /^[⟨<]([^⟨⟩<>|]{1,4})\|/.exec(text.slice(i, i + 8))
      if (m) {
        replace(i, i + m[0].length, `bra ${toSpoken(m[1]).text.trim()}`)
        i += m[0].length
        continue
      }
    }
    if (ch === '|') {
      const m = /^\|([^⟨⟩<>|]{1,4})[⟩>]/.exec(text.slice(i, i + 8))
      if (m) {
        replace(i, i + m[0].length, `ket ${toSpoken(m[1]).text.trim()}`)
        i += m[0].length
        continue
      }
    }

    if (GREEK[ch]) {
      replace(i, i + 1, GREEK[ch])
      i++
      continue
    }

    // Spaced hyphen between operands is a minus; hyphens inside words are not.
    if (ch === '-' && /\s/.test(prev) && /\s/.test(next)) {
      replace(i, i + 1, 'minus')
      i++
      continue
    }
    if (ch === '*' && WORD_CHAR.test(prev) && WORD_CHAR.test(next)) {
      replace(i, i + 1, 'times')
      i++
      continue
    }
    if (ch === '/' && isFraction(text, i)) {
      replace(i, i + 1, 'over')
      i++
      continue
    }
    if ((ch === '<' || ch === '>') && /\s/.test(prev) && /\s/.test(next)) {
      replace(i, i + 1, ch === '<' ? 'less than' : 'greater than')
      i++
      continue
    }
    if (SYMBOLS[ch] && !(ch === '~' && !/\s/.test(next))) {
      replace(i, i + 1, SYMBOLS[ch])
      i++
      continue
    }

    literal(ch)
    i += len
  }

  return finish(text, out, spans)
}

/** "a/b" and "1/2" are fractions; "example.com/a", "9/11/2001" and "and/or" are not. */
function isFraction(text, i) {
  const before = /([A-Za-z0-9.)\]]+)$/.exec(text.slice(Math.max(0, i - 24), i))?.[1] || ''
  const after = /^([A-Za-z0-9.(\[]+)/.exec(text.slice(i + 1, i + 25))?.[1] || ''
  if (!before || !after) return false
  if (before.includes('.') || after.includes('.')) return false // URLs, decimals, file names
  const dateLike = /^\d+$/.test(before) && /^\d+$/.test(after)
  if (dateLike && (text[i + 1 + after.length] === '/' || text[i - before.length - 1] === '/')) return false // dates
  if (/^[a-z]{2,}$/.test(before) && /^[a-z]{2,}$/.test(after)) return false // and/or, input/output
  return true
}

function identity(text) {
  return {
    text,
    spans: [],
    toSource: (i) => Math.max(0, Math.min(i, text.length)),
    toSourceEnd: (i) => Math.max(0, Math.min(i, text.length)),
  }
}

function finish(source, out, spans) {
  const toSource = (i) => {
    const k = lastSpanBefore(spans, i)
    if (k < 0) return clamp(i, source.length)
    const s = spans[k]
    if (i < s.out[1]) return s.src[0]
    return clamp(i - (s.out[1] - s.src[1]), source.length)
  }
  const toSourceEnd = (i) => {
    const k = lastSpanBefore(spans, i)
    if (k < 0) return clamp(i, source.length)
    const s = spans[k]
    if (i <= s.out[1] && i > s.out[0]) return s.src[1]
    return clamp(i - (s.out[1] - s.src[1]), source.length)
  }
  return { text: out, spans, toSource, toSourceEnd }
}

function clamp(i, max) {
  return Math.max(0, Math.min(i, max))
}

/** Index of the last span whose out[0] <= i, or -1. */
function lastSpanBefore(spans, i) {
  let lo = 0
  let hi = spans.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].out[0] <= i) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}
