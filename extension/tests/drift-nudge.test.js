import test from 'node:test';
import assert from 'node:assert/strict';

import { loadScripts, FakeVideo } from './helpers/load-script.js';

/**
 * Build a YouTubeAdapter attached to a fake video element.
 *
 * `attach()` is bypassed deliberately: it wires DOM observers and an interval
 * that are irrelevant here, and the target of these tests is the convergence
 * logic in syncTo.
 */
function buildAdapter(videoOptions) {
  const context = loadScripts(
    [
      'src/content/adapters/VideoAdapter.js',
      'src/content/adapters/YouTubeAdapter.js',
    ],
    {
      document: { querySelector: () => null },
      location: { href: 'https://www.youtube.com/watch?v=vid1' },
      MutationObserver: class { observe() {} disconnect() {} },
      AbortController: class { constructor() { this.signal = {}; } abort() {} },
    }
  );

  const adapter = new context.window.SyncTube.YouTubeAdapter();
  const video = new FakeVideo(videoOptions);

  adapter._video = video;
  adapter._attached = true;
  adapter._suppressUntil = 0; // Skip the page-load suppression window.

  return { adapter, video };
}

test('a sub-second drift is absorbed by playback rate, not a seek', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.5, { isPaused: false });

  assert.deepEqual(video.seekHistory, [], 'must not seek for a small correction');
  assert.ok(video.playbackRate > 1, `expected a speed-up, got ${video.playbackRate}`);
  assert.ok(
    video.playbackRate <= 1.06,
    `must stay within the imperceptible band, got ${video.playbackRate}`
  );
});

test('running ahead of the host slows playback down', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100.6, paused: false });

  adapter.syncTo(100, { isPaused: false });

  assert.deepEqual(video.seekHistory, []);
  assert.ok(video.playbackRate < 1, `expected a slow-down, got ${video.playbackRate}`);
  assert.ok(video.playbackRate >= 0.94, `got ${video.playbackRate}`);
});

test('a large drift falls back to a seek', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  // Rate-correcting 30s would take minutes or need an audibly wrong speed.
  adapter.syncTo(130, { isPaused: false });

  assert.deepEqual(video.seekHistory, [130]);
  assert.equal(video.playbackRate, 1, 'no nudge should be left running');
});

test('drift inside the dead zone does nothing at all', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.05, { isPaused: false });

  assert.deepEqual(video.seekHistory, []);
  assert.equal(video.playbackRate, 1);
});

test('a paused video is corrected by an exact seek', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: true });

  // Nudging a paused video would do nothing, and a seek is invisible anyway.
  adapter.syncTo(100.5, { isPaused: true });

  assert.deepEqual(video.seekHistory, [100.5]);
  assert.equal(video.playbackRate, 1);
});

test('a nudge restores normal speed when it expires', async () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.02 + 0.15, { isPaused: false });
  assert.notEqual(video.playbackRate, 1, 'nudge should be active');

  // Drift 0.17s at the minimum useful delta resolves quickly.
  await new Promise((resolve) => setTimeout(resolve, 60));
  adapter._cancelNudge();

  assert.equal(video.playbackRate, 1);
});

test('a second correction replaces the first rather than stacking', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.5, { isPaused: false });
  const firstRate = video.playbackRate;

  video.currentTime = 100.2;
  adapter.syncTo(100.9, { isPaused: false });

  assert.ok(video.rateHistory.length >= 2);
  assert.notEqual(video.playbackRate, 1, 'a nudge should still be running');
  assert.ok(firstRate > 1);
});

test('a deliberate user playback rate is left alone', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });
  video.playbackRate = 1.5; // User chose 1.5x
  video.rateHistory.length = 0;

  adapter.syncTo(100.5, { isPaused: false });

  assert.equal(video.playbackRate, 1.5, 'must not fight a deliberate speed choice');
  assert.deepEqual(video.rateHistory, []);
});

test('a state change from playing to paused seeks and stops nudging', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.4, { isPaused: false });
  assert.notEqual(video.playbackRate, 1);

  adapter.syncTo(105, { isPaused: true });

  assert.equal(video.paused, true);
  assert.ok(video.seekHistory.includes(105));
  assert.equal(video.playbackRate, 1, 'nudge must be cancelled on pause');
});

test('a state change from paused to playing seeks then plays', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: true });

  adapter.syncTo(120, { isPaused: false });

  assert.deepEqual(video.seekHistory, [120]);
  assert.equal(video.paused, false);
});

test('destroy restores normal speed', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(100.5, { isPaused: false });
  assert.notEqual(video.playbackRate, 1);

  adapter.destroy();

  // The <video> element survives YouTube's SPA navigation, so a leftover nudge
  // would leave the next video playing off-speed with nothing left to fix it.
  assert.equal(video.playbackRate, 1);
});

test('syncTo ignores a non-finite target', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });

  adapter.syncTo(Number.NaN, { isPaused: false });
  adapter.syncTo(undefined, { isPaused: false });

  assert.deepEqual(video.seekHistory, []);
  assert.equal(video.playbackRate, 1);
});

test('syncTo does nothing during an ad', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: false });
  adapter._isAdActive = true;

  adapter.syncTo(150, { isPaused: false });

  assert.deepEqual(video.seekHistory, [], 'must not fight the ad player');
});

test('the seek dead zone is tighter than the drift tolerance it serves', () => {
  const { adapter, video } = buildAdapter({ currentTime: 100, paused: true });

  // The engine corrects above 0.35s, so a 0.35s correction must actually apply.
  // A dead zone at or above the tolerance would silently swallow every
  // correction while the engine kept reissuing them.
  adapter.syncTo(100.35, { isPaused: true });

  assert.deepEqual(video.seekHistory, [100.35]);
});
