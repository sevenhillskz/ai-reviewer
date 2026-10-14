// Minimal GitHub REST client for PR review.

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

export class GitHub {
  constructor(token, repoFull) {
    if (!token) throw new Error('GITHUB_TOKEN не задан');
    this.token = token;
    [this.owner, this.repo] = repoFull.split('/');
  }

  async req(method, path, { body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${t.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return res.text();
    return res.status === 204 ? null : res.json();
  }

  async paginate(path) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await this.req('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  get base() { return `/repos/${this.owner}/${this.repo}`; }

  getPull(n) { return this.req('GET', `${this.base}/pulls/${n}`); }
  getPullDiff(n) { return this.req('GET', `${this.base}/pulls/${n}`, { accept: 'application/vnd.github.v3.diff', raw: true }); }
  listReviewComments(n) { return this.paginate(`${this.base}/pulls/${n}/comments`); }
  listIssueComments(n) { return this.paginate(`${this.base}/issues/${n}/comments`); }

  createReview(n, { commitId, body, comments }) {
    return this.req('POST', `${this.base}/pulls/${n}/reviews`, {
      body: { commit_id: commitId, event: 'COMMENT', body, comments },
    });
  }

  async upsertIssueComment(n, marker, body) {
    const existing = (await this.listIssueComments(n)).find((c) => c.user?.type === 'Bot' && c.body?.includes(marker));
    if (existing) return this.req('PATCH', `${this.base}/issues/comments/${existing.id}`, { body: { body } });
    return this.req('POST', `${this.base}/issues/${n}/comments`, { body: { body } });
  }

  react(commentId, content = 'eyes') {
    return this.req('POST', `${this.base}/issues/comments/${commentId}/reactions`, { body: { content } }).catch(() => null);
  }
}
