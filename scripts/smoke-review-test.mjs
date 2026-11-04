import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readerPage } from './reader-page.mjs';
import { checkDrawingReview } from './smoke-drawing-review.mjs';
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'release', 'smoke');
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, FOLIO_TEST_HIDDEN: '1', FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), 'folio-review-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: require('electron'), args: [root, '--mute-audio', ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [])], env, timeout: 60000 });
const window = await app.firstWindow(); window.setDefaultTimeout(15000);
const page = readerPage(window), errors = [];
page.on('pageerror', e => errors.push(String(e)));
try {
  await page.getByRole('button', { name: /Try a sample/ }).click();
  await page.locator('.textLayer span:not(.markedContent)').first().waitFor();
  await checkDrawingReview(app, page, output);
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'review-failure.png') }).catch(() => {});
  console.error('Page errors:', errors);
  throw error;
} finally {
  // Test-only shutdown: the hidden window cannot answer an unsaved-changes prompt.
  await app.evaluate(({ app }) => app.exit(0));
}
