/**
 * Fails if a `<style>` block in a .tsx file redefines a class owned by
 * tokens-base.css. After the CSS-module migration, inline `<style>` blocks
 * should not redefine base classes (.btn, .field, .hint, .row, …) — those
 * belong to the shared stylesheet, and local redefinitions collide when
 * components are co-mounted.
 *
 * A "redefinition" is a selector where the base class IS the selector
 * (optionally with a pseudo-class or modifier), not a descendant rule
 * like `.field label` — that styles a child, not the field itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const rendererRoot = new URL('../apps/desktop/src/renderer', import.meta.url).pathname;

// Extract base-owned class names: classes directly defined (not as descendants)
// in tokens-base.css. A line like `.field {` or `.btn.primary {` owns `.field`
// and `.btn` respectively; `.field .hint {` does NOT own `.hint`.
const baseCss = readFileSync(join(rendererRoot, 'design/tokens-base.css'), 'utf8');
const baseClasses = new Set();
for (const line of baseCss.split('\n')) {
  const m = line.match(/^\s*\.([a-z0-9-]+)\s*[,.:{]/);
  if (m) baseClasses.add(m[1]);
}

// Walk all .tsx files under src/renderer
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (extname(entry.name) === '.tsx') yield path;
  }
}

// A selector that directly redefines a base class: the class name is the
// compound selector (before a combinator). `.field {`, `.field.tight {`,
// `.field:focus {`, `.field, .hint {` all count; `.field label {` does not.
const DIRECT_REDEF = /^\s*\.([a-z0-9-]+)\s*[,.:{]/;

const violations = [];
for (const file of walk(rendererRoot)) {
  const src = readFileSync(file, 'utf8');
  for (const block of src.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)) {
    for (const line of block[1].split('\n')) {
      const m = line.match(DIRECT_REDEF);
      if (m && baseClasses.has(m[1])) {
        violations.push(`${file}: redefines base class .${m[1]}`);
      }
    }
  }
}

if (violations.length) {
  console.error('Base-class redefinitions found in <style> blocks:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nMove the CSS to a .module.css file and delete the base-class');
  console.error('redefinition — tokens-base.css already provides it.');
  process.exit(1);
}
