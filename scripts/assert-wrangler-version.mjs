import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_WRANGLER_VERSION = '4.129.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const wranglerPackage = path.join(repoRoot, 'node_modules', 'wrangler', 'package.json');

if (!fs.existsSync(wranglerPackage)) {
  console.error('Wrangler is not installed. Run `npm ci` before deploy.');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(wranglerPackage, 'utf8'));
if (pkg.version !== EXPECTED_WRANGLER_VERSION) {
  console.error(`Wrangler version mismatch: expected ${EXPECTED_WRANGLER_VERSION}, got ${pkg.version}.`);
  console.error('Run `npm ci` using the committed package-lock.json before deploy.');
  process.exit(1);
}
console.log(`Wrangler version verified: ${pkg.version}`);
