import { describe, expect, it } from 'vitest';
import {
  correctionMessage,
  exampleFor,
  extractJson,
  parseEnvelope,
  schemaFor,
} from '../src/main/engine/envelopes.js';

describe('envelope extraction', () => {
  it('takes the last balanced object when prose surrounds it', () => {
    const text =
      'Here is my thinking {"draft": true} and my answer:\n{"status":"success","summary":"done"}';
    expect(extractJson(text)).toBe('{"status":"success","summary":"done"}');
  });

  it('prefers a fenced block over loose braces', () => {
    const text = 'notes {"a":1}\n```json\n{"status":"fail","summary":"nope"}\n```';
    const json = extractJson(text);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).status).toBe('fail');
  });

  it('survives braces inside strings', () => {
    const text = '{"status":"success","summary":"used {{request}} in the prompt"}';
    expect(JSON.parse(extractJson(text)!).summary).toContain('{{request}}');
  });

  it('returns null when there is no object', () => {
    expect(extractJson('no json at all, just prose')).toBeNull();
  });
});

describe('envelope parsing', () => {
  it('fills defaults for omitted optional base fields', () => {
    const result = parseEnvelope('{"status":"success"}', 'generic');
    expect(result.ok).toBe(true);
    expect(result.envelope).toMatchObject({ summary: '', artifacts: [], notes_for_next_agent: '' });
  });

  it('names exactly what was wrong', () => {
    const result = parseEnvelope('{"summary":"forgot status"}', 'generic');
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('status');
  });

  it('requires approved on a review envelope', () => {
    const missing = parseEnvelope('{"status":"success","summary":"looks fine"}', 'review');
    expect(missing.ok).toBe(false);
    const present = parseEnvelope('{"status":"success","approved":true}', 'review');
    expect(present.ok).toBe(true);
  });

  it('reports no-json distinctly from invalid-json', () => {
    expect(parseEnvelope('prose only', 'generic').problem).toContain('no JSON object');
    expect(parseEnvelope('{"status": }', 'generic').problem).toBeDefined();
  });
});

describe('custom fields', () => {
  const custom = [
    { name: 'severity', type: 'string' as const, required: true },
    { name: 'score', type: 'number' as const, required: false },
  ];

  it('compiles into the schema', () => {
    const schema = schemaFor('generic', custom);
    expect(schema.safeParse({ status: 'success' }).success).toBe(false);
    expect(schema.safeParse({ status: 'success', severity: 'high' }).success).toBe(true);
  });

  it('appears in the generated example, so the triad cannot drift', () => {
    const example = exampleFor('generic', custom);
    expect(example).toContain('severity');
    expect(example).toContain('score');
  });
});

describe('generated examples', () => {
  const kinds = ['generic', 'plan', 'build', 'scout', 'review', 'document'] as const;

  it('carries every schema field for each built-in kind', () => {
    for (const kind of kinds) {
      const example = JSON.parse(exampleFor(kind));
      // Example must satisfy its schema so an agent can copy it literally.
      expect(schemaFor(kind).safeParse(example).success, `${kind} example must validate`).toBe(
        true,
      );
    }
  });

  it('is what the correction message restates', () => {
    const message = correctionMessage('status: Required', 'build');
    expect(message).toContain('status: Required');
    expect(message).toContain('changed_files');
  });
});
