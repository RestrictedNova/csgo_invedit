import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('icons.json was generated from this catalog.json', async () => {
  const catalog = await readFile(new URL('catalog.json', root));
  const icons = JSON.parse(await readFile(new URL('icons.json', root), 'utf8'));
  // The editor hashes the exact bytes, so line ending changes break icons too.
  assert.equal(createHash('sha256').update(catalog).digest('hex'), icons.catalogSha256);
});
