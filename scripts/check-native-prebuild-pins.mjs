import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const lockText = readFileSync('pnpm-lock.yaml', 'utf8');
const nativePackages = [
  'lightningcss-linux-x64-gnu',
  '@tailwindcss/oxide-linux-x64-gnu',
  '@rolldown/binding-linux-x64-gnu',
  '@unrs/resolver-binding-linux-x64-gnu',
  '@img/sharp-linux-x64',
  '@img/sharp-libvips-linux-x64',
];

const failures = [];

function isLocked(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\s*['"]?${escaped}@[^\\s'"]+['"]?:`, 'm');
  return re.test(lockText);
}

function isInstalled(packageName) {
  // npm-style hoist
  if (existsSync(join('node_modules', packageName))) return true;
  // pnpm virtual store: node_modules/.pnpm/@scope+name@version or name@version
  const store = join('node_modules', '.pnpm');
  if (!existsSync(store)) return false;
  const encoded = packageName.startsWith('@')
    ? packageName.replace('/', '+')
    : packageName;
  return readdirSync(store).some((entry) => entry.startsWith(`${encoded}@`));
}

for (const packageName of nativePackages) {
  if (!isLocked(packageName)) {
    failures.push(`${packageName}: missing from pnpm-lock.yaml`);
    continue;
  }

  if (process.platform === 'linux' && process.arch === 'x64' && !isInstalled(packageName)) {
    failures.push(`${packageName}: missing from Linux installation`);
  }
}

if (failures.length > 0) {
  console.error('Native Linux prebuilds are missing:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Native Linux prebuilds are locked and installed.');
