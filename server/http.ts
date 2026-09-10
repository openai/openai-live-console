import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Settings } from './config.ts';
import type { Gateway } from './openai.ts';
import { MODEL, record } from './protocol.ts';
import { SampleError, publicError } from './errors.ts';
import { LiveSession } from './session.ts';

interface Owner {
  csrf: string;
  expires: number;
  operations: Set<string>;
  current?: { operation: string; session: LiveSession };
}
const COOKIE = 'live_console';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookie(req: http.IncomingMessage) {
  return (
    (req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1) || ''
  );
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new SampleError(415, 'json_required', 'This endpoint accepts JSON only.');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024) {
        req.pause();
        fail(new SampleError(413, 'body_too_large', 'Request exceeds 128 KiB.'));
      } else chunks.push(chunk);
    };
    const end = () => {
      req.off('error', fail);
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new SampleError(400, 'invalid_json', 'Expected one JSON object.'));
      }
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
  });
}

export function createHttpApp(
  settings: Settings,
  gateway: Gateway,
  fallback: http.RequestListener = (_req, res) => {
    res.writeHead(404);
    res.end('Not found');
  },
) {
  const owners = new Map<string, Owner>();
  const sessions = new Map<string, LiveSession>();
  let active: LiveSession | undefined;
  let starts: number[] = [];
  let shuttingDown = false;
  const gc = setInterval(() => {
    for (const [id, owner] of owners) if (owner.expires < Date.now() && !owner.current) owners.delete(id);
  }, 60000);
  gc.unref();
  const expectedHost = new URL(settings.origin).host;
  const guard = (req: http.IncomingMessage, mutation = false) => {
    if (
      req.headers.host !== expectedHost ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
    )
      throw new SampleError(421, 'local_only', `Open this local sample at ${settings.origin}.`);
    const origin = req.headers.origin;
    if (
      (origin && origin !== settings.origin) ||
      (mutation && origin !== settings.origin) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new SampleError(403, 'origin_rejected', 'Cross-origin access is not allowed.');
  };
  const ownerFor = (req: http.IncomingMessage) => {
    const id = cookie(req),
      owner = owners.get(id);
    if (!owner || owner.expires < Date.now())
      throw new SampleError(
        401,
        'console_expired',
        'This console session expired.',
        'Reload the page to start a new local console session.',
      );
    owner.expires = Date.now() + 30 * 60000;
    return { id, owner };
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'microphone=(self), camera=(), geolocation=(), payment=(), speaker-selection=(self)',
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      guard(req);
      const url = new URL(req.url || '/', settings.origin);
      if (!url.pathname.startsWith('/api/')) {
        fallback(req, res);
        return;
      }
      if (url.search) throw new SampleError(400, 'unexpected_query', 'Unexpected query parameters.');
      if (req.method === 'GET' && url.pathname === '/api/config') {
        let id = cookie(req),
          owner = owners.get(id);
        if (!owner || owner.expires < Date.now()) {
          if (owners.size >= 128)
            throw new SampleError(
              503,
              'console_limit',
              'Too many local console sessions. Restart the server.',
            );
          id = randomBytes(32).toString('hex');
          owner = {
            csrf: randomBytes(32).toString('hex'),
            expires: Date.now() + 30 * 60000,
            operations: new Set(),
          };
          owners.set(id, owner);
        }
        res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`);
        json(res, 200, {
          csrf: owner.csrf,
          configured: Boolean(settings.apiKey),
          model: MODEL,
          backendModel: settings.backendModel,
          maxSessionSeconds: settings.maxSessionSeconds,
        });
        return;
      }
      if (req.method !== 'POST') throw new SampleError(405, 'method_not_allowed', 'Method not allowed.');
      guard(req, true);
      const { id, owner } = ownerFor(req);
      const csrf = req.headers['x-console-csrf'];
      if (typeof csrf !== 'string' || !equal(csrf, owner.csrf))
        throw new SampleError(
          403,
          'csrf_rejected',
          'Console verification failed.',
          'Reload the page and try again.',
        );
      const payload = await body(req);
      if (url.pathname === '/api/sessions/close') {
        if (
          Object.keys(payload).join(',') !== 'operationId' ||
          typeof payload.operationId !== 'string' ||
          !uuid.test(payload.operationId)
        )
          throw new SampleError(400, 'invalid_operation', 'A valid operationId is required.');
        if (!owner.current || owner.current.operation !== payload.operationId) {
          owner.operations.add(payload.operationId);
          if (owner.operations.size > 32) owner.operations.delete(owner.operations.values().next().value!);
          json(res, 200, { type: 'cancelled' });
          return;
        }
        if (owner.current.session.rejectedBeforeCreation) {
          json(res, 200, { type: 'cancelled' });
          return;
        }
        const session = owner.current.session;
        session.cancelStart();
        const result = await session.stop('Stop requested');
        json(res, 200, session.rejectedBeforeCreation ? { type: 'cancelled' } : result);
        return;
      }
      if (url.pathname !== '/api/sessions') throw new SampleError(404, 'not_found', 'Endpoint not found.');
      if (
        Object.keys(payload).sort().join(',') !== 'mode,operationId,sdp' ||
        !['responses', 'client'].includes(String(payload.mode)) ||
        typeof payload.sdp !== 'string' ||
        !payload.sdp.startsWith('v=0') ||
        payload.sdp.length < 32 ||
        typeof payload.operationId !== 'string' ||
        !uuid.test(payload.operationId)
      )
        throw new SampleError(
          400,
          'invalid_session_request',
          'Expected a mode, operationId, and complete SDP offer.',
        );
      if (!settings.apiKey)
        throw new SampleError(
          503,
          'key_missing',
          'The server has no OPENAI_API_KEY.',
          'Set it in the local .env file, then restart the server.',
        );
      if (shuttingDown) throw new SampleError(503, 'shutting_down', 'The server is shutting down.');
      if (owner.operations.has(payload.operationId))
        throw new SampleError(409, 'duplicate_operation', 'This startup operation was already used.');
      if (active && !active.isTerminal)
        throw new SampleError(
          409,
          'session_busy',
          'This sample allows one active session at a time.',
          'Stop the existing session before starting another.',
        );
      starts = starts.filter((time) => Date.now() - time < 60000);
      if (starts.length >= 6)
        throw new SampleError(
          429,
          'start_limit',
          'Too many session starts. Wait one minute before trying again.',
        );
      starts.push(Date.now());
      owner.operations.add(payload.operationId);
      if (owner.operations.size > 32) owner.operations.delete(owner.operations.values().next().value!);
      const session = new LiveSession(id, payload.mode as 'responses' | 'client', settings, gateway);
      active = session;
      owner.current = { operation: payload.operationId, session };
      sessions.set(session.id, session);
      // Keep creation under server ownership if the browser cancels its fetch.
      res.once('close', () => {
        if (!res.writableEnded) session.cancelStart();
      });
      void session.done.then(() => {
        if (active === session) active = undefined;
        // Retain the terminal receipt briefly for a concurrent stop request.
        const timer = setTimeout(() => {
          sessions.delete(session.id);
          if (owner.current?.session === session) owner.current = undefined;
        }, 30000);
        timer.unref();
      });
      const sdp = await session.start(payload.sdp);
      if (!res.destroyed) json(res, 201, { id: session.id, sdp });
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        const status = error instanceof SampleError ? error.status : 502;
        if (status === 413) res.setHeader('Connection', 'close');
        json(res, status, publicError(error));
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // Vite's HMR upgrade has its own handler and carries no application authority.
    if (!req.url?.startsWith('/api/')) return;
    try {
      guard(req, true);
      const url = new URL(req.url, settings.origin);
      if (url.pathname !== '/api/events' || [...url.searchParams.keys()].join(',') !== 'session')
        throw new Error();
      const { id } = ownerFor(req);
      const session = sessions.get(url.searchParams.get('session') || '');
      if (!session || session.owner !== id) throw new Error();
      sockets.handleUpgrade(req, socket, head, (ws) => {
        let unsubscribe: (() => void) | undefined;
        try {
          unsubscribe = session.subscribe((value) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
          });
        } catch {
          ws.close(1008, 'Session already connected');
          return;
        }
        ws.on('message', (raw) => {
          try {
            const value = record(JSON.parse(raw.toString()));
            if (Object.keys(value).join(',') !== 'type' || value.type !== 'heartbeat') throw new Error();
            session.beat();
          } catch {
            ws.close(1008, 'Only heartbeat messages are accepted');
          }
        });
        ws.on('error', () => ws.close());
        ws.once('close', () => unsubscribe?.());
        void session.done.then(() => {
          const timer = setTimeout(() => ws.close(1000, 'Session ended'), 250);
          timer.unref();
        });
      });
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  return {
    server,
    async dispose() {
      shuttingDown = true;
      clearInterval(gc);
      await Promise.all(
        [...sessions.values()].filter((s) => !s.isTerminal).map((s) => s.stop('Server shutting down')),
      );
      for (const client of sockets.clients) client.close();
      sockets.close();
    },
  };
}
