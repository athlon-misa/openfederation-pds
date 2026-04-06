#!/usr/bin/env node
/**
 * Generate static HTML documentation for OpenFederation lexicon schemas.
 * Reads net.openfederation.* JSON files from src/lexicon/ and outputs
 * a browsable docs site to docs-site/.
 */

import fs from 'fs';
import path from 'path';

const LEXICON_SRC = path.resolve('src/lexicon');
const OUTPUT_DIR = path.resolve('docs-site');
const PREFIX = 'net.openfederation.';

interface SchemaProperty {
  type?: string;
  description?: string;
  format?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  ref?: string;
}

interface LexiconDef {
  type: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  input?: { encoding: string; schema?: SchemaProperty };
  output?: { encoding: string; schema?: SchemaProperty };
  parameters?: { type: string; properties?: Record<string, SchemaProperty>; required?: string[] };
  errors?: Array<{ name: string; description?: string }>;
}

interface LexiconFile {
  lexicon: number;
  id: string;
  revision?: number;
  description?: string;
  defs: Record<string, LexiconDef>;
}

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         color: #1a1a2e; background: #f8f9fa; line-height: 1.6; }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.3rem; margin: 1.5rem 0 0.5rem; color: #16213e; }
  h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
  p { margin-bottom: 0.75rem; }
  a { color: #0f3460; }
  code { background: #e9ecef; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9rem; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 3px;
           font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
  .badge-query { background: #d1ecf1; color: #0c5460; }
  .badge-procedure { background: #d4edda; color: #155724; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #dee2e6; font-size: 0.9rem; }
  th { background: #e9ecef; font-weight: 600; }
  .required { color: #dc3545; font-weight: 600; }
  .optional { color: #6c757d; }
  details { margin: 1rem 0; }
  summary { cursor: pointer; font-weight: 600; color: #0f3460; }
  pre { background: #1a1a2e; color: #e9ecef; padding: 1rem; border-radius: 6px;
        overflow-x: auto; font-size: 0.85rem; margin-top: 0.5rem; }
  .namespace-group { margin: 1.5rem 0; }
  .namespace-group h2 { border-bottom: 2px solid #0f3460; padding-bottom: 0.25rem; }
  .schema-list { list-style: none; padding: 0; }
  .schema-list li { padding: 0.3rem 0; }
  .schema-list .type-tag { font-size: 0.75rem; margin-left: 0.5rem; }
  .breadcrumb { margin-bottom: 1rem; font-size: 0.9rem; color: #6c757d; }
  .breadcrumb a { color: #0f3460; }
  .error-table .error-name { font-weight: 600; font-family: monospace; }
  nav { margin-bottom: 2rem; padding: 1rem; background: #fff; border-radius: 6px; border: 1px solid #dee2e6; }
  nav a { margin-right: 1rem; }
  .header { margin-bottom: 2rem; }
  .header p { color: #6c757d; }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderFieldTable(
  props: Record<string, SchemaProperty> | undefined,
  required: string[] | undefined,
): string {
  if (!props || Object.keys(props).length === 0) return '<p>None</p>';

  const reqSet = new Set(required || []);
  let html = '<table><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr>';

  for (const [name, prop] of Object.entries(props)) {
    const typeStr = formatType(prop);
    const isReq = reqSet.has(name);
    html += `<tr>
      <td><code>${escapeHtml(name)}</code></td>
      <td><code>${escapeHtml(typeStr)}</code></td>
      <td class="${isReq ? 'required' : 'optional'}">${isReq ? 'Yes' : 'No'}</td>
      <td>${escapeHtml(prop.description || '')}</td>
    </tr>`;
  }

  html += '</table>';
  return html;
}

function formatType(prop: SchemaProperty): string {
  if (prop.ref) {
    // Strip leading # from ref for display
    return `ref: ${prop.ref.replace(/^#/, '')}`;
  }
  let t = prop.type || 'unknown';
  if (prop.format) t += ` (${prop.format})`;
  if (prop.enum) t += ` [${prop.enum.join(' | ')}]`;
  if (prop.items) t += `<${formatType(prop.items)}>`;
  if (prop.minimum !== undefined || prop.maximum !== undefined) {
    const parts: string[] = [];
    if (prop.minimum !== undefined) parts.push(`min: ${prop.minimum}`);
    if (prop.maximum !== undefined) parts.push(`max: ${prop.maximum}`);
    t += ` (${parts.join(', ')})`;
  }
  if (prop.default !== undefined) t += ` = ${JSON.stringify(prop.default)}`;
  return t;
}

/**
 * Resolve a $ref string (like "#input" or "#communityItem") to the named def in the lexicon.
 */
function resolveRef(ref: string, lex: LexiconFile): LexiconDef | undefined {
  if (ref.startsWith('#')) {
    const defName = ref.slice(1);
    return lex.defs[defName];
  }
  return undefined;
}

/**
 * Get properties and required list from a schema, resolving $ref if needed.
 */
function resolveSchema(
  schema: SchemaProperty | undefined,
  lex: LexiconFile,
): { properties?: Record<string, SchemaProperty>; required?: string[] } {
  if (!schema) return {};
  if (schema.type === 'ref' && schema.ref) {
    const resolved = resolveRef(schema.ref, lex);
    if (resolved) {
      return { properties: resolved.properties, required: resolved.required };
    }
  }
  return { properties: schema.properties, required: schema.required };
}

function renderSchemaPage(lex: LexiconFile): string {
  const main = lex.defs.main;
  const badgeClass = main.type === 'query' ? 'badge-query' : 'badge-procedure';

  const revLabel = lex.revision !== undefined ? ` <span style="font-size:0.75em;color:#6c757d;font-weight:400">(rev ${lex.revision})</span>` : '';

  let body = `
    <div class="breadcrumb"><a href="../index.html">Index</a> / ${escapeHtml(lex.id)}</div>
    <h1><code>${escapeHtml(lex.id)}</code>${revLabel}</h1>
    <p><span class="badge ${badgeClass}">${escapeHtml(main.type)}</span></p>
    <p>${escapeHtml(lex.description || main.description || '')}</p>`;

  // Parameters (for queries)
  if (main.parameters?.properties) {
    body += `<h2>Parameters</h2>`;
    body += renderFieldTable(main.parameters.properties, main.parameters.required);
  }

  // Input (for procedures) — resolve $ref if present
  if (main.input) {
    const { properties, required } = resolveSchema(main.input.schema, lex);
    body += `<h2>Input</h2>`;
    body += renderFieldTable(properties, required);
  }

  // Output — resolve $ref if present
  if (main.output) {
    const { properties: outProps, required: outRequired } = resolveSchema(main.output.schema, lex);
    body += `<h2>Output</h2>`;
    body += renderFieldTable(outProps, outRequired);

    // Nested array items — if an array field's items is a $ref, resolve it too
    if (outProps) {
      for (const [name, prop] of Object.entries(outProps)) {
        if (prop.type === 'array' && prop.items) {
          let itemProps: Record<string, SchemaProperty> | undefined;
          let itemRequired: string[] | undefined;

          if (prop.items.type === 'ref' && prop.items.ref) {
            const resolved = resolveRef(prop.items.ref, lex);
            if (resolved) {
              itemProps = resolved.properties;
              itemRequired = resolved.required;
            }
          } else {
            itemProps = prop.items.properties;
            itemRequired = prop.items.required;
          }

          if (itemProps) {
            body += `<h3><code>${escapeHtml(name)}[]</code> item fields</h3>`;
            body += renderFieldTable(itemProps, itemRequired);
          }
        }
      }
    }
  }

  // Errors
  if (main.errors && main.errors.length > 0) {
    body += `<h2>Errors</h2><table class="error-table"><tr><th>Name</th><th>Description</th></tr>`;
    for (const err of main.errors) {
      body += `<tr><td class="error-name">${escapeHtml(err.name)}</td><td>${escapeHtml(err.description || '')}</td></tr>`;
    }
    body += '</table>';
  }

  // Raw JSON
  body += `<details><summary>Raw Lexicon JSON</summary><pre>${escapeHtml(JSON.stringify(lex, null, 2))}</pre></details>`;

  return wrapHtml(lex.id, body);
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — OpenFederation Lexicon</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">${body}</div>
</body>
</html>`;
}

function main() {
  const files = fs.readdirSync(LEXICON_SRC)
    .filter(f => f.startsWith(PREFIX) && f.endsWith('.json'))
    .sort();

  // Parse all lexicons
  const lexicons: LexiconFile[] = files.map(f => {
    const raw = fs.readFileSync(path.join(LEXICON_SRC, f), 'utf-8');
    return JSON.parse(raw) as LexiconFile;
  });

  // Group by namespace (account, community, identity, etc.)
  const groups = new Map<string, LexiconFile[]>();
  for (const lex of lexicons) {
    const parts = lex.id.replace(PREFIX, '').split('.');
    const ns = parts[0];
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(lex);
  }

  // Create output dirs
  fs.mkdirSync(path.join(OUTPUT_DIR, 'schemas'), { recursive: true });

  // Generate index page
  let indexBody = `
    <div class="header">
      <h1>OpenFederation Lexicon Reference</h1>
      <p>ATProto Lexicon schemas for the OpenFederation protocol. ${lexicons.length} schemas across ${groups.size} namespaces.</p>
    </div>`;

  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Namespace nav
  indexBody += `<nav>`;
  for (const [ns] of sortedGroups) {
    indexBody += `<a href="#${ns}">${ns}</a>`;
  }
  indexBody += `</nav>`;

  for (const [ns, schemas] of sortedGroups) {
    indexBody += `<div class="namespace-group"><h2 id="${ns}">net.openfederation.${escapeHtml(ns)}</h2><ul class="schema-list">`;
    for (const lex of schemas) {
      const main = lex.defs.main;
      const badgeClass = main.type === 'query' ? 'badge-query' : 'badge-procedure';
      const shortName = lex.id.replace(PREFIX, '');
      const revTag = lex.revision !== undefined ? ` <span style="font-size:0.75rem;color:#6c757d">(rev ${lex.revision})</span>` : '';
      indexBody += `<li>
        <a href="schemas/${lex.id}.html"><code>${escapeHtml(shortName)}</code></a>${revTag}
        <span class="badge ${badgeClass} type-tag">${escapeHtml(main.type)}</span>
        — ${escapeHtml(lex.description || main.description || '')}
      </li>`;
    }
    indexBody += `</ul></div>`;
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), wrapHtml('Index', indexBody));

  // Generate per-schema pages
  for (const lex of lexicons) {
    const html = renderSchemaPage(lex);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'schemas', `${lex.id}.html`), html);
  }

  console.log(`✓ Generated docs: ${lexicons.length} schema pages + index`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
}

main();
