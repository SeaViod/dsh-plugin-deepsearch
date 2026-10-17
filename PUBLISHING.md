# Publishing `dsh-plugin-deepsearch`

Maintainer checklist for releasing this plugin: GitHub repo, optional npm publish, clean-profile
verification and the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry submission.

**Current status:** `0.2.0` is **published**.

- GitHub: <https://github.com/SeaViod/dsh-plugin-deepsearch> (public, `dsh-plugin` topic, release `v0.2.0`)
- npm: <https://www.npmjs.com/package/dsh-plugin-deepsearch> (`latest = 0.2.0`; published 2026-10-17)
- Marketplace submission is the only step left. awesome-dsh-plugin CI requires the repo to be at
  least **1 day old** (the repo was created 2026-10-17), so open the PR after that.

- [x] Step 1 — Verify the package identity (`SeaViod`)
- [x] Step 2 — Create and push the GitHub repository
- [ ] Step 3 — Verify installability from a clean profile
- [x] Step 4 — Publish to npm
- [ ] Step 5 — Submit to awesome-dsh-plugin
- [ ] Step 6 — Optional: screenshots
- [ ] Sign-off checklist

## What ships in 0.2.0

`npm pack --dry-run` must list exactly the package files (the `files` allowlist):

```
index.js  client.js  cordis.patch.yml  README.md  README.zh.md  CHANGELOG.md  LICENSE  icon.svg
```

plus `package.json` itself. `test/`, `.gitignore` and this file are **not** published. The
package intentionally has **no** `dependencies`, `devDependencies` or `peerDependencies`, no
build step and no post-install scripts (zero runtime dependencies is a feature, keep it).

## Step 1 — Verify the package identity (already set to `SeaViod`)

The package already points at `https://github.com/SeaViod/dsh-plugin-deepsearch`; no
placeholder remains, so there is nothing to replace. The repository name should stay
`dsh-plugin-deepsearch` unless you have a strong reason to rename it (if you rename, update
every URL below, the npm `repository` field, and the registry entry `name`). The commands
below are kept as a verification step for the next time identity changes.

Exact replacement list — search for `SeaViod` and replace it with your GitHub owner:

| File | Location | Current value |
|---|---|---|
| `package.json` | `repository.url` | `git+https://github.com/SeaViod/dsh-plugin-deepsearch.git` |
| `package.json` | `homepage` | `https://github.com/SeaViod/dsh-plugin-deepsearch#readme` |
| `package.json` | `bugs.url` | `https://github.com/SeaViod/dsh-plugin-deepsearch/issues` |
| `README.md` | "Questions or bug reports" link near the end | `https://github.com/SeaViod/dsh-plugin-deepsearch/issues` |
| `README.zh.md` | "问题或 bug 反馈" link near the end | `https://github.com/SeaViod/dsh-plugin-deepsearch/issues` |
| `LICENSE` | copyright line | `Copyright (c) 2026 SeaViod` |
| `PUBLISHING.md` | Step 5 YAML (`url`, `name`) and the entry filename | `SeaViod` |
| `PUBLISHING.md` | this replacement table | keep until the replacement is done, then the table can be dropped |

Commands (run from the repo root; both do the same thing):

```pwsh
# PowerShell
Get-ChildItem -Recurse -File -Exclude *.tgz,node_modules | Select-String -Pattern 'your-github-name'
# git-bash / CI
git grep -n 'your-github-name'
```

Rules:

- The npm package name stays `dsh-plugin-deepsearch` — do **not** put a GitHub owner in the
  package name.
- The npm `repository` field must point at the exact repo listed in the marketplace entry; the
  registry picks the npm↔repo link up from the registry automatically (it rejects a manual
  `npm:` key in the entry file).
- After replacing, re-run `npm test` (the packaging test accepts any valid GitHub owner; it only
  checks the repo URL shape and coverage).
- When the replacement is complete, the search above should return no matches in shipped/runtime
  files; the only permitted remaining occurrence is inside this checklist's own instructions if
  you keep them.

## Step 2 — Create and push the GitHub repository

- [ ] Create a **public** GitHub repo named `dsh-plugin-deepsearch` under your account/org.
- [ ] Push this directory as the repo root. `package.json` and `cordis.patch.yml` must be at the
  **repo root** (the registry fetches the root `package.json`; a subpackage layout is only for
  monorepos).
