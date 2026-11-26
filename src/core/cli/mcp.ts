// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The loopback MCP server a CLI bridge calls Lektor's tools through
 * (DESIGN.md § Backends; INVARIANTS.md L4). One per run, on 127.0.0.1 and a
 * random port, answering only requests that carry the run's token, the right
 * Host and no Origin (so neither another program nor a web page can use it).
 * Streamable HTTP with plain JSON responses, tools only. Calls run one at a
 * time, through the reply's tool host (the same registry, approvals and caps
 * as every other backend). This is the only module that imports `http`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { ToolHost } from '../providers/types';

export const MCP_PATH = '/mcp';
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_INFO = { name: 'lektor', version: '1' };
const DEFAULT_PROTOCOL = '2025-06-18';

export interface McpRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
}

/** Why a request is refused (an HTTP status and text), or null if it may be answered. */
export function refuse(req: McpRequest, expected: { token: string; port: number }): { status: number; text: string } | null {
  if (req.path !== MCP_PATH) return { status: 404, text: 'Not found' };
  if (req.headers['origin'] !== undefined) return { status: 403, text: 'Forbidden' };
  if (req.headers['host'] !== `127.0.0.1:${expected.port}`) return { status: 403, text: 'Forbidden' };
  const auth = req.headers['authorization'] ?? '';
  const given = Buffer.from(auth);
  const wanted = Buffer.from(`Bearer ${expected.token}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { status: 401, text: 'Unauthorized' };
  if (req.method !== 'POST') return { status: 405, text: 'Method not allowed' };
  return null;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: (typeof id === 'string' || typeof id === 'number' ? id : null) as Json, error: { code, message } });

/**
 * Answer one JSON-RPC message (INVARIANTS.md L4). Returns the response object, or null for a
 * notification. Never throws.
 */
export async function answer(body: string, host: ToolHost): Promise<object | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!isObject(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') return rpcError(isObject(msg) ? msg['id'] : null, -32600, 'Invalid request');
  const id = msg['id'];
  const method = msg['method'];
  const params = isObject(msg['params']) ? msg['params'] : {};
  if (id === undefined) return null; // a notification (initialized, cancelled): nothing to answer
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid request');
  const ok = (result: object) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: host.definitions.map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })) });
    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string' || !host.definitions.some((d) => d.name === name)) return rpcError(id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
      try {
        const r = await host.call(name, params['arguments'] ?? {});
        return ok({
          content: [{ type: 'text', text: r.content }, ...(r.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mime }))],
          isError: r.isError,
        });
      } catch {
        return ok({ content: [{ type: 'text', text: 'The tool failed.' }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

/** One tool at a time: Lektor's approval cards are one at a time. */
export function serialHost(host: ToolHost): ToolHost {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    definitions: host.definitions,
    call(name, args) {
      const next = queue.then(() => host.call(name, args));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export interface McpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Start a run's server on 127.0.0.1 and a random port. */
export function startMcpServer(host: ToolHost): Promise<McpServer> {
  const token = randomBytes(32).toString('hex');
  const tools = serialHost(host);
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    const refused = refuse({ method: req.method ?? '', path: (req.url ?? '').split('?')[0] ?? '', headers }, { token, port });
    if (refused) {
      res.writeHead(refused.status, { 'Content-Type': 'text/plain' }).end(refused.text);
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      void answer(Buffer.concat(chunks).toString('utf8'), tools).then((out) => {
        if (out === null) res.writeHead(202).end();
        else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
