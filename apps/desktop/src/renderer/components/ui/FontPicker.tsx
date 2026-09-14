/**
 * Installed-font pickers for Settings → Appearance. Two dropdown rows —
 * interface and monospace — backed by the main-side `fonts:list` enumeration.
 * The picker never blocks Appearance: loading, error, and missing-font states
 * all degrade to the shipped defaults with a hint.
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_INTERFACE_FONT, DEFAULT_MONO_FONT } from '@shared/types.js';
import { api } from '../../api.js';
import { Field } from './Field.js';
import { Dropdown } from './Dropdown.js';
import { Button } from './Button.js';
import styles from './FontPicker.module.css';

export interface FontPickerProps {
  interfaceFont: string | null;
  monoFont: string | null;
  onChange: (patch: { interfaceFont?: string | null; monoFont?: string | null }) => void;
}

async function loadFamilies(): Promise<{ families: string[]; failed: boolean }> {
  try {
    const list = await api.fonts?.list?.();
    if (!Array.isArray(list)) return { families: [], failed: true };
    return {
      families: list.filter((name): name is string => typeof name === 'string'),
      failed: false,
    };
  } catch {
    return { families: [], failed: true };
  }
}

function Row({
  label,
  testId,
  resetTestId,
  value,
  families,
  defaultLabel,
  failed,
  loading,
  onPick,
  onReset,
}: {
  label: string;
  testId: string;
  resetTestId: string;
  value: string | null;
  families: string[];
  defaultLabel: string;
  failed: boolean;
  loading: boolean;
  onPick: (family: string | null) => void;
  onReset: () => void;
}): React.JSX.Element {
  const missing = value != null && value !== '' && !families.includes(value);
  // A stored choice that is no longer installed selects Default (safe CSS
  // fallback) while naming the missing face in the hint, so reinstalling the
  // font restores it silently on the next load.
  const selected = missing || value == null ? '' : value;
  const options = useMemo(
    () => [
      { value: '', label: defaultLabel },
      ...families.map((family) => ({ value: family, label: family })),
    ],
    [families, defaultLabel],
  );
  const hint = loading
    ? 'Looking for installed fonts…'
    : failed && families.length === 0
      ? 'Could not list installed fonts — showing defaults.'
      : missing
        ? `“${value}” isn’t installed — using default.`
        : undefined;
  return (
    <div className={styles.row}>
      <div className={styles.field}>
        <Field label={label} hint={hint}>
          <Dropdown
            value={selected}
            options={options}
            menuWidth="compact"
            data-testid={testId}
            aria-label={label}
            onChange={(next) => onPick(next === '' ? null : next)}
          />
        </Field>
      </div>
      <Button
        type="button"
        size="sm"
        data-testid={resetTestId}
        disabled={value == null}
        aria-label={`Reset ${label.toLowerCase()} to default`}
        onClick={onReset}
      >
        Reset
      </Button>
    </div>
  );
}

export function FontPicker({
  interfaceFont,
  monoFont,
  onChange,
}: FontPickerProps): React.JSX.Element {
  const [families, setFamilies] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadFamilies().then(({ families: next, failed: didFail }) => {
      if (cancelled) return;
      setFamilies(next);
      setFailed(didFail);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.root} data-testid="settings-fonts">
      <Row
        label="Interface font"
        testId="settings-font-ui"
        resetTestId="settings-font-ui-reset"
        value={interfaceFont}
        families={families}
        defaultLabel={`Default (${DEFAULT_INTERFACE_FONT})`}
        failed={failed}
        loading={loading}
        onPick={(family) => onChange({ interfaceFont: family })}
        onReset={() => onChange({ interfaceFont: null })}
      />
      <Row
        label="Monospace font"
        testId="settings-font-mono"
        resetTestId="settings-font-mono-reset"
        value={monoFont}
        families={families}
        defaultLabel={`Default (${DEFAULT_MONO_FONT})`}
        failed={failed}
        loading={loading}
        onPick={(family) => onChange({ monoFont: family })}
        onReset={() => onChange({ monoFont: null })}
      />
    </div>
  );
}
