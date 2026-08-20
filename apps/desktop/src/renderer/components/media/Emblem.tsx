import { EMBLEM_BY_ID, type EmblemDef } from '../../data/emblems.js';

/**
 * One renderer for the whole library: every mark is stroke-only on a 24 grid,
 * so size is the only thing that changes between a 14px lane and a 44px editor.
 */
export function Emblem({
  emblem,
  id,
  size = 18,
  className,
}: {
  emblem?: EmblemDef;
  id?: string;
  size?: number;
  className?: string;
}): React.JSX.Element | null {
  const def = emblem ?? (id ? EMBLEM_BY_ID[id] : undefined);
  if (!def) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {def.paths?.map((d) => (
        <path key={d} d={d} />
      ))}
      {def.circles?.map((c) => (
        <circle key={`${c.cx}-${c.cy}-${c.r}`} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
    </svg>
  );
}
