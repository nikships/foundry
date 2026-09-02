import type {
  LinearIssueComment,
  LinearIssueSnapshot,
  LinearWorkflowState,
} from '@shared/types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const RETRYABLE_GRAPHQL = new Set(['INTERNAL_SERVER_ERROR', 'RATELIMITED', 'RATE_LIMITED']);
const MAX_DESCRIPTION_CHARS = 100_000;

interface GraphqlError {
  message?: unknown;
  extensions?: { code?: unknown };
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlError[];
}

interface RequestFailure {
  ok: false;
  error: LinearApiError;
  retryable: boolean;
  retryAfterMs?: number;
}

type RequestResult<T> = { ok: true; data: T } | RequestFailure;

export interface LinearTransportResponse {
  status: number;
  body: string;
  retryAfterMs?: number;
}

export type LinearTransport = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<LinearTransportResponse>;

export interface LinearClientOptions {
  apiKey: string;
  transport?: LinearTransport;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'api' | 'network' | 'invalid_response',
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

interface RawComment {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  user?: { name?: unknown } | null;
}

interface RawIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  team?: { id?: unknown; name?: unknown } | null;
  state?: { id?: unknown; name?: unknown; type?: unknown } | null;
  labels?: { nodes?: { name?: unknown }[] | null } | null;
  parent?: { identifier?: unknown; title?: unknown } | null;
  comments?: {
    nodes?: RawComment[] | null;
    pageInfo?: { hasNextPage?: unknown } | null;
  } | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  updatedAt
  team { id name }
  state { id name type }
  labels { nodes { name } }
  parent { identifier title }
  comments(first: 20, orderBy: updatedAt) {
    nodes {
      id
      body
      createdAt
      user { name }
    }
    pageInfo { hasNextPage }
  }
`;

const VIEWER_QUERY = `query LinearViewer { viewer { id name } }`;
const ISSUE_QUERY = `query LinearIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
const RECENT_ISSUES_QUERY = `query LinearIssues { issues(first: 25) { nodes { ${ISSUE_FIELDS} } } }`;
const SEARCH_ISSUES_QUERY = `
  query LinearIssues($query: String!) {
    issues(first: 25, filter: { or: [
      { identifier: { containsIgnoreCase: $query } },
      { title: { containsIgnoreCase: $query } }
    ] }) { nodes { ${ISSUE_FIELDS} } }
  }
`;
const WORKFLOW_STATES_QUERY = `
  query LinearWorkflowStates($teamId: ID!) {
    workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name type }
    }
  }
`;
const UPDATE_ISSUE_STATE = `
  mutation LinearIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`;

export class LinearClient {
  private readonly transport: LinearTransport;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LinearClientOptions) {
    this.transport = options.transport ?? fetchTransport;
    this.retries = options.retries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async test(): Promise<{ id: string; name: string }> {
    const data = await this.request<{ viewer?: { id?: unknown; name?: unknown } }>(
      VIEWER_QUERY,
      {},
    );
    const id = stringField(data.viewer?.id, 'viewer.id');
    const name = stringField(data.viewer?.name, 'viewer.name');
    return { id, name };
  }

  async issue(id: string): Promise<LinearIssueSnapshot | null> {
    const data = await this.request<{ issue?: RawIssue | null }>(ISSUE_QUERY, { id });
    return data.issue ? parseIssue(data.issue) : null;
  }

  async issues(query = ''): Promise<LinearIssueSnapshot[]> {
    const trimmed = query.trim();
    const data = await this.request<{ issues?: { nodes?: RawIssue[] } }>(
      trimmed ? SEARCH_ISSUES_QUERY : RECENT_ISSUES_QUERY,
      trimmed ? { query: trimmed } : {},
    );
    if (!Array.isArray(data.issues?.nodes)) {
      throw new LinearApiError('Linear returned no issue list', 'invalid_response');
    }
    return data.issues.nodes.map(parseIssue);
  }

  async workflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.request<{
      workflowStates?: { nodes?: { id?: unknown; name?: unknown; type?: unknown }[] };
    }>(WORKFLOW_STATES_QUERY, { teamId });
    if (!Array.isArray(data.workflowStates?.nodes)) {
      throw new LinearApiError('Linear returned no workflow states', 'invalid_response');
    }
    return data.workflowStates.nodes.map((state) => ({
      id: stringField(state.id, 'workflowState.id'),
      name: stringField(state.name, 'workflowState.name'),
      type: stringField(state.type, 'workflowState.type'),
    }));
  }

  async updateIssueState(issueId: string, stateId: string): Promise<LinearIssueSnapshot> {
    const data = await this.request<{
      issueUpdate?: { success?: unknown; issue?: RawIssue | null };
    }>(UPDATE_ISSUE_STATE, { issueId, stateId });
    if (data.issueUpdate?.success !== true || !data.issueUpdate.issue) {
      throw new LinearApiError('Linear did not update the issue status', 'api');
    }
    return parseIssue(data.issueUpdate.issue);
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: LinearApiError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let result: RequestResult<T>;
      try {
        const response = await this.transport({
          url: LINEAR_GRAPHQL_URL,
          headers: {
            Authorization: this.options.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        });
        result = requestResult<T>(response);
      } catch (error) {
        if (error instanceof LinearApiError) throw error;
        result = {
          ok: false,
          error: new LinearApiError(`Could not reach Linear: ${errorMessage(error)}`, 'network'),
          retryable: true,
        };
      }
      if (result.ok) return result.data;
      lastError = result.error;
      if (!result.retryable || attempt === this.retries) throw result.error;
      await this.sleep(result.retryAfterMs ?? retryDelay(attempt));
    }
    throw lastError ?? new LinearApiError('Could not reach Linear', 'network');
  }
}

