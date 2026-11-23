import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const tag = 'v4.0.25';
const revision = 'a3eafa408ae679db2e3401fca767ed2b89d9a2b2';
const upstream = path.resolve(process.env.ORCA_TPS_CC_SWITCH_SOURCE || path.join(tmpdir(), 'orca-cc-switch-v4-0-25-proof'));
const run = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });

if (!(await stat(upstream).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
}))) {
  run('git', ['clone', '--depth', '1', '--branch', tag, 'https://github.com/farion1231/cc-switch.git', upstream]);
}
const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (checkedOut !== revision) throw new Error(`CC Switch source must be ${revision}`);
run('git', ['diff', '--quiet', 'HEAD'], { cwd: upstream });

const backend = path.join(upstream, 'src-tauri');
const example = 'orca_tps_usage_bridge';
const extension = process.platform === 'win32' ? '.exe' : '';
await mkdir(path.join(backend, 'examples'), { recursive: true });
await copyFile(new URL('./cc-switch-usage.rs', import.meta.url), path.join(backend, 'examples', `${example}.rs`));
run('cargo', ['+stable', 'build', '--locked', '--example', example], {
  cwd: backend,
  env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: '0', CARGO_TARGET_DIR: path.join(backend, 'target') }
});
run('git', ['diff', '--quiet', 'HEAD'], { cwd: upstream });

const destination = fileURLToPath(new URL(`./bin/${process.platform}-${process.arch}/`, import.meta.url));
await mkdir(destination, { recursive: true });
const archive = path.join(destination, `cc-switch-usage${extension}.gz`);
const temporary = `${archive}.${process.pid}.next`;
try {
  await pipeline(
    createReadStream(path.join(backend, 'target', 'debug', 'examples', example + extension)),
    createGzip({ level: 9 }), createWriteStream(temporary)
  );
  await rename(temporary, archive);
} finally { await rm(temporary, { force: true }); }
console.log(`CC Switch ${tag} usage helper built at ${destination}`);
