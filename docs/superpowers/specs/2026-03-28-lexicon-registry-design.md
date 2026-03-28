# Lexicon Registry Design

**Issue:** #23 — Publish OpenFederation Lexicon schemas as public registry
**Date:** 2026-03-28
**Status:** Approved

## Context

The PDS has 61 lexicon JSON files in `src/lexicon/`. 60 are `net.openfederation.*` schemas authored by this project; the remaining `com.atproto.repo.uploadBlob` is an ATProto standard schema we don't own. Currently lexicons are static documentation with no validation, versioning, or publishing pipeline.

Federation requires other PDS implementations to know the exact schema contracts. Publishing lexicons as an npm package gives consumers programmatic access; a docs site gives humans a browsable reference.

Breaking changes to lexicons are acceptable now (single consumer: Grvty).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Publish scope | `net.openfederation.*` only | `com.atproto.*` schemas are owned by Bluesky |
| Distribution | npm package + GitHub Pages docs | Machines and humans both need access |
| Docs hosting | GitHub Pages | Free, auto-deploys from CI, decoupled from PDS |
| Versioning | SemVer on the package (`0.x.y`) | Per-schema revisions deferred to #31 |
| Source of truth | `src/lexicon/` in the PDS repo | Schemas authored alongside handlers |

## 1. npm Package (`@openfederation/lexicon`)

**Location:** `packages/openfederation-lexicon/`

**Contents (generated at build time):**
- All `net.openfederation.*` JSON files copied from `src/lexicon/` into `schemas/`
- TypeScript barrel (`src/index.ts`) exporting:
  - `schemas`: array of all lexicon objects (for `@atproto/lexicon` validators)
  - `schemaMap`: `Record<string, LexiconDoc>` keyed by NSID for individual lookups
  - `nsids`: const object of all NSID strings for type-safe references
- Built with tsup (ESM + CJS), same toolchain as `@openfederation/sdk`

**Initial version:** `0.1.0`

**Build flow:**
1. `scripts/build-lexicon-package.ts` copies `net.openfederation.*` JSON from `src/lexicon/` into `packages/openfederation-lexicon/schemas/`, then generates `src/index.ts` barrel
2. `tsup` compiles to `dist/`
3. npm publish triggered by CI on `lexicon-v*` tag

## 2. Schema Validation

**Build-time validation** (in the build script, before copying):
- Parse each JSON file with `@atproto/lexicon`'s `parseLexiconDoc()` to confirm valid Lexicon v1
- Verify each file's `id` field matches its filename (e.g., `net.openfederation.community.get.json` must have `"id": "net.openfederation.community.get"`)
- Fail the build if any schema is invalid

**CI integration:**
- `validate:lexicon` npm script
- Runs in CI alongside unit tests

No runtime validation in the PDS itself — separate concern.

## 3. Docs Site (GitHub Pages)

**Generator:** `scripts/build-lexicon-docs.ts` reads `net.openfederation.*` JSON files and produces static HTML.

**Output structure:**
```
docs-site/
  index.html              # All schemas grouped by namespace
  schemas/
    net.openfederation.community.get.html
    net.openfederation.community.createRole.html
    ...
```

**Per-schema page shows:**
- NSID, description
- Type (query/procedure)
- Input/parameters: field table (name, type, required, description)
- Output: field table
- Errors: name + description
- Raw JSON (collapsible)

**Styling:** Minimal clean HTML with inline CSS. No framework, no JS dependencies.

**Deployment:**
- Separate workflow `.github/workflows/lexicon-docs.yml`
- Triggers on push to `main` when `src/lexicon/` or docs generator changes (path filter)
- Deploys to `https://athlon-misa.github.io/openfederation-pds/`
- Custom domain (`lexicon.openfederation.net`) can be added later via CNAME

## 4. CI & Publishing

### Validation (every push) — in existing `ci.yml`
- `validate:lexicon` step after build, before tests

### Docs deployment (push to main) — `.github/workflows/lexicon-docs.yml`
- Path filter: `src/lexicon/**`, `scripts/build-lexicon-docs.ts`
- Generates HTML, deploys to GitHub Pages

### npm publish (manual tag) — `.github/workflows/lexicon-publish.yml`
- Triggers on `lexicon-v*` tags
- Builds package, publishes to npm
- Requires `NPM_TOKEN` repository secret

### Workflow for lexicon changes
1. Edit JSON in `src/lexicon/`
2. Push to main — CI validates schemas, docs auto-update on GitHub Pages
3. When ready to release: `git tag lexicon-v0.1.0 && git push --tags` — npm publish fires

### npm scripts added
- `validate:lexicon` — validate all schema files
- `build:lexicon` — build the npm package
- `build:lexicon-docs` — generate the docs site

## 5. Out of Scope

- **No runtime validation in the PDS** — handlers continue to validate manually
- **No TypeScript type generation** from lexicon schemas (separate feature)
- **No per-schema revision tracking** — deferred to #31
- **No custom domain** — GitHub Pages default URL for now
- **No changes to existing lexicon file contents** — publishing infrastructure only
