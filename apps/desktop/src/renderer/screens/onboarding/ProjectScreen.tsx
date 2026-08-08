import { useApp } from '../../stores/app.js';
import { useOnboarding } from './OnboardingContext.js';

export default function ProjectScreen(): React.JSX.Element {
  const { projects } = useApp();
  const { back, name, setName, selectedId, setSelectedId, nameDrafts, setNameDrafts, renamingId, setRenamingId, busy, error, addProject, removeProject, commitProjectRename, canEnterProject, projectBlockingHint, finish } = useOnboarding();
  const { selectProject } = useApp();
  return (
    <div className="ob-project">
      <div className="ob-project-media">
        <div className="ob-frame"><div className="ob-project-art">⬡</div></div>
        <p className="ob-caption faint">Every run branches. Your checkout stays clean.</p>
      </div>
      <div className="ob-project-copy">
        <p className="ob-eyebrow">First project</p>
        <h1 className="ob-title">Point Foundry at a repo</h1>
        <p className="ob-lead">Each run gets its own worktree and branch. Merge when you accept.{projects.length ? ' Pick the one to start in — you can change it later from the sidebar.' : ' Choose a git repository to get started.'}</p>
        <div className="ob-field">
          <label>Your name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="who is asking" />
          <span className="ob-hint">Recorded on every run as the engineer.</span>
        </div>
        {projects.length ? (
          <div className="ob-field">
            <label>Projects</label>
            <span className="ob-hint">Name is just for you — type whatever you want. The path is where Foundry runs.</span>
            <div className="ob-project-list" role="radiogroup" aria-label="Projects">
              {projects.map((p) => {
                const selected = p.id === selectedId;
                const draft = nameDrafts[p.id] ?? p.name;
                const isRenaming = renamingId === p.id;
                return (
                  <label key={p.id} className={`ob-project-row ${selected ? 'on' : ''} ${isRenaming ? 'editing' : ''}`}>
                    <input type="radio" name="onboarding-project" className="ob-project-radio" checked={selected} onChange={() => { setSelectedId(p.id); selectProject(p.id); }} />
                    <span className="ob-project-radio-mark" aria-hidden />
                    <span className="ob-project-main">
                      <input className="input ob-project-name-input" value={draft} onFocus={() => setRenamingId(p.id)} onChange={(e) => setNameDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))} onBlur={() => void commitProjectRename(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } else if (e.key === 'Escape') { setNameDrafts((prev) => ({ ...prev, [p.id]: p.name })); setRenamingId(null); (e.target as HTMLInputElement).blur(); } }} placeholder="Project name" aria-label={`Project name for ${p.path}`} />
                      <span className="faint mono ob-project-path" title={p.path}>{p.path}</span>
                    </span>
                    <button type="button" className="btn sm ghost ob-project-remove" disabled={busy} onClick={(e) => { e.preventDefault(); void removeProject(p.id); }} title="Remove from Foundry (repo on disk stays)">Remove</button>
                  </label>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="faint ob-empty">No projects yet. Pick a git repository below — Foundry isolates each run in a worktree, so the folder has to be a repo.</p>
        )}
        <button type="button" className="btn ob-project-btn" disabled={busy} onClick={() => void addProject()}>{busy ? 'Opening…' : projects.length ? 'Add another repository…' : 'Choose a repository…'}</button>
        {error && <p className="ob-err">{error}</p>}
        {!canEnterProject && projectBlockingHint && <p className="ob-hint faint">{projectBlockingHint}</p>}
        <div className="ob-foot"><button className="btn ghost" disabled={busy} onClick={back}>Back</button><span className="ob-grow" /><button className="btn primary" disabled={!canEnterProject} title={projectBlockingHint || undefined} onClick={() => void finish()}>{busy ? 'Saving…' : 'Enter Foundry'}</button></div>
      </div>
      <style>{`
        .ob-project{ flex:1; min-height:0; display:grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-project-media{ display:flex; flex-direction:column; gap: var(--s3); min-width:0; }
        .ob-frame{ position:relative; flex:1; min-height:280px; border-radius: calc(var(--r-lg) + 4px); border:1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow:hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); display:grid; place-items:center; }
        .ob-project-art{ font-size: 72px; opacity:0.3; }
        .ob-caption{ font-size: var(--text-sm); line-height: var(--leading); max-width:42ch; }
        .ob-project-copy{ display:flex; flex-direction:column; min-width:0; overflow:auto; }
        .ob-field{ display:flex; flex-direction:column; gap: var(--s1); margin: var(--s2) 0 var(--s4); }
        .ob-field label{ font-size: var(--text-sm); font-weight:500; }
        .ob-hint{ font-size: var(--text-xs); color: var(--text-faint); }
        .ob-project-list{ display:flex; flex-direction:column; gap: var(--s2); margin-top: var(--s1); }
        .ob-project-row{ display:flex; align-items:center; gap: var(--s3); padding: var(--s3) var(--s3); border:1px solid var(--line); border-radius: var(--r); background: var(--bg-raised); cursor: default; transition: border-color 140ms var(--ease), background 140ms var(--ease), box-shadow 140ms var(--ease); }
        .ob-project-row:hover{ border-color: var(--line-strong); background: var(--bg-hover); }
        .ob-project-row.on{ border-color: var(--cyan); box-shadow: var(--glow-cyan); background: color-mix(in srgb, var(--bg-raised) 88%, var(--cyan-dim) 12%); }
        .ob-project-radio{ position:absolute; opacity:0; pointer-events:none; width:0; height:0; }
        .ob-project-radio-mark{ flex:none; width:16px; height:16px; border-radius: var(--r-full); border:1.5px solid var(--line-strong); background: var(--bg-void); display:grid; place-items:center; }
        .ob-project-radio-mark::after{ content:''; width:7px; height:7px; border-radius: var(--r-full); background: var(--cyan); opacity:0; transform: scale(0.6); transition: opacity 140ms var(--ease), transform 140ms var(--ease); }
        .ob-project-row.on .ob-project-radio-mark{ border-color: var(--cyan); box-shadow: 0 0 0 3px var(--cyan-dim); }
        .ob-project-row.on .ob-project-radio-mark::after{ opacity:1; transform: scale(1); }
        .ob-project-main{ flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
        .ob-project-name-input{ font-size: var(--text-sm); font-weight:500; }
        .ob-project-path{ font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .ob-empty{ font-size: var(--text-sm); line-height: var(--leading); margin: var(--s1) 0 var(--s2); }
        .ob-project-btn{ align-self:flex-start; margin-top: var(--s2); }
        .ob-err{ margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        @media (max-width: 960px){ .ob-project{ grid-template-columns:1fr; } }
      `}</style>
    </div>
  );
}
