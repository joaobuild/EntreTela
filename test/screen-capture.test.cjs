const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capture } = require('../src/screen-capture.js');

function track(kind, settings = {}, readyState = 'live') {
  return {
    kind, readyState, stopCalls: 0,
    getSettings: () => ({ ...settings }),
    stop() { this.stopCalls++; this.readyState = 'ended'; }
  };
}
function stream(...tracks) {
  let attached = tracks.slice();
  return {
    getTracks: () => attached.slice(),
    getVideoTracks: () => attached.filter(t => t.kind === 'video'),
    getAudioTracks: () => attached.filter(t => t.kind === 'audio'),
    removeTrack(t) { attached = attached.filter(value => value !== t); }
  };
}
const captureError = (message, name = 'NotReadableError') => Object.assign(new Error(message), { name });
const audioFailure = () => captureError('Could not start audio source');
const safeAudio = () => track('audio', { restrictOwnAudio: true });
const restrictedAudio = { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function scenario(results, hooks = {}) {
  const pending = results.slice();
  const state = { current: true, retries: 0 };
  const selections = [], requests = [], waits = [], events = [];
  const options = {
    source: { id: 'screen:0:0' }, withAudio: true,
    video: { width: { ideal: 1280 }, frameRate: { ideal: 24, max: 30 } },
    isCurrent: () => state.current,
    selectSource: async choice => {
      selections.push({ ...choice }); events.push(`select:${choice.audio}`);
      await hooks.onSelect?.(state);
    },
    mediaDevices: {
      getSupportedConstraints: () => ({ restrictOwnAudio: true }),
      getDisplayMedia: async constraints => {
        requests.push(constraints); events.push(`capture:${!!constraints.audio}`);
        assert.ok(pending.length, 'Unexpected extra display capture');
        const result = pending.shift();
        if (result instanceof Error) throw result;
        return typeof result === 'function' ? result(state) : result;
      }
    },
    onRetry: () => { state.retries++; },
    wait: async ms => { waits.push(ms); await hooks.onWait?.(state); }
  };
  return { state, selections, requests, waits, events, options, run: overrides => capture({ ...options, ...overrides }) };
}
function assertAudioAttempts(s, count) {
  for (const request of s.requests.slice(0, count)) {
    assert.deepEqual(request.audio, restrictedAudio);
    assert.deepEqual(request.video, s.options.video);
  }
}

test('screen capture retries a transient audio startup failure with isolation and rearms the source', async () => {
  const video = track('video'), audio = safeAudio(), successful = stream(video, audio);
  const s = scenario([audioFailure(), successful]);
  const result = await s.run();
  assert.equal(result.stream, successful);
  assert.equal(result.warning, '');
  assert.deepEqual(s.events, ['select:true', 'capture:true', 'select:true', 'capture:true']);
  assert.deepEqual(s.selections, [{ id: 'screen:0:0', audio: true }, { id: 'screen:0:0', audio: true }]);
  assert.equal(s.requests.length, 2);
  assertAudioAttempts(s, 2);
  assert.deepEqual(s.waits, [350]);
  assert.equal(s.state.retries, 1);
  assert.equal(video.stopCalls, 0);
  assert.equal(audio.stopCalls, 0);
});

test('three audio startup failures fall back to video with a warning and no audio tracks', async () => {
  const video = track('video'), unexpectedAudio = safeAudio(), fallback = stream(video, unexpectedAudio);
  const s = scenario([audioFailure(), captureError('Failed to initialize audio'), captureError('FAILED TO START AUDIO'), fallback]);
  const result = await s.run();
  assert.equal(result.stream, fallback);
  assert.match(result.warning, /Tela transmitida sem som/);
  assert.match(result.warning, /iniciar o áudio/);
  assert.equal(s.requests.length, 4);
  assertAudioAttempts(s, 3);
  assert.equal(s.requests[3].audio, false);
  assert.deepEqual(s.selections.map(choice => choice.audio), [true, true, true, false]);
  assert.deepEqual(s.events, ['select:true', 'capture:true', 'select:true', 'capture:true', 'select:true', 'capture:true', 'select:false', 'capture:false']);
  assert.deepEqual(s.waits, [350, 900]);
  assert.equal(s.state.retries, 2);
  assert.deepEqual(fallback.getTracks(), [video]);
  assert.equal(unexpectedAudio.stopCalls, 1);
  assert.equal(video.stopCalls, 0);
});

test('permission refusal, user cancellation and video errors never retry or fall back', async t => {
  const failures = [
    captureError('Could not start audio source: permission denied', 'NotAllowedError'),
    captureError('Could not start audio source: cancelled', 'AbortError'),
    captureError('Could not start video source'),
    captureError('The selected screen no longer exists', 'NotFoundError')
  ];
  for (const failure of failures) await t.test(`${failure.name}: ${failure.message}`, async () => {
    const s = scenario([failure]);
    await assert.rejects(s.run(), error => error === failure);
    assert.equal(s.requests.length, 1);
    assert.deepEqual(s.selections, [{ id: 'screen:0:0', audio: true }]);
    assert.deepEqual(s.waits, []);
    assert.equal(s.state.retries, 0);
  });
});

test('cancelling during the retry delay prevents another source choice or capture', async () => {
  const s = scenario([audioFailure()], { onWait: state => { state.current = false; } });
  await assert.rejects(s.run(), { code: 'CAPTURE_CANCELLED' });
  assert.deepEqual(s.waits, [350]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.selections.length, 1);
});

test('a capture that resolves after cancellation stops every returned track', async () => {
  const video = track('video'), audio = safeAudio();
  let resolveCapture;
  const pending = new Promise(resolve => { resolveCapture = resolve; });
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const s = scenario([() => { notifyStarted(); return pending; }]);
  const running = s.run();
  const rejected = assert.rejects(running, { code: 'CAPTURE_CANCELLED' });
  await started;
  s.state.current = false;
  resolveCapture(stream(video, audio));
  await rejected;
  assert.equal(video.stopCalls, 1);
  assert.equal(audio.stopCalls, 1);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.waits, []);
});

