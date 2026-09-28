// Minimal Discord REST client: bot auth, serialized requests, rate-limit
// handling (per-route buckets, 429 retry_after, global limits), retries on
// 5xx/network errors, and error logging that never includes the token.

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/lastkdj/ClaudeDiscordBot, 0.1.0)';
const MAX_429_RETRIES = 6;
const MAX_ERROR_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DiscordAPIError extends Error {
  constructor(method, path, status, body) {
    const detail = body?.message ?? (typeof body === 'string' ? body : '');
    const code = body?.code !== undefined ? ` (code ${body.code})` : '';
    const fields = body?.errors ? ` ${JSON.stringify(body.errors)}` : '';
    super(`${method} ${path} -> ${status}${code}: ${detail}${fields}`);
    this.name = 'DiscordAPIError';
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

// Collapse snowflake IDs so requests to the same endpoint share a bucket key.
// Coarser than Discord's real buckets, which only makes us more conservative.
const routeKey = (method, path) => `${method} ${path.replace(/\d{15,}/g, ':id')}`;

export function createClient({ token, log = console, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('createClient: token is required');
  const redact = (s) => String(s).split(token).join('[REDACTED]');
  const bucketResetAt = new Map();
  let globalResetAt = 0;
  let queue = Promise.resolve();

  async function send(method, path, { body, query, reason } = {}) {
    const url = API + path + (query ? `?${new URLSearchParams(query)}` : '');
    const headers = { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason.slice(0, 512));
    const key = routeKey(method, path);

    let rateLimitRetries = 0;
    let errorRetries = 0;
    for (;;) {
      const wait = Math.max(globalResetAt, bucketResetAt.get(key) ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);

      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (errorRetries < MAX_ERROR_RETRIES) {
          const backoff = 1000 * 2 ** errorRetries++;
          log.warn(`[discord] network error on ${method} ${path}: ${redact(err.message)}; retrying in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        throw new Error(redact(`${method} ${path} failed: ${err.message}`));
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && resetAfter > 0) bucketResetAt.set(key, Date.now() + resetAfter * 1000 + 50);

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfter = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
        const until = Date.now() + retryAfter * 1000 + 100;
        if (data.global) globalResetAt = until;
        else bucketResetAt.set(key, until);
        if (rateLimitRetries++ < MAX_429_RETRIES) {
          log.warn(`[discord] rate limited on ${method} ${path}${data.global ? ' (global)' : ''}; waiting ${retryAfter}s`);
          continue;
        }
        throw new DiscordAPIError(method, path, 429, data);
      }

      if (res.status >= 500 && errorRetries < MAX_ERROR_RETRIES) {
        const backoff = 1000 * 2 ** errorRetries++;
        log.warn(`[discord] ${res.status} on ${method} ${path}; retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const err = new DiscordAPIError(method, path, res.status, data);
        err.message = redact(err.message);
        if (res.status === 401) err.message += ' — the bot token is invalid or was reset; update DISCORD_TOKEN.';
        log.error(`[discord] ${err.message}`);
        throw err;
      }
      return data;
    }
  }

  // Serialize every request so we never burst against the API.
  function request(method, path, opts) {
    const p = queue.then(() => send(method, path, opts));
    queue = p.catch(() => {});
    return p;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    put: (path, body, opts) => request('PUT', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
    redact,
  };
}
