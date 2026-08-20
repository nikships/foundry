/**
 * Two picker galleries: the concept-art loops, and the app screenshots.
 * Both are a hairline list on the left driving a single stage on the right.
 * Only the selected art loop decodes; the rest stay on their poster frame.
 */

import { useState } from 'react';
import { ART, APP_SHOTS } from '../../data/foundry';
import { useInView } from '../../hooks';
import { LoopVideo } from '../ui';

interface PickerItemProps {
  index: number;
  name: string;
  desc: string;
  selected: boolean;
  onSelect: () => void;
}

function PickerItem({ index, name, desc, selected, onSelect }: PickerItemProps) {
  return (
    <button
      type="button"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={onSelect}
      onFocus={onSelect}
      className={`border-t border-line-faint border-l-2 px-4 py-[15px] text-left transition-colors duration-fast ease-mech first:border-t-0 ${
        selected ? 'border-l-accent bg-bg-raised' : 'border-l-transparent hover:bg-bg-hover'
      }`}
    >
      <span className="flex items-baseline gap-[9px]">
        <span className="font-mono text-[9.5px] tracking-[0.12em] text-accent">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="text-[14.5px] font-medium text-text">{name}</span>
      </span>
      <span className="mt-[5px] block text-[13px] leading-[1.5] text-text-dim">{desc}</span>
    </button>
  );
}

/* ── concept art ─────────────────────────────────────────────────────────── */

export function ArtGallery() {
  const [selected, setSelected] = useState(0);
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const current = ART[selected];

  return (
    <div ref={ref} className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="flex flex-col overflow-hidden rounded border border-line">
        {ART.map((a, i) => (
          <PickerItem
            key={a.file}
            index={i}
            name={a.name}
            desc={a.desc}
            selected={i === selected}
            onSelect={() => setSelected(i)}
          />
        ))}
      </div>

      <div className="relative aspect-video overflow-hidden rounded border border-line bg-[#020202]">
        {ART.map((a, i) => (
          <div
            key={a.file}
            className={`absolute inset-0 transition-opacity duration-slow ease-mech ${
              i === selected ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <LoopVideo
              src={`/media/loop/${a.file}.mp4`}
              poster={`/media/loop/${a.file}.webp`}
              play={inView && i === selected}
              className="h-full w-full object-cover"
            />
          </div>
        ))}
        <div className="absolute inset-x-0 bottom-0 z-[2] bg-gradient-to-t from-[rgba(2,2,2,0.9)] to-transparent px-[18px] py-4 font-mono text-[10px] uppercase tracking-label text-text-faint">
          {current.name} — {current.desc}
        </div>
      </div>
    </div>
  );
}

/* ── app screenshots ─────────────────────────────────────────────────────── */

export function AppGallery() {
  const [selected, setSelected] = useState(0);
  const current = APP_SHOTS[selected];

  return (
    <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="flex flex-col overflow-hidden rounded border border-line">
        {APP_SHOTS.map((s, i) => (
          <PickerItem
            key={s.file}
            index={i}
            name={s.name}
            desc={s.desc}
            selected={i === selected}
            onSelect={() => setSelected(i)}
          />
        ))}
      </div>

      <div className="relative overflow-hidden rounded border border-line bg-[#020202] [aspect-ratio:1400/923]">
        {APP_SHOTS.map((s, i) => (
          <img
            key={s.file}
            src={`/media/ui/${s.file}.webp`}
            alt={`Foundry — ${s.name}`}
            width={1400}
            height={923}
            loading={i === 0 ? 'eager' : 'lazy'}
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-slow ease-mech ${
              i === selected ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))}
        <div className="absolute inset-x-0 bottom-0 z-[2] bg-gradient-to-t from-[rgba(2,2,2,0.9)] to-transparent px-[18px] py-4 font-mono text-[10px] uppercase tracking-label text-text-faint">
          {current.name}
        </div>
      </div>
    </div>
  );
}
