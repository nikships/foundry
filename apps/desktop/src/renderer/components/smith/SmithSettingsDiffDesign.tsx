/**
 * Read-only settings diff design body for Smith's chat:
 * displays human-labeled configuration changes grouped by section/scope with
 * visual before/after values and an Open Settings action.
 */

import type { SettingsDiffChange, SettingsDiffDef, SettingsDiffSection } from '@shared/types.js';
import { formatSettingValue, settingsDiffSummary } from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithSettingsDiffDesign.module.css';

function ChangeItemRow({
  change,
  compact,
}: {
  change: SettingsDiffChange;
  compact?: boolean;
}): React.JSX.Element {
  const prevText = formatSettingValue(change.previous);
  const nextText = formatSettingValue(change.next);

  return (
    <li className={styles.changeItem} data-testid={`settings-diff-change-${change.key}`}>
      <div className={styles.changeMeta}>
        <span className={styles.changeLabel}>{change.label}</span>
        <span className={styles.changeKey}>{change.key}</span>
      </div>
      <div className={styles.valuesRow}>
        <span className={styles.previousValue} title="Previous value">
          {prevText}
        </span>
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <span className={styles.nextValue} title="New value">
          {nextText}
        </span>
        {change.scope && !compact && <span className={styles.scopeBadge}>{change.scope}</span>}
      </div>
    </li>
  );
}

function SectionBlock({
  section,
  compact,
}: {
  section: SettingsDiffSection;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.section} data-testid={`settings-diff-section-${section.section}`}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{section.label ?? section.section}</span>
        <span className={styles.sectionId}>{section.section}</span>
      </div>
      <ul className={styles.changesList}>
        {section.changes.map((change, index) => (
          <ChangeItemRow key={`${change.key}-${index}`} change={change} compact={compact} />
        ))}
      </ul>
    </div>
  );
}

export function SettingsDiffDesign({
  diff,
  compact,
}: {
  diff: SettingsDiffDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = settingsDiffSummary(diff);

  return (
    <div
      className={cx(styles.settingsDiff, compact && styles.compact)}
      data-testid="smith-settings-diff-design"
    >
      <div className={styles.summaryBar}>
        <span className={styles.summaryText}>{summary}</span>
        {diff.scope && <span className={styles.scopeBadge}>Scope: {diff.scope}</span>}
      </div>

      <div className={styles.sections}>
        {diff.sections.map((section, index) => (
          <SectionBlock key={`${section.section}-${index}`} section={section} compact={compact} />
        ))}
      </div>

      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.openSettingsBtn}
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }),
            )
          }
          data-testid="settings-diff-open-settings"
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}
