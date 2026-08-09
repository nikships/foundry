import NewProjectWizard from '../../components/NewProjectWizard.js';
import { useApp } from '../../stores/app.js';
import { useOnboarding } from './OnboardingContext.js';
import { StepFooter } from './shared.js';
import styles from './ProjectScreen.module.css';

export default function ProjectScreen(): React.JSX.Element {
  const { projects } = useApp();
  const {
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
    creatingProject,
    startCreateProject,
    cancelCreateProject,
    projectCreated,
    removeProject,
    commitProjectRename,
    canEnterProject,
    projectBlockingHint,
    finish,
  } = useOnboarding();
  const { selectProject } = useApp();

  return (
    <div className={styles.obProject}>
      {/* left — atmospheric worktree visual */}
      <aside className={styles.obProjectDiagram} aria-hidden="true">
        <div className={styles.obProjectDiagramGrid} />

        <div className={styles.obProjectDiagramInner}>
          <div className={styles.obProjectDiagramLabel}>worktree topology</div>

          <svg
            className={styles.obProjectTree}
            viewBox="0 0 460 520"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="obp-fade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.06" />
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
              <circle
                key={y}
                cx="42"
                cy={y}
                r="3"
                fill="var(--bg-void)"
                stroke="var(--line-strong)"
              />
            ))}
            <circle
              cx="168"
              cy="120"
              r="4.5"
              fill="var(--accent)"
              className={styles.obProjectNode}
            />
            <circle
              cx="232"
              cy="224"
              r="6"
              fill="var(--accent)"
              className={`${styles.obProjectNode} ${styles.obProjectNodeLg}`}
            />
            <circle
              cx="168"
              cy="320"
              r="4.5"
              fill="var(--accent)"
              className={styles.obProjectNode}
            />
            <circle cx="148" cy="410" r="3.5" fill="var(--bg-void)" stroke="var(--line-strong)" />
            <circle cx="356" cy="150" r="3.5" fill="var(--bg-void)" stroke="var(--line-strong)" />
            <text
              x="58"
              y="44"
              fill="var(--text-faint)"
              fontFamily="var(--font-mono)"
              fontSize="10"
              letterSpacing="0.06em"
            >
              main
            </text>
            <text
              x="176"
              y="124"
              fill="var(--text-faint)"
              fontFamily="var(--font-mono)"
              fontSize="10"
            >
              run_8f2c1a
            </text>
            <text x="240" y="228" fill="var(--accent)" fontFamily="var(--font-mono)" fontSize="10">
              run_31de07
            </text>
          </svg>

          <div className={styles.obProjectSchematic}>
            <div className={styles.obProjectSchematicRow}>
              <span className={styles.obProjectSchematicKey}>main</span>
              <span className={styles.obProjectSchematicArrow}>→</span>
              <span className={styles.obProjectSchematicVal}>foundry/run_8f2c1a</span>
              <span className={`${styles.obProjectSchematicTag} ${styles.obProjectSchematicTagOn}`}>
                gates 4/4
              </span>
            </div>
            <div className={styles.obProjectSchematicRow}>
              <span className={styles.obProjectSchematicKey}>main</span>
              <span className={styles.obProjectSchematicArrow}>→</span>
              <span className={styles.obProjectSchematicVal}>foundry/run_31de07</span>
              <span className={styles.obProjectSchematicTag}>$0.42</span>
            </div>
            <div className={`${styles.obProjectSchematicRow} ${styles.obProjectSchematicRowDim}`}>
              <span className={styles.obProjectSchematicKey}>main</span>
              <span className={styles.obProjectSchematicArrow}>→</span>
              <span className={styles.obProjectSchematicVal}>foundry/run_…</span>
              <span className={styles.obProjectSchematicTag}>queued</span>
            </div>
          </div>

          <p className={styles.obProjectQuote}>
            Every run branches.
            <br />
            <span>Your checkout stays clean.</span>
          </p>

          <div className={styles.obProjectDiagramFoot}>
            <span className={styles.obProjectFootK}>isolated</span>
            <span className={styles.obProjectFootSep}>·</span>
            <span className={styles.obProjectFootK}>inspectable</span>
            <span className={styles.obProjectFootSep}>·</span>
            <span className={styles.obProjectFootK}>merge on your terms</span>
          </div>
        </div>
      </aside>

      {/* right — the form */}
      <main className={styles.obProjectForm}>
        <header className={styles.obProjectHead}>
          <div className={`${styles.obProjectEyebrow} eyebrow`}>
            <span className="index">06</span>First project
            <span className={styles.obProjectEyebrowSep} />
            <span className={styles.obProjectEyebrowStep}>06 / 06</span>
          </div>
          <h1 className={styles.obProjectTitle}>
            Point Foundry
            <br />
            at a repo.
          </h1>
          <p className={styles.obProjectLead}>
            Foundry runs every change in an isolated git worktree and leaves the evidence behind —
            prompts, tools, gates, cost. Choose the repository it should start with.
          </p>
        </header>

        {/* engineer */}
        <section className={styles.obProjectSection}>
          <div className={styles.obProjectSectionHead}>
            <h2 className={styles.obProjectSectionTitle}>Your name</h2>
            <span className={styles.obProjectSectionMeta}>recorded on every run</span>
          </div>
          <input
            className={styles.obProjectInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            aria-describedby="ob-project-name-hint"
            autoComplete="name"
          />
          <p className={styles.obProjectHint} id="ob-project-name-hint">
            Recorded on every run as the engineer.
          </p>
        </section>

        {/* projects */}
        <section className={styles.obProjectSection}>
          <div className={styles.obProjectSectionHead}>
            <h2 className={styles.obProjectSectionTitle}>Repository</h2>
            <span className={styles.obProjectSectionMeta}>
              {projects.length === 0 ? 'none yet' : `${projects.length} local`}
            </span>
          </div>

          {projects.length ? (
            <>
              <p className={styles.obProjectHint} style={{ marginTop: 'var(--s2)' }}>
                Name is just for you — rename inline. Path is where Foundry runs.
              </p>
              <ul className={styles.obProjectList} role="radiogroup" aria-label="Projects">
                {projects.map((p) => {
                  const selected = p.id === selectedId;
                  const draft = nameDrafts[p.id] ?? p.name;
                  const isRenaming = renamingId === p.id;
                  return (
                    <li
                      key={p.id}
                      className={`${styles.obProjectRow} ${selected ? styles.on : ''} ${isRenaming ? styles.editing : ''}`}
                    >
                      <label className={styles.obProjectRadioHit}>
                        <input
                          type="radio"
                          name="onboarding-project"
                          className={styles.obProjectRadio}
                          checked={selected}
                          onChange={() => {
                            setSelectedId(p.id);
                            selectProject(p.id);
                          }}
                        />
                        <span className={styles.obProjectRadioMark} aria-hidden="true" />
                      </label>

                      <span className={styles.obProjectMain}>
                        <input
                          className={styles.obProjectNameInput}
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
                        <span className={`${styles.obProjectPath} mono faint`} title={p.path}>
                          {p.path}
                        </span>
                      </span>

                      <button
                        type="button"
                        className={styles.obProjectRemove}
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
            <div className={styles.obProjectEmpty}>
              <svg
                className={styles.obProjectEmptyIcon}
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
              <p className={styles.obProjectEmptyTitle}>No repositories yet</p>
              <p className={styles.obProjectEmptyBody}>
                Pick a folder with a <code>.git</code> directory, or have Foundry create a new
                repository on GitHub. Foundry never writes to your working tree — only to worktrees
                it creates.
              </p>
            </div>
          )}

          <div className={styles.obProjectActions}>
            <button
              type="button"
              className={styles.obProjectAdd}
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
              {busy
                ? 'Opening…'
                : projects.length
                  ? 'Add another repository…'
                  : 'Choose a repository…'}
            </button>

            <button
              type="button"
              className={styles.obProjectAdd}
              disabled={busy}
              onClick={startCreateProject}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden="true"
              >
                <path d="M12 3a9 9 0 0 0-2.85 17.54c.45.08.62-.2.62-.44v-1.7c-2.5.55-3.03-1.06-3.03-1.06-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.07 1.38.93 1.38.93.8 1.38 2.11.98 2.63.75.08-.58.31-.98.57-1.2-2-.23-4.1-1-4.1-4.45 0-.98.35-1.79.93-2.42-.1-.23-.4-1.15.08-2.4 0 0 .76-.24 2.48.92a8.6 8.6 0 0 1 4.52 0c1.72-1.16 2.47-.92 2.47-.92.49 1.25.18 2.17.09 2.4.58.63.93 1.44.93 2.42 0 3.46-2.11 4.22-4.12 4.44.32.28.61.83.61 1.68v2.5c0 .24.16.52.62.43A9 9 0 0 0 12 3Z" />
              </svg>
              Create a new project…
            </button>
          </div>
        </section>

        {error ? (
          <div className={styles.obProjectError} role="alert">
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

        <StepFooter
          nextLabel="Enter Foundry"
          onNext={() => void finish()}
          nextDisabled={!canEnterProject}
          nextTitle={projectBlockingHint || undefined}
          busy={busy}
          hint={!canEnterProject ? projectBlockingHint : undefined}
        />
      </main>

      {creatingProject && (
        <NewProjectWizard
          onClose={cancelCreateProject}
          onCreated={async (project) => {
            await projectCreated(project);
          }}
        />
      )}
    </div>
  );
}
