import { useApp } from '../../stores/app.js';
import { useOnboarding } from './OnboardingContext.js';

export default function ProjectScreen(): React.JSX.Element {
  const { projects } = useApp();
  const {
    back,
    name,
    setName,
    selectedId,
    setSelectedId,
    nameDrafts,
    setNameDrafts,
    renamingId,
    setRenamingId,
    busy,
    error,
    addProject,
    removeProject,
    commitProjectRename,
    canEnterProject,
    projectBlockingHint,
    finish,
  } = useOnboarding();
  const { selectProject } = useApp();

  return (
    <div className="ob-project">
      {/* left — atmospheric worktree visual */}
      <aside className="ob-project-visual" aria-hidden="true">
        <div className="ob-project-visual-grid" />
        <div className="ob-project-orb ob-project-orb-a" />
        <div className="ob-project-orb ob-project-orb-b" />

        <div className="ob-project-visual-inner">
          <div className="ob-project-visual-label">worktree topology</div>

          <svg className="ob-project-tree" viewBox="0 0 460 520" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="obp-fade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.55" />
                <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0.06" />
              </linearGradient>
            </defs>
            <line x1="42" y1="14" x2="42" y2="506" stroke="var(--line-strong)" strokeWidth="1" />
            <path d="M42 92 C 42 132, 120 120, 168 120" stroke="url(#obp-fade)" strokeWidth="1" />
            <path d="M42 188 C 42 240, 150 224, 232 224" stroke="url(#obp-fade)" strokeWidth="1" />
            <path d="M42 284 C 42 336, 120 320, 168 320" stroke="url(#obp-fade)" strokeWidth="1" />
            <path
              d="M42 376 C 42 422, 110 410, 148 410"
              stroke="var(--line-strong)"
              strokeWidth="1"
              strokeDasharray="2 5"
            />
            <path
              d="M232 224 C 320 224, 300 150, 356 150"
              stroke="var(--line-strong)"
              strokeWidth="1"
              strokeDasharray="2 5"
            />
            {[40, 92, 188, 284, 376, 470].map((y) => (
              <circle key={y} cx="42" cy={y} r="3" fill="var(--bg-void)" stroke="var(--line-strong)" />
            ))}
            <circle cx="168" cy="120" r="4.5" fill="var(--cyan)" className="ob-project-node" />
            <circle cx="232" cy="224" r="6" fill="var(--cyan)" className="ob-project-node ob-project-node-lg" />
            <circle cx="168" cy="320" r="4.5" fill="var(--cyan)" className="ob-project-node" />
            <circle cx="148" cy="410" r="3.5" fill="var(--bg-void)" stroke="var(--line-strong)" />
            <circle cx="356" cy="150" r="3.5" fill="var(--bg-void)" stroke="var(--line-strong)" />
            <text x="58" y="44" fill="var(--text-faint)" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="0.06em">
              main
            </text>
            <text x="176" y="124" fill="var(--text-faint)" fontFamily="var(--font-mono)" fontSize="10">
              run_8f2c1a
            </text>
            <text x="240" y="228" fill="var(--cyan)" fontFamily="var(--font-mono)" fontSize="10">
              run_31de07
            </text>
          </svg>

          <div className="ob-project-schematic">
            <div className="ob-project-sch-row">
              <span className="ob-project-sch-key">main</span>
              <span className="ob-project-sch-arrow">→</span>
              <span className="ob-project-sch-val">foundry/run_8f2c1a</span>
              <span className="ob-project-sch-tag ob-project-sch-tag-on">gates 4/4</span>
            </div>
            <div className="ob-project-sch-row">
              <span className="ob-project-sch-key">main</span>
              <span className="ob-project-sch-arrow">→</span>
              <span className="ob-project-sch-val">foundry/run_31de07</span>
              <span className="ob-project-sch-tag">$0.42</span>
            </div>
            <div className="ob-project-sch-row ob-project-sch-row-dim">
              <span className="ob-project-sch-key">main</span>
              <span className="ob-project-sch-arrow">→</span>
              <span className="ob-project-sch-val">foundry/run_…</span>
              <span className="ob-project-sch-tag">queued</span>
            </div>
          </div>

          <p className="ob-project-quote">
            Every run branches.
            <br />
            <span>Your checkout stays clean.</span>
          </p>

          <div className="ob-project-visual-foot">
            <span className="ob-project-foot-k">isolated</span>
            <span className="ob-project-foot-sep">·</span>
            <span className="ob-project-foot-k">inspectable</span>
            <span className="ob-project-foot-sep">·</span>
            <span className="ob-project-foot-k">merge on your terms</span>
          </div>
        </div>
      </aside>

      {/* right — the form */}
      <main className="ob-project-form">
        <header className="ob-project-head">
          <div className="ob-project-eyebrow">
            <span>First project</span>
            <span className="ob-project-eyebrow-sep" />
            <span className="ob-project-eyebrow-step">06 / 06</span>
          </div>
          <h1 className="ob-project-title">
            Point Foundry
            <br />
            at a repo.
          </h1>
          <p className="ob-project-lead">
            Foundry runs every change in an isolated git worktree and leaves the evidence behind — prompts, tools,
            gates, cost. Choose the repository it should start with.
          </p>
          <div className="ob-project-dots" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={i === 5 ? 'ob-project-dot ob-project-dot-on' : 'ob-project-dot'} />
            ))}
          </div>
        </header>

        {/* engineer */}
        <section className="ob-project-section">
          <div className="ob-project-section-head">
            <h2 className="ob-project-section-title">Your name</h2>
            <span className="ob-project-section-meta">recorded on every run</span>
          </div>
          <input
            className="ob-project-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            aria-describedby="ob-project-name-hint"
            autoComplete="name"
          />
          <p className="ob-project-hint" id="ob-project-name-hint">
            Recorded on every run as the engineer.
          </p>
        </section>

        {/* projects */}
        <section className="ob-project-section">
          <div className="ob-project-section-head">
            <h2 className="ob-project-section-title">Repository</h2>
            <span className="ob-project-section-meta">
              {projects.length === 0 ? 'none yet' : `${projects.length} local`}
            </span>
          </div>

          {projects.length ? (
            <>
              <p className="ob-project-hint" style={{ marginTop: 'var(--s2)' }}>
                Name is just for you — rename inline. Path is where Foundry runs.
              </p>
              <ul className="ob-project-list" role="radiogroup" aria-label="Projects">
                {projects.map((p) => {
                  const selected = p.id === selectedId;
                  const draft = nameDrafts[p.id] ?? p.name;
                  const isRenaming = renamingId === p.id;
                  return (
                    <li
                      key={p.id}
                      className={`ob-project-row ${selected ? 'on' : ''} ${isRenaming ? 'editing' : ''}`}
                    >
                      <label className="ob-project-radio-hit">
                        <input
                          type="radio"
                          name="onboarding-project"
                          className="ob-project-radio"
                          checked={selected}
                          onChange={() => {
                            setSelectedId(p.id);
                            selectProject(p.id);
                          }}
                        />
                        <span className="ob-project-radio-mark" aria-hidden="true" />
                      </label>

                      <span className="ob-project-main">
                        <input
                          className="ob-project-name-input"
                          value={draft}
                          onFocus={() => setRenamingId(p.id)}
                          onChange={(e) =>
                            setNameDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          onBlur={() => void commitProjectRename(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              setNameDrafts((prev) => ({ ...prev, [p.id]: p.name }));
                              setRenamingId(null);
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          placeholder="Project name"
                          aria-label={`Project name for ${p.path}`}
                          spellCheck={false}
                        />
                        <span className="ob-project-path mono faint" title={p.path}>
                          {p.path}
                        </span>
                      </span>

                      <button
                        type="button"
                        className="ob-project-remove"
                        disabled={busy}
                        onClick={(e) => {
                          e.preventDefault();
                          void removeProject(p.id);
                        }}
                        title="Remove from Foundry (repo on disk stays)"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="ob-project-empty">
              <svg
                className="ob-project-empty-icon"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                aria-hidden="true"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                <path d="M3 7.5 4.8 9.5H22" />
              </svg>
              <p className="ob-project-empty-title">No repositories yet</p>
              <p className="ob-project-empty-body">
                Pick a folder with a <code>.git</code> directory. Foundry never writes to your working tree — only to
                worktrees it creates.
              </p>
            </div>
          )}

          <button
            type="button"
            className="ob-project-add"
            disabled={busy}
            onClick={() => void addProject()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              aria-hidden="true"
            >
              <path d="M7 2.5v9M2.5 7h9" />
            </svg>
            {busy ? 'Opening…' : projects.length ? 'Add another repository…' : 'Choose a repository…'}
          </button>
        </section>

        {error ? (
          <div className="ob-project-error" role="alert">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              aria-hidden="true"
            >
              <path d="M12 3 2.5 19.5a1 1 0 0 0 .87 1.5h17.26a1 1 0 0 0 .87-1.5L12 3Z" />
              <path d="M12 9v6M12 17h.01" />
            </svg>
            <span>{error}</span>
          </div>
        ) : null}

        <footer className="ob-project-bar">
          <button type="button" className="ob-project-back" disabled={busy} onClick={back}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="M8.2 3 4.7 7l3.5 4" />
              <path d="M4.7 7H11.2" />
            </svg>
            Back
          </button>
          <div className="ob-project-bar-spacer">
            {!canEnterProject && projectBlockingHint ? (
              <span className="ob-project-gate">{projectBlockingHint}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="ob-project-cta"
            disabled={!canEnterProject}
            title={projectBlockingHint || undefined}
            onClick={() => void finish()}
          >
            {busy ? 'Saving…' : 'Enter Foundry'}
            {!busy ? (
              <svg
                width="15"
                height="15"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M5.8 3 9.3 7l-3.5 4" />
                <path d="M9.3 7H2.8" />
              </svg>
            ) : null}
          </button>
        </footer>
      </main>

      <style>{`
        .ob-project{
          flex:1; min-height:0; display:grid;
          grid-template-columns: minmax(0,0.92fr) minmax(0,1fr);
          background: transparent;
        }

        /* ── left visual ─────────────────────────────── */
        .ob-project-visual{
          position:relative; overflow:hidden;
          border-right:1px solid var(--line);
          background: color-mix(in srgb, var(--bg-void) 80%, transparent);
          display:flex; flex-direction:column;
          min-width:0;
        }
        .ob-project-visual-grid{
          position:absolute; inset:0;
          background-image:
            linear-gradient(to right, var(--line) 1px, transparent 1px),
            linear-gradient(to bottom, var(--line) 1px, transparent 1px);
          background-size: 64px 64px;
          mask-image: radial-gradient(circle at 30% 42%, #000 0%, transparent 78%);
          -webkit-mask-image: radial-gradient(circle at 30% 42%, #000 0%, transparent 78%);
          opacity: 0.7;
          pointer-events:none;
        }
        .ob-project-orb{
          position:absolute; border-radius: var(--r-full);
          filter: blur(80px); pointer-events:none;
        }
        .ob-project-orb-a{
          width: 420px; height: 420px; left:-90px; top: 6%;
          background: color-mix(in srgb, var(--cyan) 14%, transparent);
        }
        .ob-project-orb-b{
          width: 340px; height: 340px; right:-70px; bottom: 2%;
          background: color-mix(in srgb, var(--cyan) 7%, transparent);
        }
        .ob-project-orb::after{
          content:''; position:absolute; inset:0; border-radius:inherit;
          background: radial-gradient(closest-side, color-mix(in srgb, var(--cyan) 10%, transparent), transparent 70%);
        }
        .ob-project-visual-inner{
          position:relative; z-index:1;
          display:flex; flex-direction:column;
          flex:1; min-height:0;
          padding: var(--s6) var(--s8);
        }
        .ob-project-visual-label{
          font-family: var(--font-mono); font-size: var(--text-xs);
          letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--text-faint);
          padding-bottom: var(--s4);
          border-bottom: 1px solid var(--line);
        }
        .ob-project-tree{
          width: 100%; max-width: 420px; height: auto;
          margin: var(--s8) 0 var(--s6);
          flex-shrink:0;
        }
        .ob-project-node{
          filter: drop-shadow(0 0 10px color-mix(in srgb, var(--cyan) 55%, transparent));
        }
        .ob-project-node-lg{
          filter: drop-shadow(0 0 18px color-mix(in srgb, var(--cyan) 72%, transparent));
        }
        .ob-project-schematic{
          border-top: 1px solid var(--line);
          padding-top: var(--s5);
          display:flex; flex-direction:column; gap: var(--s2);
          font-family: var(--font-mono); font-size: var(--text-xs);
        }
        .ob-project-sch-row{
          display:flex; align-items:center; gap: var(--s2);
          white-space:nowrap; overflow:hidden;
        }
        .ob-project-sch-row-dim{ opacity: 0.42; }
        .ob-project-sch-key{ color: var(--text-dim); }
        .ob-project-sch-arrow{ color: var(--text-faint); }
        .ob-project-sch-val{ color: var(--text); overflow:hidden; text-overflow:ellipsis; }
        .ob-project-sch-tag{
          margin-left:auto; flex:none;
          color: var(--text-faint); letter-spacing: 0.06em;
        }
        .ob-project-sch-tag-on{ color: var(--cyan); }
        .ob-project-quote{
          margin: var(--s8) 0 0;
          font-size: var(--text-xl); line-height: var(--leading-tight);
          letter-spacing: -0.022em;
          color: var(--text-faint);
        }
        .ob-project-quote span{ color: var(--text-dim); }
        .ob-project-visual-foot{
          margin-top:auto; padding-top: var(--s6);
          display:flex; align-items:center; gap: var(--s2);
          font-family: var(--font-mono); font-size: 10px;
          letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--text-faint);
          border-top: 1px solid var(--line);
        }
        .ob-project-foot-sep{ opacity:0.5; }

        /* ── right form ──────────────────────────────── */
        .ob-project-form{
          display:flex; flex-direction:column;
          min-width:0; overflow:auto;
          padding: var(--s6) var(--s8) var(--s6);
        }
        .ob-project-head{
          padding-bottom: var(--s6);
        }
        .ob-project-eyebrow{
          display:flex; align-items:center; gap: var(--s3);
          font-family: var(--font-mono); font-size: var(--text-xs);
          letter-spacing: 0.2em; text-transform: uppercase;
          color: var(--text-faint);
        }
        .ob-project-eyebrow-sep{
          flex: 0 0 32px; height: 1px; background: var(--line-strong);
        }
        .ob-project-eyebrow-step{ color: var(--cyan); }
        .ob-project-title{
          margin: var(--s4) 0 0;
          font-size: clamp(1.9rem, 2.6vw, 2.5rem);
          line-height: 1.03; letter-spacing: -0.045em;
          font-weight: 600; color: var(--text);
        }
        .ob-project-lead{
          margin: var(--s4) 0 0; max-width: 44ch;
          font-size: var(--text-base); line-height: var(--leading-loose);
          color: var(--text-dim);
        }
        .ob-project-dots{
          display:flex; gap: var(--s2); margin-top: var(--s6);
        }
        .ob-project-dot{
          width: 18px; height: 2px; border-radius: var(--r-full);
          background: var(--line-strong);
        }
        .ob-project-dot-on{
          background: var(--cyan);
          box-shadow: 0 0 12px color-mix(in srgb, var(--cyan) 65%, transparent);
        }

        .ob-project-section{
          margin-top: var(--s6); padding-top: var(--s6);
          border-top: 1px solid var(--line);
        }
        .ob-project-section-head{
          display:flex; align-items:baseline; justify-content:space-between; gap: var(--s4);
        }
        .ob-project-section-title{
          margin:0; font-size: var(--text-sm); font-weight: 600;
          letter-spacing: 0.02em; color: var(--text);
        }
        .ob-project-section-meta{
          font-family: var(--font-mono); font-size: var(--text-xs);
          letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--text-faint);
        }
        .ob-project-input{
          margin-top: var(--s4); width: 100%;
          background: transparent; color: var(--text);
          border:0; border-bottom: 1px solid var(--line-strong);
          padding: var(--s3) 0;
          font-family: var(--font); font-size: var(--text-xl);
          letter-spacing: -0.02em; outline:none;
          transition: border-color 160ms var(--ease), box-shadow 160ms var(--ease);
        }
        .ob-project-input::placeholder{ color: var(--text-faint); }
        .ob-project-input:hover{ border-bottom-color: var(--text-faint); }
        .ob-project-input:focus{
          border-bottom-color: var(--cyan);
          box-shadow: 0 12px 24px -20px color-mix(in srgb, var(--cyan) 50%, transparent);
        }
        .ob-project-hint{
          margin: var(--s2) 0 0;
          font-size: var(--text-xs); color: var(--text-faint);
          letter-spacing: 0.01em; line-height: var(--leading);
        }

        /* flat list — hairline dividers only, no card */
        .ob-project-list{
          list-style:none; margin: var(--s4) 0 0; padding:0;
          border-top: 1px solid var(--line);
        }
        .ob-project-row{
          display:flex; align-items:flex-start; gap: var(--s3);
          padding: var(--s3) var(--s2) var(--s3) var(--s1);
          border-bottom: 1px solid var(--line);
          border-left: 1px solid transparent;
          transition: background 160ms var(--ease), border-color 160ms var(--ease), box-shadow 200ms var(--ease);
        }
        .ob-project-row:hover{ background: color-mix(in srgb, var(--bg-panel) 70%, transparent); }
        .ob-project-row.on{
          background: color-mix(in srgb, var(--bg-panel) 88%, var(--cyan-dim) 12%);
          border-left-color: var(--cyan);
          box-shadow: var(--glow-cyan);
        }
        .ob-project-radio-hit{
          position:relative; display:flex; align-items:center;
          cursor:pointer; padding-top: 4px; flex:0 0 auto;
        }
        .ob-project-radio{
          position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer;
        }
        .ob-project-radio-mark{
          width: 16px; height: 16px; border-radius: var(--r-full);
          border: 1.5px solid var(--line-strong);
          background: var(--bg-void);
          display:grid; place-items:center;
          transition: border-color 160ms var(--ease), box-shadow 160ms var(--ease), background 160ms var(--ease);
          flex:none;
        }
        .ob-project-radio-mark::after{
          content:''; width:7px; height:7px; border-radius: var(--r-full);
          background: var(--cyan); opacity:0; transform: scale(0.6);
          transition: opacity 140ms var(--ease), transform 140ms var(--ease);
        }
        .ob-project-row:hover .ob-project-radio-mark{ border-color: var(--text-dim); }
        .ob-project-row.on .ob-project-radio-mark{
          border-color: var(--cyan);
          box-shadow: 0 0 0 3px var(--cyan-dim);
        }
        .ob-project-row.on .ob-project-radio-mark::after{ opacity:1; transform: scale(1); }
        .ob-project-radio:focus-visible + .ob-project-radio-mark{
          outline: 1px solid var(--cyan); outline-offset: 3px;
        }
        .ob-project-main{
          flex:1 1 auto; min-width:0;
          display:flex; flex-direction:column; gap: 2px;
        }
        .ob-project-name-input{
          width:100%; background: transparent; border:0;
          border-bottom: 1px solid transparent;
          padding: 2px 0 3px; margin:0;
          color: var(--text); font-family: var(--font);
          font-size: var(--text-sm); font-weight: 500;
          letter-spacing: -0.01em; outline:none;
          transition: border-color 160ms var(--ease);
        }
        .ob-project-name-input:hover{ border-bottom-color: var(--line-strong); }
        .ob-project-name-input:focus{ border-bottom-color: var(--cyan); }
        .ob-project-path{
          font-size: 11px; font-family: var(--font-mono);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%;
        }
        .ob-project-remove{
          flex:0 0 auto; background: transparent; border:0; cursor:pointer;
          font-family: var(--font); font-size: var(--text-xs); letter-spacing: 0.06em;
          color: var(--text-faint);
          padding: var(--s1) var(--s2); border-radius: var(--r-sm);
          opacity:0;
          transition: opacity 160ms var(--ease), color 160ms var(--ease), background 160ms var(--ease);
        }
        .ob-project-row:hover .ob-project-remove,
        .ob-project-row.on .ob-project-remove,
        .ob-project-row.editing .ob-project-remove{ opacity:1; }
        .ob-project-remove:hover{ color: var(--red); background: var(--red-dim); }
        .ob-project-remove:disabled{ opacity:0.35; cursor:not-allowed; }

        /* empty */
        .ob-project-empty{
          margin-top: var(--s4); padding: var(--s8) 0;
          border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
          text-align:left;
        }
        .ob-project-empty-icon{ color: var(--text-faint); display:block; }
        .ob-project-empty-title{
          margin: var(--s3) 0 0;
          font-size: var(--text-base); font-weight: 600;
          letter-spacing:-0.02em; color: var(--text);
        }
        .ob-project-empty-body{
          margin: var(--s2) 0 0; max-width: 42ch;
          font-size: var(--text-sm); line-height: var(--leading-loose);
          color: var(--text-dim);
        }
        .ob-project-empty-body code{
          font-family: var(--font-mono); font-size: var(--text-xs); color: var(--cyan);
        }
        .ob-project-add{
          margin-top: var(--s5);
          display:inline-flex; align-items:center; gap: var(--s2);
          background: transparent; color: var(--text-dim); cursor:pointer;
          border: 1px dashed var(--line-strong); border-radius: var(--r-sm);
          padding: var(--s3) var(--s5);
          font-family: var(--font); font-size: var(--text-sm);
          transition: color 160ms var(--ease), border-color 160ms var(--ease), background 160ms var(--ease);
        }
        .ob-project-add:hover:not(:disabled){
          color: var(--text); border-color: var(--cyan);
          background: color-mix(in srgb, var(--bg-panel) 70%, transparent);
        }
        .ob-project-add:disabled{ opacity:0.55; cursor:progress; }

        .ob-project-error{
          margin-top: var(--s5);
          display:flex; align-items:center; gap: var(--s3);
          border-top: 1px solid var(--red);
          background: var(--red-dim);
          padding: var(--s3) var(--s4);
          color: var(--red); font-size: var(--text-sm);
          line-height: var(--leading);
        }

        .ob-project-bar{
          margin-top:auto; padding-top: var(--s6);
          border-top: 1px solid var(--line);
          display:flex; align-items:center; gap: var(--s3);
        }
        .ob-project-bar-spacer{ flex:1 1 auto; min-width:0; text-align:right; }
        .ob-project-gate{ font-size: var(--text-xs); color: var(--text-faint); }
        .ob-project-back{
          display:inline-flex; align-items:center; gap: var(--s2);
          background: transparent; border:0; cursor:pointer;
          color: var(--text-faint); font-family: var(--font); font-size: var(--text-sm);
          padding: var(--s2) var(--s3) var(--s2) 0;
          transition: color 160ms var(--ease);
        }
        .ob-project-back:hover:not(:disabled){ color: var(--text); }
        .ob-project-back:disabled{ opacity:0.4; cursor:not-allowed; }
        .ob-project-cta{
          display:inline-flex; align-items:center; gap: var(--s2);
          background: var(--cyan); color: #04212a; cursor:pointer;
          border:0; border-radius: var(--r-sm);
          padding: var(--s3) var(--s5);
          font-family: var(--font); font-size: var(--text-sm); font-weight: 600;
          letter-spacing: 0.01em;
          box-shadow: var(--glow-cyan);
          transition: transform 160ms var(--ease), box-shadow 200ms var(--ease), opacity 160ms var(--ease);
        }
        .ob-project-cta:hover:not(:disabled){
          transform: translateY(-1px);
          box-shadow: 0 0 0 1px var(--cyan), 0 0 34px color-mix(in srgb, var(--cyan) 38%, transparent);
        }
        .ob-project-cta:disabled{ opacity:0.34; box-shadow:none; cursor:not-allowed; }

        @media (max-width: 960px){
          .ob-project{ grid-template-columns: 1fr; }
          .ob-project-visual{
            border-right:0; border-bottom: 1px solid var(--line);
            min-height: 420px;
          }
          .ob-project-visual-inner{ padding: var(--s6) var(--s6); }
          .ob-project-tree{ max-width: 360px; margin: var(--s6) 0 var(--s4); }
          .ob-project-form{ padding: var(--s6) var(--s6) var(--s6); overflow: visible; }
          .ob-project-title{ font-size: 1.85rem; }
        }
        @media (max-width: 520px){
          .ob-project-bar{ flex-wrap:wrap; }
          .ob-project-bar-spacer{ flex-basis:100%; order:3; text-align:left; margin-top: var(--s2); }
        }
      `}</style>
    </div>
  );
}
