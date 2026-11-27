const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_ORIGIN = 'https://avatars.githubusercontent.com';
const PROFILE_ORIGIN = 'https://github.com';
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_IMAGE_BYTES = 32 * 1024;
const CACHE_ENTRIES = 80;
const MAX_PENDING = 24, MAX_DOWNLOADS = 3, DOWNLOAD_TIMEOUT = 10_000;
const IMAGE_TTL = 24 * 60 * 60_000, RETRY_TTL = 10_000;

export const githubLoginKey = name => typeof name === 'string' &&
  /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(name) ? name.toLowerCase() : null;

export function createAvatarCache({ fetcher = fetch, now = Date.now, signal }) {
  const cached = new Map(), pending = new Map(), queue = [];
  let downloading = 0;

  async function download(login) {
    try {
      const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
      const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const profile = await fetcher(new URL(`/${login}.png?size=64`, PROFILE_ORIGIN), {
        credentials: 'omit', redirect: 'manual', signal: downloadSignal
      });
      let id = null;
      try {
        const loc = profile.headers.get('location');
        if (REDIRECT_CODES.has(profile.status) && loc) {
          const target = new URL(loc);
          const parsed = target.origin === AVATAR_ORIGIN ? Number(/^\/u\/([1-9]\d*)$/.exec(target.pathname)?.[1]) : 0;
          if (Number.isSafeInteger(parsed) && parsed > 0) id = parsed;
        }
      } finally { await profile.body?.cancel(); }
      if (!id) return null;
      const response = await fetcher(new URL(`/u/${id}?s=64`, AVATAR_ORIGIN), {
        credentials: 'omit', redirect: 'error', signal: downloadSignal
      });
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !IMAGE_TYPES.has(type) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        return null;
      }
      const body = response.body?.getReader();
      if (!body) return null;
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await body.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_IMAGE_BYTES) { await body.cancel(); return null; }
          chunks.push(value);
        }
      } finally { body.releaseLock(); }
      return bytes ? `data:${type};base64,${Buffer.concat(chunks, bytes).toString('base64')}` : null;
    } catch { return null; }
  }

  function pump() {
    while (downloading < MAX_DOWNLOADS && queue.length) {
      const { login, resolve } = queue.shift();
      if (signal?.aborted) { pending.delete(login); resolve(null); continue; }
      downloading++;
      void download(login).then(image => {
        if (!signal?.aborted) {
          cached.set(login, { image, until: now() + (image ? IMAGE_TTL : RETRY_TTL) });
          if (cached.size > CACHE_ENTRIES) cached.delete(cached.keys().next().value);
        }
        pending.delete(login);
        downloading--;
        resolve(image);
        pump();
      });
    }
  }

  async function get(username) {
    const key = githubLoginKey(username);
    if (key === null || signal?.aborted) return null;
    const entry = cached.get(key);
    if (entry) {
      cached.delete(key);
      if (entry.until > now()) { cached.set(key, entry); return entry.image; }
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= MAX_PENDING) return null;
    const { promise, resolve } = Promise.withResolvers();
    pending.set(key, promise);
    queue.push({ login: key, resolve });
    pump();
    return promise;
  }
  return { get };
}
