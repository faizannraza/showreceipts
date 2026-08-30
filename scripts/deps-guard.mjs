// Guards the zero-dependency, install-script-free, four-entry `files` contract
// of the published package (ARCHITECTURE §15). Exit 1 with every violation.
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const failures = [];

const pkg = JSON.parse(read('package.json'));

for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  if (key in pkg) failures.push(`package.json has a "${key}" key (the package must have zero runtime dependencies)`);
}
for (const script of ['postinstall', 'prepare', 'preinstall', 'install']) {
  if (pkg.scripts && script in pkg.scripts) failures.push(`package.json has a "${script}" script (installs must run no code)`);
}

const expectedFiles = ['bin', 'dist', 'README.md', 'LICENSE'];
const files = Array.isArray(pkg.files) ? [...pkg.files].sort() : [];
if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort())) {
  failures.push(`package.json "files" must be exactly ${JSON.stringify(expectedFiles)} (got ${JSON.stringify(pkg.files)})`);
}

if (typeof pkg.repository?.url !== 'string' || pkg.repository.url === '') {
  failures.push('package.json "repository.url" is missing (required for provenance)');
}

let lock;
try {
  lock = JSON.parse(read('package-lock.json'));
} catch (err) {
  failures.push(`package-lock.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
}
if (lock) {
  if (!(lock.lockfileVersion >= 2) || typeof lock.packages !== 'object') {
    failures.push(`package-lock.json lockfileVersion ${lock.lockfileVersion} is not inspectable (need >= 2)`);
  } else {
    const rootEntry = lock.packages[''] ?? {};
    if (rootEntry.dependencies && Object.keys(rootEntry.dependencies).length > 0) {
      failures.push(`package-lock.json root entry lists runtime dependencies: ${Object.keys(rootEntry.dependencies).join(', ')}`);
    }
    const nonDev = Object.entries(lock.packages)
      .filter(([name, entry]) => name !== '' && entry.dev !== true)
      .map(([name]) => name);
    if (nonDev.length > 0) failures.push(`package-lock.json contains non-dev package(s): ${nonDev.join(', ')}`);
  }
}

const versionSource = read('src/version.ts');
const match = /TOOL_VERSION\s*=\s*'([^']+)'/.exec(versionSource);
if (!match) failures.push('src/version.ts does not define TOOL_VERSION');
else if (match[1] !== pkg.version) failures.push(`src/version.ts TOOL_VERSION ${match[1]} != package.json version ${pkg.version}`);

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`deps-guard: ${f}\n`);
  process.exit(1);
}
const devCount = lock ? Object.keys(lock.packages).length - 1 : 0;
process.stdout.write(`deps-guard: ok (${devCount} dev packages, zero runtime dependencies, files=${expectedFiles.join(',')})\n`);
