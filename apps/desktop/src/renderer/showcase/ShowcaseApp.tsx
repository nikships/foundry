/**
 * Pipelines redesign showcase — a review surface, not a product screen.
 *
 * It mounts the two candidate Pipelines screens for real, against a seeded
 * backend, so the comparison is between working software rather than pictures.
 * Switching options swaps the live screen; everything below it is the argument
 * for and against each direction.
 */
// Must precede every import that reaches `api.ts`: importing this installs the
// seeded backend, and `api.ts` installs the plain web mock if it gets there first.
import './mock.js';
import { useCallback, useEffect, useState } from 'react';
import { AppProvider } from '../stores/app.js';
import PipelinesScreen from '../screens/PipelinesScreen.js';
import PipelinesBoardScreen from '../screens/PipelinesBoardScreen.js';
import ConfirmModal from '../components/ConfirmModal.js';
import { DroidGlyph } from '../components/BrandIcon.js';
import { OPTIONS, CAPABILITIES, type OptionId } from './options.js';
import styles from './showcase.module.css';

function useHashOption(): [OptionId, (next: OptionId) => void] {
  const read = (): OptionId => (window.location.hash === '#option-b' ? 'b' : 'a');
  const [option, setOption] = useState<OptionId>(read);
  useEffect(() => {
    const onHash = (): void => setOption(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = useCallback((next: OptionId): void => {
    window.location.hash = next === 'b' ? '#option-b' : '#option-a';
    setOption(next);
  }, []);
  return [option, select];
}

function Stage({ option }: { option: OptionId }): React.JSX.Element {
  const meta = OPTIONS[option];
  return (
    <figure className={styles.stage} aria-label={`${meta.label}: ${meta.name}, live preview`}>
      <figcaption className={styles.stageBar}>
        <span className={styles.stageDots} aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className={styles.stageTitle}>
          Foundry — {meta.name}
          <span className={styles.stageBadge}>{meta.label}</span>
        </span>
        <span className={styles.stageHint}>Live and editable</span>
      </figcaption>
      <div className={styles.stageViewport}>
        {/* Keyed so switching options remounts cleanly rather than reusing
            the other screen's transient selection state. */}
        {option === 'a' ? <PipelinesScreen key="a" /> : <PipelinesBoardScreen key="b" />}
      </div>
    </figure>
  );
}

export default function ShowcaseApp(): React.JSX.Element {
  const [option, setOption] = useHashOption();
  const meta = OPTIONS[option];
  const other = OPTIONS[option === 'a' ? 'b' : 'a'];

  return (
    <AppProvider>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroInner}>
            <p className={styles.brand}>
              <DroidGlyph size={14} />
              <span>Foundry</span>
              <span className={styles.brandDivider} aria-hidden />
              <span className={styles.brandKicker}>Design review</span>
            </p>
            <h1 className={styles.heroTitle}>
              Two ways to build a pipeline.
              <br />
              Pick the one you want to live in.
            </h1>
            <p className={styles.heroBody}>
              The Pipelines page is being replaced outright — the old horizontal phase ribbon is
              gone from both directions. Each option below is a complete, working screen over the
              same data and the same contracts. They differ in what they make you look at first.
            </p>
          </div>
        </header>

        <div className={styles.switcherBar}>
          <div className={styles.switcherInner}>
            <div className={styles.switcher} role="tablist" aria-label="Redesign options">
              {(['a', 'b'] as OptionId[]).map((id) => {
                const on = id === option;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    id={`opt-tab-${id}`}
                    aria-controls="opt-panel"
                    className={`${styles.switch} ${on ? styles.on : ''}`}
                    onClick={() => setOption(id)}
                  >
                    <span className={styles.switchLabel}>{OPTIONS[id].label}</span>
                    <span className={styles.switchName}>{OPTIONS[id].name}</span>
                  </button>
                );
              })}
            </div>
            <p className={styles.switcherTagline}>{meta.tagline}</p>
          </div>
        </div>

        <main
          className={styles.main}
          id="opt-panel"
          role="tabpanel"
          aria-labelledby={`opt-tab-${option}`}
        >
          <Stage option={option} />

          <section className={styles.model} aria-label="Interaction model">
            <h2 className={styles.h2}>
              <span className={styles.h2Index}>01</span>
              The model
            </h2>
            <p className={styles.modelBody}>{meta.model}</p>
            <ul className={styles.moves}>
              {meta.moves.map((move) => (
                <li key={move.label}>
                  <span className={styles.moveLabel}>{move.label}</span>
                  <span className={styles.moveText}>{move.text}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.tradeoffs} aria-label="Strengths and tradeoffs">
            <h2 className={styles.h2}>
              <span className={styles.h2Index}>02</span>
              Why, and what it costs
            </h2>
            <div className={styles.tradeGrid}>
              <div className={styles.tradeCol}>
                <p className={`${styles.tradeHead} ${styles.forIt}`}>Strengths</p>
                <ul className={styles.tradeList}>
                  {meta.strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
              <div className={styles.tradeCol}>
                <p className={`${styles.tradeHead} ${styles.against}`}>Tradeoffs</p>
                <ul className={styles.tradeList}>
                  {meta.tradeoffs.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className={styles.bestFor}>
              <strong>Best for</strong> {meta.bestFor}
            </p>
          </section>

          <section className={styles.matrix} aria-label="Preserved capabilities">
            <h2 className={styles.h2}>
              <span className={styles.h2Index}>03</span>
              Everything the old page did, in both
            </h2>
            <p className={styles.matrixIntro}>
              Both options are presentations of one shared hook, so selection, auto-save, live
              validation, dry run and the phase contracts are the same code in each. Only where you
              reach for them differs.
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>
                  How each preserved capability is reached in Option A and Option B
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col" className={option === 'a' ? styles.colOn : undefined}>
                      A · Ladder
                    </th>
                    <th scope="col" className={option === 'b' ? styles.colOn : undefined}>
                      B · Stage board
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITIES.map((cap) => (
                    <tr key={cap.label}>
                      <th scope="row">{cap.label}</th>
                      <td className={option === 'a' ? styles.colOn : undefined}>{cap.a}</td>
                      <td className={option === 'b' ? styles.colOn : undefined}>{cap.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.cta} aria-label="Choose a direction">
            <h2 className={styles.ctaTitle}>Choose a direction</h2>
            <p className={styles.ctaBody}>
              Option A ships wired into the app today. Option B is complete and swaps in by changing
              one import in <code>App.tsx</code>. Whichever wins, the other is deleted — this page
              exists to make that call, not to keep both.
            </p>
            <div className={styles.ctaRow}>
              <span className={styles.ctaCurrent}>
                Reviewing <strong>{meta.label}</strong> · {meta.name}
              </span>
              <button type="button" className={styles.ctaSwap} onClick={() => setOption(other.id)}>
                Compare with {other.label} · {other.name}
              </button>
            </div>
            <p className={styles.ctaNote}>
              Record the decision on the pull request. The losing option and this showcase route
              come out in the same commit.
            </p>
          </section>
        </main>

        <footer className={styles.foot}>
          <span>Foundry · Pipelines redesign review</span>
          <span className={styles.footDim}>
            Seeded data. Edits are held in memory and reset on reload.
          </span>
        </footer>

        <ConfirmModal />
      </div>
    </AppProvider>
  );
}