function requestResult<T>(response: LinearTransportResponse): RequestResult<T> {
  const failure = httpFailure(response);
  if (failure) return failure;
  const envelope = parseEnvelope<T>(response.body);
  const graphqlError = envelope.errors?.[0];
  if (graphqlError) return graphqlFailure(graphqlError);
  if (envelope.data === undefined) {
    throw new LinearApiError('Linear returned no data', 'invalid_response');
  }
  return { ok: true, data: envelope.data };
}

function httpFailure(response: LinearTransportResponse): RequestFailure | null {
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: new LinearApiError('Linear rejected the API key', 'auth'),
      retryable: false,
    };
  }
  if (RETRYABLE_HTTP.has(response.status)) {
    return {
      ok: false,
      error: new LinearApiError(
        response.status === 429 ? 'Linear rate limit reached' : 'Linear is temporarily unavailable',
        response.status === 429 ? 'rate_limit' : 'network',
      ),
      retryable: true,
      retryAfterMs: response.retryAfterMs,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: new LinearApiError(`Linear request failed (HTTP ${response.status})`, 'api'),
      retryable: false,
    };
  }
  return null;
}

function graphqlFailure(error: GraphqlError): RequestFailure {
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code : 'GRAPHQL_ERROR';
  const message =
    typeof error.message === 'string' ? error.message : 'Linear returned a GraphQL error';
  return {
    ok: false,
    error: new LinearApiError(message, graphqlErrorKind(code)),
    retryable: RETRYABLE_GRAPHQL.has(code),
  };
}

function graphqlErrorKind(code: string): LinearApiError['kind'] {
  if (code === 'AUTHENTICATION_ERROR') return 'auth';
  if (code.includes('RATE')) return 'rate_limit';
  return RETRYABLE_GRAPHQL.has(code) ? 'network' : 'api';
}

function parseEnvelope<T>(body: string): GraphqlEnvelope<T> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as GraphqlEnvelope<T>;
  } catch {
    throw new LinearApiError('Linear returned invalid JSON', 'invalid_response');
  }
}

function parseIssue(issue: RawIssue): LinearIssueSnapshot {
  const description =
    issue.description == null ? '' : stringField(issue.description, 'issue.description');
  const { comments, commentsTruncated } = parseComments(issue.comments);
  return {
    id: stringField(issue.id, 'issue.id'),
    identifier: stringField(issue.identifier, 'issue.identifier'),
    title: stringField(issue.title, 'issue.title'),
    description:
      description.length > MAX_DESCRIPTION_CHARS
        ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n\n[Linear description truncated — ${description.length - MAX_DESCRIPTION_CHARS} chars omitted]`
        : description,
    url: stringField(issue.url, 'issue.url'),
    updatedAt: stringField(issue.updatedAt, 'issue.updatedAt'),
    team: {
      id: stringField(issue.team?.id, 'issue.team.id'),
      name: stringField(issue.team?.name, 'issue.team.name'),
    },
    state: {
      id: stringField(issue.state?.id, 'issue.state.id'),
      name: stringField(issue.state?.name, 'issue.state.name'),
      type: stringField(issue.state?.type, 'issue.state.type'),
    },
    labels: parseLabels(issue.labels),
    parent: parseParent(issue.parent),
    comments,
    commentsTruncated,
  };
}

function parseLabels(labels: RawIssue['labels']): string[] {
  const nodes = labels?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (typeof node?.name === 'string' ? node.name.trim() : ''))
    .filter(Boolean);
}

function parseParent(parent: RawIssue['parent']): LinearIssueSnapshot['parent'] {
  if (!parent) return null;
  const identifier = typeof parent.identifier === 'string' ? parent.identifier : '';
  const title = typeof parent.title === 'string' ? parent.title : '';
  if (!identifier || !title) return null;
  return { identifier, title };
}

function parseComments(comments: RawIssue['comments']): {
  comments: LinearIssueComment[];
  commentsTruncated: boolean;
} {
  if (!comments) return { comments: [], commentsTruncated: false };
  const nodes = Array.isArray(comments.nodes) ? comments.nodes : [];
  return {
    comments: nodes.map(parseComment),
    commentsTruncated: comments.pageInfo?.hasNextPage === true,
  };
}

function parseComment(comment: RawComment): LinearIssueComment {
  const author =
    typeof comment.user?.name === 'string' && comment.user.name.trim()
      ? comment.user.name.trim()
      : 'unknown';
  return {
    id: stringField(comment.id, 'comment.id'),
    body: comment.body == null ? '' : optionalText(comment.body, 'comment.body'),
    createdAt: stringField(comment.createdAt, 'comment.createdAt'),
    author,
  };
}

function optionalText(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new LinearApiError(`Linear returned an invalid ${name}`, 'invalid_response');
  }
  return value;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new LinearApiError(`Linear returned an invalid ${name}`, 'invalid_response');
  }
  return value;
}

function retryDelay(attempt: number): number {
  return 250 * 2 ** attempt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

const fetchTransport: LinearTransport = async (input) => {
  const response = await fetch(input.url, {
    method: 'POST',
    headers: input.headers,
    body: input.body,
    signal: AbortSignal.timeout(15_000),
  });
  const retryAfter = response.headers.get('retry-after');
  const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  return {
    status: response.status,
    body: await response.text(),
    ...(Number.isFinite(retrySeconds) ? { retryAfterMs: retrySeconds * 1000 } : {}),
  };
};
