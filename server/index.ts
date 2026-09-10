import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { settingsFromEnv } from './config.ts';
import { createGateway } from './openai.ts';
import { createHttpApp } from './http.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = settingsFromEnv();
const production = process.argv.includes('--production');
let serve = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(503);
  res.end('Starting');
};
const app = createHttpApp(settings, createGateway(settings), (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'${production ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${settings.port}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  );
  serve(req, res);
});
if (production)
  app.server.on('upgrade', (req, socket) => {
    if (!req.url?.startsWith('/api/')) socket.destroy();
  });
let closeVite: (() => Promise<void>) | undefined;
if (!production) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    server: { middlewareMode: true, fs: { strict: true, allow: [root] }, ws: { server: app.server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  serve = (req, res) =>
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end('Not found');
    });
} else {
  const dist = resolve(root, 'dist');
  try {
    await stat(resolve(dist, 'index.html'));
  } catch {
    throw new Error('Build the frontend first: npm run build');
  }
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  serve = (req, res) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const path = decodeURIComponent(new URL(req.url || '/', settings.origin).pathname);
        const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
        if (!file.startsWith(`${dist}/`) || !mime[extname(file)] || !(await stat(file)).isFile())
          throw new Error();
        res.writeHead(200, { 'Content-Type': mime[extname(file)] });
        if (req.method === 'HEAD') res.end();
        else
          createReadStream(file)
            .on('error', () => res.destroy())
            .pipe(res);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    })();
  };
}
app.server.listen(settings.port, '127.0.0.1', () => {
  console.log(
    `\nOpenAI Live Console → ${settings.origin}\nLocal only · ${settings.maxSessionSeconds}s session limit · ${settings.backendModel} backend\n${settings.apiKey ? 'Server API key configured.' : 'Set OPENAI_API_KEY in .env and restart to connect.'}\n`,
  );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Closing active session before stopping…');
  await app.dispose();
  await closeVite?.();
  app.server.close(() => process.exit(0));
  app.server.closeIdleConnections();
  const timer = setTimeout(() => {
    app.server.closeAllConnections();
    process.exit(0);
  }, 1000);
  timer.unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