- [ ] Repo settings: default branch `main`; add the **`dsh-plugin`** topic
  ([github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)) under *About*; set the
  About description to the package description
  ("Switch DSH's built-in web_search between the DeepSeek Search API ... and the default account
  search, with live fallback, a settings page and a sidebar switch.").
- [ ] Wait at least **24 hours** after the repo is created before submitting to the registry —
  the 1-day repo age is checked automatically by CI and a fresh repo is the most common
  rejection reason.
- [ ] Verify the root manifest is installable: `package.json` declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }` and
  `cordis.patch.yml` exists next to it. Declaring only `dsh.client` is **not installable** and
  will be rejected.
- [ ] No `private: true` in `package.json`.

## Step 3 — Verify installability from a clean profile

A bundle install (`dsh plugin add` or the plugin market) does **not** copy an `- insert:` row into
the profile's `cordis.patch.yml`. It installs the package into the profile's `node_modules` and
records it in the profile's `package.json` under `dsh.profile.bundles` (next to the other installed
bundles); the bundle layer then applies the package's own `cordis.patch.yml` at boot. Verify that
record — not a hand-edited patch row.

**Offline pre-check (before the repo / npm artifact exists).** The three test suites already run
without DSH, so they are the pre-publish gate; nothing has to be installed:

```pwsh
npm test                 # packaging + host + client suites, offline
npm pack --dry-run       # confirm the eight shipped files
```

The full clean-profile check needs the repo (or the published package), so run it after Step 2 and
Step 4. Use a throwaway `DSH_HOME` so the real profile is untouched, and install the way a user
would: the plugin-market UI, or the CLI by package name once the package is resolvable (npm
published, or a GitHub URL your market/CLI supports). Do **not** hardcode profile paths — let the
CLI/market resolve them.

```pwsh
# 1. Isolated DSH home for the check
$env:DSH_HOME = Join-Path $env:TEMP 'dsh-deepsearch-clean'

# 2. Install through the real distribution path (market UI, or by package name)
dsh plugin --profile web add dsh-plugin-deepsearch

# 3. Verify the bundle layer's record, not a copied patch row
Get-Content (Join-Path $env:DSH_HOME 'profiles/web/package.json')
#    dsh.profile.bundles must contain "dsh-plugin-deepsearch"
Test-Path (Join-Path $env:DSH_HOME 'profiles/web/node_modules/dsh-plugin-deepsearch/cordis.patch.yml')
#    True — the package's own patch is applied by the bundle layer at boot

# 4. Start DSH with that home and check end-to-end
dsh web
```

- [ ] `profiles/<profile>/package.json` lists `dsh-plugin-deepsearch` under `dsh.profile.bundles`,
  **and** `profiles/<profile>/node_modules/dsh-plugin-deepsearch/cordis.patch.yml` exists.
- [ ] Exactly one loading path: a leftover `0.1.x` hand-written `- insert:` row in the profile patch
  plus a bundle install would load the plugin twice; when migrating an old profile, delete the
  hand-written row. The state/key files under `$DSH_HOME` are preserved across that migration.
- [ ] Settings → Built-in plugins shows the **DeepSeek Search** tab; the sidebar footer switch appears.
- [ ] `deepsearch status` (model tool) returns `ok: true`, the current mode and endpoint, and
  `key.configured` / `key.source` without any key material.
- [ ] Toggle ON/OFF from the sidebar and from the settings page; mode persists after restart.
- [ ] Save a key in the settings page, restart, confirm `key.source` is `file`; clear it and
  confirm it disappears from `$DSH_HOME` and from the page. The key value must never be echoed.
- [ ] Uninstall: remove the package from the scratch profile and confirm it is gone from
  `dsh.profile.bundles` and the plugin no longer loads. Delete the scratch `$env:DSH_HOME` afterwards.

Profile naming: a `dsh web` server uses `dsh plugin --profile web ...`; the Desktop app uses the
`desktop` profile and its in-app plugin-market UI. Do not type a full user-home/profile path.

## Step 4 — Publish to npm (optional, recommended)

The registry does not require npm — plugins install from GitHub. Publishing is recommended
because storefronts can show and sort by download count and prebuilt installs skip the
`allowBuilds` build-approval step. This package has no build step, so the tarball is the repo
content itself.

Preconditions already in the package: `private` removed, `publishConfig.access: "public"` and
registry `https://registry.npmjs.org/`, `repository`/`homepage`/`bugs` pointing at the repo,
`prepublishOnly: npm test`.

