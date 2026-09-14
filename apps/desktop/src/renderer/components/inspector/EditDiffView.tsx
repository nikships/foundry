/**
 * GitHub-style edit/write diffs via @pierre/diffs, themed to Foundry tokens.
 * Used by Inspector transcript rows and the run-detail phase timeline.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FileDiffOptions } from '@pierre/diffs';
import type { FileContents } from '@pierre/diffs/react';
import { MultiFileDiff, PatchDiff } from '@pierre/diffs/react';
import { isAppTheme, themeAppearance } from '@shared/themes.js';
import type { EventRow } from '@shared/types.js';
import { editDiffFromEvent, type EditFileSide } from './edit-diff.js';
import styles from './EditDiffView.module.css';

const FOUNDRY_DIFF_CSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font);
    --diffs-font-size: 12px;
    --diffs-line-height: 18px;
    --diffs-bg: var(--bg-input);
    --diffs-fg: var(--text);
    --diffs-fg-number: var(--text-faint);
    --diffs-bg-context: var(--bg-raised);
    --diffs-bg-separator: var(--bg-raised);
    --diffs-addition-base: var(--green);
    --diffs-deletion-base: var(--red);
    --diffs-modified-base: var(--amber);
    --diffs-mixer: var(--bg-hover);
  }
  [data-diffs-header="default"] {
    min-height: 28px;
    padding-inline: 10px;
    font-size: 11px;
    border-bottom: 1px solid var(--line);
  }
`;

const OPTIONS: FileDiffOptions<undefined> = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  diffStyle: 'unified',
  diffIndicators: 'classic',
  overflow: 'wrap',
  hunkSeparators: 'line-info-basic',
  lineDiffType: 'word-alt',
  unsafeCSS: FOUNDRY_DIFF_CSS,
};

function readThemeType(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  const id = document.documentElement.getAttribute('data-theme');
  return id && isAppTheme(id) ? themeAppearance(id) : 'dark';
}

/** Follows the document theme so this can render outside AppProvider (tests). */
function useDocumentThemeType(): 'dark' | 'light' {
  const [type, setType] = useState(readThemeType);
  useEffect(() => {
    const root = document.documentElement;
    const apply = (): void => setType(readThemeType());
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return type;
}

function toFile(side: EditFileSide): FileContents {
  return { name: side.name, contents: side.contents };
}

function EmptyDiff(): React.JSX.Element {
  return <div className={styles.empty}>No changes</div>;
}

function PairDiff({
  oldFile,
  newFile,
  themeType,
}: {
  oldFile: FileContents | null;
  newFile: FileContents | null;
  themeType: 'dark' | 'light';
}): React.JSX.Element {
  const options = useMemo(() => ({ ...OPTIONS, themeType }), [themeType]);
  // @pierre/diffs MultiFileDiff crashes when either side is null (reads .name
  // off the missing FileContents). An empty opposite side still yields a pure
  // addition/deletion hunk for create and delete writes.
  if (oldFile && newFile) {
    return <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />;
  }
  if (newFile && !oldFile) {
    return (
      <MultiFileDiff
        oldFile={{ name: newFile.name, contents: '' }}
        newFile={newFile}
        options={options}
      />
    );
  }
  if (oldFile && !newFile) {
    return (
      <MultiFileDiff
        oldFile={oldFile}
        newFile={{ name: oldFile.name, contents: '' }}
        options={options}
      />
    );
  }
  return <EmptyDiff />;
}

export default function EditDiffView({ event }: { event: EventRow }): React.JSX.Element {
  const themeType = useDocumentThemeType();
  const model = useMemo(() => editDiffFromEvent(event), [event]);
  const options = useMemo(() => ({ ...OPTIONS, themeType }), [themeType]);

  if (model.kind === 'empty') return <EmptyDiff />;

  if (model.kind === 'patch') {
    return (
      <div className={styles.wrap} data-testid="edit-diff">
        <PatchDiff patch={model.patch} options={options} />
      </div>
    );
  }

  if (model.kind === 'pairs') {
    return (
      <div className={styles.wrap} data-testid="edit-diff">
        {model.pairs.map((pair, index) => (
          <PairDiff
            key={index}
            oldFile={toFile(pair.oldFile)}
            newFile={toFile(pair.newFile)}
            themeType={themeType}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-testid="edit-diff">
      <PairDiff
        oldFile={model.oldFile ? toFile(model.oldFile) : null}
        newFile={model.newFile ? toFile(model.newFile) : null}
        themeType={themeType}
      />
    </div>
  );
}
