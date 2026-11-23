import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLeaderboardServer } from './app.mjs';
import { openLeaderboardStore } from './store.mjs';
import { createLeaderboardJobs } from './leaderboard-jobs.mjs';
import { createTokensManagerJobs } from './tokens-manager-jobs.mjs';

const env = process.env;
const host = env.LEADERBOARD_HOST ?? '127.0.0.1';
const port = Number(env.LEADERBOARD_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LEADERBOARD_PORT');
const filename = resolve(env.LEADERBOARD_DB ?? 'server/.data/leaderboard.sqlite');
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = openLeaderboardStore(filename);
const maxTokens = Number(env.LEADERBOARD_MAX_TOKENS ?? Number.MAX_SAFE_INTEGER);
const log = message => process.stderr.write(message + '\n');
const jobOptions = { filename, maxTokens, readPublished: store.leaderboardData.latestResult,
  onWrite: store.invalidateUploadCaches, log };
const brokers = env.LEADERBOARD_KAFKA_BROKERS?.split(',').map(address => address.trim()).filter(Boolean);
const jobs = brokers?.length
  ? (await import('./kafka-transport.mjs')).createKafkaLeaderboardJobs({ ...jobOptions, brokers,
    topic: env.LEADERBOARD_KAFKA_TOPIC, groupId: env.LEADERBOARD_KAFKA_GROUP_ID })
  : createLeaderboardJobs(jobOptions);
const tokensJobs = createTokensManagerJobs({ maxTokens, now: Date.now, log, intervals: {
  scanMs: Number(env.LEADERBOARD_TOKENS_SCAN_MS), personalMs: Number(env.LEADERBOARD_TOKENS_PERSONAL_MS),
  uploadMs: Number(env.LEADERBOARD_TOKENS_UPLOAD_MS), publishMs: Number(env.LEADERBOARD_TOKENS_PUBLISH_MS),
  readMs: Number(env.LEADERBOARD_TOKENS_READ_MS)
} });
const server = createLeaderboardServer({
  store, jobs, tokensJobs, maxTokens, log,
  baseUrl: env.LEADERBOARD_BASE_URL ?? `http://127.0.0.1:${port}`,
  clientId: env.GITHUB_CLIENT_ID,
  clientSecret: env.GITHUB_CLIENT_SECRET,
  adminEmail: env.LEADERBOARD_ADMIN_EMAIL?.trim(),
  trustedProxyIps: env.LEADERBOARD_TRUSTED_PROXY_IPS?.split(',').map(address => address.trim()).filter(Boolean)
});
server.listen(port, host, () => process.stdout.write(`榜单服务监听 ${host}:${port}。\n`));
function stop() {
  server.close(() => { void Promise.allSettled([jobs.close(), tokensJobs.close()]).finally(store.close); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
