/**
 * ClockSync — Cristian's Algorithm Style Clock Synchronization
 * 
 * Handles latency compensation between peers by measuring RTT
 * and estimating one-way delay. Uses periodic PING/PONG pairs
 * for accurate RTT measurement, with fallback to timestamp-diffing.
 * 
 * Networks Pillar: Demonstrates Cristian's algorithm for clock
 * synchronization in a distributed system.
 */

export class ClockSync {
  constructor() {
    /** @type {number} Estimated one-way delay in ms */
    this._estimatedDelay = 0;

    /** @type {number[]} Recent RTT samples for averaging */
    this._rttSamples = [];

    /** @type {number} Max samples to keep */
    this._maxSamples = 10;
  }

  /**
   * Estimate one-way delay from a received message's originTimestamp.
   * This is the naive fallback (assumes roughly synced clocks).
   * Guarded against negative values caused by client clock skew.
   * @param {number} originTimestamp - Sender's wall-clock ms when command was issued
   * @returns {number} Estimated one-way delay in ms
   */
  estimateDelay(originTimestamp) {
    if (!originTimestamp || typeof originTimestamp !== 'number') {
      return 0;
    }
    const localReceiveTime = Date.now();
    // Protect against negative delta due to peer clock skew (sender time > local time)
    const rawDiff = (localReceiveTime - originTimestamp) / 2;
    return Math.max(0, rawDiff);
  }

  /**
   * Calculate compensated seek time to account for network latency.
   * Assumes video is playing, so time progresses during transit.
   * @param {number} videoTime - Original video time in seconds
   * @param {number} originTimestamp - When the command was issued (ms)
   * @returns {number} Compensated video time in seconds
   */
  compensateTime(videoTime, originTimestamp) {
    if (typeof videoTime !== 'number' || isNaN(videoTime)) {
      return 0;
    }

    // Prefer RTT-based delay from PING/PONG samples (Cristian's algorithm).
    // Fall back to naive timestamp-diffing only when no samples exist yet.
    const delayMs = this._rttSamples.length > 0
      ? this._estimatedDelay
      : this.estimateDelay(originTimestamp);

    // If the video is playing, time advanced by delayMs during transit.
    const compensated = videoTime + (delayMs / 1000);
    return Math.max(0, compensated);
  }

  /**
   * Record an RTT sample from a PING/PONG exchange.
   * Discards negative or unreasonable outliers (> 5000ms) to preserve stability.
   * @param {number} rttMs - Measured round-trip time in ms
   */
  recordRTT(rttMs) {
    if (typeof rttMs !== 'number' || isNaN(rttMs) || rttMs < 0 || rttMs > 5000) {
      return; // Ignore invalid or extreme outlier RTT samples
    }

    this._rttSamples.push(rttMs);
    if (this._rttSamples.length > this._maxSamples) {
      this._rttSamples.shift();
    }
    this._estimatedDelay = this._averageRTT() / 2;
  }

  /**
   * @returns {number} Average RTT from recent samples
   * @private
   */
  _averageRTT() {
    if (this._rttSamples.length === 0) return 0;
    const sum = this._rttSamples.reduce((a, b) => a + b, 0);
    return sum / this._rttSamples.length;
  }

  /**
   * @returns {number} Current estimated one-way delay in ms
   */
  get estimatedDelay() {
    return this._estimatedDelay;
  }
}