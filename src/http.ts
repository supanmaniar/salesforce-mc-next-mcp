/**
 * http.ts — optional Streamable HTTP transport.
 *
 * Disabled by default. The server is stdio-only unless MC_NEXT_HTTP_ENABLED=true.
 *
 * ## Why this is off by default
 *
 * stdio has a strong security property: the only thing that can talk to the
 * server is the process that launched it. Moving to HTTP removes that property
 * entirely. Two consequences matter here:
 *
 *  1. **Anyone who can reach the port can call every tool**, including the
 *     destructive ones (subject to the same gates). A bearer token is therefore
 *     mandatory for any non-loopback bind — enforced in config.ts, which refuses
 *     to start rather than warning.
 *
 *  2. **Every caller acts as the same Salesforce user.** This server uses OAuth
 *     client-credentials, so there is one integration user and no per-request
 *     identity. A shared HTTP deployment therefore gives every user the
 *     integration user's access. There is no impersonation and no per-user audit
 *     trail. This is a property of the auth model, not of the transport, and it
 *     cannot be fixed here. See docs/HTTP-DEPLOYMENT.md.
 *
 * ## Session model
 *
 * Stateful sessions, one transport per initialized client, tracked by session
 * ID. Sessions are in-memory only and are dropped on restart.
 *
 * See docs/HTTP-DEPLOYMENT.md for deployment guidance.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McNextConfig } from './config.js';
import { log, isLoopbackHost } from './config.js';

/** Constant-time comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface HttpHandle {
  /** The underlying Node HTTP server, for tests and for graceful shutdown. */
  close: () => Promise<void>;
  url: string;
}

/**
 * Build the Express app. Exported separately so tests can mount it without
 * binding a port.
 *
 * `buildServer` is called once per session: each session gets its own
 * McpServer instance, which is the SDK's recommended stateful pattern.
 */
export function createHttpApp(
  cfg: McNextConfig,
  buildServer: () => McpServer
): { app: Express; transports: Map<string, StreamableHTTPServerTransport> } {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // --- Host header validation (DNS rebinding protection) -------------------
  // When bound beyond loopback, the Host header must be explicitly allowed.
  // Without this, a malicious page could resolve its own hostname to this
  // server's address and drive it from a victim's browser.
  if (!isLoopbackHost(cfg.http.host)) {
    const allowed = new Set(cfg.http.allowedHosts);
    if (allowed.size) {
      app.use((req: Request, res: Response, next: NextFunction) => {
        const host = (req.headers.host ?? '').split(':')[0];
        if (!allowed.has(host)) {
          res.status(403).json({ error: `Host "${host}" is not in MC_NEXT_HTTP_ALLOWED_HOSTS.` });
          return;
        }
        next();
      });
    }
  }

  // --- Bearer token auth ----------------------------------------------------
  // Enforced whenever a token is configured. config.ts guarantees a token
  // exists for any non-loopback bind, so this cannot be bypassed there.
  if (cfg.http.authToken) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      // A bare liveness probe must not require credentials.
      if (req.path === '/healthz') {
        next();
        return;
      }
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!token || !safeEqual(token, cfg.http.authToken)) {
        res.status(401).json({ error: 'Missing or invalid bearer token.' });
        return;
      }
      next();
    });
  }

  // --- Liveness ------------------------------------------------------------
  // Deliberately minimal: reports nothing about Salesforce connectivity, and
  // is the only unauthenticated route.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http' });
  });

  // --- MCP endpoint --------------------------------------------------------
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            log(cfg, `http session initialized: ${sid}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports.has(sid)) {
            transports.delete(sid);
            log(cfg, `http session closed: ${sid}`);
          }
        };
        await buildServer().connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session ID provided.' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(
        req as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (err) {
      log(cfg, 'http request error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET (SSE stream) and DELETE (session teardown) reuse the same handler.
  const sessionHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID.');
      return;
    }
    await transports
      .get(sessionId)!
      .handleRequest(req as IncomingMessage, res as unknown as ServerResponse);
  };
  app.get('/mcp', sessionHandler);
  app.delete('/mcp', sessionHandler);

  return { app, transports };
}

/** Start the HTTP listener. Resolves once it is accepting connections. */
export async function startHttp(
  cfg: McNextConfig,
  buildServer: () => McpServer
): Promise<HttpHandle> {
  const { app, transports } = createHttpApp(cfg, buildServer);

  const server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
    const s = app.listen(cfg.http.port, cfg.http.host, () => resolve(s));
    s.on('error', reject);
  });

  const shownHost = cfg.http.host === '0.0.0.0' ? 'localhost' : cfg.http.host;
  const url = `http://${shownHost}:${cfg.http.port}`;

  console.error(
    `[mc-next-mcp-server] HTTP transport listening on ${cfg.http.host}:${cfg.http.port}\n` +
      `  endpoint:   POST ${url}/mcp\n` +
      `  health:     GET  ${url}/healthz\n` +
      `  auth:       ${cfg.http.authToken ? 'bearer token required' : 'NONE (loopback only)'}\n` +
      `  sessions:   stateful, in-memory\n` +
      `  WARNING:    every caller runs as the same Salesforce integration user. ` +
      'See docs/HTTP-DEPLOYMENT.md.'
  );

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of transports.values()) void t.close().catch(() => undefined);
        transports.clear();
        server.close(() => resolve());
      }),
  };
}
