## What

Brief description of the change.

## Why

Link to issue or explain motivation.

## Checklist

- [ ] Tests pass (`npm run test:unit` / `npm run test:api`)
- [ ] Build succeeds (`npm run build`)
- [ ] No secrets, credentials, or `.env` files included
- [ ] New XRPC endpoints have lexicon definitions in `src/lexicon/`; lexicon `revision` bumped where inputs, outputs or errors changed; `npm run lexicon:validate` passes
- [ ] Changeset added (`npx changeset`) for changes to a published package in `packages/`
- [ ] `CHANGELOG.md` entry under `[Unreleased]` for user-visible changes
- [ ] Audit logging added for admin/security-relevant actions
- [ ] Breaking changes documented (if any)
