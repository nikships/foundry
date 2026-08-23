/** Sticky nav, hero, closing CTA and footer. */

import { RUN } from '../../data/foundry';
import {
  DOWNLOAD_URL as RELEASES,
  REPO_URL as REPO,
  ISSUES_URL,
  AGENTS_MD_URL,
  NAV_LINKS,
  HERO_STATS,
  HERO_SPEC,
} from '../../data/site';
import { useInView, useScrolled } from '../../hooks';
import { Button, Eyebrow, LoopVideo } from '../ui';

export function Nav() {
  const scrolled = useScrolled();
  return (
    <header
      className={`sticky top-0 z-[60] border-b bg-[rgba(2,2,2,0.82)] backdrop-blur-md transition-colors duration-normal ease-mech ${
        scrolled ? 'border-line' : 'border-transparent'
      }`}
    >
      <div className="wrap flex h-[60px] items-center gap-7">
        <a
          href="#top"
          className="flex items-center gap-[10px] font-mono text-[12px] font-semibold uppercase tracking-[0.18em]"
        >
          <img src="/media/app-icon.webp" alt="" width={22} height={22} className="rounded-sm" />
          Foundry
        </a>
        <nav className="ml-auto hidden gap-1 xl:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className="rounded-sm px-[11px] py-[7px] font-mono text-[11px] uppercase tracking-label text-text-dim transition-colors duration-fast ease-mech hover:bg-bg-hover hover:text-text"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto xl:ml-0">
          <Button href={RELEASES} variant="primary">
            Download
          </Button>
        </div>
      </div>
    </header>
  );
}

export function Hero() {
  const [ref, inView] = useInView<HTMLElement>(0.05);

  return (
    <section
      ref={ref}
      id="top"
      className="relative flex min-h-[min(92vh,880px)] items-center overflow-hidden"
    >
      <div className="absolute inset-0 z-0">
        <LoopVideo
          src="/media/loop/foundry-intake-chamber.mp4"
          poster="/media/loop/foundry-intake-chamber.webp"
          play={inView}
          className="h-full w-full object-cover [object-position:72%_center]"
        />
        {/* the art is composed with a quiet left third — keep it that way */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg,#020202 0%,rgba(2,2,2,0.94) 26%,rgba(2,2,2,0.35) 58%,rgba(2,2,2,0.5) 100%),linear-gradient(0deg,#020202 0%,transparent 30%,transparent 76%,rgba(2,2,2,0.7) 100%)',
          }}
        />
      </div>

      <div className="wrap relative z-[1] pb-[260px] pt-28 md:pb-[210px]">
        <div className="max-w-[46rem]">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-px w-[22px] bg-accent" />
            <span className="font-mono text-[11px] uppercase tracking-eyebrow text-text-dim">
              Your SDLC · your models · your rules
            </span>
          </div>

          <h1 className="mt-7 max-w-[18ch] text-[clamp(40px,6.2vw,64px)] font-semibold leading-[1.04] tracking-tighter">
            The software factory you configure,{' '}
            <span className="text-accent">not the one you&rsquo;re handed.</span>
          </h1>

          <p className="mt-7 max-w-[50ch] text-[17px] leading-[1.65] text-text-dim">
            A native macOS app that runs your delivery lifecycle as data — phases, checks,
            boundaries, human checkpoints — with a different model on every seat, mixed freely
            across providers, in an isolated git worktree that ends in a pull request.{' '}
            <strong className="font-medium text-text">Agent proposes. Code disposes.</strong>
          </p>

          <div className="mt-9 flex flex-wrap gap-3">
            <Button href={RELEASES} variant="primary">
              Download for Mac
            </Button>
            <Button href={REPO}>Read the source</Button>
          </div>

          <p className="mt-7 font-mono text-[11px] uppercase tracking-label text-text-ghost">
            {HERO_SPEC}
          </p>
        </div>
      </div>

      <dl className="absolute inset-x-0 bottom-0 z-[2] border-t border-line bg-[rgba(2,2,2,0.72)] backdrop-blur-sm">
        <div className="mx-auto grid w-full max-w-wrap grid-cols-2 md:grid-cols-4">
          {HERO_STATS.map((s, i) => (
            <div
              key={s.label}
              className={`px-6 py-5 md:px-8 ${i > 0 ? 'md:border-l md:border-line' : ''} ${
                i % 2 === 1 ? 'border-l border-line' : ''
              } ${i >= 2 ? 'border-t border-line md:border-t-0' : ''}`}
            >
              <dt className="font-mono text-[10px] uppercase tracking-eyebrow text-text-ghost">
                {s.label}
              </dt>
              <dd className="mt-2 font-mono text-[26px] leading-none tabular-nums text-text">
                {s.value}
              </dd>
              <dd className="mt-2 max-w-[26ch] text-[11px] leading-[1.5] text-text-faint">
                {s.note}
              </dd>
            </div>
          ))}
        </div>
      </dl>
    </section>
  );
}

export function ClosingCta() {
  const [ref, inView] = useInView<HTMLElement>(0.15);
  return (
    <section ref={ref} className="relative overflow-hidden border-t border-line">
      <div className="absolute inset-0 z-0">
        <LoopVideo
          src="/media/loop/foundry-forge-workcell.mp4"
          poster="/media/loop/foundry-forge-workcell.webp"
          play={inView}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,#020202_0%,rgba(2,2,2,0.72)_45%,#020202_100%)]" />
      </div>

      <div className="wrap relative z-[1] py-[116px] text-center">
        <Eyebrow index="14">Stop prompting. Start shipping.</Eyebrow>
        <h2 className="mx-auto mt-5 max-w-[17ch] text-[clamp(34px,5.2vw,60px)] font-semibold leading-[1.04] tracking-tight">
          Run a shop, not a chat.
        </h2>
        <p className="mx-auto mt-[22px] max-w-[54ch] text-[17px] leading-[1.65] text-text-dim">
          Free and MIT-licensed. Bring the model subscriptions you already pay for, or your own API
          keys, and your own repos.
        </p>
        <div className="mt-[34px] flex flex-wrap justify-center gap-3">
          <Button href={RELEASES} variant="primary">
            Download for Mac
          </Button>
          <Button href={REPO}>Star on GitHub</Button>
        </div>
        <div className="mt-[26px] flex flex-wrap justify-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.06em] text-text-faint">
          <span>macOS 26+</span>
          <span>Apple Silicon</span>
          <span>MIT</span>
          <span>No account required</span>
          <span>No telemetry</span>
        </div>
      </div>
    </section>
  );
}

const FOOTER_LINKS: Array<[string, string]> = [
  [REPO, 'Source'],
  [RELEASES, 'Releases'],
  [ISSUES_URL, 'Issues'],
  [AGENTS_MD_URL, 'AGENTS.md'],
];

export function Footer() {
  return (
    <footer className="border-t border-line pb-14 pt-11">
      <div className="wrap">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <span className="flex items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.18em] text-text-dim">
            <img src="/media/app-icon.webp" alt="" width={20} height={20} className="rounded-sm" />
            Foundry
          </span>
          <nav className="flex flex-wrap gap-[18px]">
            {FOOTER_LINKS.map(([href, label]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] uppercase tracking-label text-text-faint transition-colors duration-fast ease-mech hover:text-accent-bright"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
        <p className="mt-2 border-t border-line-faint pt-[26px] font-mono text-[10.5px] tracking-[0.06em] text-text-ghost">
          MIT · Built for builders who ship · Agent proposes, code disposes. This page is static,
          ships no trackers, and sets no cookies. Trace shown: {RUN.branch}.
        </p>
      </div>
    </footer>
  );
}