test('cancelling while selecting the source does not open display capture', async () => {
  const s = scenario([], { onSelect: state => { state.current = false; } });
  await assert.rejects(s.run(), { code: 'CAPTURE_CANCELLED' });
  assert.equal(s.selections.length, 1);
  assert.equal(s.requests.length, 0);
});

test('unsafe, missing or ended audio is discarded and replaced with a fresh video-only capture', async t => {
  const cases = [
    ['explicitly unrestricted audio', () => [track('audio', { restrictOwnAudio: false })]],
    ['isolation setting absent', () => [track('audio')]],
    ['missing audio', () => []],
    ['ended audio', () => [track('audio', { restrictOwnAudio: true }, 'ended')]],
    ['one unsafe track among safe tracks', () => [safeAudio(), track('audio', { restrictOwnAudio: false })]]
  ];
  for (const [name, makeAudio] of cases) await t.test(name, async () => {
    const oldTracks = [track('video'), ...makeAudio()], previous = stream(...oldTracks);
    const video = track('video'), fallback = stream(video);
    const s = scenario([previous, fallback]);
    const result = await s.run();
    assert.equal(result.stream, fallback);
    assert.notEqual(result.stream, previous);
    assert.match(result.warning, /Tela transmitida sem som/);
    for (const oldTrack of oldTracks) assert.equal(oldTrack.stopCalls, 1);
    assert.equal(video.stopCalls, 0);
    assert.equal(result.stream.getAudioTracks().length, 0);
    assert.equal(s.requests.length, 2);
    assertAudioAttempts(s, 1);
    assert.equal(s.requests[1].audio, false);
    assert.deepEqual(s.selections.map(choice => choice.audio), [true, false]);
    assert.deepEqual(s.waits, []);
    assert.equal(s.state.retries, 0);
  });
});

test('a resolved stream without live video is stopped and fails without retry or fallback', async () => {
  const video = track('video', {}, 'ended'), audio = safeAudio();
  const s = scenario([stream(video, audio)]);
  await assert.rejects(s.run(), /tela selecionada não está mais disponível/);
  assert.equal(video.stopCalls, 1);
  assert.equal(audio.stopCalls, 1);
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.waits, []);
});

test('unsupported voice isolation goes directly to video-only capture with an explanation', async () => {
  const video = track('video'), s = scenario([stream(video)]);
  s.options.mediaDevices.getSupportedConstraints = () => ({});
  const result = await s.run();
  assert.match(result.warning, /excluir as vozes da chamada/);
  assert.deepEqual(s.selections, [{ id: 'screen:0:0', audio: false }]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].audio, false);
  assert.deepEqual(s.waits, []);
  assert.equal(video.stopCalls, 0);
});

test('the option without audio never requests audio and removes any unexpected audio track', async () => {
  const video = track('video'), unexpectedAudio = track('audio'), captured = stream(video, unexpectedAudio);
  const s = scenario([captured]);
  s.options.mediaDevices.getSupportedConstraints = () => { assert.fail('Audio support must not be queried when audio is disabled'); };
  const result = await s.run({ withAudio: false });
  assert.equal(result.stream, captured);
  assert.equal(result.warning, '');
  assert.deepEqual(s.selections, [{ id: 'screen:0:0', audio: false }]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].audio, false);
  assert.deepEqual(result.stream.getTracks(), [video]);
  assert.equal(unexpectedAudio.stopCalls, 1);
  assert.equal(video.stopCalls, 0);
  assert.deepEqual(s.waits, []);
});
