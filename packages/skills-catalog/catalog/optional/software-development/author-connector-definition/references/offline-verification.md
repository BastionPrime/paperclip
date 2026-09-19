# Offline verification harness

Run the real catalog generator, the real brand validators, and the real catalog
tests without mutating the App checkout. Use this when you must verify before
you have permission to write to the repository, when another task owns the
working tree, or when you want to prove a failure is attributable to your change
and not to the environment.

The recipe below builds it. It exports the needed files with `git archive` and
`git show` at a pinned commit and symlinks `node_modules` read-only, so the
checkout is untouched.

This used to ship as `scripts/make-harness.sh` inside the skill. It is inlined
here on purpose: a skill package containing anything under `scripts/` derives
the `scripts_executables` trust level (`deriveTrustLevel` in
`packages/skills-catalog/src/catalog-builder.ts:763-767`), and the shipped
catalog pins that set to exactly one key
(`packages/skills-catalog/src/shipped-catalog.test.ts:132-136`). Carrying the
recipe as documentation keeps this package `markdown_only` and installable
without an audit-allowlist change. Save it to a file yourself and `chmod +x` it
if you prefer to run it as a script.

## Build it

Save as `make-harness.sh` outside the App checkout, then:

```sh
./make-harness.sh <app-repo> <commit-ish> <out-dir> <corpus-dir>
```

<details>
<summary><code>make-harness.sh</code></summary>

```bash
#!/usr/bin/env bash
# Build an isolated harness that runs the real catalog generator, the real brand
# validators, and the real catalog tests against a copy of a pinned commit.
#
# Nothing in the App checkout is modified: files are exported with `git archive`
# and `git show`, and node_modules is symlinked read-only.
#
# Usage:
#   make-harness.sh <app-repo> <commit-ish> <out-dir> <corpus-dir>

set -euo pipefail

APP_REPO=${1:?app repo path}
COMMIT=${2:?commit-ish}
OUT=${3:?output dir}
CORPUS=${4:?ingestion corpus dir}

[ -d "$CORPUS" ] || { echo "corpus not found: $CORPUS" >&2; exit 1; }
[ -d "$APP_REPO/node_modules" ] || { echo "install dependencies in $APP_REPO first" >&2; exit 1; }

SHA=$(git -C "$APP_REPO" rev-parse "$COMMIT")
rm -rf "$OUT"; mkdir -p "$OUT/gen/scripts" "$OUT/vt/packages/shared" "$OUT/vt/ui/public/brands"
echo "$SHA" > "$OUT/PINNED_COMMIT"

# --- generator harness -------------------------------------------------------
for f in scripts/ingest-app-definitions.mjs \
         scripts/app-brand-validation.mjs \
         scripts/check-app-brand-assets.mjs \
         scripts/app-brand-validation.test.mjs; do
  git -C "$APP_REPO" show "$SHA:$f" > "$OUT/gen/$f"
done
git -C "$APP_REPO" archive "$SHA" ui/public/brands/apps | tar -x -C "$OUT/gen"
git -C "$APP_REPO" archive "$SHA" \
  packages/shared/src/app-definitions \
  packages/shared/src/app-definitions.generated.ts \
  packages/shared/src/app-definitions.ingestion-report.json \
  packages/shared/src/app-definitions.ts \
  packages/shared/src/self-serve-mcp-research.json | tar -x -C "$OUT/gen"

# Pristine copies, so fidelity and change can be told apart.
cp -r "$OUT/gen/packages/shared/src/app-definitions" "$OUT/gen/.baseline-definitions"
cp "$OUT/gen/packages/shared/src/app-definitions.generated.ts" "$OUT/gen/.baseline-generated.ts"
cp "$OUT/gen/packages/shared/src/app-definitions.ingestion-report.json" "$OUT/gen/.baseline-report.json"

cat > "$OUT/gen/verify-fidelity.sh" <<'FIDELITY'
#!/usr/bin/env bash
# Regenerate from the pristine source and prove the harness reproduces the
# checked-in output exactly. Run this BEFORE applying your own change.
set -euo pipefail
: "${PAPERCLIP_CONTENT_TEMPLATES:?point this at the ingestion corpus}"
node scripts/ingest-app-definitions.mjs
diff -rq .baseline-definitions packages/shared/src/app-definitions
diff -q .baseline-generated.ts packages/shared/src/app-definitions.generated.ts
diff -q .baseline-report.json packages/shared/src/app-definitions.ingestion-report.json
echo "fidelity OK: harness reproduces the checked-in output byte-for-byte"
FIDELITY
chmod +x "$OUT/gen/verify-fidelity.sh"

# --- vitest harness ----------------------------------------------------------
git -C "$APP_REPO" archive "$SHA" \
  packages/shared/src packages/shared/package.json packages/shared/tsconfig.json | tar -x -C "$OUT/vt"
git -C "$APP_REPO" show "$SHA:tsconfig.base.json" > "$OUT/vt/tsconfig.base.json"
ln -s "$(cd "$APP_REPO" && pwd)/node_modules" "$OUT/vt/node_modules"
ln -s "$(cd "$APP_REPO" && pwd)/packages/shared/node_modules" "$OUT/vt/packages/shared/node_modules"

cat > "$OUT/vt/sync-from-gen.sh" <<'SYNC'
#!/usr/bin/env bash
# Copy the generator harness's current output into the vitest harness, so the
# tests run against exactly what you generated.
set -euo pipefail
GEN=${1:?path to the gen harness}
rm -rf ui/public/brands/apps && mkdir -p ui/public/brands
cp -r "$GEN/ui/public/brands/apps" ui/public/brands/apps
cp "$GEN/packages/shared/src/app-definitions.ts" packages/shared/src/app-definitions.ts
cp "$GEN/packages/shared/src/app-definitions.generated.ts" packages/shared/src/app-definitions.generated.ts
cp "$GEN/packages/shared/src/app-definitions/"*.json packages/shared/src/app-definitions/
echo "synced from $GEN"
SYNC
chmod +x "$OUT/vt/sync-from-gen.sh"

echo "harness ready at $OUT (pinned $SHA)"
echo "  generator: $OUT/gen"
echo "  vitest:    $OUT/vt/packages/shared"
```

