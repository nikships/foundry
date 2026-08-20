import Ajv from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  correctionMessage,
  exampleFor,
  extractJson,
  jsonSchemaFor,
  parseEnvelope,
  placeholderEnvelope,
  schemaFor,
  schemas,
} from '../../../src/main/engine/envelopes.js';
import { BUILTIN_ENVELOPE_KINDS, PR_TITLE_MAX } from '../../../src/shared/types.js';

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

  it('requires a bounded title and non-empty body on a pr envelope', () => {
    expect(parseEnvelope('{"status":"success","summary":"drafted"}', 'pr').ok).toBe(false);
    expect(parseEnvelope('{"status":"success","title":"","body":"## Summary"}', 'pr').ok).toBe(
      false,
    );
    expect(parseEnvelope('{"status":"success","title":"Add rate limit","body":""}', 'pr').ok).toBe(
      false,
    );
    const tooLong = 'x'.repeat(PR_TITLE_MAX + 1);
    expect(
      parseEnvelope(
        JSON.stringify({ status: 'success', title: tooLong, body: '## Summary\nDone.' }),
        'pr',
      ).ok,
    ).toBe(false);
    const ok = parseEnvelope(
      '{"status":"success","title":"Add rate limiting","body":"## Summary\\nCaps burst traffic."}',
      'pr',
    );
    expect(ok.ok).toBe(true);
    expect(ok.envelope).toMatchObject({
      title: 'Add rate limiting',
      body: '## Summary\nCaps burst traffic.',
    });
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
  const kinds = BUILTIN_ENVELOPE_KINDS;

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
    for (const kind of BUILTIN_ENVELOPE_KINDS) {
      const result = schemaFor(kind).safeParse(placeholderEnvelope('x', kind));
      expect(result.success, `${kind} placeholder must validate`).toBe(true);
    }
  });
});

