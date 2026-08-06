// Registers the ts-node ESM hooks so `.ts` entrypoints run directly.
//
// Use `node --import ./scripts/register-ts-node.mjs <entry>.ts`, never
// `node --loader ts-node/esm`. `--loader` is deprecated, and under Node 24+ the
// test runner registers it once per forked test file, which crashes before any
// test executes. `register()` is the supported replacement and is applied per
// process, so `--test` works again.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('ts-node/esm', pathToFileURL('./'));
