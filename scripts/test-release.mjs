import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_REPO = '0x3639/folio';
export const TEST_PRODUCT = 'Folio Drawing Review Test';
export const TEST_FILES = {
  windows: ['Folio-Test-Setup.exe', 'Folio-Test-Portable.exe'],
  macos: ['Folio-Test-mac.dmg', 'Folio-Test-mac.zip'],
  linux: ['Folio-Test-linux-x86_64.AppImage', 'Folio-Test-linux-amd64.deb'],
};

export function testVersion(version, tag) {
  const sequence = /^test-blue-beam-([1-9]\d*)$/.exec(tag)?.[1];
  if (!sequence || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a test-blue-beam-N tag and a stable source version.');
  return `${version}-blue-beam.${sequence}`;
}

export function testPackage(original, tag) {
  const pkg = structuredClone(original);
  pkg.version = testVersion(pkg.version, tag);
  pkg.name = 'folio-drawing-review-test';
  pkg.productName = TEST_PRODUCT;
  pkg.desktopName = 'folio-drawing-review-test.desktop';
  pkg.folioTestBuild = true;
  pkg.folioMacSigned = false;
  const b = pkg.build;
  b.appId = 'app.folio.drawingreview.test'; b.productName = TEST_PRODUCT;
  b.publish = []; b.fileAssociations = [];
  b.nsis.shortcutName = TEST_PRODUCT; b.nsis.include = 'build/test-installer.nsh';
  b.nsis.artifactName = 'Folio-Test-Setup.exe'; b.portable.artifactName = 'Folio-Test-Portable.exe';
  b.mac.fileAssociations = []; b.mac.identity = '-'; b.mac.hardenedRuntime = false; b.mac.notarize = false;
  b.mac.artifactName = 'Folio-Test-mac.${ext}'; b.dmg.artifactName = 'Folio-Test-mac.dmg';
  b.linux.executableName = 'folio-drawing-review-test'; b.linux.mimeTypes = []; b.linux.extraResources = [];
  b.appImage.artifactName = 'Folio-Test-linux-x86_64.AppImage'; b.deb.artifactName = 'Folio-Test-linux-amd64.deb';
  // The default hooks manage this package's own executable; the stable hooks also modify its apt source.
  delete b.deb.afterInstall; delete b.deb.afterRemove;
  return pkg;
}

export function testReleaseFiles(folder) {
  const directories = readdirSync(folder, { withFileTypes: true });
  if (directories.length !== 3 || directories.some(d => !d.isDirectory() || !Object.hasOwn(TEST_FILES, d.name.replace(/^folio-test-/, '')) || !d.name.startsWith('folio-test-'))) throw new Error('Expected exactly three platform artifact folders.');
  return Object.entries(TEST_FILES).flatMap(([platform, names]) => {
    const dir = path.join(folder, `folio-test-${platform}`), files = readdirSync(dir, { withFileTypes: true });
    if (files.length !== names.length || files.some(f => !f.isFile() || !names.includes(f.name))) throw new Error(`Unexpected ${platform} test artifacts.`);
    return names.map(name => { const file = path.join(dir, name); if (statSync(file).size === 0) throw new Error(`Empty artifact: ${name}`); return file; });
  });
}

export async function runTestRelease(args) {
  const env = process.env, tag = env.GITHUB_REF_NAME;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== TEST_REPO || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF_TYPE !== 'tag') throw new Error('Branch test releases must run in the fork’s tag-push workflow.');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const version = testVersion(pkg.version, tag);
  if (args.length === 1 && args[0] === '--test-prepare') {
    writeFileSync('package.json', JSON.stringify(testPackage(pkg, tag), null, 2) + '\n');
    console.log(`Preparing ${TEST_PRODUCT} ${version}; stable updates and shared install hooks are disabled.`);
    return;
  }
  if (args.length !== 2 || args[0] !== '--test-publish') throw new Error('Use --test-prepare or --test-publish ARTIFACT_FOLDER.');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', env: { ...env, GH_HOST: 'github.com' } });
  const api = endpoint => JSON.parse(gh('api', `repos/${TEST_REPO}/${endpoint}`));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== env.GITHUB_SHA || execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim() !== commit) throw new Error('The release checkout does not match its immutable tag.');
  const tagObject = execFileSync('git', ['rev-parse', `refs/tags/${tag}`], { encoding: 'utf8' }).trim();
  if (api(`git/ref/tags/${tag}`).object.sha !== tagObject) throw new Error('The remote test tag changed during this build.');
  const branch = api('git/ref/heads/blue-beam').object.sha;
  if (branch !== commit && api(`compare/${commit}...${branch}`).merge_base_commit?.sha !== commit) throw new Error('The test tag must belong to blue-beam.');
  const jobs = api(`actions/runs/${env.GITHUB_RUN_ID}/jobs?per_page=100`).jobs;
  for (const platform of Object.keys(TEST_FILES)) if (!jobs.some(j => j.name === `Build ${platform}` && j.conclusion === 'success')) throw new Error(`The ${platform} build has not succeeded in this run.`);
  const files = testReleaseFiles(args[1]);
  const digests = new Map();
  for (const file of files) {
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    digests.set(path.basename(file), hash.digest('hex'));
  }
  const sums = path.join(path.dirname(args[1]), 'SHA256SUMS.txt');
  writeFileSync(sums, [...digests].map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
  const notes = path.join(path.dirname(args[1]), 'test-release-notes.md');
  writeFileSync(notes, `Drawing review test build ${version}, from blue-beam at ${commit}.\n\n` +
    `Includes calibrated measurements, drawing markups, review layers, revision comparison, and carrying comments onto matched revised sheets.\n\n` +
    `This installs as **${TEST_PRODUCT}**, with separate app data. Automatic updates and the stable apt feed are disabled. This is a prerelease for manual testing.\n\n` +
    `## Downloads\n- Windows: Folio-Test-Setup.exe or Folio-Test-Portable.exe.\n- macOS (Apple Silicon and Intel): Folio-Test-mac.dmg.\n- Linux: Folio-Test-linux-x86_64.AppImage or Folio-Test-linux-amd64.deb.\n\n` +
    `These test builds are not Developer ID notarized or Windows publisher-signed. macOS may require System Settings → Privacy & Security → Open Anyway after the first launch attempt; Windows may show an unrecognized-app prompt.\n\n` +
    `All three platform builds and automated review checks must pass before publication. PDF rendering is checked with PDFium and, on macOS, PDFKit. Direct Acrobat/Bluebeam application testing remains pending. Test on copies of drawings.\n`);
  gh('release', 'create', tag, '--repo', TEST_REPO, '--verify-tag', '--prerelease', '--latest=false', '--title', `Folio drawing review test ${version}`, '--notes-file', notes, ...files, sums);
  const release = api(`releases/tags/${tag}`);
  if (!release.prerelease || release.draft || release.assets.length !== files.length + 1) throw new Error('Published release has unexpected status or assets.');
  for (const file of [...files, sums]) {
    const asset = release.assets.find(a => a.name === path.basename(file));
    if (!asset || asset.size !== statSync(file).size || asset.state !== 'uploaded') throw new Error(`Published asset is incomplete: ${file}`);
    if (digests.has(asset.name) && asset.digest && asset.digest !== `sha256:${digests.get(asset.name)}`) throw new Error(`Published checksum differs: ${asset.name}`);
  }
  console.log(`Verified test release for all three platforms: ${release.html_url}`);
}
