/**
 * Drift guard for the `foundry-smith` skill.
 *
 * The skill is now the only thing that teaches an agent how to drive Foundry —
 * there is no generated system prompt to fall back on — and nothing else in the
 * build reads it, so it can rot silently. These assertions are deliberately
 * cheap: the files exist, the tokens the skill documents are actually present in
 * the template it points at, and the socket path in the prose is the one the CLI
 * really uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSocketPath } from '../../../src/cli/args.js';

const SKILL_DIR = join(import.meta.dirname, '../../../../..', 'skills', 'foundry-smith');
const read = (...parts: string[]): string => readFileSync(join(SKILL_DIR, ...parts), 'utf8');

/** The token vocabulary each template promises, per SKILL.md § Visual previews. */
const TEMPLATE_TOKENS: Record<string, string[]> = {
  'agent.html': [
    'name',
    'purpose',
    'color',
    'model',
    'reasoning_effort',
    'envelope',
    'writes',
    'system_prompt',
    'user_prompt',
    'mode',
  ],
  'pipeline.html': [
    'id',
    'name',
    'description',
    'acceptance',
    'phase_index',
    'phase_name',
    'phase_kind',
    'phase_agent',
    'phase_description',
    'phase_detail',
  ],
  'envelope.html': [
    'name',
    'description',
    'field_name',
    'field_type',
    'field_required',
    'field_description',
  ],
};

describe('the foundry-smith skill', () => {
  it('ships SKILL.md and all three preview templates', () => {
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true);
    for (const template of Object.keys(TEMPLATE_TOKENS)) {
      expect(existsSync(join(SKILL_DIR, 'resources', template))).toBe(true);
    }
  });

  it('declares frontmatter a skill loader can route on', () => {
    const skill = read('SKILL.md');
    expect(skill.startsWith('---\n')).toBe(true);
    const frontmatter = skill.slice(4, skill.indexOf('\n---', 4));
    expect(frontmatter).toContain('name: foundry-smith');
    expect(frontmatter).toMatch(/description: .+/);
  });

  it('documents the CLI surface an agent has no other way to discover', () => {
    const skill = read('SKILL.md');
    for (const fragment of [
      'foundry-cli project list',
      '--project',
      'FOUNDRY_SMITH_SOCKET',
      'app.asar.unpacked/out/main/foundry-cli.js',
      'proposal_pending',
      '"rejected":true',
      'notes_for_next_agent',
    ]) {
      expect(skill).toContain(fragment);
    }
  });

  it('quotes the socket path the CLI actually defaults to', () => {
    // `~` stands in for the home directory the CLI resolves at runtime.
    expect(read('SKILL.md')).toContain(defaultSocketPath('~'));
  });

  it('backs every documented token with a placeholder in its template', () => {
    for (const [template, tokens] of Object.entries(TEMPLATE_TOKENS)) {
      const html = read('resources', template);
      for (const token of tokens) {
        expect(html, `${template} is missing {{${token}}}`).toContain(`{{${token}}}`);
      }
    }
  });

  it('pairs every repeat marker with its close, so an expansion cannot be ambiguous', () => {
    for (const template of Object.keys(TEMPLATE_TOKENS)) {
      const html = read('resources', template);
      for (const [, section] of html.matchAll(/<!-- repeat:(\w+) -->/g)) {
        expect(html, `${template} never closes repeat:${section}`).toContain(
          `<!-- /repeat:${section} -->`,
        );
      }
    }
  });

  it('keeps the templates standalone, since a preview opens from a temp file', () => {
    for (const template of Object.keys(TEMPLATE_TOKENS)) {
      const html = read('resources', template);
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/src="https?:/i);
    }
  });
});
