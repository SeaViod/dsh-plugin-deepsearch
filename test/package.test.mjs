/**
 * dsh-plugin-deepsearch — packaging checks (CONTRACT §5.3).
 *
 * Pure Node ESM: no third-party test framework, no YAML library, no network.
 * Run from the package root:  node test/package.test.mjs
 *
 * This suite guards the marketplace-facing surface: the package manifest, the
 * bundle patch, shipped files, docs, and the "no local paths / one version source"
 * rules. It intentionally does not exercise plugin behaviour (see host/client tests).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    const suffix = detail === undefined || detail === '' ? '' : ` — ${detail}`;
    console.log(`FAIL ${name}${suffix}`);
  }
}

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function bytes(rel) {
  try {
    return statSync(join(ROOT, rel)).size;
  } catch {
    return -1;
  }
}

// Local machine paths and usernames must never be committed. Assembled at runtime so this
// test file does not itself embed the literal strings it is guarding against.
const BACKSLASH = String.fromCharCode(92);
const LOCAL_PATH_MARKERS = [
  'C:' + BACKSLASH + 'Users',
  '235' + '64',
  'E:' + BACKSLASH + 'Openhanao',
  'dsh-' + 'runtimes',
];

function findLocalPath(text) {
  for (const marker of LOCAL_PATH_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

// --- Tiny semver-ish range check -------------------------------------------------------
// Only what this manifest needs: `>=x <y` comparator sets joined by `||`, with the
// node-semver rule that a prerelease version only satisfies a range when some comparator
// shares its exact major.minor.patch tuple and itself carries a prerelease tag.

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const cmp = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function comparatorHolds(version, comparator) {
  const match = /^(>=|<)(.+)$/.exec(comparator.trim());
  const target = match ? parseVersion(match[2]) : null;
  if (!match || !target) return false;
  const cmp = compareVersions(version, target);
  return match[1] === '>=' ? cmp >= 0 : cmp < 0;
}

function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText);
  if (!version || typeof rangeText !== 'string') return false;
  return rangeText.split('||').some((branch) => {
    const comparators = branch
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (comparators.length === 0) return false;
    if (!comparators.every((comparator) => comparatorHolds(version, comparator))) return false;
    if (version.prerelease.length === 0) return true;
    return comparators.some((comparator) => {
      const match = /^(?:>=|<)(.+)$/.exec(comparator);
      const target = match ? parseVersion(match[1]) : null;
      return (
        target !== null &&
        target.prerelease.length > 0 &&
        target.major === version.major &&
        target.minor === version.minor &&
        target.patch === version.patch
      );
    });
  });
}

// --- Expected values from CONTRACT §2 --------------------------------------------------

const PACKAGE_DESCRIPTION =
  "Switch DSH's built-in web_search between the DeepSeek Search API (/v1/tools/search) " +
  'and the default account search, with live fallback, a settings page and a sidebar switch.';
const EXPECTED_KEYWORDS = [
  'dsh',
  'deepseek-harness',
  'dsh-plugin',
  'deepseek',
  'web-search',
  'search-api',
  'tools',
];
const EXPECTED_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
  'icon.svg',
];
const EXPECTED_DSH_ENGINE = '>=0.1.7-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0-0';
const CONFIG_KEYS = [
  'apiKey',
  'apiKeyEnv',
  'baseURL',
  'searchPath',
  'fetchPath',
  'keyFile',
  'count',
  'needContent',
  'timeoutMs',
  'retryCount',
  'retryDelayMs',
  'maxFetchChars',
  'providerId',
  'fallbackProvider',
  'fallbackOnError',
  'language',
  'checkQuery',
];
const SUBMISSION_DESCRIPTION_EN =
  "Switch DSH's built-in web_search between the DeepSeek Search API (/v1/tools/search) " +
  'and the default account search, with automatic fallback, a settings page and a sidebar switch.';
const SUBMISSION_DESCRIPTION_ZH =
  '给 DSH 内置 web_search 加一个开关：在 DeepSeek Search API（/v1/tools/search）与默认账号搜索之间切换，失败自动回退，并带设置页与侧栏开关。';

// --- 1. package.json -------------------------------------------------------------------

let pkg = {};
let pkgError = '';
try {
  pkg = JSON.parse(read('package.json'));
} catch (error) {
  pkgError = error.message;
}
check('package.json parses as JSON', pkgError === '' && pkg !== null && typeof pkg === 'object', pkgError);
const manifest = pkg && typeof pkg === 'object' ? pkg : {};

check('package.json has no "private" field (blocks publishing)', !Object.prototype.hasOwnProperty.call(manifest, 'private'));
check('package name is dsh-plugin-deepsearch', manifest.name === 'dsh-plugin-deepsearch', manifest.name);
check('package version is 0.2.0', manifest.version === '0.2.0', manifest.version);
check('package description matches the contract', manifest.description === PACKAGE_DESCRIPTION, manifest.description);
check('package is ESM with main index.js', manifest.type === 'module' && manifest.main === 'index.js');
check(
  'exports map exposes index.js, client.js and package.json',
  manifest.exports && manifest.exports['.'] === './index.js' &&
    manifest.exports['./client'] === './client.js' &&
    manifest.exports['./package.json'] === './package.json',
  JSON.stringify(manifest.exports)
);
check(
  'dsh.bundle.patch declares ./cordis.patch.yml (required for installability)',
  Boolean(manifest.dsh) && Boolean(manifest.dsh.bundle) && manifest.dsh.bundle.patch === './cordis.patch.yml',
  JSON.stringify(manifest.dsh && manifest.dsh.bundle)
);
check(
  'dsh.client.platform is web',
  Boolean(manifest.dsh) && Boolean(manifest.dsh.client) && manifest.dsh.client.platform === 'web',
  JSON.stringify(manifest.dsh && manifest.dsh.client)
);
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  .filter((field) => manifest[field] !== undefined && manifest[field] !== null);
check('no dependency fields (zero-dependency plugin)', dependencyFields.length === 0, dependencyFields.join(', '));
check('engines.node is >=20', manifest.engines && manifest.engines.node === '>=20', manifest.engines && manifest.engines.node);
check(
  'engines.dsh uses explicit prerelease branches',
  manifest.engines && manifest.engines.dsh === EXPECTED_DSH_ENGINE,
  manifest.engines && manifest.engines.dsh
);
const dshEngine = manifest.engines && typeof manifest.engines.dsh === 'string' ? manifest.engines.dsh : '';
check(
  'engines.dsh matches the prerelease host 0.2.0-rc.2',
  satisfies('0.2.0-rc.2', dshEngine),
  dshEngine
);
check(
  'engines.dsh matches stable hosts inside the range (0.1.7, 0.2.0, 0.2.5)',
  satisfies('0.1.7', dshEngine) && satisfies('0.2.0', dshEngine) && satisfies('0.2.5', dshEngine),
  dshEngine
);
check(
  'engines.dsh rejects hosts outside the range (0.1.6, 0.3.0-0, 0.3.0-rc.1)',
  !satisfies('0.1.6', dshEngine) && !satisfies('0.3.0-0', dshEngine) && !satisfies('0.3.0-rc.1', dshEngine),
  dshEngine
);
check(
  'a broad range without the || break would silently exclude prereleases (regression guard)',
  !satisfies('0.2.0-rc.2', '>=0.1.7-rc.1 <0.3.0-0')
);
check('license is MIT', manifest.license === 'MIT', manifest.license);
check(
  'keywords match the contract discovery set',
  Array.isArray(manifest.keywords) && manifest.keywords.join('|') === EXPECTED_KEYWORDS.join('|'),
  JSON.stringify(manifest.keywords)
);
check('icon points at ./icon.svg', manifest.icon === './icon.svg', manifest.icon);

const repositoryUrl = manifest.repository && typeof manifest.repository.url === 'string' ? manifest.repository.url : '';
const repositoryMatch =
  /^git\+https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/dsh-plugin-deepsearch\.git$/.exec(repositoryUrl);
check(
  'repository.url points at the GitHub repo (owner placeholder may be present)',
  repositoryMatch !== null && manifest.repository.type === 'git',
  repositoryUrl
);
const owner = repositoryMatch ? repositoryMatch[1] : '<owner>';
const homepage = typeof manifest.homepage === 'string' ? manifest.homepage : '';
const bugsUrl = manifest.bugs && typeof manifest.bugs.url === 'string' ? manifest.bugs.url : '';
check(
  'homepage and bugs point at the same GitHub repo as repository.url',
  homepage === `https://github.com/${owner}/dsh-plugin-deepsearch#readme` &&
    bugsUrl === `https://github.com/${owner}/dsh-plugin-deepsearch/issues`,
  `${homepage} / ${bugsUrl}`
);
check(
  'publishConfig publishes publicly to the npmjs registry',
  Boolean(manifest.publishConfig) &&
    manifest.publishConfig.access === 'public' &&
    manifest.publishConfig.registry === 'https://registry.npmjs.org/',
  JSON.stringify(manifest.publishConfig)
);

const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
const testScript = typeof scripts.test === 'string' ? scripts.test : '';
const packageIndex = testScript.indexOf('test/package.test.mjs');
const hostIndex = testScript.indexOf('test/host.test.mjs');
const clientIndex = testScript.indexOf('test/client.test.mjs');
check(
  'npm test runs the packaging, host and client suites in order',
  packageIndex !== -1 && hostIndex !== -1 && clientIndex !== -1 &&
    packageIndex < hostIndex && hostIndex < clientIndex,
  testScript
);
check('prepublishOnly runs npm test', scripts.prepublishOnly === 'npm test', scripts.prepublishOnly);

// --- 2. cordis.patch.yml ---------------------------------------------------------------

const patchRaw = read('cordis.patch.yml');
check('cordis.patch.yml exists and is non-empty', bytes('cordis.patch.yml') > 0, String(bytes('cordis.patch.yml')));
const patchContentLines = patchRaw
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
const patchTopLevelLines = patchContentLines.filter((line) => /^\S/.test(line));
check(
  'bundle patch starts with the top-level "- insert:" list item',
  patchContentLines.length > 0 && patchContentLines[0] === '- insert:',
  patchContentLines[0]
);
check(
  'bundle patch has no other top-level keys',
  patchTopLevelLines.length === 1 && patchTopLevelLines[0] === '- insert:',
  JSON.stringify(patchTopLevelLines)
);
check(
  'bundle patch content is exactly the contract insert (id + package name)',
  JSON.stringify(patchContentLines.map((line) => line.trim())) ===
    JSON.stringify(['- insert:', '- id: deepsearch', 'name: dsh-plugin-deepsearch']),
  JSON.stringify(patchContentLines)
);
check(
  'bundle patch inserts "id: deepsearch" exactly once',
  (patchRaw.match(/\bid:\s*deepsearch\b/g) || []).length === 1
);
check(
  'bundle patch inserts "name: dsh-plugin-deepsearch" exactly once',
  (patchRaw.match(/\bname:\s*dsh-plugin-deepsearch\b/g) || []).length === 1
);
check('bundle patch contains exactly one insert', (patchRaw.match(/\binsert:/g) || []).length === 1);

// --- 3. shipped files ------------------------------------------------------------------

const requiredRepoFiles = [
  'index.js',
  'client.js',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'PUBLISHING.md',
  'LICENSE',
  'icon.svg',
  '.gitignore',
];
for (const file of requiredRepoFiles) {
  check(`required file ${file} exists and is non-empty`, bytes(file) > 0, String(bytes(file)));
}
check('index.js is a substantial host implementation', bytes('index.js') > 1000, String(bytes('index.js')));
check('client.js is a substantial browser bundle', bytes('client.js') > 1000, String(bytes('client.js')));

const shippedFiles = Array.isArray(manifest.files) ? manifest.files : [];
check(
  'files allowlist matches the contract exactly',
  JSON.stringify(shippedFiles) === JSON.stringify(EXPECTED_FILES),
  JSON.stringify(shippedFiles)
);
check(
  'files allowlist does not ship tests or repo-only files',
  shippedFiles.every((file) => !/^test\//.test(file) && file !== '.gitignore' && file !== 'PUBLISHING.md')
);
check(
  'every file in the allowlist exists in the package root',
  EXPECTED_FILES.every((file) => existsSync(join(ROOT, file)) && bytes(file) > 0)
);
check(
  'screenshots.json is not added in 0.2.0',
  !existsSync(join(ROOT, 'screenshots.json')),
  'screenshots.json must not ship in 0.2.0'
);

const gitignore = read('.gitignore');
check(
  '.gitignore ignores dependencies, scratch homes, tarballs and logs',
  ['node_modules', '.test-home', '*.tgz', 'log'].every((entry) => gitignore.includes(entry)),
  gitignore.replace(/\r?\n/g, ' | ')
);

// --- 4. no local machine paths / no stale version literals -----------------------------

const hygieneFiles = ['index.js', 'client.js', 'README.md', 'README.zh.md', 'PUBLISHING.md', 'package.json'];
for (const file of hygieneFiles) {
  const hit = findLocalPath(read(file));
  check(`${file} contains no local machine paths`, hit === null, hit === null ? '' : hit);
}
for (const file of ['index.js', 'client.js', 'README.md', 'README.zh.md', 'PUBLISHING.md', 'package.json']) {
  check(`${file} contains no 0.1.1 version literal`, !read(file).includes('0.1.1'));
}

// --- 5. version consistency ------------------------------------------------------------

const changelog = read('CHANGELOG.md');
const changelogHeadings = changelog.split(/\r?\n/).filter((line) => /^##\s/.test(line));
const topChangelogHeading = changelogHeadings.length > 0 ? changelogHeadings[0] : '';
check(
  'CHANGELOG top heading matches the package version',
  /^##\s+\[?0\.2\.0\]?/.test(topChangelogHeading),
  topChangelogHeading
);
check(
  'CHANGELOG keeps the 0.1.1 history section',
  changelog.split(/\r?\n/).some((line) => /^##\s+\[?0\.1\.1\]?/.test(line))
);
const hostSource = read('index.js');
check(
  'index.js reads its version from package.json (single source of truth)',
  hostSource.includes('package.json') && hostSource.includes('readFileSync')
);
check('index.js contains no hardcoded 0.1.1 version literal', !hostSource.includes('0.1.1'));
check('client.js contains no hardcoded 0.1.1 version literal', !read('client.js').includes('0.1.1'));

// --- 6. README / docs ------------------------------------------------------------------

const readme = read('README.md');
const readmeZh = read('README.zh.md');
const publishing = read('PUBLISHING.md');
const license = read('LICENSE');
const icon = read('icon.svg');

check('README.md links to README.zh.md', readme.includes('README.zh.md'));
check('README.zh.md links to README.md', readmeZh.includes('README.md'));
check(
  'README.md documents the CLI install command and the plugin market',
  readme.includes('dsh plugin add dsh-plugin-deepsearch') && /market/i.test(readme)
);
check(
  'both READMEs document the web-profile install command',
  readme.includes('dsh plugin --profile web add dsh-plugin-deepsearch') &&
    readmeZh.includes('dsh plugin --profile web add dsh-plugin-deepsearch')
);
check(
  'both READMEs document the 0.1.x bundle migration (no double load)',
  readme.includes('0.1.x') && readme.includes('load the plugin twice') &&
    readme.includes('dsh.profile.bundles') && readme.includes('cordis.patch.yml') &&
    readmeZh.includes('0.1.x') && readmeZh.includes('加载两次') &&
    readmeZh.includes('dsh.profile.bundles') && readmeZh.includes('cordis.patch.yml'),
  'missing migration note'
);
check(
  'README.md config table documents every host config key',
  CONFIG_KEYS.filter((key) => !readme.includes('`' + key + '`')).length === 0,
  CONFIG_KEYS.filter((key) => !readme.includes('`' + key + '`')).join(', ')
);
check(
  'README.zh.md config table documents every host config key',
  CONFIG_KEYS.filter((key) => !readmeZh.includes('`' + key + '`')).length === 0,
  CONFIG_KEYS.filter((key) => !readmeZh.includes('`' + key + '`')).join(', ')
);
check(
  'README documents the API key resolution sources',
  readme.includes('credentials') && readme.includes('env-file') &&
    readme.includes('deepsearch-key.txt') && readme.includes('$DSH_HOME/.env'),
  'missing key-source documentation'
);

check(
  'PUBLISHING.md contains the exact awesome-dsh-plugin en/zh descriptions',
  publishing.includes(SUBMISSION_DESCRIPTION_EN) && publishing.includes(SUBMISSION_DESCRIPTION_ZH),
  'submission description mismatch'
);
check(
  'PUBLISHING.md contains the awesome-dsh-plugin entry fields (url, name, category tools)',
  /^url: https:\/\/github\.com\/\S+$/m.test(publishing) &&
    /^name: \S+\/dsh-plugin-deepsearch$/m.test(publishing) &&
    /^category: tools$/m.test(publishing),
  'missing submission fields'
);
check(
  'PUBLISHING.md names the data/plugins entry file',
  publishing.includes('data/plugins/') && publishing.includes('__dsh-plugin-deepsearch.yml')
);
check(
  'PUBLISHING.md covers identity replacement targets',
  ['package.json', 'repository.url', 'homepage', 'bugs.url', 'README.md', 'README.zh.md', 'LICENSE']
    .every((target) => publishing.includes(target))
);
check(
  'PUBLISHING.md covers repo age/topic, npm publish, screenshots, bundle patch and CI',
  ['dsh-plugin', '1 day', 'npm publish', 'screenshots.json', 'cordis.patch.yml', 'dsh.bundle.patch']
    .every((target) => publishing.includes(target)),
  'missing publishing checklist item'
);
check(
  'PUBLISHING.md explains the real bundle-install mechanism (profile package.json record)',
  publishing.includes('dsh.profile.bundles') && publishing.includes('node_modules') &&
    publishing.includes('cordis.patch.yml'),
  'missing bundle-install mechanism description'
);
check(
  'PUBLISHING.md repeats the 0.1.x migration note (no double load)',
  publishing.includes('0.1.x') && publishing.includes('load the plugin twice')
);

// --- 7. icon.svg / LICENSE -------------------------------------------------------------

check(
  'icon.svg is a valid square SVG',
  /^<svg[\s>]/.test(icon.trim()) && icon.includes('</svg>') &&
    /viewBox="0 0 64 64"/.test(icon) && /width="64"/.test(icon) && /height="64"/.test(icon),
  'expected a 64x64 SVG'
);
check(
  'icon.svg references no external assets',
  !/<image\b/i.test(icon) && !/xlink:href|href=/i.test(icon) && !/url\(\s*['"]?https?:/i.test(icon)
);
check(
  'LICENSE contains the MIT permission text',
  license.includes('MIT License') &&
    license.includes('Permission is hereby granted') &&
    license.includes('THE SOFTWARE IS PROVIDED')
);
check(
  'LICENSE has a copyright line (placeholder holder is replaced before publishing)',
  /Copyright \(c\) \d{4}(?:-\d{4})? \S+/.test(license),
  'missing copyright line'
);

// --- summary ---------------------------------------------------------------------------

console.log('');
console.log(`package: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL packaging checks failed');
  process.exitCode = 1;
} else {
  console.log('ok packaging checks passed');
}
