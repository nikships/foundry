/**
 * The stable ordinary pipeline id shown in the export sheet and written by
 * main. Generated ids carry a planning-session id; exported entities must not.
 */
export function exportedPipelineId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'orchestrated-pipeline';
  return /^[a-z]/.test(slug) ? slug : `pipeline-${slug}`;
}
