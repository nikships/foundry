import { PIPELINES } from './data/foundry';
import {
  PROBLEM_POINTS,
  SAFE_POINTS,
  ISOLATION_POINTS,
  STEPS,
  SMITH_FACTS,
  SMITH_URL,
} from './data/site';
import { ArtPanel, Button, Dot, Reveal, Section, SectionHead, WindowFrame } from './components/ui';
import { SmithApprovalDemo } from './components/demos/SmithApprovalDemo';
import { Nav, Hero, ClosingCta, Footer } from './components/sections/Chrome';
import { Roster } from './components/sections/Roster';
import { ArtGallery, AppGallery } from './components/sections/Galleries';
import { RunWaterfallDemo } from './components/demos/RunWaterfallDemo';
import { PipelineCanvasDemo } from './components/demos/PipelineCanvasDemo';
import { GateEvidenceDemo } from './components/demos/GateEvidenceDemo';

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />

        {/* ══ 02 the problem ═══════════════════════════════════════════ */}
        <Section id="why" tight>
          <div className="wrap grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
            <Reveal>
              <Eyebrowed index="02" label="The problem" />
              <h2 className="mt-[18px] max-w-[20ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                One agent in a terminal is a bottleneck with a cursor.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                You prompt, you wait, you review, you re-prompt. You are the orchestrator, the QA, and the git
                janitor. The agent is fast; the loop around it is not.
              </p>
              <Ticks items={PROBLEM_POINTS.map((p) => [p.title, p.body])} />
            </Reveal>
            <Reveal delay={80}>
              <ArtPanel
                src="/media/loop/foundry-night-shift.mp4"
                poster="/media/loop/foundry-night-shift.webp"
                caption="Night shift — the factory keeps going without you in the loop"
              />
            </Reveal>
          </div>
        </Section>

        {/* ══ 03 the run ═══════════════════════════════════════════════ */}
        <Section id="run">
          <div className="wrap">
            <SectionHead
              index="03"
              eyebrow="Watch every move"
              title="The Inspector is a live waterfall, not a spinner."
              lede="Tool calls stream mid-phase. Envelopes and gate evidence are inspectable per phase. Cost and timing fill in as you go — the same view for a run happening now and a run from last Tuesday."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — Inspector"
                right={<span>run_412</span>}
                hint={
                  <>
                    <span>Interactive</span>
                    <span className="text-text-faint">— click any phase lane to pin its transcript</span>
                  </>
                }
              >
                <RunWaterfallDemo />
              </WindowFrame>
            </Reveal>

            <div className="mt-14 grid grid-cols-1 items-start gap-9 lg:grid-cols-2 lg:gap-16">
              <Reveal>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Evidence, not vibes
                </h3>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  Each phase returns a typed envelope — a schema, not free text. The plan carries its commit
                  message. The build carries the exact list of files it touched. The review carries a verdict
                  and one finding per requirement.
                </p>
              </Reveal>
              <Reveal delay={70}>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Failure is a location, not a mood
                </h3>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  When a run fails you get the phase, the gate, and the check that refused it. Retool that phase
                  and run it again — scrap the part, not the factory. Failed runs keep their worktree so you can
                  open it and learn before you discard it.
                </p>
              </Reveal>
            </div>
          </div>
        </Section>

        {/* ══ 04 pipelines ═════════════════════════════════════════════ */}
        <Section id="pipelines">
          <div className="wrap">
            <SectionHead
              index="04"
              eyebrow="Pipelines, not prompts"
              title="A recipe you can edit — not a mega-prompt you re-type."
              lede="Each phase has one job and one way to be judged. Drag to rearrange, swap who does what, drop in a checkpoint where a human should look. Save it. Ship it again tomorrow."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — Pipelines · Refine → Build → Ship"
                right={
                  <>
                    <Dot color="var(--green)" /> Valid
                  </>
                }
                hint={
                  <>
                    <span>Interactive</span>
                    <span className="text-text-faint">
                      — the dashed amber wire is the repair loop: a failing command hands its evidence back to
                      the builder
                    </span>
                  </>
                }
              >
                <PipelineCanvasDemo />
              </WindowFrame>
            </Reveal>

            <Reveal className="mt-11 overflow-hidden rounded border border-line">
              <div className="hidden grid-cols-[34px_minmax(0,210px)_minmax(0,1fr)_auto] items-center gap-4 border-b border-line bg-bg-panel px-[18px] py-[13px] font-mono text-[9.5px] uppercase tracking-eyebrow text-text-ghost md:grid">
                <span />
                <span>Pipeline</span>
                <span>When to use it</span>
                <span>Phases</span>
              </div>
              {PIPELINES.map((p, i) => (
                <div
                  key={p.id}
                  className="grid grid-cols-[30px_minmax(0,1fr)] items-center gap-x-4 gap-y-[6px] border-t border-line-faint px-[18px] py-[13px] transition-colors duration-fast ease-mech first-of-type:border-t-0 hover:bg-bg-hover md:grid-cols-[34px_minmax(0,210px)_minmax(0,1fr)_auto]"
                >
                  <span className="font-mono text-[10px] text-text-ghost">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="font-mono text-[13px] text-text">{p.name}</span>
                  <span className="col-start-2 text-[13.5px] leading-[1.5] text-text-dim md:col-start-auto">
                    {p.desc}
                  </span>
                  <span className="col-start-2 whitespace-nowrap font-mono text-[10px] uppercase tracking-label text-text-faint md:col-start-auto">
                    {p.phases} {p.phases === 1 ? 'phase' : 'phases'}
                  </span>
                </div>
              ))}
            </Reveal>
          </div>
        </Section>

        {/* ══ 05 the crew ══════════════════════════════════════════════ */}
        <Section id="crew">
          <div className="wrap">
            <SectionHead
              index="05"
              eyebrow="A crew, not a chatbot"
              title="Eight specialists. Each one bounded."
              lede={
                <>
                  Every agent has its own prompt, its own reasoning budget, its own envelope, and its own write
                  boundary — enforced by <Code>git diff</Code> after every call. A violation is reverted and the
                  phase fails. Retune any of them, or bring your own.
                </>
              }
            />
            <Reveal>
              <Roster />
            </Reveal>
          </div>
        </Section>

        {/* ══ 06 gates ═════════════════════════════════════════════════ */}
        <Section id="gates">
          <div className="wrap">
            <SectionHead
              index="06"
              eyebrow="Agent proposes, code disposes"
              title="Green means it was actually checked."
              lede="A gate is a function, not a judgement. It takes the envelope the agent produced and the state of the worktree, and returns checks with evidence attached. The agent does not get a vote on whether its own work passed."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — Gate evidence · phase build"
                right={<span>envelope: build</span>}
                hint={
                  <>
                    <span>Live</span>
                    <span className="text-text-faint">
                      — the second pass fails on purpose: git reports a file the envelope never claimed
                    </span>
                  </>
                }
              >
                <GateEvidenceDemo />
              </WindowFrame>
            </Reveal>

            <div className="mt-16 grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
              <Reveal>
                <ArtPanel
                  src="/media/loop/foundry-gate-tribunal.mp4"
                  poster="/media/loop/foundry-gate-tribunal.webp"
                  caption="Gate tribunal — a work package is measured before it is released"
                />
              </Reveal>
              <Reveal delay={70}>
                <h2 className="max-w-[20ch] text-[clamp(26px,3vw,34px)] font-semibold leading-[1.1] tracking-tight">
                  Safe by default, not by discipline.
                </h2>
                <Ticks items={SAFE_POINTS.map((p) => [p.title, p.body])} />
              </Reveal>
            </div>
          </div>
        </Section>

        {/* ══ 07 isolation ═════════════════════════════════════════════ */}
        <Section id="isolation">
          <div className="wrap grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
            <Reveal>
              <Eyebrowed index="07" label="Parallel by construction" />
              <h2 className="mt-[18px] max-w-[20ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                Four runs, four worktrees, one repo.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                Concurrency is not a setting you enable and hope for. Each run is handed its own checkout, its
                own branch, and its own agents. They cannot see each other and they cannot collide — so starting
                a fifth is a decision about your budget, not about your git state.
              </p>
              <Ticks items={ISOLATION_POINTS.map((p) => [p.title, p.body])} />
              <div className="mt-8">
                <Button href="#start">Set it up</Button>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <ArtPanel
                src="/media/loop/foundry-branching-worktrees.mp4"
                poster="/media/loop/foundry-branching-worktrees.webp"
                caption="Branching worktrees — one router, four isolated cells"
              />
            </Reveal>
          </div>
        </Section>

        {/* ══ 08 the app ═══════════════════════════════════════════════ */}
        <Section id="app">
          <div className="wrap">
            <SectionHead
              index="08"
              eyebrow="The app"
              title="A real macOS app. Not a CLI wrapper, not a chat skin."
              lede="Point it at any git repo and it reads the project — commands, harnesses, conventions — before you run anything."
            />
            <Reveal>
              <AppGallery />
            </Reveal>
          </div>
        </Section>

        {/* ══ 09 smith ═════════════════════════════════════════════════ */}
        <Section id="smith">
          <div className="wrap grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
            <Reveal>
              <Eyebrowed index="09" label="Smith" />
              <h2 className="mt-[18px] max-w-[20ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                Let an agent build the factory itself.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                Smith is a skill, not another chat window. Load it into whatever agent you already run in
                whatever terminal you already like, and it can author agents, pipelines, and envelopes for you
                through a helper CLI.
              </p>
              <p className="mt-4 max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                Every mutation blocks on you. The command does not return until you approve the proposal in the
                app — and on approve, the entity saves and opens in its editor. No deletes, no run control, no
                settings.
              </p>

              <dl className="mt-8 border-t border-line">
                {SMITH_FACTS.map(([k, v]) => (
                  <div
                    key={k}
                    className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-4 border-b border-line-faint py-[11px]"
                  >
                    <dt className="font-mono text-[10px] uppercase tracking-eyebrow text-text-ghost">{k}</dt>
                    <dd className="break-words font-mono text-[12px] text-text-dim">{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-8">
                <Button href={SMITH_URL}>Read the skill</Button>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <SmithApprovalDemo />
              <p className="mt-3 font-mono text-[10px] uppercase tracking-label text-text-ghost">
                Interactive — approve or reject the pending proposal
              </p>
            </Reveal>
          </div>
        </Section>

        {/* ══ 10 concept art ═══════════════════════════════════════════ */}
        <Section id="art">
          <div className="wrap">
            <SectionHead
              index="10"
              eyebrow="The shape of the thing"
              title="A factory is a better metaphor than a chat."
              lede="Intake, routing, isolated cells, inspection, an evidence archive, and a night shift that keeps running. That is the model Foundry is built on — not a conversation that happens to write code."
            />
            <Reveal>
              <ArtGallery />
            </Reveal>
          </div>
        </Section>

        {/* ══ 11 get started ═══════════════════════════════════════════ */}
        <Section id="start">
          <div className="wrap">
            <SectionHead
              index="11"
              eyebrow="Get started"
              title="Sixty seconds, and no setup script."
              lede={
                <>
                  Requirements: macOS 26+ on Apple Silicon, <Code>git</Code>, and a model provider subscription
                  or API key.
                </>
              }
            />
            <Reveal>
              <ol className="grid gap-px overflow-hidden rounded border border-line bg-line-faint [grid-template-columns:repeat(auto-fit,minmax(216px,1fr))]">
                {STEPS.map((step) => (
                  <li
                    key={step.index}
                    className="bg-bg-base px-5 pb-[26px] pt-6 transition-colors duration-fast ease-mech hover:bg-bg-panel"
                  >
                    <span className="block font-mono text-[10px] tracking-eyebrow text-accent">
                      {step.index}
                    </span>
                    <h3 className="mt-[14px] text-[16px] font-semibold leading-[1.3] tracking-[-0.015em]">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-[1.6] text-text-dim">{step.body}</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </Section>
      </main>

      <ClosingCta />
      <Footer />
    </>
  );
}

/* ── small local helpers ─────────────────────────────────────────────────── */

function Eyebrowed({ index, label }: { index: string; label: string }) {
  return (
    <span className="eyebrow">
      <span className="index">{index}</span>
      {label}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[2px] border border-line bg-bg-raised px-[5px] py-px font-mono text-[0.85em] text-text">
      {children}
    </code>
  );
}

function Ticks({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <ul className="mt-8 flex flex-col gap-[18px]">
      {items.map(([title, body]) => (
        <li key={title} className="relative pl-[22px]">
          <span className="absolute left-0 top-[11px] h-px w-[10px] bg-accent" aria-hidden="true" />
          <strong className="block text-[15px] font-medium text-text">{title}</strong>
          <span className="mt-[5px] block text-[14.5px] leading-[1.6] text-text-dim">{body}</span>
        </li>
      ))}
    </ul>
  );
}
