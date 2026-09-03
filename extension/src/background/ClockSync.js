/**
 * ClockSync — Cristian's Algorithm Style Clock Synchronization
 *
 * Estimates the one-way network delay to the host so playback commands can be
 * applied at the position the host will be at when the command lands, rather
 * than the position the host was at when it was sent.
 *
 * Why RTT and not wall-clock difference
 * -------------------------------------
 * `localReceiveTime - originTimestamp` looks like a one-way delay but is really
 * one-way delay *plus the difference between the two machines' clocks*. Those
 * clocks are independent and routinely disagree by seconds, so the naive
 * subtraction can even come out negative. Measuring a round trip against a
 * single clock cancels the offset out entirely, which is the whole point of
 * Cristian's algorithm. The timestamp difference is kept only as a bootstrap
 * value for the first moments of a session, before any sample exists.
 *
 * Networks Pillar: Cristian's algorithm for clock synchronization in a
 * distributed system.
 */

/** Discard samples above this; they are queueing artefacts, not path delay. */
const MAX_PLAUSIBLE_RTT_MS = 5000;

/** Never compensate by more than this, however large the samples get. */
const MAX_COMPENSATION_MS = 2000;

/** Samples retained for the running estimate. */
const MAX_SAMPLES = 10;

export class ClockSync {
  constructor() {
    /** @type {number} Estimated one-way delay in ms */
    this._estimatedDelay = 0;

    /** @type {number[]} Recent RTT samples */
    this._rttSamples = [];

    /** @type {number} Most recent raw RTT, for display */
    this._lastRttMs = 0;
  }

  /**
   * Bootstrap estimate from a message's originTimestamp.
   *
   * Contaminated by clock offset between the two machines (see the class note),
   * so this is only used until the first real RTT sample arrives.
   *
   * @param {number} originTimestamp - Sender's wall-clock ms when issued
   * @returns {number} Estimated one-way delay in ms
   */
  estimateDelay(originTimestamp) {
    if (!originTimestamp || typeof originTimestamp !== 'number') {
      return 0;
    }

    const rawDiff = (Date.now() - originTimestamp) / 2;

    // A sender clock ahead of ours yields a negative figure; a badly-behind one
    // yields an absurd figure. Neither is a delay, so clamp to a sane range.
    return Math.min(Math.max(0, rawDiff), MAX_COMPENSATION_MS);
  }

  /**
   * Adjust a playback position for the time the command spent in flight.
   *
   * @param {number} videoTime - Position in seconds as sent
   * @param {number} originTimestamp - When the command was issued (ms)
   * @param {boolean} [isPlaying=true] - Whether the source was playing
   * @returns {number} Position in seconds to apply locally
   */
  compensateTime(videoTime, originTimestamp, isPlaying = true) {
    if (typeof videoTime !== 'number' || !Number.isFinite(videoTime)) {
      return 0;
    }

    // A paused video's position does not advance while the command travels, so
    // adding the delay would push every peer ahead of the host by the latency.
    if (!isPlaying) {
      return Math.max(0, videoTime);
    }

    const delayMs = this._rttSamples.length > 0
      ? this._estimatedDelay
      : this.estimateDelay(originTimestamp);

    const bounded = Math.min(delayMs, MAX_COMPENSATION_MS);
    return Math.max(0, videoTime + bounded / 1000);
  }

  /**
   * Record a round-trip time sample.
   * @param {number} rttMs - Measured round-trip time in ms
   */
  recordRTT(rttMs) {
    if (typeof rttMs !== 'number' || !Number.isFinite(rttMs)) return;
    if (rttMs < 0 || rttMs > MAX_PLAUSIBLE_RTT_MS) return;

    this._lastRttMs = rttMs;
    this._rttSamples.push(rttMs);
    if (this._rttSamples.length > MAX_SAMPLES) {
      this._rttSamples.shift();
    }

    this._estimatedDelay = this._medianRTT() / 2;
  }

  /**
   * Median rather than mean.
   *
   * RTT distributions are heavily right-skewed: most samples cluster near the
   * true path delay, with occasional multiples caused by a scheduling hiccup or
   * a service-worker wake-up. A mean chases those spikes and inflates the
   * estimate for the next ten samples; the median ignores them.
   *
   * @returns {number}
   * @private
   */
  _medianRTT() {
    if (this._rttSamples.length === 0) return 0;

    const sorted = [...this._rttSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /** Discard all samples, e.g. after switching transport. */
  reset() {
    this._rttSamples = [];
    this._estimatedDelay = 0;
    this._lastRttMs = 0;
  }

  /** @returns {number} Current estimated one-way delay in ms */
  get estimatedDelay() {
    return this._estimatedDelay;
  }

  /** @returns {number} Median round-trip time in ms, for display */
  get rttMs() {
    return Math.round(this._medianRTT());
  }

  /** @returns {number} Number of samples backing the current estimate */
  get sampleCount() {
    return this._rttSamples.length;
  }
}
