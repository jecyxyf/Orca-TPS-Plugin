import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const revision = '768eec9ca94db629f086e8c01ca91e2f63bb273d';
const source = path.resolve(process.env.ORCA_TPS_SCAN_SOURCE || path.join(tmpdir(), 'orca-tps-cc-switch-4.0.39'));
const example = 'orca_tps_manager_scan';
const run = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });
if (!(await stat(source).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
}))) {
  run('git', ['clone', '--depth', '1', '--branch', 'v4.0.39', 'https://github.com/farion1231/cc-switch.git', source]);
}
const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (checkout !== revision) throw new Error(`CC Switch scanner must use commit ${revision}`);
run('git', ['diff', '--quiet', 'HEAD'], { cwd: source });
const backend = path.join(source, 'src-tauri');
const lib = path.join(backend, 'src', 'lib.rs');
const original = await readFile(lib, 'utf8');
const declaration = '\npub use services::session_usage::sync_all_unlocked;\npub use session_manager::providers as tps_session_providers;\n';
const targetDir = path.join(backend, 'target');
const suffix = process.platform === 'win32' ? '.exe' : '';
await mkdir(path.join(backend, 'examples'), { recursive: true });
await copyFile(new URL('./tokens-manager-scan.rs', import.meta.url), path.join(backend, 'examples', example + '.rs'));
try {
  if (!original.includes(declaration)) await writeFile(lib, original + declaration);
  run('cargo', ['+stable', 'build', '--locked', '--example', example], {
    cwd: backend, env: { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_PROFILE_DEV_DEBUG: '0' }
  });
} finally {
  await writeFile(lib, original);
}

const destination = fileURLToPath(new URL(`./bin/${process.platform}-${process.arch}/`, import.meta.url));
await mkdir(destination, { recursive: true });
const archive = path.join(destination, `tokens-manager-scan${suffix}.gz`);
const temp = `${archive}.${process.pid}.next`;
await pipeline(createReadStream(path.join(targetDir, 'debug', 'examples', example + suffix)),
  createGzip({ level: 9 }), createWriteStream(temp));
await rename(temp, archive);
console.log(`Built CC Switch 4.0.39 scanner at ${archive}`);