describe('json schema derivation', () => {
  const BUILTIN_KINDS = BUILTIN_ENVELOPE_KINDS;

  // ajv is the only 2020-12 validator in the tree; a fresh instance per compile
  // keeps schemas from colliding on the anonymous $id ajv derives.
  function compile(schema: Record<string, unknown>) {
    return new Ajv2020({ strict: true }).compile(schema);
  }

  it('emits a schema whose example round-trips back through the zod parse', () => {
    for (const kind of BUILTIN_KINDS) {
      const schema = jsonSchemaFor(kind);
      expect(schema.type).toBe('object');

      const validate = compile(schema);
      const sample: unknown = JSON.parse(exampleFor(kind));
      expect(validate(sample), `${kind}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(schemas[kind].safeParse(sample).success, `${kind} zod parse`).toBe(true);
    }
  });

  /**
   * Pi compiles the output constraint itself and rejects a dialect URI it
   * does not understand. Zod stamps `$schema` by default, so leaving it on
   * would fail every structured turn.
   */
  it('declares no dialect, so both the strict Draft-07 and 2020-12 validators take it', () => {
    for (const kind of BUILTIN_KINDS) {
      const schema = jsonSchemaFor(kind);
      expect(schema.$schema, `${kind} dialect`).toBeUndefined();
      const draft07 = new Ajv({ allErrors: true, strict: false, strictSchema: true });
      expect(() => draft07.compile(structuredClone(schema)), `${kind} draft-07`).not.toThrow();
      expect(() => compile(schema), `${kind} 2020-12`).not.toThrow();
    }
  });

  it('refuses unknown properties, so a model cannot invent envelope fields', () => {
    const validate = compile(jsonSchemaFor('generic'));
    const sample = JSON.parse(exampleFor('generic')) as Record<string, unknown>;
    expect(validate({ ...sample, surprise: 1 })).toBe(false);
  });

  /**
   * Pinned semantics: the emitted schema is the OUTPUT view, so every
   * `.default()` field is `required`. The model is told to emit them all —
   * strictly more than `parseEnvelope` demands, which fills defaults for
   * anything omitted. Anything conforming to the schema therefore parses;
   * the looser text-parse fallback stays the safety net for anything that
   * does not. Changing this to the input view would silently let a model
   * skip fields the next phase reads.
   */
  it('pins required-ness per kind, defaults included', () => {
    const base = ['status', 'summary', 'artifacts', 'notes_for_next_agent'];
    const expected: Record<(typeof BUILTIN_KINDS)[number], string[]> = {
      generic: base,
      brief: [...base, 'improved_request', 'constraints', 'acceptance_criteria'],
      plan: [...base, 'commit_message'],
      build: [...base, 'changed_files', 'commit_message'],
      scout: [...base, 'findings'],
      review: [...base, 'approved', 'findings', 'blocking'],
      document: [...base, 'document_path', 'documented_files'],
      pr: [...base, 'title', 'body'],
      issue: [...base, 'title', 'body', 'labels'],
    };
    for (const kind of BUILTIN_KINDS) {
      expect(jsonSchemaFor(kind).required, `${kind} required`).toEqual(expected[kind]);
    }

    // Nested objects follow the same rule: review findings carry a defaulted
    // `evidence` and it is required too.
    const reviewFindings = (
      (jsonSchemaFor('review').properties as Record<string, Record<string, unknown>>).findings
        .items as Record<string, unknown>
    ).required;
    expect(reviewFindings).toEqual(['requirement', 'met', 'evidence']);
  });

  it('lets the zod parse fill every defaulted field the schema demands', () => {
    // The other half of the pin: omitting all defaults is stricter than the
    // JSON Schema allows but still a valid envelope on the parse side.
    for (const kind of BUILTIN_KINDS) {
      const minimal: Record<string, unknown> = { status: 'success' };
      if (kind === 'brief') minimal.improved_request = 'do the thing';
      if (kind === 'review') minimal.approved = true;
      if (kind === 'pr' || kind === 'issue') {
        minimal.title = 'Add the thing';
        minimal.body = '## Summary\nAdds the thing.';
      }

      expect(schemas[kind].safeParse(minimal).success, `${kind} zod fills defaults`).toBe(true);
      expect(compile(jsonSchemaFor(kind))(minimal), `${kind} json schema demands defaults`).toBe(
        false,
      );
    }
  });

  it('rejects a missing non-defaulted field in both validators', () => {
    const cases: { kind: (typeof BUILTIN_KINDS)[number]; omit: string; instance: unknown }[] = [
      { kind: 'generic', omit: 'status', instance: JSON.parse(exampleFor('generic')) },
      { kind: 'brief', omit: 'improved_request', instance: JSON.parse(exampleFor('brief')) },
      { kind: 'review', omit: 'approved', instance: JSON.parse(exampleFor('review')) },
      { kind: 'pr', omit: 'title', instance: JSON.parse(exampleFor('pr')) },
      { kind: 'pr', omit: 'body', instance: JSON.parse(exampleFor('pr')) },
    ];
    for (const { kind, omit, instance } of cases) {
      const broken = { ...(instance as Record<string, unknown>) };
      delete broken[omit];
      expect(compile(jsonSchemaFor(kind))(broken), `${kind} json schema rejects ${omit}`).toBe(
        false,
      );
      expect(schemas[kind].safeParse(broken).success, `${kind} zod rejects ${omit}`).toBe(false);
    }
  });

  it('compiles a custom library def with every field type, agent overrides winning', () => {
    const defs = [
      {
        name: 'severity_report',
        description: 'A severity-tagged report',
        fields: [
          {
            name: 'severity',
            type: 'string' as const,
            required: true,
            description: 'low|med|high',
          },
          { name: 'score', type: 'number' as const, required: false },
          { name: 'urgent', type: 'boolean' as const, required: true },
          { name: 'steps', type: 'string[]' as const, required: false, description: 'one step' },
        ],
      },
    ];
    // Name collision: the agent relaxes the library's required `severity`.
    const customFields = [
      { name: 'severity', type: 'string' as const, required: false },
      { name: 'owner', type: 'string' as const, required: true },
    ];

    const schema = jsonSchemaFor('severity_report', customFields, defs);
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.score.type).toBe('number');
    expect(props.urgent.type).toBe('boolean');
    expect(props.steps).toMatchObject({ type: 'array', items: { type: 'string' } });
    // The agent override wins, so severity drops out of required; owner joins it.
    expect(schema.required).toEqual([
      'status',
      'summary',
      'artifacts',
      'notes_for_next_agent',
      'urgent',
      'owner',
    ]);

    const sample: unknown = JSON.parse(exampleFor('severity_report', customFields, defs));
    const validate = compile(schema);
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    expect(schemaFor('severity_report', customFields, defs).safeParse(sample).success).toBe(true);
  });

  it('falls back to the generic schema for an unknown kind', () => {
    const defs = [{ name: 'severity_report', fields: [] }];
    const schema = jsonSchemaFor('deleted_envelope', undefined, defs);
    expect(schema.required).toEqual(['status', 'summary', 'artifacts', 'notes_for_next_agent']);
    expect(compile(schema)(JSON.parse(exampleFor('deleted_envelope', undefined, defs)))).toBe(true);
  });
});
