/**
 * Registers the SportyBet vFootball source.
 *
 *   npm run db:seed
 *   npm run db:seed -- "https://www.sportybet.com/ng/m/sport/vFootball/live_list"
 *
 * Runs pending migrations first, then inserts the source. Both steps are
 * idempotent, so this is safe to run on every deploy.
 */
import './load-env.mjs';

import { runMigrations } from '../src/lib/db/client.ts';
import { getSourceByUrl, insertSource, listSources } from '../src/lib/db/queries.ts';
import { UrlNotAllowedError, resolveSource } from '../src/lib/core/url-allowlist.ts';

const DEFAULT_URL =
  process.env.DEFAULT_SOURCE_URL?.trim() ||
  'https://www.sportybet.com/ng/m/sport/vFootball/live_list';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
    process.exitCode = 1;
    return;
  }

  const input = process.argv[2]?.trim() || DEFAULT_URL;

  // Registering a source requires tables, so migrate on first run rather than
  // requiring two separate manual steps.
  const applied = await runMigrations();
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }

  let descriptor;
  try {
    descriptor = resolveSource(input);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) {
      console.error(`Rejected: ${error.message}`);
      console.error(`Input:   ${error.input}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const existing = await getSourceByUrl(descriptor.pageUrl);
  if (existing) {
    console.log('Source already registered — nothing to do.');
    console.log(`  name:  ${existing.name}`);
    console.log(`  url:   ${existing.sourceUrl}`);
    console.log(`  api:   ${existing.baseUrl}`);
    await listSources();
    return;
  }

  const source = await insertSource(descriptor);

  console.log('Registered source:');
  console.log(`  name:  ${source.name}`);
  console.log(`  url:   ${source.sourceUrl}`);
  console.log(`  api:   ${descriptor.apiBaseUrl}`);
  console.log(`  sport: ${descriptor.sportId ?? 'unknown'}`);
  console.log(`  id:    ${source.id}`);
  console.log('');
  console.log('Next: npm run poll:once -- --start   (creates a tracking session)');
  console.log('Then: npm run poll:once              (single poll)');
}

main().catch((error) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});