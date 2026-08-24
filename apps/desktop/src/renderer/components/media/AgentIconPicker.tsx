import { useMemo, useRef, useState } from 'react';
import { Check, Upload, X } from 'lucide-react';
import { api } from '../../api.js';
import {
  EMBLEM_BY_ID,
  EMBLEM_GROUPS,
  EMBLEMS,
  IMAGE_EMBLEM_PREFIX,
  markLabel,
  resolveAgentMark,
  suggestedEmblemIds,
  type EmblemDef,
} from '../../data/emblems.js';
import AgentAvatar from './AgentAvatar.js';
import { Emblem } from './Emblem.js';
import { ModalShell } from '../ui/ModalShell.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import styles from './AgentIconPicker.module.css';

const COLORS = ['#4fa8b8', '#9b7ede', '#d19a3d', '#3cb87a', '#e0605f', '#5b8fd9'];

type PickerTab = 'emblems' | 'upload';

export default function AgentIconPicker({
  name,
  emblem,
  color,
  onChange,
  onColorChange,
  onClose,
}: {
  name: string;
  emblem?: string;
  color: string;
  builtin?: boolean;
  onChange: (emblem: string | undefined) => void;
  onColorChange?: (color: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const mark = resolveAgentMark(emblem);
  const [tab, setTab] = useState<PickerTab>(mark.kind === 'image' ? 'upload' : 'emblems');
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);

  const suggested = useMemo(() => suggestedEmblemIds(name), [name]);
  const grouped = useMemo(
    () =>
      EMBLEM_GROUPS.map((group) => ({
        group,
        items: EMBLEMS.filter((e) => e.group === group),
      })),
    [],
  );

  const setEmblem = (next: string | undefined): void => {
    if (emblem && emblem !== next && emblem.startsWith(IMAGE_EMBLEM_PREFIX)) {
      void api.roster.removeMark(emblem);
    }
    onChange(next);
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file || uploading) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('That file is not an image. PNG, JPEG, WebP, GIF, or SVG.');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await api.roster.uploadMark(btoa(binary), file.type);
      if (!result.ok || !result.emblem) {
        setUploadError(result.error ?? 'Could not store that image.');
        return;
      }
      setEmblem(result.emblem);
      setTab('upload');
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      className={styles.pickerModal}
      ariaLabelledBy="agent-mark-modal-title"
    >
      <div className={styles.head}>
        <AgentAvatar name={name} emblem={emblem} color={color} size={40} />
        <div className={styles.headCopy}>
          <h2 id="agent-mark-modal-title" className={styles.headTitle}>
            Mark · {name}
          </h2>
          <span className={styles.headLabel}>{markLabel(emblem)}</span>
        </div>
        <div className={styles.sizes} aria-hidden>
          {[
            { size: 24, label: 'List' },
            { size: 18, label: 'Rail' },
            { size: 14, label: 'Lane' },
          ].map((p) => (
            <div key={p.label} className={styles.size}>
              <AgentAvatar name={name} emblem={emblem} color={color} size={p.size} />
              <span>{p.label}</span>
            </div>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className={styles.closeBtn}>
          <X size={14} />
        </button>
      </div>

      <div className={styles.tabs}>
        <SegmentedControl
          options={[
            { label: 'Emblems', on: tab === 'emblems', onClick: () => setTab('emblems') },
            { label: 'Custom image', on: tab === 'upload', onClick: () => setTab('upload') },
          ]}
        />
      </div>

      {tab === 'emblems' ? (
        <div className={styles.emblems} data-testid="agent-mark-picker">
          <div className={styles.scroll}>
            <PickerRow label="Default">
              <button
                type="button"
                onClick={() => setEmblem(undefined)}
                aria-pressed={mark.kind === 'monogram'}
                title="Initial letter"
                className={`${styles.initial} ${mark.kind === 'monogram' ? styles.on : ''}`}
                data-testid="agent-mark-monogram"
              >
                <span
                  className={styles.initialDot}
                  style={{
                    borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
                    background: `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
                    color,
                  }}
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                Initial
              </button>
            </PickerRow>

            <PickerRow label={`Suggested for ${name}`}>
              <EmblemGrid
                items={suggested
                  .map((id) => EMBLEM_BY_ID[id])
                  .filter((e): e is EmblemDef => Boolean(e))}
                selectedId={mark.kind === 'emblem' ? mark.emblemId : undefined}
                color={color}
                onPick={setEmblem}
              />
            </PickerRow>

            {grouped.map((g) => (
              <PickerRow key={g.group} label={g.group}>
                <EmblemGrid
                  items={g.items}
                  selectedId={mark.kind === 'emblem' ? mark.emblemId : undefined}
                  color={color}
                  onPick={setEmblem}
                />
              </PickerRow>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.upload} data-testid="agent-mark-picker">
          {mark.kind === 'image' ? (
            <div className={styles.currentImage}>
              <AgentAvatar name={name} emblem={emblem} color={color} size={44} />
              <div className={styles.currentCopy}>
                <p>Custom image</p>
                <p className={styles.currentPath}>
                  {emblem?.startsWith(IMAGE_EMBLEM_PREFIX)
                    ? `agent-marks/${emblem.slice(IMAGE_EMBLEM_PREFIX.length)}`
                    : 'stored with the project'}
                </p>
              </div>
              <button
                type="button"
                className={styles.textBtn}
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                Replace
              </button>
              <button
                type="button"
                className={`${styles.textBtn} ${styles.danger}`}
                onClick={() => setEmblem(undefined)}
                disabled={uploading}
              >
                Remove
              </button>
            </div>
          ) : (
            <div
              className={`${styles.drop} ${dragging ? styles.dragging : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void readFile(e.dataTransfer.files[0]);
              }}
            >
              <Upload size={18} aria-hidden />
              <p>Drop an image, or</p>
              <button
                type="button"
                className={styles.choose}
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-testid="agent-mark-upload"
              >
                {uploading ? 'Storing…' : 'Choose file'}
              </button>
              <p className={styles.dropHint}>
                PNG, JPEG, WebP, GIF, or SVG. Cropped to a circle and stored with the app.
              </p>
            </div>
          )}
          {uploadError && <p className={styles.error}>{uploadError}</p>}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className={styles.file}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void readFile(file);
            }}
          />
        </div>
      )}

      {onColorChange && (
        <div className={styles.accentRow}>
          <span className={styles.accentLabel}>Accent</span>
          <div className={styles.accentSwatches}>
            {COLORS.map((c) => {
              const on = c.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={`Accent ${c}`}
                  aria-pressed={on}
                  onClick={() => onColorChange(c)}
                  className={styles.accentSwatch}
                  style={{
                    borderColor: on ? c : 'var(--line)',
                    background: `color-mix(in srgb, ${c} ${on ? 30 : 16}%, var(--bg-panel))`,
                  }}
                >
                  {on ? (
                    <Check size={12} style={{ color: c }} />
                  ) : (
                    <span className={styles.accentDot} style={{ background: c }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.footerAutosave}>Saved automatically</span>
        <button type="button" onClick={onClose} className={styles.doneBtn}>
          Done
        </button>
      </div>
    </ModalShell>
  );
}

function PickerRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.row}>
      <p className={styles.rowLabel}>{label}</p>
      {children}
    </div>
  );
}

function EmblemGrid({
  items,
  selectedId,
  color,
  onPick,
}: {
  items: EmblemDef[];
  selectedId?: string;
  color: string;
  onPick: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.grid}>
      {items.map((e) => {
        const on = e.id === selectedId;
        return (
          <button
            key={e.id}
            type="button"
            title={e.name}
            aria-label={e.name}
            aria-pressed={on}
            onClick={() => onPick(e.id)}
            className={`${styles.cell} ${on ? styles.on : ''}`}
            style={on ? { borderColor: color, color } : undefined}
            data-testid={`agent-mark-emblem-${e.id}`}
          >
            <Emblem emblem={e} size={18} />
          </button>
        );
      })}
    </div>
  );
}
