import { useEffect, useMemo, useState } from 'react';
import type { CliVendor, ToolInfo, ToolProfile } from '@shared/types.js';
import { api } from '../api.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import styles from './ToolProfilePicker.module.css';

/** What each profile means, in the operator's terms rather than the wire's. */
const BLURBS: Record<ToolProfile, string> = {
  full: 'Every tool the model would have had. The default.',
  'read-only': 'Reading only — no edits, no commands.',
  review: 'Reading plus running commands, so it can execute the tests it judges.',
  custom: 'Exactly the tools you pick, and nothing else.',
};

const ORDER: ToolProfile[] = ['full', 'read-only', 'review', 'custom'];

/** Category labels, matching what the CLI reports for each tool. */
const CATEGORY_LABELS: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  execute: 'Execute',
  other: 'Other',
};

/**
 * An agent's system tool surface: one of three narrowed profiles, or an explicit
 * allowlist.
 *
 * The narrowed profiles are deliberately not shown as lists of tool names. They
 * are evaluated against the tool list the live session reports, so what they
 * cover grows with the CLI and with whatever MCP servers are attached — a list
 * here would be a promise this UI cannot keep. `custom` is the escape hatch when
 * an operator does want to name ids, and its picker is fed by discovery rather
 * than by a hardcoded catalogue.
 */
export default function ToolProfilePicker({
  vendor,
  model,
  profile,
  tools,
  onChange,
}: {
  vendor: CliVendor;
  model: string;
  profile: ToolProfile | undefined;
  tools: string[] | undefined;
  onChange: (next: { toolProfile?: ToolProfile; tools?: string[] }) => void;
}): React.JSX.Element {
  const [discovered, setDiscovered] = useState<ToolInfo[] | null>(null);
  // A roster with an allowlist but no profile predates profiles and means custom.
  const effective: ToolProfile = profile ?? (tools?.length ? 'custom' : 'full');
  const chosen = useMemo(() => new Set(tools ?? []), [tools]);

  useEffect(() => {
    if (effective !== 'custom') return;
    let cancelled = false;
    void api.catalog
      .tools(vendor, model)
      .then((next) => {
        if (!cancelled) setDiscovered(next);
      })
      .catch(() => {
        if (!cancelled) setDiscovered([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effective, vendor, model]);

  const byCategory = useMemo(() => {
    const groups = new Map<string, ToolInfo[]>();
    for (const tool of discovered ?? []) {
      const key = (tool.category || 'other').toLowerCase();
      const list = groups.get(key) ?? [];
      list.push(tool);
      groups.set(key, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.id.localeCompare(b.id));
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [discovered]);

  const toggle = (id: string, on: boolean): void => {
    const next = on ? [...chosen, id] : [...chosen].filter((entry) => entry !== id);
    onChange({ toolProfile: 'custom', tools: next });
  };

  return (
    <div className={styles.picker}>
      <SegmentedControl
        options={ORDER.map((option) => ({
          label: option,
          on: effective === option,
          onClick: () =>
            onChange({
              toolProfile: option,
              // Leaving the allowlist in place would silently re-narrow the
              // agent if it were ever switched back to custom by accident.
              tools: option === 'custom' ? (tools ?? []) : undefined,
            }),
        }))}
      />
      <p className={styles.blurb}>{BLURBS[effective]}</p>

      {effective === 'custom' && (
        <div className={styles.custom}>
          {discovered === null ? (
            <p className={styles.note}>Reading the tool list…</p>
          ) : discovered.length === 0 ? (
            // Only a live session can enumerate tools, so a fresh install has
            // nothing to offer yet. Saying so is better than an empty box.
            <p className={styles.note}>
              No tools discovered yet. The CLI reports its tool list from a live session, so this
              fills in after the first run. Ids typed into a roster file still apply.
            </p>
          ) : (
            byCategory.map(([category, entries]) => (
              <div key={category} className={styles.group}>
                <p className={styles.groupTitle}>{CATEGORY_LABELS[category] ?? category}</p>
                {entries.map((tool) => (
                  <label key={tool.id} className={styles.row}>
                    <input
                      type="checkbox"
                      checked={chosen.has(tool.id)}
                      onChange={(e) => toggle(tool.id, e.target.checked)}
                    />
                    <span className={styles.rowLabel}>{tool.displayName || tool.id}</span>
                    <span className={styles.rowId}>{tool.id}</span>
                  </label>
                ))}
              </div>
            ))
          )}
          {chosen.size > 0 && (
            <p className={styles.note}>
              {chosen.size} tool{chosen.size === 1 ? '' : 's'} allowed. Foundry&apos;s own progress
              tools stay available regardless.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
