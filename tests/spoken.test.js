import test from 'node:test'
import assert from 'node:assert/strict'
import { toSpoken } from '../src/lib/spoken.js'

const say = (s) => toSpoken(s).text.replace(/\s+/g, ' ').trim()

test('spoken: Greek letters become their names, capitals called out', () => {
  assert.equal(say('α + β ≤ γ'), 'alpha plus beta less than or equal to gamma'.replace('plus', '+'))
  assert.equal(say('Σ and σ'), 'capital sigma and sigma')
  assert.equal(say('2α'), '2 alpha')
  assert.equal(say('(γ).'), '(gamma).')
})

test('spoken: exponents and subscripts', () => {
  assert.equal(say('E = mc²'), 'E equals mc squared')
  assert.equal(say('x³ + x^n'), 'x cubed + x to the power of n')
  assert.equal(say('e^{-x}'), 'e to the power of minus x')
  assert.equal(say('10⁻¹'), '10 to the power of minus 1')
  assert.equal(say('σ_x and a_{ij} and H₂O'), 'sigma sub x and a sub ij and H sub two O')
})

test('spoken: operators, minus, fractions', () => {
  assert.equal(say('3 - 2 = 1'), '3 minus 2 equals 1')
  assert.equal(say('3 − 2'), '3 minus 2')
  assert.equal(say('well-known'), 'well-known')
  assert.equal(say('a/b and 1/2'), 'a over b and 1 over 2')
  assert.equal(say('example.com/a and 9/11/2001 and and/or'), 'example.com/a and 9/11/2001 and and/or')
  assert.equal(say('a*b'), 'a times b')
  assert.equal(say('ħ ∂ ∇ ∑ ∫ √ ∞ ±'), 'h bar partial del sum integral square root of infinity plus or minus')
  assert.equal(say('50%'), '50 percent')
  assert.equal(say('x < y'), 'x less than y')
})

test('spoken: TeX escapes and Dirac notation', () => {
  assert.equal(say('\\alpha \\leq \\sum'), 'alpha less than or equal to sum')
  assert.equal(say('⟨ψ|H|ψ⟩'), 'bra psi H ket psi')
})

test('spoken: prose is untouched and maps as identity', () => {
  const s = 'Dr. Whitfield opened the notebook at 9.30 a.m. and began.'
  const r = toSpoken(s)
  assert.equal(r.text, s)
  assert.equal(r.spans.length, 0)
  for (let i = 0; i <= s.length; i++) assert.equal(r.toSource(i), i)
})

test('spoken: every spoken position maps back into the source, monotonically', () => {
  const s = 'E = mc² and σ_x ≤ 3 − 2, α + β → γ.'
  const r = toSpoken(s)
  let last = 0
  for (let i = 0; i <= r.text.length; i++) {
    const src = r.toSource(i)
    assert.ok(src >= 0 && src <= s.length, `index ${i} -> ${src}`)
    assert.ok(src >= last, `not monotonic at ${i}: ${src} < ${last}`)
    last = src
  }
  // A boundary landing inside "alpha" highlights the α itself.
  const alphaOut = r.text.indexOf('alpha')
  assert.equal(s[r.toSource(alphaOut + 2)], 'α')
  assert.equal(r.toSourceEnd(alphaOut + 5), s.indexOf('α') + 1)
  // Text after the last replacement still lines up exactly.
  assert.equal(s[r.toSource(r.text.length - 1)], '.')
})

test('spoken: math=false is the identity', () => {
  const r = toSpoken('α ≤ β', { math: false })
  assert.equal(r.text, 'α ≤ β')
  assert.equal(r.toSource(3), 3)
})

test('spoken: mathematical alphanumeric symbols are folded, not spelled as hex', () => {
  assert.equal(say('𝐸 = 𝑚𝑐² and 𝛼 + 𝛽 ≤ 𝛾'), 'E equals mc squared and alpha + beta less than or equal to gamma')
  assert.equal(say('ﬁnite ﬂow'), 'finite flow')
  assert.equal(say('a\uE0A3b'), 'ab') // private-use glyph from a symbol font: silent
  // Offsets survive surrogate pairs: "alpha" maps back onto the two-unit 𝛼.
  const s = 'x 𝛼 y'
  const r = toSpoken(s)
  const at = r.text.indexOf('alpha')
  assert.equal(r.toSource(at), 2)
  assert.equal(r.toSourceEnd(at + 5), 4)
  assert.equal(s[r.toSource(r.text.indexOf('y'))], 'y')
})
