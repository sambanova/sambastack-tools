/**
 * @jest-environment node
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type Server } from 'http';
import { curlLike } from '../cli';

let server: Server;
let base = '';
const seen: { auth?: string; ctype?: string; method?: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, ctype: req.headers['content-type'], method: req.method, body });
      if (req.url === '/slow') return; // never answers
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(req.url === '/missing' ? '{"error":"nope"}' : '{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

describe('curlLike (replaces the curl calls that put the API key on a command line)', () => {
  it('returns "<body>\\n<status>" like curl -w did, for 2xx and for error statuses', async () => {
    expect(await curlLike(`${base}/v1/models`, { apiKey: 'k1', timeoutMs: 5000 })).toBe('{"ok":true}\n200');
    expect(await curlLike(`${base}/missing`, { apiKey: 'k1', timeoutMs: 5000 })).toBe('{"error":"nope"}\n404');
  });
  it('sends the key as a header and the JSON body with a content type; a GET has no body', async () => {
    seen.length = 0;
    await curlLike(`${base}/x`, { method: 'POST', apiKey: 'secret-key', body: '{"a":1}', timeoutMs: 5000 });
    expect(seen[0]).toMatchObject({ method: 'POST', auth: 'Bearer secret-key', ctype: 'application/json', body: '{"a":1}' });
    await curlLike(`${base}/x`, { timeoutMs: 5000 });
    expect(seen[1]).toMatchObject({ method: 'GET', auth: undefined, body: '' });
  });
  it('HEAD yields just the status', async () => {
    expect(await curlLike(`${base}/x`, { method: 'HEAD', timeoutMs: 5000 })).toBe('\n200');
  });
  it('a refused connection and a timeout throw a readable message that names the URL', async () => {
    await expect(curlLike('http://127.0.0.1:1/x', { timeoutMs: 5000 })).rejects.toThrow(/Cannot reach http:\/\/127\.0\.0\.1:1\/x/);
    await expect(curlLike(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow(/timed out after 0\.3s/);
  });
});
