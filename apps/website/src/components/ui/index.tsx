/**
 * Shared page primitives. These are the marketing-page equivalents of the
 * Factory design system's Button / Badge / Eyebrow / Card, kept thin and local
 * so the site has no dependency on the app's CSS modules.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { useInView } from '../../hooks';

/* ── eyebrow: orange index + tracked uppercase label ─────────────────────── */

export function Eyebrow({ index, children }: { index: string; children: ReactNode }) {
  return (
    <span className="eyebrow">
      <span className="index">{index}</span>
      {children}
    </span>
  );
}

/* ── buttons ─────────────────────────────────────────────────────────────── */

interface ButtonProps {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'default' | 'ghost';
  className?: string;
}

const BTN_BASE =
  'inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-sm border px-[18px] font-mono text-[11px] uppercase tracking-label transition-colors duration-fast ease-mech';

export function Button({ href, children, variant = 'default', className = '' }: ButtonProps) {
  const tone =
    variant === 'primary'
      ? 'border-text bg-text font-semibold text-[#020202] hover:border-white hover:bg-white'
      : variant === 'ghost'
        ? 'border-transparent bg-transparent text-text-dim hover:text-accent-bright'
        : 'border-line-strong bg-bg-raised text-text hover:border-accent/65 hover:text-accent-bright';
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      className={`${BTN_BASE} ${tone} ${className}`}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

/* ── badge / chip / dot ──────────────────────────────────────────────────── */

export function Badge({
  children,
  color,
  className = '',
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-sm border border-line px-[7px] font-mono text-[10px] font-semibold uppercase tracking-label ${className}`}
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}

export function Chip({
  children,
  color,
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex h-[17px] items-center gap-1 whitespace-nowrap rounded-[2px] border border-line px-[6px] font-mono text-[9.5px] text-text-faint"
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-[5px] w-[5px] flex-none rounded-full ${pulse ? 'animate-pulse-soft' : ''}`}
      style={{ background: color }}
    />
  );
}

/* ── section scaffolding ─────────────────────────────────────────────────── */

export function Section({
  id,
  children,
  className = '',
  tight = false,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  tight?: boolean;
}) {
  return (
    <section
      id={id}
      className={`relative border-t border-line-faint ${tight ? 'py-[76px]' : 'py-[92px] md:py-[108px]'} ${className}`}
    >
      {children}
    </section>
  );
}

/** Headline left, lede right — the editorial two-column section head. */
export function SectionHead({
  index,
  eyebrow,
  title,
  lede,
}: {
  index: string;
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
}) {
  return (
    <Reveal className="mb-[52px] grid items-end gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] md:gap-14">
      <div>
        <Eyebrow index={index}>{eyebrow}</Eyebrow>
        <h2 className="mt-[18px] max-w-[20ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
          {title}
        </h2>
      </div>
      <p className="max-w-[62ch] pb-1 text-[17px] leading-[1.65] text-text-dim">{lede}</p>
    </Reveal>
  );
}

/* ── scroll reveal ───────────────────────────────────────────────────────── */