```pwsh
# Name availability was verified on 2026-10-17; re-check right before the first publish
npm view dsh-plugin-deepsearch

npm login
npm test                 # runs the three suites; prepublishOnly repeats this on publish
npm publish --access public
npm view dsh-plugin-deepsearch version dist-tags repository
```

- [ ] `npm view dsh-plugin-deepsearch version` prints `0.2.0` after publishing.
- [ ] `npm view dsh-plugin-deepsearch repository.url` points at the GitHub repo from Step 2.
- [ ] `npm pack --dry-run` lists only the eight shipped files above; no `test/`, no `.gitignore`.
- [ ] Version is bumped in exactly one place (`package.json`); `CHANGELOG.md` gets the matching
  top heading. Do not add version literals to code or docs.
- [ ] If you choose **not** to publish to npm, optionally attach a prebuilt tarball to a GitHub
  release and point the registry entry at it with the optional `tarball:` field (must be an
  `https` `.tgz` on GitHub release hosting; prefer a version-free asset name with
  `releases/latest/download/...`, or pin the release tag). Converting the repo to npm later needs
  no registry change.

## Step 5 — Submit to awesome-dsh-plugin

Submission is **one new YAML file** in the registry repo; do not edit the generated READMEs or
any other plugin's entry in the same PR.

- [ ] Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
- [ ] Add `data/plugins/SeaViod__dsh-plugin-deepsearch.yml`
  (after Step 1: `<owner>__dsh-plugin-deepsearch.yml`; for a monorepo subpackage the pattern is
  `<owner>__<repo>--<subpath>.yml`).
- [ ] Use exactly this content (it must match this repo's real URLs, category and description):

```yaml
url: https://github.com/SeaViod/dsh-plugin-deepsearch
name: SeaViod/dsh-plugin-deepsearch
category: tools
description:
  en: Switch DSH's built-in web_search between the DeepSeek Search API (/v1/tools/search) and the default account search, with automatic fallback, a settings page and a sidebar switch.
  zh: 给 DSH 内置 web_search 加一个开关：在 DeepSeek Search API（/v1/tools/search）与默认账号搜索之间切换，失败自动回退，并带设置页与侧栏开关。
```

- [ ] Do **not** add an `npm:` key (rejected) — the npm mapping is picked up automatically.
  Do not add `tarball:` unless you rely on a GitHub-release tarball instead of npm.
- [ ] `category: tools` — the plugin adds a tool/provider surface, so this is the closest
  category; a maintainer may re-file it if a better one fits.
- [ ] Descriptions must be accurate; they are checked against the code. Keep the wording above
  unless the plugin's behaviour changes. If you edit a description to contain `: ` (colon +
  space), quote the value (`en: '...'`), otherwise YAML parses it as a nested key. The strings
  above do not need quoting.
- [ ] Open one PR titled e.g. `Add dsh-plugin-deepsearch`; a PR may add at most 3 entries, and
  the usual case is exactly one. Push follow-up fixes to the same branch.
- [ ] Wait for CI (see below) and for the maintainer review; feedback arrives as PR comments
  naming the exact file/field to fix.

Registry requirements recap (all checked by their CI or a maintainer):

- [ ] The repo declares `dsh.bundle` and ships a root `cordis.patch.yml` (a repo declaring only
  `dsh.client` is rejected as not installable).
- [ ] The repo contains real, working code (not a placeholder, name-squat or README-only repo).
- [ ] The repo is at least **1 day old**.
- [ ] The repo has the **`dsh-plugin`** topic.
- [ ] The project is actively maintained; the description states what the plugin does (no
  marketing superlatives) and is accurate.
- [ ] The PR only adds/updates your own entry file.

## Step 6 — Optional: screenshots

`screenshots.json` is **not** part of `0.2.0` and must not be added by this checklist. Storefronts
fall back to extracting images from the README, which is enough to ship now. If you add curated
screenshots later, for a follow-up release:

- Declare them in **your own repo**: a `screenshots.json` next to `package.json` (inside the
  subdirectory for a monorepo entry) with 1–8 entries, for example
  `["assets/settings-tab.png", "assets/sidebar-switch.png"]`; the `{"screenshots": [...]}` form
  is also accepted.
