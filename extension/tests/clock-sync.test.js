import test from 'node:test';
import assert from 'node:assert/strict';

import { ClockSync } from '../src/background/ClockSync.js';

test('compensateTime advances a playing position by the one-way delay', () => {
  const clock = new ClockSync();
  clock.recordRTT(200); // one-way estimate: 100ms

  const result = clock.compensateTime(50, Date.now(), true);

  assert.ok(Math.abs(result - 50.1) < 0.001, `expected ~50.1, got ${result}`);
});

test('compensateTime leaves a paused position untouched', () => {
  const clock = new ClockSync();
  clock.recordRTT(400); // one-way estimate: 200ms

  // A paused video is not advancing, so adding delay would push every peer
  // ahead of the host by exactly the network latency.
  assert.equal(clock.compensateTime(50, Date.now(), false), 50);
});

test('compensateTime uses the median so one spike does not skew the estimate', () => {
  const clock = new ClockSync();
  [100, 100, 100, 100, 4000].forEach((rtt) => clock.recordRTT(rtt));

  // Mean would be 880ms (one-way 440ms); the median is 100ms (one-way 50ms).
  assert.equal(clock.rttMs, 100);
  assert.equal(clock.estimatedDelay, 50);
});

test('recordRTT rejects negative and implausible samples', () => {
  const clock = new ClockSync();

  clock.recordRTT(-50);
  clock.recordRTT(99999);
  clock.recordRTT(Number.NaN);
  clock.recordRTT('300');

  assert.equal(clock.sampleCount, 0);
  assert.equal(clock.estimatedDelay, 0);
});

test('recordRTT keeps only the most recent samples', () => {
  const clock = new ClockSync();
  for (let i = 0; i < 25; i++) clock.recordRTT(100 + i);

  assert.equal(clock.sampleCount, 10);
});

test('estimateDelay clamps a sender clock that runs ahead of ours', () => {
  const clock = new ClockSync();

  // originTimestamp in the future yields a negative raw difference, which is
  // clock offset rather than delay and must never become a negative seek.
  assert.equal(clock.estimateDelay(Date.now() + 60000), 0);
});

test('estimateDelay clamps a wildly behind sender clock', () => {
  const clock = new ClockSync();

  // A sender clock hours behind ours would otherwise imply an enormous delay.
  const result = clock.estimateDelay(Date.now() - 3600_000);

  assert.equal(result, 2000, 'must saturate at the compensation ceiling');
});

test('compensateTime never exceeds the compensation ceiling', () => {
  const clock = new ClockSync();
  clock.recordRTT(5000); // one-way estimate: 2500ms, above the 2000ms cap

  const result = clock.compensateTime(10, Date.now(), true);

  assert.ok(Math.abs(result - 12) < 0.001, `expected 12, got ${result}`);
});

test('compensateTime rejects a non-finite position', () => {
  const clock = new ClockSync();

  assert.equal(clock.compensateTime(Number.NaN, Date.now(), true), 0);
  assert.equal(clock.compensateTime(undefined, Date.now(), true), 0);
});

test('compensateTime never returns a negative position', () => {
  const clock = new ClockSync();

  assert.equal(clock.compensateTime(-5, Date.now(), false), 0);
});

test('reset clears samples so stale RTT cannot survive a transport switch', () => {
  const clock = new ClockSync();
  clock.recordRTT(300);
  assert.ok(clock.estimatedDelay > 0);

  clock.reset();

  assert.equal(clock.sampleCount, 0);
  assert.equal(clock.estimatedDelay, 0);
  assert.equal(clock.rttMs, 0);
});
