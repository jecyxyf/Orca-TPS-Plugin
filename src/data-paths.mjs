import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRoots } from './harness_parser.mjs';

export function localUsageDatabasePath(options = {}) {
  const join = (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(defaultRoots(options).userData, 'tps-plugin', 'usage.sqlite');
}

export function ccSwitchUsagePaths() {
  const { ccSwitchDb, userData } = defaultRoots();
  const filename = process.platform === 'win32' ? 'cc-switch-usage.exe' : 'cc-switch-usage';
  const bundled = new URL(`../native/bin/${process.platform}-${process.arch}/${filename}.gz`, import.meta.url);
  return {
    binary: process.env.ORCA_TPS_CC_SWITCH_USAGE_BIN,
    archive: fileURLToPath(bundled),
    filename,
    sourceDb: ccSwitchDb,
    stateHome: path.join(userData, 'tps-plugin', 'cc-switch-4.0.25')
  };
}