</details>

```text
harness ready at /tmp/harness (pinned e558f25e99020b8ab762b91a8eabb0fe383f993f)
  generator: /tmp/harness/gen
  vitest:    /tmp/harness/vt/packages/shared
```

The output above is from a run at Paperclip App commit `e558f25e` on
15 September 2026, Node v24.20.0. The harness was previously exercised at
`728f7185`; the recipe did not need changing between the two.

Two roots, because they have different working directories:

- `gen/` — the generator runs from a repo-shaped root (`process.cwd()` is the
  root it reads `ui/public/brands/apps/manifest.json` from and writes
  `packages/shared/src/app-definitions/` into).
- `vt/` — the vitest root. `app-definitions.test.ts` resolves `../../../ui/public`
  relative to its own file, so `vt/ui/public/brands/apps` has to exist.

## Prove the harness first

Never trust a harness you have not checked. Regenerate from the pristine source
and confirm the output matches the checked-in files byte-for-byte:

```sh
cd <out-dir>/gen
PAPERCLIP_CONTENT_TEMPLATES=<corpus-dir> ./verify-fidelity.sh
```

```text
Parsed 99 captures and 179 states; emitted 70 Wave 1 definitions and flagged 63 states for review.
fidelity OK: harness reproduces the checked-in output byte-for-byte
```

The corpus is in the non-public `paperclip-content` repository. Without it the
generator refuses to run and this harness cannot be built — report that as a
blocked prerequisite rather than editing the guard.

If that diff is not empty, stop. Either the corpus is wrong or the harness is
missing an input, and any later result is meaningless.

## Run your change through it

```sh
cd <out-dir>/gen
# edit scripts/ingest-app-definitions.mjs, ui/public/brands/apps/manifest.json,
# packages/shared/src/app-definitions.ts, and add the brand asset
node scripts/check-app-brand-assets.mjs
node --test scripts/app-brand-validation.test.mjs
PAPERCLIP_CONTENT_TEMPLATES=<corpus-dir> node scripts/ingest-app-definitions.mjs

cd <out-dir>/vt && ./sync-from-gen.sh <out-dir>/gen
cd <out-dir>/vt/packages/shared
node ../../node_modules/vitest/vitest.mjs run \
  src/app-definitions.test.ts src/app-definitions-url.test.ts
```

Expect the count assertion to fail first, then update it and rerun. Real output
from the Neon worked example at `e558f25e`:

```text
Validated 70 brand identities: local paths, aliases and artwork safety.
Parsed 99 captures and 179 states; emitted 71 Wave 1 definitions and flagged 63 states for review.

AssertionError: expected [ { schemaVersion: 1, …(8) }, …(46) ] to have a length of 46 but got 47
 ❯ src/app-definitions.test.ts:689:35
```

```text
Test Files  2 passed (2)
     Tests  27 passed (27)
```

Also diff the generated registry and confirm the only changes are positional.
At this commit one inserted provider moved 125 lines of `a<N>` imports in
`app-definitions.generated.ts` and changed nothing semantic in another
provider:

```sh
diff .baseline-generated.ts packages/shared/src/app-definitions.generated.ts \
  | grep '^[<>]' | grep -v 'a[0-9]'   # must print nothing
```

## What this harness does not cover

Be explicit about this in your report. The harness reaches the shared package
only. It does not run:

- the server suites (`tool-access-service`, `generic-mcp-connection`,
  `tool-connection-removal`) — they need the server package and its fixtures;
- the UI suites (`AppsConnect`, `Browse`) — they need the UI package;
- `pnpm check:token-gates`, `pnpm -r typecheck`, `pnpm build`, `pnpm test:e2e`;
- anything account-bound.

Source-inspecting those is a legitimate intermediate result. Reporting them as
passed is not.

Above all: a green run here proves the definition fits the tested contracts. It
is not provider validation, not an agent run, and not acceptance. See
`references/live-acceptance.md` for the gate that is.

## Notes

- `node_modules/.bin/vitest` is a shell wrapper that Node cannot execute
  directly. Call `node_modules/vitest/vitest.mjs`.
- `--reporter=basic` is not a valid reporter on vitest 4. Omit it.
- The harness needs `tsconfig.base.json` at the harness root; the script exports
  it, because the shared package's tsconfig extends it and the transform fails
  without it.
