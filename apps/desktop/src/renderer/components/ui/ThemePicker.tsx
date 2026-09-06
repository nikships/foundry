import { APP_THEMES, type AppTheme } from '@shared/themes.js';
import { cx } from './cx.js';
import styles from './ThemePicker.module.css';

const GROUPS = [...new Set(APP_THEMES.map((theme) => theme.group))];

interface ThemePickerProps {
  value: AppTheme;
  onChange: (theme: AppTheme) => void;
}

/**
 * Visual palette picker for Settings → Appearance. Each option shows the
 * candidate colors so the operator can compare without applying first.
 */
export function ThemePicker({ value, onChange }: ThemePickerProps): React.JSX.Element {
  return (
    <div
      className={styles.root}
      role="radiogroup"
      aria-label="Theme"
      data-testid="settings-theme"
      data-theme={value}
    >
      {GROUPS.map((group) => (
        <div key={group} className={styles.group}>
          <p className={styles.groupLabel}>{group}</p>
          <div className={styles.grid}>
            {APP_THEMES.filter((theme) => theme.group === group).map((theme) => {
              const selected = theme.id === value;
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={theme.label}
                  data-testid={`settings-theme-${theme.id}`}
                  className={cx(styles.card, selected && styles.on)}
                  onClick={() => onChange(theme.id)}
                >
                  <span className={styles.swatches} aria-hidden>
                    <span className={styles.swatch} style={{ background: theme.preview.base }} />
                    <span className={styles.swatch} style={{ background: theme.preview.panel }} />
                    <span className={styles.swatch} style={{ background: theme.preview.accent }} />
                    <span className={styles.swatch} style={{ background: theme.preview.text }} />
                  </span>
                  <span className={styles.name}>{theme.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
