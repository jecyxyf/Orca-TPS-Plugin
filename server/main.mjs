import { resolve } from 'node:path';
import { createLeaderboardServer } from './app.mjs';
import { openLeaderboardStore } from './store.mjs';
import { createTokensManagerJobs } from './tokens-manager-jobs.mjs';

const env = process.env;
const host = env.LEADERBOARD_HOST ?? '127.0.0.1';
const port = Number(env.LEADERBOARD_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LEADERBOARD_PORT');
const filename = resolve(env.LEADERBOARD_STATE_FILE ?? 'server/.data/leaderboard.bin');
const store = openLeaderboardStore(filename);
const maxTokens = Number(env.LEADERBOARD_MAX_TOKENS ?? Number.MAX_SAFE_INTEGER);
const log = message => process.stderr.write(message + '\n');
const tokensJobs = createTokensManagerJobs({
  maxTokens, now: Date.now, log,
  receiverCount: env.LEADERBOARD_TOKENS_RECEIVERS === undefined ? undefined : Number(env.LEADERBOARD_TOKENS_RECEIVERS),
  flushMs: env.LEADERBOARD_TOKENS_FLUSH_MS === undefined ? undefined : Number(env.LEADERBOARD_TOKENS_FLUSH_MS),
  intervals: {
    scanMs: Number(env.LEADERBOARD_TOKENS_SCAN_MS), personalMs: Number(env.LEADERBOARD_TOKENS_PERSONAL_MS),
    uploadMs: Number(env.LEADERBOARD_TOKENS_UPLOAD_MS), publishMs: Number(env.LEADERBOARD_TOKENS_PUBLISH_MS),
    readMs: Number(env.LEADERBOARD_TOKENS_READ_MS)
  }
});
const server = createLeaderboardServer({
  store, tokensJobs, maxTokens, log,
  baseUrl: env.LEADERBOARD_BASE_URL ?? `http://127.0.0.1:${port}`,
  clientId: env.GITHUB_CLIENT_ID,
  clientSecret: env.GITHUB_CLIENT_SECRET,
  adminEmail: env.LEADERBOARD_ADMIN_EMAIL?.trim(),
  trustedProxyIps: env.LEADERBOARD_TRUSTED_PROXY_IPS?.split(',').map(address => address.trim()).filter(Boolean)
});
server.listen(port, host, () => process.stdout.write(`榜单服务监听 ${host}:${port}。\n`));
function stop() {
  server.close(() => { void tokensJobs.close().catch(() => log('榜单线程退出失败。')); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
