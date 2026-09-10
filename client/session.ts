import type { ConsoleConfig, ConsoleEvent, Mode, Phase } from '../shared/types.ts';

interface Callbacks {
  phase(value: Phase): void;
  event(value: ConsoleEvent): void;
  error(message: string, action?: string, code?: string): void;
  level(value: number): void;
  playbackBlocked(value: boolean): void;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(
      () => finish(new Error('ICE gathering timed out. Check your network or VPN.')),
      10000,
    );
    peer.addEventListener('icegatheringstatechange', changed);
  });
}
async function request(path: string, csrf: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Console-Csrf': csrf },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.message || 'The local server rejected the request.'), {
      action: typeof result.action === 'string' ? result.action : undefined,
      code: typeof result.code === 'string' ? result.code : undefined,
    });
  return result;
}

export class BrowserSession {
  private callbacks: Callbacks;
  private audio: HTMLAudioElement;
  private generation = 0;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private socket?: WebSocket;
  private stream?: MediaStream;
  private context?: AudioContext;
  private meterSource?: MediaStreamAudioSourceNode;
  private frame = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private operationId = '';
  private config?: ConsoleConfig;
  private requested = false;
  private stopping?: Promise<void>;
  private phase: Phase = 'idle';
  private liveStarted = false;
  private bridgeReady = false;
  private terminal = deferred<Extract<ConsoleEvent, { type: 'closed' }>>();
  private terminalSeen = false;
  private muted = false;
  private unload = () => this.dispose();

  constructor(audio: HTMLAudioElement, callbacks: Callbacks) {
    this.audio = audio;
    this.callbacks = callbacks;
    window.addEventListener('pagehide', this.unload);
  }
  private setPhase(value: Phase) {
    this.phase = value;
    this.callbacks.phase(value);
  }
  private activate() {
    if (this.liveStarted && this.bridgeReady && this.phase === 'connecting') {
      clearTimeout(this.startupTimer);
      for (const track of this.stream?.getAudioTracks() || []) track.enabled = !this.muted;
      this.setPhase('live');
    }
  }

