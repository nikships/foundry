import { useMemo } from 'react';
import { CodeBlock } from './ui/CodeBlock.js';
import styles from './JsonView.module.css';

interface Token {
  text: string;
  cls: string;
}

function tokenize(value: unknown, indent = 0, key: string | null = null): Token[] {
  const pad = '  '.repeat(indent);
  const prefix: Token[] = key === null ? [] : [{ text: `${pad}"${key}": `, cls: 'k' }];

  if (value === null) return [...prefix, { text: 'null', cls: 'null' }];
  if (typeof value === 'boolean') return [...prefix, { text: String(value), cls: 'bool' }];
  if (typeof value === 'number') return [...prefix, { text: String(value), cls: 'num' }];
  if (typeof value === 'string') return [...prefix, { text: JSON.stringify(value), cls: 'str' }];

  if (Array.isArray(value)) {
    if (!value.length) return [...prefix, { text: '[]', cls: 'p' }];
    const out: Token[] = [...prefix, { text: '[\n', cls: 'p' }];
    value.forEach((item, i) => {
      out.push({ text: '  '.repeat(indent + 1), cls: 'p' });
      out.push(...tokenize(item, indent + 1));
      out.push({ text: i < value.length - 1 ? ',\n' : '\n', cls: 'p' });
    });
    out.push({ text: `${pad}]`, cls: 'p' });
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return [...prefix, { text: '{}', cls: 'p' }];
  const out: Token[] = [...prefix, { text: '{\n', cls: 'p' }];
  entries.forEach(([k, v], i) => {
    out.push(...tokenize(v, indent + 1, k));
    out.push({ text: i < entries.length - 1 ? ',\n' : '\n', cls: 'p' });
  });
  out.push({ text: `${pad}}`, cls: 'p' });
  return out;
}

export default function JsonView({ value }: { value: unknown }): React.JSX.Element {
  const tokens = useMemo(() => {
    try {
      return tokenize(value);
    } catch {
      return [{ text: String(value), cls: 'p' }];
    }
  }, [value]);
  return (
    <CodeBlock maxHeight={420} className={styles.json}>
      {tokens.map((t, i) => (
        <span key={i} className={styles[t.cls]}>
          {t.text}
        </span>
      ))}
    </CodeBlock>
  );
}
