---
"@open-federation/lexicon": minor
---

Export generated TypeScript types for BFF consumers.

`@open-federation/lexicon` now exports all `Net*Input`, `Net*Output`, and `Net*Error` types derived from the `net.openfederation.*` lexicon schemas. The PDS-internal maps (`LexiconInputMap`, `LexiconOutputMap`, `LexiconErrorMap`) are intentionally excluded.

BFF consumers can now import authoritative types instead of hand-authoring them:

```ts
import type { NetOpenfederationContactListOutput } from '@open-federation/lexicon';
type Contact = NetOpenfederationContactListOutput['contacts'][number];
```

`build:lexicon` now runs `lexicon:generate` as a prerequisite so the types file is always up-to-date with the JSON schemas before the package builds.
