/**
 * Attention checkpoints.
 *
 * Every few minutes the reader asks "still with me?" and waits for a key. If
 * nothing comes within the grace period, reading pauses so the voice does not
 * carry on to an empty room -- the characteristic failure of listening with
 * ADHD, where attention leaves and the audio does not notice. Thought-probe
 * studies (Smallwood & Schooler) show that being asked catches wandering that
 * goes unnoticed otherwise.
 *
 * A pure state machine driven by tick(now), so it can be tested without timers.
 *
 *   idle --start--> armed --(interval)--> prompting --acknowledge--> armed
 *                                                  \--(grace)--> idle + onMissed
 */
export class Checkpoints {
  /**
   * @param {{intervalMs: number, graceMs?: number, onPrompt?: Function, onMissed?: Function, onClear?: Function}} options
   */
  constructor({ intervalMs, graceMs = 12_000, onPrompt, onMissed, onClear }) {
    this.intervalMs = intervalMs
    this.graceMs = graceMs
    this.onPrompt = onPrompt || (() => {})
    this.onMissed = onMissed || (() => {})
    this.onClear = onClear || (() => {})
    /** @type {'idle'|'armed'|'prompting'} */
    this.state = 'idle'
    this._dueAt = 0
  }

  /** Begin (or restart) the countdown to the next prompt. */
  start(now = Date.now()) {
    if (!(this.intervalMs > 0)) return
    if (this.state === 'prompting') this.onClear()
    this.state = 'armed'
    this._dueAt = now + this.intervalMs
  }

  stop() {
    if (this.state === 'prompting') this.onClear()
    this.state = 'idle'
  }

  /** The reader is still here: dismiss the prompt and arm the next one. */
  acknowledge(now = Date.now()) {
    if (this.state !== 'prompting') return false
    this.onClear()
    this.state = 'armed'
    this._dueAt = now + this.intervalMs
    return true
  }

  /** Milliseconds until the current prompt is missed, for the shrinking bar. */
  remaining(now = Date.now()) {
    return this.state === 'prompting' ? Math.max(0, this._dueAt - now) : 0
  }

  /** Advance the clock. Call from a timer while reading is in progress. */
  tick(now = Date.now()) {
    if (this.state === 'armed' && now >= this._dueAt) {
      this.state = 'prompting'
      this._dueAt = now + this.graceMs
      this.onPrompt()
    } else if (this.state === 'prompting' && now >= this._dueAt) {
      this.state = 'idle'
      this.onClear()
      this.onMissed()
    }
  }
}
