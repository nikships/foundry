import { useEffect, useState } from 'react';
import type { AgentInvocables, HostInvocableInventory, UserMcpServer } from '@shared/types.js';
import { api } from '../api.js';
import { Toggle } from './ui/Toggle.js';
import styles from './InvocablePicker.module.css';

/** One switchable row, flattened so the four groups render through one path. */
interface Row {
  id: string;
  label: string;
  hint: string;
}

type GroupKey = keyof AgentInvocables;

/**
 * Per-agent opt-in to the operator's installed skills, custom Droids, and MCP
 * servers.
 *
 * The default state of this control is every switch off, and that is the point:
 * an agent inherits nothing from `~/.factory` until someone says otherwise, so a
 * pipeline costs and behaves the same on a machine with forty skills installed
 * as on a fresh one. Turning a switch on grants it to this agent for its own
 * sessions only — the host install is never edited, which is why there is no
 * "add" or "remove" affordance anywhere on this surface.
 */
export default function InvocablePicker({
  value,
  userMcpServers,
  onChange,
}: {
  value: AgentInvocables;
  /** The operator's Foundry-defined MCP servers, from settings. */
  userMcpServers: UserMcpServer[];
  onChange: (next: AgentInvocables) => void;
}): React.JSX.Element {
  const [inventory, setInventory] = useState<HostInvocableInventory | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api.catalog
      .invocables()
      .then((next) => {
        if (!cancelled) setInventory(next);
      })
      .catch((e: Error) => {
        if (!cancelled) setFailed(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (group: GroupKey, id: string, on: boolean): void => {
    // Assigned through a typed copy rather than a computed spread key: a union
    // key in an object literal widens to an index signature and stops being an
    // AgentInvocables.
    const next: AgentInvocables = { ...value };
    next[group] = on ? [...value[group], id] : value[group].filter((entry) => entry !== id);
    onChange(next);
  };

  const skills: Row[] = (inventory?.skills ?? []).map((s) => ({
    id: s.id,
    label: s.name,
    hint: s.description || s.location,
  }));
  const droids: Row[] = (inventory?.droids ?? []).map((d) => ({
    id: d.id,
    label: d.name,
    hint: d.description || d.location,
  }));
  // A server the host file itself disables is shown as unavailable rather than
  // hidden: an operator who cannot find it here would otherwise go looking for a
  // Foundry bug instead of at their own mcp.json.
  const hostMcp: Row[] = (inventory?.mcpServers ?? []).map((s) => ({
    id: s.id,
    label: s.name,
    hint: s.disabled ? `${s.transport} · disabled in mcp.json` : `${s.transport} · ${s.detail}`,
  }));
  const disabledHostMcp = new Set(
    (inventory?.mcpServers ?? []).filter((s) => s.disabled).map((s) => s.id),
  );
  const userMcp: Row[] = userMcpServers.map((s) => ({
    id: s.id,
    label: s.name,
    hint: s.disabled
      ? `${s.type} · disabled in Settings`
      : `${s.type} · ${s.type === 'stdio' ? s.command : s.url}`,
  }));
  const disabledUserMcp = new Set(userMcpServers.filter((s) => s.disabled).map((s) => s.id));

  const total = skills.length + droids.length + hostMcp.length + userMcp.length;
  const enabled =
    value.skills.length +
    value.droids.length +
    value.hostMcpServers.length +
    value.userMcpServers.length;

  return (
    <div className={styles.picker}>
      <p className={styles.summary}>
        {inventory === null && !failed
          ? 'Reading the host install…'
          : total === 0
            ? 'Nothing installed on this host to offer.'
            : `${enabled} of ${total} enabled for this agent.`}
      </p>

      {failed && (
        <p className={styles.failed}>
          The host install could not be read: {failed}. No host skills, Droids, or MCP servers are
          offered, and none will be reachable.
        </p>
      )}

      <Group
        title="Skills"
        empty="No skills in ~/.factory/skills."
        rows={skills}
        selected={value.skills}
        onToggle={(id, on) => toggle('skills', id, on)}
      />
      <Group
        title="Custom Droids"
        empty="No Droids in ~/.factory/droids."
        rows={droids}
        selected={value.droids}
        onToggle={(id, on) => toggle('droids', id, on)}
      />
      <Group
        title="Host MCP servers"
        empty="No servers in ~/.factory/mcp.json."
        rows={hostMcp}
        selected={value.hostMcpServers}
        unavailable={disabledHostMcp}
        onToggle={(id, on) => toggle('hostMcpServers', id, on)}
      />
      <Group
        title="Foundry MCP servers"
        empty="None defined in Settings → MCP."
        rows={userMcp}
        selected={value.userMcpServers}
        unavailable={disabledUserMcp}
        onToggle={(id, on) => toggle('userMcpServers', id, on)}
      />

      {inventory && inventory.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {inventory.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Group({
  title,
  empty,
  rows,
  selected,
  unavailable,
  onToggle,
}: {
  title: string;
  empty: string;
  rows: Row[];
  selected: string[];
  unavailable?: Set<string>;
  onToggle: (id: string, on: boolean) => void;
}): React.JSX.Element {
  const chosen = new Set(selected);
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>
        {title}
        <span className={styles.groupCount}>{rows.length ? `${rows.length}` : ''}</span>
      </p>
      {rows.length === 0 ? (
        <p className={styles.groupEmpty}>{empty}</p>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) =>
            unavailable?.has(row.id) ? (
              // Not switchable: enabling something its own config disables would
              // be a promise Foundry cannot keep.
              <p key={row.id} className={styles.rowOff}>
                <span className={styles.rowOffLabel}>{row.label}</span>
                <span className={styles.rowOffHint}>{row.hint}</span>
              </p>
            ) : (
              <Toggle
                key={row.id}
                checked={chosen.has(row.id)}
                onChange={(on) => onToggle(row.id, on)}
                label={row.label}
                hint={row.hint}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
