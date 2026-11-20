import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLeaderboardServer } from './app.mjs';
import { openLeaderboardStore } from './store.mjs';

const env = process.env;
const port = Number(env.LEADERBOARD_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LEADERBOARD_PORT');
const filename = resolve(env.LEADERBOARD_DB ?? 'server/.data/leaderboard.sqlite');
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = openLeaderboardStore(filename);
const server = createLeaderboardServer({
  store,
  baseUrl: env.LEADERBOARD_BASE_URL ?? `http://127.0.0.1:${port}`,
  clientId: env.GITHUB_CLIENT_ID,
  clientSecret: env.GITHUB_CLIENT_SECRET,
  adminEmail: env.LEADERBOARD_ADMIN_EMAIL?.trim(),
  maxTokens: Number(env.LEADERBOARD_MAX_TOKENS ?? Number.MAX_SAFE_INTEGER),
  log: message => process.stderr.write(message + '\n')
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`榜单服务在本机端口 ${port} 运行。\n`));
function stop() {
  server.close(() => store.close());
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
