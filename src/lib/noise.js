/**
 * Background noise, generated rather than played from a file.
 *
 * Moderate broadband noise measurably improves attention and memory in people
 * with inattentive ADHD (Söderlund et al., 2007, 2010, and replications since);
 * the proposed mechanism is stochastic resonance -- a little noise lifts a weak
 * signal over threshold. White noise is the version studied; pink and brown are
 * the same idea with less energy in the high frequencies, which most people
 * find easier to sit with for an hour.
 *
 * The generators are pure functions so they can be tested in Node. NoisePlayer
 * wraps them in the Web Audio API: one four-second buffer per colour, looped.
 */

/**
 * White noise. Equal energy per hertz means most of it sits in the high
 * frequencies the ear is most sensitive to, so at matched loudness it is still
 * the harshest of the three; it is taken down a further 5 dB for comfort.
 */
export function whiteNoise(length, random = Math.random) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1
  return normalize(out, 0.56)
}

/** Pink noise (-3 dB per octave): Paul Kellet's "refined" 7-pole approximation. */
export function pinkNoise(length, random = Math.random) {
  const out = new Float32Array(length)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.969 * b2 + white * 0.153852
    b3 = 0.8665 * b3 + white * 0.3104856
    b4 = 0.55 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.016898
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
    b6 = white * 0.115926
  }
  return normalize(out, 1)
}

/** Brown (red) noise (-6 dB per octave): a leaky integrator over white noise. */
export function brownNoise(length, random = Math.random) {
  const out = new Float32Array(length)
  let last = 0
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    out[i] = last * 3.5
  }
  return normalize(out, 1)
}

/**
 * Match colours by loudness (RMS), not by peak. Brown noise is spiky -- a peak
 * match leaves it whispering while white shouts. Target RMS 0.18 keeps brown's
 * peaks under 1.0; `comfort` scales a colour down from there.
 */
function normalize(samples, comfort = 1) {
  let energy = 0
  for (const s of samples) energy += s * s
  const rms = Math.sqrt(energy / samples.length)
  if (rms === 0) return samples
  const gain = (0.18 * comfort) / rms
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i] * gain))
  return samples
}

export const NOISE_COLOURS = ['off', 'white', 'pink', 'brown']
const GENERATORS = { white: whiteNoise, pink: pinkNoise, brown: brownNoise }

/**
 * Plays one colour of noise on a loop. The AudioContext is created on first use,
 * which must happen inside a user gesture -- browsers refuse to start audio
 * otherwise, the same rule that makes speech wait for a click.
 */
export class NoisePlayer {
  constructor() {
    this.colour = 'off'
    this.volume = 0.35
    this._context = null
    this._gain = null
    this._source = null
    this._buffers = new Map()
  }

  get playing() {
    return this.colour !== 'off' && Boolean(this._source)
  }

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0))
    if (this._gain) this._gain.gain.setTargetAtTime(this._curve(), this._context.currentTime, 0.05)
  }

  /** @param {'off'|'white'|'pink'|'brown'} colour */
  setColour(colour) {
    if (!NOISE_COLOURS.includes(colour)) colour = 'off'
    this.colour = colour
    this._stopSource()
    if (colour === 'off') return
    this._ensureContext()
    if (!this._context) return

    const source = this._context.createBufferSource()
    source.buffer = this._bufferFor(colour)
    source.loop = true
    source.connect(this._gain)
    source.start()
    this._source = source
    if (this._context.state === 'suspended') this._context.resume().catch(() => {})
  }

  /** Perceived loudness is roughly logarithmic; a squared curve feels linear. */
  _curve() {
    return this.volume * this.volume
  }

  _ensureContext() {
    if (this._context) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    this._context = new Ctx()
    this._gain = this._context.createGain()
    this._gain.gain.value = this._curve()
    this._gain.connect(this._context.destination)
  }

  _bufferFor(colour) {
    if (!this._buffers.has(colour)) {
      const rate = this._context.sampleRate
      const length = rate * 4
      const buffer = this._context.createBuffer(2, length, rate)
      // Independent noise per channel reads as a wide, room-like sound.
      buffer.copyToChannel(GENERATORS[colour](length), 0)
      buffer.copyToChannel(GENERATORS[colour](length), 1)
      this._buffers.set(colour, buffer)
    }
    return this._buffers.get(colour)
  }

  _stopSource() {
    if (!this._source) return
    try {
      this._source.stop()
      this._source.disconnect()
    } catch {
      /* already stopped */
    }
    this._source = null
  }
}