export function Reveal({
  children,
  className = '',
  delay = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: 'div' | 'li' | 'figure';
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.08, true);
  return (
    <Tag
      ref={ref as never}
      className={`transition-[opacity,transform] duration-[620ms] ease-mech ${
        inView ? 'translate-y-0 opacity-100' : 'translate-y-[14px] opacity-0'
      } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

/* ── a faux macOS window that hosts the interactive demos ────────────────── */

export function WindowFrame({
  title,
  right,
  hint,
  children,
}: {
  title: string;
  right?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-strong bg-bg-void">
      <div className="flex h-10 items-center gap-3 border-b border-line bg-bg-base px-3">
        <span className="flex gap-[7px]" aria-hidden="true">
          <i className="h-[10px] w-[10px] rounded-full bg-[#3b2320]" />
          <i className="h-[10px] w-[10px] rounded-full bg-[#3a3222]" />
          <i className="h-[10px] w-[10px] rounded-full bg-[#22301f]" />
        </span>
        <span className="mx-auto truncate font-mono text-[10.5px] uppercase tracking-eyebrow text-text-faint">
          {title}
        </span>
        <span className="flex items-center gap-[10px] font-mono text-[10px] uppercase tracking-label text-text-faint">
          {right}
        </span>
      </div>
      {children}
      {hint ? (
        <div className="flex items-center gap-2 border-t border-line bg-bg-base px-[14px] py-[10px] font-mono text-[10px] uppercase tracking-label text-text-ghost">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/* ── a looping art panel that only plays while it is on screen ───────────── */

export function ArtPanel({
  src,
  poster,
  caption,
  className = '',
  style,
}: {
  src: string;
  poster: string;
  caption?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [ref, inView] = useInView<HTMLElement>(0.15);

  return (
    <figure
      ref={ref}
      className={`relative overflow-hidden rounded border border-line bg-[#020202] ${className}`}
      style={style}
    >
      <LoopVideo src={src} poster={poster} play={inView} />
      {caption ? (
        <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgba(2,2,2,0.92)] to-transparent px-4 py-[14px] font-mono text-[10px] uppercase tracking-label text-text-faint">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A muted, looping, inline video that decodes only while `play` is true.
 * Six of these on one page will fight for the decoder otherwise.
 */
export function LoopVideo({
  src,
  poster,
  play,
  className = '',
}: {
  src: string;
  poster: string;
  play: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (play) {
      // Autoplay can still be refused; a paused poster is an acceptable result.
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [play]);

  return (
    <video
      ref={ref}
      className={`w-full ${className}`}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}

/**
 * The one video on the page with sound. It stays behind its poster until the
 * visitor asks for it — `preload="none"` so a 7 MB film is never on the
 * critical path, and native controls once it is running.
 */
export function FilmPlayer({
  src,
  poster,
  label,
  runtime,
  className = '',
}: {
  src: string;
  poster: string;
  label: string;
  runtime: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  function start() {
    const v = ref.current;
    if (!v) return;
    setStarted(true);
    void v.play().catch(() => undefined);
  }

  return (
    <div
      className={`relative overflow-hidden rounded border border-line bg-[#020202] [aspect-ratio:16/9] ${className}`}
    >
      <video
        ref={ref}
        className="h-full w-full"
        poster={poster}
        controls={started}
        playsInline
        preload="none"
        onPlay={() => setStarted(true)}
      >
        <source src={src} type="video/mp4" />
      </video>

      {started ? null : (
        <button
          type="button"
          onClick={start}
          aria-label={`Play ${label}`}
          className="group absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[linear-gradient(180deg,rgba(2,2,2,0.28)_0%,rgba(2,2,2,0.62)_100%)] transition-colors duration-fast ease-mech hover:bg-[rgba(2,2,2,0.32)]"
        >
          <span className="flex h-[62px] w-[62px] items-center justify-center rounded-full border border-line-strong bg-[rgba(2,2,2,0.72)] backdrop-blur-sm transition-colors duration-fast ease-mech group-hover:border-accent group-hover:bg-[rgba(2,2,2,0.88)]">
            <span
              aria-hidden="true"
              className="ml-[4px] h-0 w-0 border-y-[11px] border-l-[18px] border-y-transparent border-l-text transition-colors duration-fast ease-mech group-hover:border-l-accent-bright"
            />
          </span>
          <span className="flex items-center gap-[10px] font-mono text-[10.5px] uppercase tracking-label text-text-faint">
            <span className="text-text">{label}</span>
            <span aria-hidden="true" className="h-px w-[14px] bg-line-strong" />
            <span>{runtime}</span>
            <span aria-hidden="true" className="h-px w-[14px] bg-line-strong" />
            <span>sound on</span>
          </span>
        </button>
      )}
    </div>
  );
}
