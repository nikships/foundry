import type { LinearIssueSnapshot } from './types.js';

const MAX_BRIEF_DESCRIPTION_CHARS = 32_000;

/** The exact Linear snapshot text both planning and run start operate on. */
export function linearIssueBrief(issue: LinearIssueSnapshot): string {
  const description =
    issue.description.length > MAX_BRIEF_DESCRIPTION_CHARS
      ? `${issue.description.slice(0, MAX_BRIEF_DESCRIPTION_CHARS)}\n\n[Linear description truncated for the run brief]`
      : issue.description;
  return [`Implement ${issue.identifier}: ${issue.title}`, description, `Source: ${issue.url}`]
    .filter(Boolean)
    .join('\n\n');
}
