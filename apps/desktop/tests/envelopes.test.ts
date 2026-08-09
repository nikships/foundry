import { describe, expect, it } from 'vitest';
import {
  correctionMessage,
  exampleFor,
  extractJson,
  parseEnvelope,
  placeholderEnvelope,
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

  it('requires a non-empty improved_request on a brief envelope', () => {
    expect(parseEnvelope('{"status":"success","summary":"sharpened"}', 'brief').ok).toBe(false);
    expect(parseEnvelope('{"status":"success","improved_request":""}', 'brief').ok).toBe(false);
    const ok = parseEnvelope(
      '{"status":"success","improved_request":"add rate limiting"}',
      'brief',
    );
    expect(ok.ok).toBe(true);
    expect(ok.envelope).toMatchObject({ constraints: [], acceptance_criteria: [] });
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

describe('custom envelope library defs', () => {
  const defs = [
    {
      name: 'severity_report',
      description: 'A severity-tagged report',
      fields: [
        { name: 'severity', type: 'string' as const, required: true, description: 'low|med|high' },
        { name: 'score', type: 'number' as const, required: false },
      ],
    },
  ];

  it('resolves a custom name against the library def', () => {
    const schema = schemaFor('severity_report', undefined, defs);
    expect(schema.safeParse({ status: 'success' }).success).toBe(false);
    expect(schema.safeParse({ status: 'success', severity: 'high' }).success).toBe(true);
  });

  it('puts library fields and their hints into the example', () => {
    const example = JSON.parse(exampleFor('severity_report', undefined, defs));
    expect(example.severity).toBe('low|med|high');
    expect(example.score).toBe(0);
    expect(example.status).toBe('success');
  });

  it('keeps a described non-string field copyable, so the example still validates', () => {
    const typed = [
      { name: 'steps', type: 'string[]' as const, required: true, description: 'one step' },
      { name: 'score', type: 'number' as const, required: true, description: '0-100' },
    ];
    const example = JSON.parse(exampleFor('generic', typed));
    expect(example.steps).toEqual(['one step']);
    expect(example.score).toBe(0);
    expect(schemaFor('generic', typed).safeParse(example).success).toBe(true);
  });

  it('parses a reply against the custom shape', () => {
    const ok = parseEnvelope(
      '{"status":"success","severity":"high","score":3}',
      'severity_report',
      undefined,
      defs,
    );
    expect(ok.ok).toBe(true);
    expect(ok.envelope).toMatchObject({ severity: 'high', score: 3 });

    const missing = parseEnvelope('{"status":"success"}', 'severity_report', undefined, defs);
    expect(missing.ok).toBe(false);
    expect(missing.problem).toContain('severity');
  });

  it('restates the custom example in a correction', () => {
    const message = correctionMessage('severity: Required', 'severity_report', undefined, defs);
    expect(message).toContain('severity');
    expect(message).toContain('low|med|high');
  });

  it('falls back to generic when the name is unknown', () => {
    const schema = schemaFor('deleted_envelope', undefined, defs);
    expect(schema.safeParse({ status: 'success' }).success).toBe(true);
    // No library fields leaked in.
    expect(JSON.parse(exampleFor('deleted_envelope', undefined, defs))).not.toHaveProperty(
      'severity',
    );
  });

  it('still layers agent customFields on top of a library def', () => {
    const agentExtra = [{ name: 'owner', type: 'string' as const, required: true }];
    const schema = schemaFor('severity_report', agentExtra, defs);
    expect(schema.safeParse({ status: 'success', severity: 'high' }).success).toBe(false);
    expect(schema.safeParse({ status: 'success', severity: 'high', owner: 'nik' }).success).toBe(
      true,
    );
  });

  it('prefers a built-in when the name collides with a kind', () => {
    const colliding = [
      {
        name: 'build',
        fields: [{ name: 'severity', type: 'string' as const, required: true }],
      },
    ];
    // Built-in wins: changed_files is present, severity is not required.
    const example = JSON.parse(exampleFor('build', undefined, colliding));
    expect(example).toHaveProperty('changed_files');
    expect(example).not.toHaveProperty('severity');
  });
});

describe('generated examples', () => {
  const kinds = ['generic', 'brief', 'plan', 'build', 'scout', 'review', 'document'] as const;

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

describe('dry-run placeholders', () => {
  it('carries the fields of the kind it stands in for, not a fixed shape', () => {
    const brief = placeholderEnvelope('refine', 'brief');
    expect(brief).toHaveProperty('improved_request');
    expect(brief).toHaveProperty('acceptance_criteria');
    expect(brief).not.toHaveProperty('changed_files');

    const build = placeholderEnvelope('build', 'build');
    expect(build).toHaveProperty('changed_files');
    expect(build).not.toHaveProperty('improved_request');
  });

  it('names the phase it stands in for, so a reader knows it is not real output', () => {
    expect(placeholderEnvelope('refine', 'brief').summary).toContain('refine');
  });

  it('satisfies the schema of the kind it stands in for', () => {
    for (const kind of ['generic', 'brief', 'plan', 'build', 'scout', 'review', 'document']) {
      const result = schemaFor(kind).safeParse(placeholderEnvelope('x', kind));
      expect(result.success, `${kind} placeholder must validate`).toBe(true);
    }
  });
});
