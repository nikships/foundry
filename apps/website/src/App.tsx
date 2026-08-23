import {
  PIPELINES,
  CHECK_DESCRIPTIONS,
  ACCEPTANCE_KINDS,
  SUBSCRIPTIONS,
  DIRECT_KEYS,
  SMITH_FACTS,
  SMITH_TOOLS,
  COMPANION_POINTS,
  READINESS_POINTS,
} from './data/foundry';
import { PROBLEM_POINTS, SAFE_POINTS, ISOLATION_POINTS, STEPS, REPO_URL } from './data/site';
import { ArtPanel, Button, Dot, Reveal, Section, SectionHead, WindowFrame } from './components/ui';
import { Nav, Hero, ClosingCta, Footer } from './components/sections/Chrome';
import { Roster } from './components/sections/Roster';
import { ArtGallery, AppGallery, PhoneGallery } from './components/sections/Galleries';
import { RunWaterfallDemo } from './components/demos/RunWaterfallDemo';
import { PipelineCanvasDemo } from './components/demos/PipelineCanvasDemo';
import { CheckEvidenceDemo } from './components/demos/CheckEvidenceDemo';
import { ModelCastingDemo } from './components/demos/ModelCastingDemo';
import { SmithChatDemo } from './components/demos/SmithChatDemo';

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
              <h2 className="mt-[18px] max-w-[22ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                Two lock-ins are slowing you down.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                Every agent tool hands you one process and one vendor. If your team specs before it
                builds, or gates on a security pass, or needs a sign-off before a PR opens, you bend
                your process to the tool — and you get exactly one model family to do it with.
              </p>
              <Ticks items={PROBLEM_POINTS.map((p) => [p.title, p.body])} />
              <p className="mt-8 max-w-[58ch] border-t border-line pt-6 text-[15px] leading-[1.65] text-text-dim">
                <strong className="font-medium text-text">Foundry removes both.</strong> You define
                the lifecycle as data, and you assign a model per agent and per phase, mixed freely
                across providers, with automatic failover when one dies mid-run.
              </p>
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
              lede="Tool calls stream mid-phase. Reports and check evidence are inspectable per phase. Context occupancy, tokens and the model that actually answered fill in as you go — the same view for a run happening now and a run from last Tuesday."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — Inspector"
                right={<span>run_260823_a41c9e</span>}
                hint={
                  <>
                    <span>Interactive</span>
                    <span className="text-text-faint">
                      — click any phase lane to pin its transcript, or open its Report and Checks
                    </span>
                  </>
                }
              >
                <RunWaterfallDemo />
              </WindowFrame>
            </Reveal>

            <div className="mt-14 grid grid-cols-1 items-start gap-9 lg:grid-cols-3 lg:gap-12">
              <Reveal>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Evidence, not vibes
                </h3>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  Each phase returns a typed report — a schema, not free text. The plan carries its
                  commit message. The review carries a verdict and one finding per requirement. Nine
                  shapes ship built in, and you can define your own with typed fields.
                </p>
              </Reveal>
              <Reveal delay={70}>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Failure is a location
                </h3>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  When a run fails you get the phase, the check, and the line that refused it. A
                  failing command can hand its log tail back to the agent that owns the fix instead
                  of failing the run — that is the dashed edge on the canvas below.
                </p>
              </Reveal>
              <Reveal delay={140}>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Accepted means it exists
                </h3>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  Every shipped chain accepts on its PR phase reporting success — the engine, not
                  the agent, pushes the branch and runs <Code>gh pr create</Code>, and a missing
                  number fails the phase. &ldquo;Accepted&rdquo; can only mean the pull request is
                  real.
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
              eyebrow="Structure the SDLC to your liking"
              title="A recipe you can edit — not a mega-prompt you re-type."
              lede="A pipeline is data: three kinds of phase, a write boundary each, checks that prove them, and an explicit definition of done. Drag to rearrange, swap who does what, drop in a checkpoint where a human should look. No YAML, no scripts."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — Pipelines"
                right={
                  <>
                    <Dot color="var(--green)" /> Valid
                  </>
                }
                hint={
                  <>
                    <span>Interactive</span>
                    <span className="text-text-faint">
                      — the dashed amber wire is the repair loop: a failing command hands its
                      evidence back to the builder
                    </span>
                  </>
                }
              >
                <PipelineCanvasDemo />
              </WindowFrame>
            </Reveal>

            {/* the three phase kinds */}
            <div className="mt-11 grid gap-px overflow-hidden rounded border border-line bg-line-faint md:grid-cols-3">
              {(
                [
                  [
                    'agent',
                    'var(--accents-builder)',
                    'A specialist takes a turn and must return a typed report.',
                  ],
                  [
                    'command',
                    'var(--blue)',
                    'A real command in the worktree — your tests, your linter, your build, a commit.',
                  ],
                  [
                    'checkpoint',
                    'var(--amber)',
                    'The line stops and asks you a question before it moves on.',
                  ],
                ] as Array<[string, string, string]>
              ).map(([kind, color, body]) => (
                <div key={kind} className="bg-bg-base px-5 pb-[22px] pt-5">
                  <span
                    className="font-mono text-[10px] uppercase tracking-eyebrow"
                    style={{ color }}
                  >
                    {kind}
                  </span>
                  <p className="mt-[10px] text-[13.5px] leading-[1.6] text-text-dim">{body}</p>
                </div>
              ))}
            </div>

            {/* the six shipped chains */}
            <Reveal className="mt-11 overflow-hidden rounded border border-line">
              <div className="hidden grid-cols-[34px_minmax(0,230px)_minmax(0,1fr)_auto] items-center gap-4 border-b border-line bg-bg-panel px-[18px] py-[13px] font-mono text-[9.5px] uppercase tracking-eyebrow text-text-ghost md:grid">
                <span />
                <span>Pipeline</span>
                <span>When to use it</span>
                <span>Phases</span>
              </div>
              {PIPELINES.map((p, i) => (
                <div
                  key={p.id}
                  className="grid grid-cols-[30px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-[6px] border-t border-line-faint px-[18px] py-[14px] transition-colors duration-fast ease-mech first-of-type:border-t-0 hover:bg-bg-hover md:grid-cols-[34px_minmax(0,230px)_minmax(0,1fr)_auto]"
                >
                  <span className="font-mono text-[10px] text-text-ghost">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="font-mono text-[13px] text-text">{p.name}</span>
                  <span className="col-start-2 md:col-start-auto">
                    <span className="block text-[13.5px] leading-[1.5] text-text-dim">
                      {p.desc}
                    </span>
                    <span className="mt-[7px] flex flex-wrap gap-[5px]">
                      {p.chain.map((phase) => (
                        <span
                          key={phase}
                          className="rounded-[2px] border border-line-faint px-[5px] font-mono text-[9px] text-text-ghost"
                        >
                          {phase}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className="col-start-2 whitespace-nowrap font-mono text-[10px] uppercase tracking-label text-text-faint md:col-start-auto">
                    {p.phases} phases
                  </span>
                </div>
              ))}
            </Reveal>

            <p className="mt-6 max-w-[80ch] text-[14.5px] leading-[1.65] text-text-dim">
              All six are starting points, not the menu — fork any of them and it becomes yours.
              Every one holds two rules by construction: nothing is committed unproven, and a
              rejection halts the run before it can reach a pull request.
            </p>

            {/* acceptance */}
            <Reveal className="mt-11">
              <span className="label-sm mb-[14px] block text-text-faint">
                And you decide what &ldquo;done&rdquo; means
              </span>
              <dl className="grid gap-px overflow-hidden rounded border border-line bg-line-faint md:grid-cols-2">
                {ACCEPTANCE_KINDS.map(([kind, desc]) => (
                  <div key={kind} className="bg-bg-base px-[18px] py-[15px]">
                    <dt className="font-mono text-[11.5px] text-accent">{kind}</dt>
                    <dd className="mt-[6px] text-[13px] leading-[1.55] text-text-dim">{desc}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>
        </Section>

        {/* ══ 05 models ════════════════════════════════════════════════ */}
        <Section id="models">
          <div className="wrap">
            <SectionHead
              index="05"
              eyebrow="Never bet a run on one model"
              title="Cast every seat for what that model is actually good at."
              lede="Foundry keeps no model allowlist of its own. A model id is an opaque provider/model string, so anything your install can reach is selectable anywhere a model is chosen — per agent, overridable per phase."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — one run, five providers"
                right={<span>failover armed</span>}
                hint={
                  <>
                    <span>Live</span>
                    <span className="text-text-faint">
                      — the build seat fails on purpose: watch the turn continue on the next
                      reachable model
                    </span>
                  </>
                }
              >
                <ModelCastingDemo />
              </WindowFrame>
            </Reveal>

            <div className="mt-14 grid grid-cols-1 items-start gap-9 lg:grid-cols-3 lg:gap-12">
              <Reveal>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Bring what you already pay for
                </h3>
                <p className="mt-3 text-[15px] leading-[1.65] text-text-dim">
                  Sign in to a subscription through the built-in Bridge and it becomes a local
                  endpoint. No per-token cost, and no walled garden — your process lives here, so
                  the day one of them raises the price you change a dropdown.
                </p>
                <ul className="mt-5 flex flex-wrap gap-[6px]">
                  {SUBSCRIPTIONS.map(([label]) => (
                    <li
                      key={label}
                      className="rounded-sm border border-line px-[8px] py-[4px] font-mono text-[10.5px] text-text-dim"
                    >
                      {label}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal delay={70}>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  Or your own keys, or your own weights
                </h3>
                <p className="mt-3 text-[15px] leading-[1.65] text-text-dim">
                  Direct API keys live in the runtime&rsquo;s credential store on your Mac, never in
                  Foundry&rsquo;s settings file. A hand-added OpenAI-compatible endpoint survives
                  every catalog regeneration, so a local coder can hold a seat next to a frontier
                  model in the same run.
                </p>
                <p className="mt-4 font-mono text-[11px] leading-[1.75] text-text-faint">
                  {DIRECT_KEYS}
                </p>
              </Reveal>
              <Reveal delay={140}>
                <h3 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  The picker is honest
                </h3>
                <p className="mt-3 text-[15px] leading-[1.65] text-text-dim">
                  A provider with no usable credential is not listed, so a model you can select is a
                  model a run can start on. Reasoning effort offers only the levels that model
                  genuinely supports. Hide the ones you never want.
                </p>
              </Reveal>
            </div>
          </div>
        </Section>

        {/* ══ 06 the crew ══════════════════════════════════════════════ */}
        <Section id="crew">
          <div className="wrap">
            <SectionHead
              index="06"
              eyebrow="A crew, not a chatbot"
              title="Nine specialists. Each one bounded."
              lede={
                <>
                  Every agent has its own model, prompt, reasoning budget, report shape, tool surface
                  and write boundary — enforced by <Code>git diff</Code> after every call. A
                  violation is reverted and the phase fails. Retune any of them, or bring your own.
                </>
              }
            />
            <Reveal>
              <Roster />
            </Reveal>
            <p className="mt-6 max-w-[80ch] text-[14.5px] leading-[1.65] text-text-dim">
              A boundary is one of three things: unrestricted (everything but protected paths),
              read-only, or an allowlist of paths and globs. Read-only agents get no shell at all —
              the reviewer reads the patch through <Code>git_diff</Code> and cannot touch the tree it
              is judging.
            </p>
          </div>
        </Section>

        {/* ══ 07 checks ════════════════════════════════════════════════ */}
        <Section id="checks">
          <div className="wrap">
            <SectionHead
              index="07"
              eyebrow="Agent proposes, code disposes"
              title="Green means it was actually checked."
              lede="A check is a function, not a judgement. It takes the report the agent produced and the state of the worktree, and returns checks with evidence attached. The agent does not get a vote on whether its own work passed."
            />
            <Reveal>
              <WindowFrame
                title="Foundry — check evidence · phase production_check"
                right={<span>report: review</span>}
                hint={
                  <>
                    <span>Live</span>
                    <span className="text-text-faint">
                      — the second pass lists a blocker and still claims success: watch the run halt
                    </span>
                  </>
                }
              >
                <CheckEvidenceDemo />
              </WindowFrame>
            </Reveal>

            <Reveal className="mt-11">
              <span className="label-sm mb-[14px] block text-text-faint">
                The six that ship — plus <Code>command_passes</Code>, which runs your argv
              </span>
              <dl className="grid gap-px overflow-hidden rounded border border-line bg-line-faint md:grid-cols-2">
                {Object.entries(CHECK_DESCRIPTIONS).map(([name, desc]) => (
                  <div key={name} className="bg-bg-base px-[18px] py-[15px]">
                    <dt className="font-mono text-[11.5px] text-accent">{name}</dt>
                    <dd className="mt-[6px] text-[13px] leading-[1.55] text-text-dim">{desc}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>

            <div className="mt-16 grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16">
              <Reveal>
                <ArtPanel
                  src="/media/loop/foundry-gate-tribunal.mp4"
                  poster="/media/loop/foundry-gate-tribunal.webp"
                  caption="Inspection bay — a work package is measured before it is released"
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

        {/* ══ 08 isolation ═════════════════════════════════════════════ */}
        <Section id="isolation">
          <div className="wrap grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-16">
            <Reveal>
              <Eyebrowed index="08" label="Parallel by construction" />
              <h2 className="mt-[18px] max-w-[20ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                Four runs, four worktrees, one repo.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                Concurrency is not a setting you enable and hope for. Each run is handed its own
                checkout, its own branch, and its own agents. They cannot see each other and they
                cannot collide — so starting a fifth is a decision about your budget, not about your
                git state.
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

        {/* ══ 09 the app ═══════════════════════════════════════════════ */}
        <Section id="app">
          <div className="wrap">
            <SectionHead
              index="09"
              eyebrow="The app"
              title="A real macOS app. Not a CLI wrapper, not a chat skin."
              lede="Point it at any git repo and it reads the project — commands, harnesses, conventions — before you run anything. Everything below is one window: no browser tab, no terminal, no dashboard to log into."
            />
            <Reveal>
              <AppGallery />
            </Reveal>
          </div>
        </Section>

        {/* ══ 10 smith ═════════════════════════════════════════════════ */}
        <Section id="smith">
          <div className="wrap">
            <SectionHead
              index="10"
              eyebrow="Smith"
              title="An operator who can drive the factory — with your hand on every write."
              lede="Smith is a native chat inside the app, on the bundled runtime. Ask it to design a pipeline, retune an agent, check a provider, answer a checkpoint, or tell you why a run failed. Reads answer immediately; every privileged action stops at one inline card."
            />
            <div className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
              <Reveal>
                <p className="max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  It answers with typed inline cards rather than prose — a pipeline design, a run
                  summary, a provider status, a diagnostics report, a settings diff. Seventeen kinds,
                  each validated and size-capped at the process boundary, each presentation only:
                  a card never performs a write.
                </p>
                <p className="mt-4 max-w-[62ch] text-[15px] leading-[1.65] text-text-dim">
                  Approving is not the same as succeeding. The executor closure never leaves the main
                  process, and when it finishes Foundry mints a receipt from what actually happened —
                  including a failure. An API key is typed into the card and never enters the
                  transcript, the model result, or the saved chat.
                </p>

                <dl className="mt-8 border-t border-line">
                  {SMITH_FACTS.map(([k, v]) => (
                    <div
                      key={k}
                      className="grid grid-cols-[86px_minmax(0,1fr)] items-baseline gap-4 border-b border-line-faint py-[11px]"
                    >
                      <dt className="font-mono text-[10px] uppercase tracking-eyebrow text-text-ghost">
                        {k}
                      </dt>
                      <dd className="break-words text-[12.5px] leading-[1.5] text-text-dim">{v}</dd>
                    </div>
                  ))}
                </dl>

                <span className="label-sm mb-[10px] mt-8 block text-text-faint">
                  Its whole tool surface
                </span>
                <ul className="flex flex-wrap gap-[5px]">
                  {SMITH_TOOLS.map((t) => (
                    <li
                      key={t}
                      className="rounded-[2px] border border-line-faint px-[6px] py-[3px] font-mono text-[10px] text-text-faint"
                    >
                      {t}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 max-w-[58ch] text-[13px] leading-[1.6] text-text-faint">
                  Fixed enums over the handlers the window already uses — not a shell, not a channel
                  argument. There is no delete, and unknown tools fail closed.
                </p>
              </Reveal>

              <Reveal delay={80} className="lg:sticky lg:top-[84px]">
                <SmithChatDemo />
                <p className="mt-3 font-mono text-[10px] uppercase tracking-label text-text-ghost">
                  Interactive — approve or reject the pending proposal
                </p>
              </Reveal>
            </div>
          </div>
        </Section>

        {/* ══ 11 readiness ═════════════════════════════════════════════ */}
        <Section id="readiness" tight>
          <div className="wrap grid grid-cols-1 items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <Reveal>
              <Eyebrowed index="11" label="Agent readiness" />
              <h2 className="mt-[18px] max-w-[22ch] text-[clamp(30px,4vw,46px)] font-semibold leading-[1.06] tracking-tight">
                Most repos are not ready for agents. Foundry says so, then fixes it.
              </h2>
              <p className="mt-[22px] max-w-[62ch] text-[17px] leading-[1.65] text-text-dim">
                An agent that cannot find your build command writes plausible nonsense. Before you
                spend a run, Foundry checks whether the repository actually tells an agent how to
                work in it — and if it does not, it opens a pull request that adds the guidance.
              </p>
              <Ticks items={READINESS_POINTS.map(([t, b]) => [t, b])} />
            </Reveal>
            <Reveal delay={80}>
              <ArtPanel
                src="/media/loop/foundry-evidence-vault.mp4"
                poster="/media/loop/foundry-evidence-vault.webp"
                caption="Evidence vault — every run keeps its proof"
              />
            </Reveal>
          </div>
        </Section>

        {/* ══ 12 the phone ═════════════════════════════════════════════ */}
        <Section id="phone">
          <div className="wrap">
            <SectionHead
              index="12"
              eyebrow="The companion"
              title="Start a run from the couch. Answer a checkpoint from the train."
              lede="A LAN host inside the main process, and an Android app that talks to it. Every route is a projection of an operation the desktop already has, so the phone can never do something the window cannot."
            />
            <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
              <Reveal>
                <Ticks items={COMPANION_POINTS.map(([t, b]) => [t, b])} />
                <p className="mt-8 max-w-[58ch] border-t border-line pt-6 text-[13.5px] leading-[1.65] text-text-faint">
                  The host only exists while you turn it on. Apart from pairing, every route requires
                  a bearer token that hashes to a paired device — and everything else, unknown paths
                  included, answers 401 before it answers 404, so an unpaired caller cannot even map
                  the surface.
                </p>
              </Reveal>
              <Reveal delay={80}>
                <PhoneGallery />
              </Reveal>
            </div>
          </div>
        </Section>

        {/* ══ 13 concept art ═══════════════════════════════════════════ */}
        <Section id="art">
          <div className="wrap">
            <SectionHead
              index="13"
              eyebrow="The shape of the thing"
              title="A factory is a better metaphor than a chat."
              lede="Intake, routing, isolated cells, inspection, an evidence archive, and a night shift that keeps running. That is the model Foundry is built on — not a conversation that happens to write code."
            />
            <Reveal>
              <ArtGallery />
            </Reveal>
          </div>
        </Section>

        {/* ══ get started ══════════════════════════════════════════════ */}
        <Section id="start">
          <div className="wrap">
            <SectionHead
              index="14"
              eyebrow="Get started"
              title="Sixty seconds, and no setup script."
              lede={
                <>
                  Requirements: macOS 26+ on Apple Silicon, <Code>git</Code>, and at least one model
                  reachable — a subscription signed in or an API key stored.
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
            <p className="mt-6 text-[14.5px] leading-[1.65] text-text-dim">
              An Android APK ships alongside every release. The source for all of it is{' '}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-bright"
              >
                on GitHub
              </a>
              , MIT-licensed.
            </p>
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