- Paths are relative to that file, must stay inside the plugin directory (no leading `/`, no
  `..`), and point at images already committed to the repo. Absolute URLs are accepted only on
  GitHub hosting (`raw.githubusercontent.com`, `github.com` attachments/camo/user-images);
  third-party image hosts are rejected.
- No screenshots are required; if you do add them, do not edit the generated READMEs and do not
  add keys to the registry's own `data/screenshots.json` (legacy only).
- Keep the repo-level file out of the npm tarball unless the storefront needs it: the `files`
  allowlist in `package.json` is intentionally fixed. Re-run `npm test` and
  `npm pack --dry-run` after any change.

## Upgrading from 0.1.x (migration note, repeated for release notes)

- `0.1.x` was installed **by hand**: one `- insert:` row in the profile's `cordis.patch.yml` with
  `id: deepsearch`, `name: dsh-plugin-deepsearch`.
- `0.2.0` ships `dsh.bundle.patch` (`cordis.patch.yml` in the package): a marketplace /
  `dsh plugin add` install puts the package into the profile's `node_modules`, records it in the
  profile's `package.json` under `dsh.profile.bundles`, and the bundle layer applies the package's
  own patch at boot. **Remove the old hand-written insert row before installing 0.2.0 as a
  bundle** — a leftover hand-written row plus a bundle install would load the plugin twice. State
  (`deepsearch-mode.json`), diagnostics (`deepsearch-diag.json`) and the key file inside
  `$DSH_HOME` are preserved.
- The profile name differs by client: `dsh plugin --profile web add dsh-plugin-deepsearch` for a
  `dsh web` server; the Desktop app uses the `desktop` profile / in-app plugin-market UI. Never
  hardcode a user profile path.

## CI expectations

**awesome-dsh-plugin CI** (on your submission PR) runs, in order:

1. **Entry count** — at most 3 entries per PR; a single-entry PR is the normal case.
2. **`dsh.bundle`** — fetched from the repo's root `package.json` (or a
   `packages/` · `plugins/` · `apps/` subpackage). Declaring only `dsh.client` fails here.
3. **Repo age** — the 1-day bar.
4. **`awesome-lint` + site build** — locale parity, separators, dates, screenshots.

A green run is the precondition, not the approval: a maintainer reads the repo and checks the
entry's claims against the code. Fix CI by pushing to the same branch; no new PR is needed.

**This repo's own CI** should run the offline, zero-dependency suite on every push and PR.
Because there are no third-party dependencies, no `npm install` step is needed. Suggested
GitHub Actions workflow (add it when you create the repo; it is intentionally not part of the
0.2.0 layout):

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: node test/package.test.mjs
      - run: node test/host.test.mjs
      - run: node test/client.test.mjs
      - run: npm pack --dry-run
```

Keep `npm test` as the single entry point locally — it runs the packaging, host and client
suites in order (and `prepublishOnly` runs it again before any npm publish).

## Sign-off checklist

- [ ] Identity is `SeaViod`; `git grep -n 'your-github-name'` returns nothing outside these
  instructions.
- [ ] `package.json` version is `0.2.0`, `private` absent, `dsh.bundle.patch`,
  `dsh.client.platform`, explicit prerelease `engines.dsh`; no dependency fields.
- [ ] `cordis.patch.yml` at the repo root with exactly one `- insert:` row
  (`id: deepsearch`, `name: dsh-plugin-deepsearch`).
- [ ] `npm test` green (packaging + host + client).
- [ ] `npm pack --dry-run` shows only the eight shipped files.
- [ ] Repo public, ≥1 day old, `dsh-plugin` topic added, About description set.
- [ ] Clean-profile install verified: package present under `dsh.profile.bundles`, its own
  `cordis.patch.yml` shipped in `node_modules`, no duplicate hand-written insert row; settings tab
  and sidebar switch work; key save/clear works; uninstall leaves nothing behind.
- [ ] npm publish done (or explicitly skipped; optional), `repository` points at the repo.
- [ ] `CHANGELOG.md` `0.2.0` section dated; git tag `v0.2.0` and GitHub release created.
- [ ] awesome-dsh-plugin PR opened with exactly the YAML in Step 5
  (`data/plugins/<owner>__dsh-plugin-deepsearch.yml`), CI green, no unrelated changes.
- [ ] After merge: confirm the entry appears in the generated list/storefront; screenshots are
  optional and belong to a later release.
