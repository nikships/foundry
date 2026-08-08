import React, { useState } from 'react';
import { CliIcon } from '../../components/BrandIcon.js';
import { OnboardingProvider } from './OnboardingContext.js';
import { Stepper } from './shared.js';
import { useOnboarding } from './OnboardingContext.js';

import WelcomeScreen from './WelcomeScreen.js';
import FactoryScreen from './FactoryScreen.js';
import RosterScreen from './RosterScreen.js';
import CliScreen from './CliScreen.js';
import DoctorScreen from './DoctorScreen.js';
import ProjectScreen from './ProjectScreen.js';

const STEP_COMPONENTS: Record<string, React.ComponentType> = {
  welcome: WelcomeScreen,
  factory: FactoryScreen,
  roster: RosterScreen,
  clis: CliScreen,
  doctor: DoctorScreen,
  project: ProjectScreen,
};

function OnboardingShellInner(): React.JSX.Element {
  const { step, stepIndex, canLeaveDoctor, go, entered } = useOnboarding();
  const Active = STEP_COMPONENTS[step] ?? WelcomeScreen;
  return (
    <div className={`ob-shell ${entered ? 'in' : ''}`}>
      <div className="ob-stage" aria-hidden>
        <div className="ob-orb ob-orb-a" />
        <div className="ob-orb ob-orb-b" />
        <div className="ob-orb ob-orb-c" />
        <div className="ob-grid" />
      </div>
      <header className="ob-top">
        <div className="ob-brand">
          <CliIcon vendor="droid" size={20} />
          <span>Foundry</span>
        </div>
        <Stepper stepIndex={stepIndex} canLeaveDoctor={canLeaveDoctor} currentStep={step} onGo={go} />
      </header>
      <div className="ob-page" key={step}>
        <Active />
      </div>
      <style>{`
        .ob-shell {
          position: relative; flex: 1; min-height: 0;
          display: flex; flex-direction: column; overflow: hidden;
          opacity: 0; transform: translateY(8px);
          transition: opacity 480ms var(--ease), transform 480ms var(--ease);
        }
        .ob-shell.in { opacity: 1; transform: none; }
        .ob-stage { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
        .ob-orb { position: absolute; border-radius: 50%; filter: blur(60px); opacity: 0.45; animation: ob-drift 18s ease-in-out infinite alternate; }
        .ob-orb-a { width: 420px; height: 420px; background: color-mix(in srgb, var(--cyan) 35%, transparent); top: -120px; left: -80px; }
        .ob-orb-b { width: 360px; height: 360px; background: color-mix(in srgb, var(--purple, #c89bff) 28%, transparent); bottom: -100px; right: -60px; animation-delay: -6s; }
        .ob-orb-c { width: 240px; height: 240px; background: color-mix(in srgb, var(--amber) 18%, transparent); top: 40%; left: 45%; animation-delay: -11s; }
        .ob-grid { position: absolute; inset: 0; background-image: linear-gradient(color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px); background-size: 48px 48px; mask-image: radial-gradient(ellipse at center, black 20%, transparent 72%); opacity: 0.35; }
        .ob-top { position: relative; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--s4); padding: calc(var(--titlebar-h) + var(--s3)) var(--s6) var(--s3); }
        .ob-brand { display: flex; align-items: center; gap: var(--s2); font-weight: 600; letter-spacing: -0.02em; }
        .ob-stepper { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
        .ob-step-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--r-full); border: 1px solid transparent; background: transparent; color: var(--text-faint); font: inherit; font-size: var(--text-xs); }
        .ob-step-pill .ob-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
        .ob-step-pill.done { color: var(--text-dim); }
        .ob-step-pill.done .ob-dot { background: var(--cyan); }
        .ob-step-pill.on { color: var(--text); background: var(--bg-panel); border-color: var(--line); box-shadow: var(--glow-cyan); }
        .ob-step-pill.on .ob-dot { background: var(--cyan); box-shadow: 0 0 0 3px var(--cyan-dim); }
        .ob-page { position: relative; z-index: 2; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; animation: ob-fade 420ms var(--ease); }
        @keyframes ob-drift { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(24px,-18px,0) scale(1.08); } }
        @keyframes ob-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        /* Each step screen owns its own layout; no nested card wrapper here. */
        /* Step chrome for eyebrow/title/lead/footer — shared utility, not a card. */
        .ob-eyebrow { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.12em; color: var(--cyan); font-weight: 600; margin-bottom: var(--s2); }
        .ob-title { font-size: clamp(1.7rem, 2.4vw, 2.35rem); font-weight: 600; letter-spacing: -0.03em; margin-bottom: var(--s3); }
        .ob-lead { font-size: var(--text-base); color: var(--text-dim); line-height: var(--leading-loose); margin-bottom: var(--s5); max-width: 52ch; }
        .ob-lead strong { color: var(--text); }
        .ob-foot { display: flex; align-items: center; gap: var(--s3); margin-top: auto; padding-top: var(--s6); }
        .ob-grow { flex: 1; }
      `}</style>
    </div>
  );
}

export default function OnboardingShell({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  return (
    <OnboardingProvider stepIndex={stepIndex} setStepIndex={setStepIndex} onDone={onDone}>
      <OnboardingShellInner />
    </OnboardingProvider>
  );
}
