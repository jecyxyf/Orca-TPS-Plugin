import path from 'node:path';
import { defaultRoots } from './harness_parser.mjs';

export function localUsageDatabasePath(options = {}) {
  const join = (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(defaultRoots(options).userData, 'tps-plugin', 'usage.sqlite');
}
