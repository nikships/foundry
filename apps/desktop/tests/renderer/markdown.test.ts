/**
 * Pins the chat Markdown grammar: what Smith's transcript renders is exactly
 * what this parser says. The parser is deliberately small — anything outside
 * this grammar must fall through as literal text, never disappear.
 */

import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '@renderer/utils/markdown.js';

describe('parseMarkdown blocks', () => {
  it('splits paragraphs on blank lines and keeps inner newlines', () => {
    const blocks = parseMarkdown('first line\nsecond line\n\nnext paragraph');
    expect(blocks).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'first line\nsecond line' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'next paragraph' }] },
    ]);
  });

  it('parses ATX headings with their level', () => {
    const blocks = parseMarkdown('## Plan\nbody');
    expect(blocks[0]).toEqual({
      type: 'heading',
      level: 2,
      children: [{ type: 'text', text: 'Plan' }],
    });
    expect(blocks[1]!.type).toBe('paragraph');
  });

  it('keeps fenced code verbatim — no inline parsing inside', () => {
    const blocks = parseMarkdown('```ts\nconst a = "**not bold**";\n```');
    expect(blocks).toEqual([{ type: 'code', language: 'ts', text: 'const a = "**not bold**";' }]);
  });

  it('closes an unterminated fence at EOF instead of dropping the body', () => {
    const blocks = parseMarkdown('```\nstill code');
    expect(blocks).toEqual([{ type: 'code', language: '', text: 'still code' }]);
  });

  it('groups bullet and ordered lists', () => {
    const blocks = parseMarkdown('- one\n- two\n\n1. first\n2. second');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true });
  });

  it('parses blockquotes and horizontal rules', () => {
    const blocks = parseMarkdown('> quoted\n> more\n\n---');
    expect(blocks[0]).toEqual({
      type: 'quote',
      children: [{ type: 'text', text: 'quoted\nmore' }],
    });
    expect(blocks[1]).toEqual({ type: 'rule' });
  });

  it('starts a new block when a structural line follows a paragraph without a blank line', () => {
    const blocks = parseMarkdown('intro\n- item');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
  });

  it('normalizes CRLF input', () => {
    const blocks = parseMarkdown('a\r\n\r\nb');
    expect(blocks).toHaveLength(2);
  });
});

describe('parseInline', () => {
  it('parses bold, italic, and inline code', () => {
    expect(parseInline('**bold** and *em* and `code`')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'em' }] },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'code' },
    ]);
  });

  it('nests inline marks inside bold', () => {
    expect(parseInline('**a `b`**')).toEqual([
      {
        type: 'strong',
        children: [
          { type: 'text', text: 'a ' },
          { type: 'code', text: 'b' },
        ],
      },
    ]);
  });

  it('parses explicit links and bare http(s) URLs, and only those schemes', () => {
    expect(parseInline('[docs](https://example.com/a)')).toEqual([
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'docs' }] },
    ]);
    expect(parseInline('see https://example.com now')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        href: 'https://example.com',
        children: [{ type: 'text', text: 'https://example.com' }],
      },
      { type: 'text', text: ' now' },
    ]);
    // A non-http scheme is not a link — it stays literal text.
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });

  it('never nests a link inside a link label', () => {
    expect(parseInline('[see https://a.com](https://b.com)')).toEqual([
      {
        type: 'link',
        href: 'https://b.com',
        children: [{ type: 'text', text: 'see https://a.com' }],
      },
    ]);
  });

  it('leaves trailing sentence punctuation out of a bare URL', () => {
    expect(parseInline('read https://example.com/a.')).toEqual([
      { type: 'text', text: 'read ' },
      {
        type: 'link',
        href: 'https://example.com/a',
        children: [{ type: 'text', text: 'https://example.com/a' }],
      },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves unbalanced markers as literal text', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    // Underscores inside identifiers are never emphasis.
    expect(parseInline('a_b_c and snake_case_name')).toEqual([
      { type: 'text', text: 'a_b_c and snake_case_name' },
    ]);
    expect(parseInline('say _hi_ there')).toEqual([
      { type: 'text', text: 'say ' },
      { type: 'em', children: [{ type: 'text', text: 'hi' }] },
      { type: 'text', text: ' there' },
    ]);
  });
});
