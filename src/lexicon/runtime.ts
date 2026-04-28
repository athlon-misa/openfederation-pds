import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  lexiconContracts,
  type LexiconInputMap,
  type LexiconNsid,
  type LexiconOutputMap,
} from './generated.js';

type LexiconError = {
  name?: unknown;
  description?: unknown;
};

type LexiconSchema = {
  type?: string;
  ref?: string;
  properties?: Record<string, LexiconSchema>;
  required?: string[];
  items?: LexiconSchema;
  minimum?: number;
  maximum?: number;
};

type LexiconDoc = {
  id?: unknown;
  defs?: {
    main?: {
      type?: string;
      input?: {
        schema?: LexiconSchema;
      };
      parameters?: LexiconSchema;
      output?: {
        schema?: LexiconSchema;
      };
      errors?: LexiconError[];
    };
    [defName: string]: unknown;
  };
};

const LEXICON_DIR = join(process.cwd(), 'src', 'lexicon');

let schemaCache: Map<string, LexiconDoc> | null = null;

function loadSchemas(): Map<string, LexiconDoc> {
  if (schemaCache) return schemaCache;

  const schemas = new Map<string, LexiconDoc>();
  for (const file of readdirSync(LEXICON_DIR)) {
    if (!file.endsWith('.json')) continue;

    const raw = JSON.parse(readFileSync(join(LEXICON_DIR, file), 'utf-8')) as LexiconDoc;
    if (typeof raw.id === 'string') {
      schemas.set(raw.id, raw);
    }
  }

  schemaCache = schemas;
  return schemas;
}

export function getMethodSchema(nsid: string): LexiconDoc | undefined {
  return loadSchemas().get(nsid);
}

export function getDeclaredErrorCodes(nsid: string): Set<string> {
  const contract = lexiconContracts[nsid as keyof typeof lexiconContracts];
  if (contract) return new Set(contract.errors);

  const schema = getMethodSchema(nsid);
  const errors = schema?.defs?.main?.errors ?? [];
  return new Set(errors
    .map((error) => error.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0));
}

export function isDeclaredErrorCode(nsid: string, code: string): boolean {
  return getDeclaredErrorCodes(nsid).has(code);
}

export function assertDeclaredErrorCode(nsid: string, code: string): void {
  if (!isDeclaredErrorCode(nsid, code)) {
    throw new Error(`XRPC error "${code}" is not declared by lexicon "${nsid}"`);
  }
}

export type LexiconValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateXrpcInput(nsid: string, value: unknown): LexiconValidationResult {
  const schema = getMethodSchema(nsid);
  const main = schema?.defs?.main;
  if (!schema || !main) return { ok: true };

  const inputSchema = main.type === 'query' ? main.parameters : main.input?.schema;
  if (!inputSchema) return { ok: true };

  return validateAgainstSchema(schema, inputSchema, value, '$', { allowStringNumbers: main.type === 'query' });
}

export function validateTypedXrpcInput<N extends LexiconNsid>(
  nsid: N,
  value: unknown,
): LexiconValidationResult & { value?: LexiconInputMap[N] } {
  const result = validateXrpcInput(nsid, value);
  if (!result.ok) return result;
  return { ok: true, value: value as LexiconInputMap[N] };
}

export function validateXrpcOutput(nsid: string, value: unknown): LexiconValidationResult {
  const schema = getMethodSchema(nsid);
  const outputSchema = schema?.defs?.main?.output?.schema;
  if (!schema || !outputSchema) return { ok: true };

  return validateAgainstSchema(schema, outputSchema, value, '$', { allowStringNumbers: false });
}

export function validateTypedXrpcOutput<N extends LexiconNsid>(
  nsid: N,
  value: unknown,
): LexiconValidationResult & { value?: LexiconOutputMap[N] } {
  const result = validateXrpcOutput(nsid, value);
  if (!result.ok) return result;
  return { ok: true, value: value as LexiconOutputMap[N] };
}

function validateAgainstSchema(
  doc: LexiconDoc,
  schema: LexiconSchema,
  value: unknown,
  path: string,
  options: { allowStringNumbers: boolean },
): LexiconValidationResult {
  const resolved = resolveSchema(doc, schema);
  const type = resolved.type;

  if (type === 'unknown' || !type) return { ok: true };
  if (value === null) return { ok: true };

  if (type === 'ref') {
    return validateAgainstSchema(doc, resolveSchema(doc, resolved), value, path, options);
  }

  if (type === 'object' || type === 'params') {
    if (!isPlainObject(value)) {
      return invalid(`${path} must be an object`);
    }
    const properties = resolved.properties ?? {};
    if (Object.keys(properties).length === 0) {
      return { ok: true };
    }
    const required = new Set(resolved.required ?? []);
    for (const field of required) {
      if (!(field in value) || value[field] === null || value[field] === undefined) {
        return invalid(`${path}.${field} is required`);
      }
    }
    for (const field of Object.keys(value)) {
      const fieldSchema = properties[field];
      if (!fieldSchema) {
        return invalid(`${path}.${field} is not declared by the lexicon`);
      }
      const result = validateAgainstSchema(doc, fieldSchema, value[field], `${path}.${field}`, options);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      return invalid(`${path} must be an array`);
    }
    const itemSchema = resolved.items ?? { type: 'unknown' };
    for (let i = 0; i < value.length; i += 1) {
      const result = validateAgainstSchema(doc, itemSchema, value[i], `${path}[${i}]`, options);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  if (type === 'string') {
    return typeof value === 'string' ? { ok: true } : invalid(`${path} must be a string`);
  }

  if (type === 'integer') {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return validateNumberBounds(resolved, value, path);
    }
    if (options.allowStringNumbers && typeof value === 'string' && /^-?\d+$/.test(value)) {
      return validateNumberBounds(resolved, Number(value), path);
    }
    return invalid(`${path} must be an integer`);
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true };
    if (options.allowStringNumbers && (value === 'true' || value === 'false')) return { ok: true };
    return invalid(`${path} must be a boolean`);
  }

  return { ok: true };
}

function validateNumberBounds(schema: LexiconSchema, value: number, path: string): LexiconValidationResult {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    return invalid(`${path} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    return invalid(`${path} must be <= ${schema.maximum}`);
  }
  return { ok: true };
}

function resolveSchema(doc: LexiconDoc, schema: LexiconSchema): LexiconSchema {
  if (schema.type !== 'ref' || typeof schema.ref !== 'string') return schema;

  if (!schema.ref.startsWith('#')) {
    return { type: 'unknown' };
  }
  const defName = schema.ref.slice(1);
  const resolved = doc.defs?.[defName];
  return isLexiconSchema(resolved) ? resolved : { type: 'unknown' };
}

function isLexiconSchema(value: unknown): value is LexiconSchema {
  return isPlainObject(value) && (typeof value.type === 'string' || typeof value.ref === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): LexiconValidationResult {
  return { ok: false, message };
}

export function resetLexiconRuntimeCacheForTests(): void {
  schemaCache = null;
}
