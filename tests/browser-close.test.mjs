import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { BrowserSession } from '../client/session.ts';

async function startSession(t, { sendError, apiCloses = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const phases = [],
    events = [],
    errors = [];
  const restoreGlobals = [];
  const track = { enabled: false, stop: t.mock.fn() };
  let peer, socket;
  const channel = {
    readyState: 'open',
    send: t.mock.fn(() => {
      if (sendError) throw sendError;
    }),
    close: t.mock.fn(),
  };
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    constructor() {
      super();
      peer = this;
    }
    createDataChannel() {
      return channel;
    }
    addTrack() {}
    async createOffer() {
      return { type: 'offer', sdp: 'v=0' };
    }
    async setLocalDescription(value) {
      this.localDescription = value;
    }
    async setRemoteDescription() {
      channel.onmessage({ data: JSON.stringify({ type: 'session.started' }) });
    }
    close = t.mock.fn();
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.onopen();
        this.onmessage({ data: JSON.stringify({ type: 'ready' }) });
      });
    }
    send() {}
    close = t.mock.fn();
  }
  for (const [name, value] of Object.entries({
    window: {
      RTCPeerConnection: Peer,
      addEventListener() {},
      removeEventListener() {},
      location: { href: 'http://127.0.0.1:3000/', protocol: 'http:' },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
      },
    },
    RTCPeerConnection: Peer,
    WebSocket: Socket,
    cancelAnimationFrame() {},
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/sessions') return Response.json({ id: 'synthetic-session', sdp: 'v=0' });
    assert.equal(url, '/api/sessions/close');
    if (apiCloses)
      return Response.json({
        type: 'closed',
        finalized: true,
        reason: 'Stopped',
        seconds: 1,
        inputTokens: 2,
        outputTokens: 3,
      });
    throw new TypeError('Synthetic local server connection failure');
  });
  const audio = { pause: t.mock.fn(), srcObject: null };
  const session = new BrowserSession(audio, {
    phase: (value) => phases.push(value),
    event: (value) => events.push(value),
    error: (message) => errors.push(message),
    level() {},
    playbackBlocked() {},
  });
  t.after(() => {
    session.dispose();
    for (const restore of restoreGlobals.reverse()) restore();
  });
  await session.start({ csrf: 'synthetic-csrf' }, 'responses', '', '');
  assert.equal(phases.at(-1), 'live');
  return { session, phases, events, errors, channel, track, peer, socket, audio };
}

for (const name of ['none', 'OperationError', 'InvalidStateError']) {
  test(`failed HTTP close still cleans up after data-channel fallback (${name})`, async (t) => {
    const fixture = await startSession(t, {
      sendError: name === 'none' ? undefined : new DOMException('Synthetic send failure', name),
    });
    const outcome = fixture.session.stop().then(
      () => undefined,
      (error) => error,
    );
    await setImmediate();
    assert.equal(fixture.channel.send.mock.callCount(), 1);
    t.mock.timers.tick(35000);
    assert.equal(await outcome, undefined, 'fallback send errors must not reject finalization');
    assert.equal(fixture.phases.at(-1), 'incomplete');
    assert.equal(fixture.events.at(-1).finalized, false);
    assert.equal(fixture.track.stop.mock.callCount(), 1);
    assert.equal(fixture.peer.close.mock.callCount(), 1);
    assert.equal(fixture.socket.close.mock.callCount(), 1);
    assert.equal(fixture.audio.pause.mock.callCount(), 1);
  });
}

test('successful HTTP closure skips the fallback and keeps the final receipt', async (t) => {
  const fixture = await startSession(t, { sendError: new Error('Must not send'), apiCloses: true });
  await fixture.session.stop();
  assert.equal(fixture.channel.send.mock.callCount(), 0);
  assert.equal(fixture.phases.at(-1), 'closed');
  assert.equal(fixture.events.at(-1).outputTokens, 3);
  assert.equal(fixture.track.stop.mock.callCount(), 1);
});

test('a terminal receipt still wins after the fallback send fails', async (t) => {
  const fixture = await startSession(t, {
    sendError: new DOMException('Synthetic send failure', 'OperationError'),
  });
  const outcome = fixture.session.stop().then(
    () => undefined,
    (error) => error,
  );
  await setImmediate();
  fixture.socket.onmessage({
    data: JSON.stringify({
      type: 'closed',
      finalized: true,
      reason: 'Stopped',
      seconds: 1,
      inputTokens: 2,
      outputTokens: 3,
    }),
  });
  assert.equal(await outcome, undefined);
  assert.equal(fixture.phases.at(-1), 'closed');
  assert.equal(fixture.events.at(-1).outputTokens, 3);
  assert.equal(fixture.track.stop.mock.callCount(), 1);
  t.mock.timers.tick(35000);
  assert.equal(fixture.phases.at(-1), 'closed');
});
