/**
 * Three picker galleries: the concept-art loops, the desktop screenshots, and
 * the phone. Each is a hairline list on the left driving a single stage on the
 * right. Only the selected art loop decodes; the rest stay on their poster.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ART, APP_SHOTS, PHONE_SHOTS } from '../../data/foundry';
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
    <div
      ref={ref}
      className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
    >
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

/* ── desktop screenshots ─────────────────────────────────────────────────── */

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

      <div className="relative overflow-hidden rounded border border-line bg-[#020202] [aspect-ratio:1440/940]">
        {APP_SHOTS.map((s, i) => (
          <img
            key={s.file}
            src={`/media/ui/${s.file}.webp`}
            alt={`Foundry — ${s.name}`}
            width={1440}
            height={940}
            loading={i === 0 ? 'eager' : 'lazy'}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-slow ease-mech ${
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

/* ── the phone ─────────────────────────────────────────────────────────────
 * Pixel 10 Pro XL front: 162.8 × 76.6 mm body, 6.8" 20:9 (1344 × 2992),
 * even ~2.7 mm bezels, centred punch-hole. Shots are adb screencaps from a
 * Pixel_10_Pro_XL AVD (hw.lcd 1344×2992 @ 480 dpi), not a 1080×1000 crop.
 */

export function PhoneGallery() {
  const [selected, setSelected] = useState(0);

  return (
    <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-[minmax(0,22rem)_auto] md:justify-center md:gap-14">
      <div className="flex flex-col overflow-hidden rounded border border-line">
        {PHONE_SHOTS.map((s, i) => (
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

      <div className="mx-auto w-full max-w-[348px] md:sticky md:top-[84px]">
        <Pixel10ProXL>
          {PHONE_SHOTS.map((s, i) => (
            <img
              key={s.file}
              src={`/media/phone/${s.file}.webp`}
              alt={`Foundry companion — ${s.name}`}
              width={672}
              height={1496}
              loading={i === 0 ? 'eager' : 'lazy'}
              className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-slow ease-mech ${
                i === selected ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ))}
        </Pixel10ProXL>
        <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-label text-text-ghost">
          Pixel 10 Pro XL · paired over your LAN
        </p>
      </div>
    </div>
  );
}

function Pixel10ProXL({ children }: { children: ReactNode }) {
  return (
    <div className="relative px-[5px]">
      <span
        aria-hidden="true"
        className="absolute right-0 top-[21%] z-[2] h-[11%] w-[3px] rounded-r-[2px]"
        style={{ background: 'linear-gradient(90deg, #6a6a6a, #2c2c2c)' }}
      />
      <span
        aria-hidden="true"
        className="absolute right-0 top-[34.5%] z-[2] h-[6%] w-[3px] rounded-r-[2px]"
        style={{ background: 'linear-gradient(90deg, #6a6a6a, #2c2c2c)' }}
      />
      <span
        aria-hidden="true"
        className="absolute left-px top-[17%] z-[2] h-[8%] w-[2px] rounded-l-[1px] bg-[#2a2a2a]"
      />

      <figure
        aria-label="Pixel 10 Pro XL"
        className="relative"
        style={{
          aspectRatio: '76.6 / 162.8',
          borderRadius: '14.6% / 6.87%',
          background:
            'linear-gradient(160deg, #4a4a4a 0%, #2a2a2a 22%, #1a1a1a 52%, #242424 86%, #3a3a3a 100%)',
          boxShadow:
            '0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(0,0,0,0.55)',
        }}
      >
        <span aria-hidden="true" className="absolute left-0 top-[13%] h-px w-[3.7%] bg-black/55" />
        <span aria-hidden="true" className="absolute right-0 top-[13%] h-px w-[3.7%] bg-black/55" />
        <span aria-hidden="true" className="absolute bottom-[13%] left-0 h-px w-[3.7%] bg-black/55" />
        <span aria-hidden="true" className="absolute bottom-[13%] right-0 h-px w-[3.7%] bg-black/55" />

        <span
          aria-hidden="true"
          className="absolute left-1/2 top-[0.6%] z-[3] h-[0.35%] w-[12%] -translate-x-1/2 rounded-full bg-[#111]"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-[0.55%] left-1/2 z-[3] h-[0.7%] w-[4.4%] -translate-x-1/2 rounded-full bg-black"
        />

        <div
          className="absolute overflow-hidden bg-black"
          style={{ inset: '1.63% 3.72%', borderRadius: '11.2% / 5.3%' }}
        >
          <div className="absolute inset-0">{children}</div>
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-[1.15%] z-[3] aspect-square w-[5.2%] -translate-x-1/2 rounded-full"
            style={{
              background: 'radial-gradient(circle at 38% 32%, #2c3548 0%, #0b0d12 58%, #000 100%)',
              boxShadow: '0 0 0 1.5px #070707, 0 0 0 2.5px #1a1a1a',
            }}
          />
        </div>
      </figure>
    </div>
  );
}
