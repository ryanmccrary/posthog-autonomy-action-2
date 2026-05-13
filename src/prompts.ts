/**
 * Prompt files live in src/prompts/*.md so they can be edited as markdown and
 * iterated on without a rebuild. At build time `ncc` bundles all TS into a
 * single dist/index.js but does NOT copy non-JS assets — the build script in
 * package.json explicitly copies src/prompts/ to dist/prompts/.
 *
 * This loader works in BOTH execution modes:
 *  - **source / dev** (`tsx src/index.ts`): the running file is in src/, so
 *    prompts are at `./prompts/` relative to this loader.
 *  - **bundled** (`node dist/index.js` — the GitHub Action entry point):
 *    `import.meta.url` resolves to inside dist/, so prompts are at
 *    `./prompts/` relative to the bundle. Same lookup, different anchor.
 *
 * We also accept `../prompts/` as a third fallback so older relative-import
 * call sites still work without modification.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const CANDIDATE_DIRS = [
  join(here, 'prompts'), // src/prompts when running dev; dist/prompts when bundled
  join(here, '..', 'prompts'),
  join(here, '..', 'src', 'prompts'),
];

let cachedDir: string | null = null;
function resolvePromptsDir(): string {
  if (cachedDir) return cachedDir;
  for (const dir of CANDIDATE_DIRS) {
    if (existsSync(dir)) {
      cachedDir = dir;
      return dir;
    }
  }
  throw new Error(
    `Cannot locate prompts directory near ${here}. Tried: ${CANDIDATE_DIRS.join(', ')}`,
  );
}

export async function loadPrompt(filename: string): Promise<string> {
  return readFile(join(resolvePromptsDir(), filename), 'utf8');
}
