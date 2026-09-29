import { existsSync, readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const nativePackages = [
  'lightningcss-linux-x64-gnu',
  '@tailwindcss/oxide-linux-x64-gnu',
  '@rolldown/binding-linux-x64-gnu',
  '@unrs/resolver-binding-linux-x64-gnu',
  '@img/sharp-linux-x64',
  '@img/sharp-libvips-linux-x64',
];

const failures = [];

for (const packageName of nativePackages) {
  const lockedVersion = lock.packages?.[`node_modules/${packageName}`]?.version;
  if (!lockedVersion) {
    failures.push(`${packageName}: missing from package-lock.json`);
    continue;
  }

  if (process.platform === 'linux' && process.arch === 'x64' && !existsSync(`node_modules/${packageName}`)) {
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
