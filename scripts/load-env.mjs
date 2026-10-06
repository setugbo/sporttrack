/**
 * Minimal `.env` / `.env.local` loader.
 *
 * Deliberately dependency-free: this runs before any application module reads
 * `process.env`, and real values already in the environment always win.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function apply(file) {
  const full = path.join(projectRoot, file);
  if (!existsSync(full)) return false;

  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// `.env.local` is applied first so it overrides `.env`.
apply('.env.local');
apply('.env');

export { projectRoot };