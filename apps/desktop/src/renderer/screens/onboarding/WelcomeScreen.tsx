import { SceneArt, StepFooter } from './shared.js';
import styles from './WelcomeScreen.module.css';

type Proof = {
  title: string;
  desc: string;
  glyph: React.JSX.Element;
};

const PROOFS: Proof[] = [
  {
    title: 'Watch it work',
    desc: 'Live transcripts, not a black box.',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 12 h4 l2.5-6 3 12 L15 9 l2 3 h4" />
      </svg>
    ),
  },
  {
    title: 'Judge every phase',
    desc: 'Envelopes and gates decide success, not the agent.',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3 v18" />
        <path d="M5 7 h14" />
        <path d="M8 7 l-3 6 h6 Z" />
        <path d="M16 7 l-3 6 h6 Z" />
      </svg>
    ),
  },
  {
    title: 'Stay in control',
    desc: 'Write boundaries, checkpoints, and merge on your terms.',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="7" cy="6" r="2.2" />
        <circle cx="7" cy="18" r="2.2" />
        <circle cx="17" cy="12" r="2.2" />
        <path d="M7 8.4 v7.2" />
        <path d="M9.2 6 h4.2 a1.6 1.6 0 0 1 1.6 1.6 v2.2" />
        <path d="M9.2 18 h4.2 a1.6 1.6 0 0 0 1.6-1.6 v-2.8" />
      </svg>
    ),
  },
];

export default function WelcomeScreen(): React.JSX.Element {
  return (
    <div className={styles.obWelcome}>
      <div className={styles.obWelcomeSplit}>
        {/* stage — new Factory blueprint hero */}
        <section className={styles.obWelcomeHero} aria-hidden="true">
          <div className={styles.obWelcomeHeroGrid} />
          <div className={styles.obWelcomeHeroFrame} />
          <div className={styles.obWelcomeHeroField}>
            <SceneArt path="scenes/onboarding-hero.png" className={styles.obWelcomeHeroArt} />
          </div>
          <p className={styles.obWelcomeHeroCaption}>A software factory you can watch work.</p>
        </section>

        {/* editorial */}
        <section className={styles.obWelcomeEditorial}>
          <div className={styles.obWelcomeEditorialInner}>
            <p
              className={`${styles.obWelcomeEyebrow} ${styles.obWelcomeRise} eyebrow`}
              style={{ ['--d' as string]: '0ms' } as React.CSSProperties}
            >
              <span className="index">01</span>Introducing
            </p>
            <h1
              className={`${styles.obWelcomeWordmark} ${styles.obWelcomeRise}`}
              style={{ ['--d' as string]: '60ms' } as React.CSSProperties}
            >
              Foundry
            </h1>
            <p
              className={`${styles.obWelcomeLead} ${styles.obWelcomeRise}`}
              style={{ ['--d' as string]: '120ms' } as React.CSSProperties}
            >
              Describe a change. A pipeline of agents carries it out in an isolated worktree. Every
              phase leaves evidence you can read: prompts, tools, gates, and cost.
            </p>

            <ul className={styles.obWelcomeProof}>
              {PROOFS.map((p, i) => (
                <li
                  key={p.title}
                  className={`${styles.obWelcomeProofRow} ${styles.obWelcomeRise}`}
                  style={{ ['--d' as string]: `${200 + i * 70}ms` } as React.CSSProperties}
                >
                  <span className={styles.obWelcomeProofGlyph} aria-hidden="true">
                    {p.glyph}
                  </span>
                  <span className={styles.obWelcomeProofText}>
                    <span className={styles.obWelcomeProofTitle}>{p.title}</span>
                    <span className={styles.obWelcomeProofDesc}>{p.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <StepFooter nextLabel="Begin" showBack={false} />
    </div>
  );
}
