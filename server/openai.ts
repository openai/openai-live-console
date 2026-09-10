import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import WebSocket from 'ws';
import type { Settings } from './config.ts';
import type { WireEvent } from './protocol.ts';
import { record } from './protocol.ts';

export interface CreatedSession {
  session: { id: string };
  transport: { type: 'webrtc'; sdp: string };
}
export interface Sideband {
  send(event: WireEvent): void;
  close(): void;
}
export interface Gateway {
  client: OpenAI;
  create(session: Record<string, unknown>, sdp: string): Promise<CreatedSession>;
  attach(id: string, onEvent: (event: WireEvent) => void, onDisconnect: () => void): Promise<Sideband>;
  hangup(id: string): Promise<void>;
}

export function createGateway(settings: Settings): Gateway {
  // The released SDK has no typed Live resource yet. Its public post() method
  // provides supported HTTP transport; this small adapter owns the wire types.
  // Node's --use-env-proxy and this adapter honor HTTP(S) proxy/NO_PROXY settings.
  const client = new OpenAI({
    apiKey: settings.apiKey || 'not-configured',
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    timeout: 20000,
  });
  return {
    client,
    async create(session, sdp) {
      const result = await client.post<CreatedSession>('/live/sessions', {
        body: { session, transport: { type: 'webrtc', sdp } },
      });
      if (
        !result?.session?.id ||
        typeof result.session.id !== 'string' ||
        result.transport?.type !== 'webrtc' ||
        typeof result.transport.sdp !== 'string' ||
        !result.transport.sdp.startsWith('v=0')
      ) {
        if (typeof result?.session?.id === 'string' && result.session.id)
          await client
            .post<void>(`/live/sessions/${encodeURIComponent(result.session.id)}/hangup`, { timeout: 5000 })
            .catch(() => undefined);
        throw new Error('Invalid Live session response.');
      }
      return result;
    },
    attach(id, onEvent, onDisconnect) {
      return new Promise<Sideband>((resolve, reject) => {
        let opened = false,
          intentionalClose = false;
        const proxy = getProxyForUrl('https://api.openai.com');
        if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) {
          reject(new Error('The sample supports HTTP(S) proxies only.'));
          return;
        }
        const socket = new WebSocket(
          `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`,
          {
            headers: { Authorization: `Bearer ${settings.apiKey}` },
            agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
            handshakeTimeout: 15000,
            maxPayload: 1024 * 1024,
          },
        );
        socket.on('message', (bytes) => {
          try {
            const value = record(JSON.parse(bytes.toString()));
            if (typeof value.type === 'string') onEvent(value as WireEvent);
          } catch {
            if (!intentionalClose) onDisconnect();
          }
        });
        socket.once('open', () => {
          opened = true;
          resolve({
            send(value) {
              if (socket.readyState !== WebSocket.OPEN) throw new Error('Sideband is not open.');
              socket.send(JSON.stringify(value));
            },
            close() {
              intentionalClose = true;
              socket.close();
              const timer = setTimeout(() => socket.terminate(), 1000);
              timer.unref();
            },
          });
        });
        socket.on('error', (error) => {
          if (!opened) reject(error);
        });
        socket.on('close', () => {
          if (!opened) reject(new Error('Sideband closed before attachment.'));
          else if (!intentionalClose) onDisconnect();
        });
      });
    },
    async hangup(id) {
      await client.post<void>(`/live/sessions/${encodeURIComponent(id)}/hangup`, { timeout: 5000 });
    },
  };
}
