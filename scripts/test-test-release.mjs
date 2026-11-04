import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { testVersion, testPackage, testReleaseFiles, TEST_FILES, runTestRelease } from './test-release.mjs';

test('test versions and installer identities cannot masquerade as stable releases', () => {
  const source = JSON.parse(readFileSync('package.json', 'utf8'));
  const prepared = testPackage(source, 'test-blue-beam-1');
  assert.equal(prepared.version, `${source.version}-blue-beam.1`);
  assert.notEqual(prepared.name, source.name);
  assert.notEqual(prepared.productName, source.productName);
  assert.notEqual(prepared.build.appId, source.build.appId);
  assert.notEqual(prepared.build.linux.executableName, source.build.linux.executableName);
  assert.notEqual(prepared.desktopName, source.desktopName);
  assert.equal(prepared.folioTestBuild, true);
  assert.deepEqual(prepared.build.publish, []);
  assert.deepEqual(prepared.build.fileAssociations, []);
  assert.deepEqual(prepared.build.mac.fileAssociations, []);
  assert.equal(prepared.build.nsis.include, 'build/test-installer.nsh');
  assert.equal(prepared.build.deb.afterInstall, undefined);
  assert.equal(prepared.build.deb.afterRemove, undefined);
  assert.equal(source.folioTestBuild, undefined, 'the stable package is not mutated');
  for (const tag of ['v1.2.3', 'main', 'test-blue-beam-0', 'test-blue-beam-1/../../x', 'test-blue-beam-1\n']) assert.throws(() => testVersion('1.2.3', tag));
  assert.throws(() => testVersion('1.2.3-beta.1', 'test-blue-beam-1'));
});

test('all three platform payloads must be complete before publication', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'folio-test-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [platform, names] of Object.entries(TEST_FILES)) {
    mkdirSync(path.join(dir, `folio-test-${platform}`));
    for (const name of names) writeFileSync(path.join(dir, `folio-test-${platform}`, name), 'installer fixture');
  }
  assert.equal(testReleaseFiles(dir).length, 6);
  const linux = path.join(dir, 'folio-test-linux', TEST_FILES.linux[0]);
  writeFileSync(linux, ''); assert.throws(() => testReleaseFiles(dir), /Empty/);
  rmSync(linux); assert.throws(() => testReleaseFiles(dir), /Unexpected linux/);
});

test('the test publisher refuses local or unrelated workflow contexts', async () => {
  const previous = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = 'unrelated/repository';
  try { await assert.rejects(runTestRelease(['--test-publish', 'missing']), /fork’s tag-push/); }
  finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});