  async start(config: ConsoleConfig, mode: Mode, inputDevice: string, outputDevice: string) {
    if (['connecting', 'live', 'closing'].includes(this.phase)) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.config = config;
    this.operationId = crypto.randomUUID();
    const operationId = this.operationId;
    this.requested = false;
    this.stopping = undefined;
    this.terminal = deferred();
    this.terminalSeen = false;
    this.liveStarted = false;
    this.bridgeReady = false;
    this.muted = false;
    this.setPhase('connecting');
    this.callbacks.playbackBlocked(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error('This browser needs WebRTC and microphone access on localhost.');
      const peer = new RTCPeerConnection();
      this.peer = peer;
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onmessage = (message) => {
        if (!current() || typeof message.data !== 'string' || message.data.length > 65536) return;
        try {
          const value = JSON.parse(message.data);
          if (value.type === 'session.started') {
            this.liveStarted = true;
            this.activate();
          }
          if (value.type === 'session.closed') {
            const seconds = value.usage?.seconds;
            const finalized = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;
            const final: Extract<ConsoleEvent, { type: 'closed' }> = {
              type: 'closed',
              finalized,
              reason: typeof value.reason === 'string' ? value.reason : 'Session ended',
              seconds: finalized ? seconds : null,
              inputTokens: 0,
              outputTokens: 0,
            };
            // The server owns backend usage. A primary terminal event is also
            // sufficient to prove Live finalization if the bridge is interrupted.
            this.terminalSeen = true;
            this.terminal.resolve(final);
            if (this.phase !== 'closing') void this.stop();
          }
          if (value.type === 'error')
            this.callbacks.error(
              'The Live control channel reported an error.',
              'Stop the session and review project access and protocol compatibility.',
            );
        } catch {
          this.callbacks.error('An invalid Live control event was received.');
          void this.stop();
        }
      };
      channel.onclose = () => {
        if (current() && !this.terminalSeen && !this.stopping) {
          this.callbacks.error('The connection to Live was lost. Ending the session.');
          void this.stop();
        }
      };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        clearTimeout(this.disconnectTimer);
        if (peer.connectionState === 'failed') {
          this.callbacks.error('The WebRTC connection failed.');
          void this.stop();
        } else if (peer.connectionState === 'disconnected' && this.phase !== 'closing')
          this.disconnectTimer = setTimeout(() => {
            this.callbacks.error('The WebRTC connection was lost.');
            void this.stop();
          }, 5000);
      };
      peer.ontrack = (track) => {
        if (!current()) return;
        this.audio.srcObject = track.streams[0] || new MediaStream([track.track]);
        void this.audio.play().catch(() => this.callbacks.playbackBlocked(true));
      };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputDevice ? { deviceId: { exact: inputDevice } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!current() || this.phase !== 'connecting') {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
        peer.addTrack(track, stream);
      }
      this.monitor(stream, current);
      if ('setSinkId' in this.audio) await this.audio.setSinkId(outputDevice);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer);
      if (!current() || this.phase !== 'connecting') return;
      this.requested = true;
      const created = await request('/api/sessions', config.csrf, {
        sdp: peer.localDescription?.sdp,
        mode,
        operationId,
      });
      if (!current() || this.phase !== 'connecting') {
        void request('/api/sessions/close', config.csrf, { operationId }).catch(() => undefined);
        return;
      }
      if (typeof created.id !== 'string' || typeof created.sdp !== 'string')
        throw new Error('The server returned an invalid connection offer.');
      const socketUrl = new URL('/api/events', window.location.href);
      socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socketUrl.searchParams.set('session', created.id);
      const socket = new WebSocket(socketUrl);
      this.socket = socket;
      socket.onmessage = (message) => {
        if (!current()) return;
        try {
          const value = JSON.parse(message.data) as ConsoleEvent;
          if (value.type === 'ready') {
            this.bridgeReady = true;
            this.activate();
          }
          if (value.type === 'closing') void this.stop();
          if (value.type === 'closed') {
            this.terminalSeen = true;
            this.terminal.resolve(value);
            this.callbacks.event(value);
            this.setPhase(value.finalized ? 'closed' : 'incomplete');
            this.cleanup();
            return;
          }
          this.callbacks.event(value);
        } catch {
          this.callbacks.error('The local connection returned invalid data.');
          void this.stop();
        }
      };
      socket.onclose = () => {
        if (current() && !this.terminalSeen && !this.stopping) {
          this.callbacks.error('The backend connection was lost. Ending the session.');
          void this.stop();
        }
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The local event connection timed out.')), 10000);
        socket.onopen = () => {
          clearTimeout(timer);
          this.heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' }));
          }, 5000);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Could not connect to the local event server.'));
        };
      });
      if (!current() || this.phase !== 'connecting') return;
      this.startupTimer = setTimeout(() => {
        if (current() && this.phase === 'connecting') {
          this.callbacks.error('Live did not report that the session started.');
          void this.stop();
        }
      }, 15000);
      // Arm before applying the answer: session.started may arrive immediately.
      // WebRTC state changes only manage the separate disconnection grace period.
      await peer.setRemoteDescription({ type: 'answer', sdp: created.sdp });
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it for this site in your browser settings.'
          : error instanceof Error
            ? error.message
            : 'Could not start the session.';
      const detail = error as { action?: string; code?: string } | null;
      this.callbacks.error(message, detail?.action, detail?.code);
      if (this.requested) {
        await this.stop();
        if ((this.phase as Phase) === 'idle') this.setPhase('error');
      } else {
        this.cleanup();
        this.setPhase('error');
      }
    }
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = this.phase === 'live' && !muted;
  }
  setSpeakerMuted(muted: boolean) {
    this.audio.muted = muted;
  }
  async resumePlayback() {
    try {
      await this.audio.play();
      this.callbacks.playbackBlocked(false);
    } catch {
      this.callbacks.playbackBlocked(true);
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!['connecting', 'live', 'closing'].includes(this.phase)) return Promise.resolve();
    this.stopping = this.finalize();
    return this.stopping;
  }
  private async finalize() {
    const generation = this.generation;
    this.setPhase('closing');
    this.setMuted(true);
    if (!this.requested || !this.config) {
      this.cleanup();
      this.setPhase('idle');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = request('/api/sessions/close', this.config.csrf, { operationId: this.operationId }).catch(
      () => {
        if (generation === this.generation && this.channel?.readyState === 'open')
          this.channel.send(JSON.stringify({ type: 'session.close', event_id: crypto.randomUUID() }));
        return new Promise<never>(() => undefined);
      },
    );
    const receipt = await Promise.race([
      this.terminal.promise,
      api,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 35000);
      }),
    ]);
    clearTimeout(timer);
    if (generation !== this.generation) return;
    if (receipt?.type === 'closed') {
      this.callbacks.event(receipt);
      this.setPhase(receipt.finalized ? 'closed' : 'incomplete');
    } else if (receipt?.type === 'cancelled') this.setPhase('idle');
    else {
      this.callbacks.error(
        'Session finalization is incomplete.',
        'The final session.closed event was not received. The last usage reading is not final.',
      );
      this.setPhase('incomplete');
      this.callbacks.event({
        type: 'closed',
        finalized: false,
        reason: 'Final event not received',
        seconds: null,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    this.cleanup();
  }
  private monitor(stream: MediaStream, current: () => boolean) {
    try {
      this.context = new AudioContext();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 256;
      this.meterSource = this.context.createMediaStreamSource(stream);
      this.meterSource.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let last = 0;
      const tick = (time: number) => {
        if (!current()) return;
        if (time - last > 60) {
          analyser.getByteTimeDomainData(data);
          const rms = Math.sqrt(data.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / data.length);
          this.callbacks.level(this.muted ? 0 : Math.min(1, rms * 7));
          last = time;
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } catch {
      /* The meter is optional; WebRTC audio does not depend on it. */
    }
  }
  private cleanup() {
    this.generation++;
    clearInterval(this.heartbeat);
    clearTimeout(this.startupTimer);
    clearTimeout(this.disconnectTimer);
    cancelAnimationFrame(this.frame);
    this.channel?.close();
    this.channel = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.peer?.close();
    this.peer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.audio.pause();
    this.audio.srcObject = null;
    this.meterSource?.disconnect();
    this.meterSource = undefined;
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.callbacks.level(0);
  }
  dispose() {
    if (
      this.requested &&
      this.config &&
      !this.terminalSeen &&
      ['connecting', 'live', 'closing'].includes(this.phase)
    ) {
      void fetch('/api/sessions/close', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Console-Csrf': this.config.csrf },
        body: JSON.stringify({ operationId: this.operationId }),
      }).catch(() => undefined);
    }
    this.cleanup();
    window.removeEventListener('pagehide', this.unload);
  }
}
