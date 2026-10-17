import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { PRInfo } from "./types";

const API = "https://api.github.com";

export interface RepoSummary {
  full_name: string;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  language: string | null;
  pushed_at: string;
}

export interface PullSummary {
  number: number;
  title: string;
  html_url: string;
  author: string;
  updated_at: string;
  draft: boolean;
  repo: string;
}

export interface GitHubClient {
  canWrite(): boolean;
  getPR(owner: string, repo: string, number: number): Promise<PRInfo>;
  getDiff(pr: PRInfo): Promise<string>;
  getTarball(pr: PRInfo, sha: string): Promise<ArrayBuffer>;
  upsertComment(pr: PRInfo, body: string, commentId?: number): Promise<number | undefined>;
  setStatus(pr: PRInfo, state: "pending" | "success" | "failure" | "error", description: string, targetUrl: string): Promise<void>;
  getUser(): Promise<{ login: string; avatar_url: string; name: string | null }>;
  listRepos(page?: number): Promise<RepoSummary[]>;
  listPulls(owner: string, repo: string): Promise<PullSummary[]>;
  searchMyOpenPRs(login: string): Promise<PullSummary[]>;
}

/** A GitHub REST client bound to one token: the server's (webhooks) or a signed-in user's. */
export function github(token?: string): GitHubClient {
  const headers = (accept = "application/vnd.github+json"): Record<string, string> => ({
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-courtroom",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function gh(path: string, init: RequestInit = {}, accept?: string): Promise<Response> {
    const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(accept), ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }
  const json = async (path: string) => (await gh(path)).json() as Promise<any>;

  return {
    canWrite: () => Boolean(token),

    async getPR(owner, repo, number) {
      const pr = await json(`/repos/${owner}/${repo}/pulls/${number}`);
      return {
        owner,
        repo,
        number,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        html_url: pr.html_url,
        head_sha: pr.head.sha,
        base_sha: pr.base.sha,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        private: Boolean(pr.base?.repo?.private),
      };
    },

    async getDiff(pr) {
      return (await gh(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {}, "application/vnd.github.diff")).text();
    },

    /** Downloaded on the host so the token never enters a sandbox. The base repo serves fork head commits too. */
    async getTarball(pr, sha) {
      return (await gh(`/repos/${pr.owner}/${pr.repo}/tarball/${sha}`)).arrayBuffer();
    },

    async upsertComment(pr, body, commentId) {
      if (!token) return undefined;
      const path = commentId
        ? `/repos/${pr.owner}/${pr.repo}/issues/comments/${commentId}`
        : `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
      const res = await gh(path, { method: commentId ? "PATCH" : "POST", body: JSON.stringify({ body }) });
      return ((await res.json()) as any).id;
    },

    async setStatus(pr, state, description, targetUrl) {
      if (!token) return;
      await gh(`/repos/${pr.owner}/${pr.repo}/statuses/${pr.head_sha}`, {
        method: "POST",
        body: JSON.stringify({ state, description: description.slice(0, 139), context: "agent-courtroom", target_url: targetUrl }),
      });
    },

    async getUser() {
      const u = await json("/user");
      return { login: u.login, avatar_url: u.avatar_url, name: u.name ?? null };
    },

    async listRepos(page = 1) {
      const repos: any[] = await json(
        `/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member&per_page=50&page=${page}`,
      );
      return repos.map((r) => ({
        full_name: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        description: r.description ?? "",
        language: r.language,
        pushed_at: r.pushed_at,
      }));
    },

    async listPulls(owner, repo) {
      const pulls: any[] = await json(`/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
      return pulls.map((p) => ({
        number: p.number,
        title: p.title,
        html_url: p.html_url,
        author: p.user?.login ?? "unknown",
        updated_at: p.updated_at,
        draft: Boolean(p.draft),
        repo: `${owner}/${repo}`,
      }));
    },

    async searchMyOpenPRs(login) {
      const q = encodeURIComponent(`is:pr is:open author:${login}`);
      const res = await json(`/search/issues?q=${q}&sort=updated&order=desc&per_page=50`);
      return (res.items ?? []).map((i: any) => ({
        number: i.number,
        title: i.title,
        html_url: i.html_url,
        author: i.user?.login ?? login,
        updated_at: i.updated_at,
        draft: Boolean(i.draft),
        repo: String(i.repository_url ?? "").replace(`${API}/repos/`, ""),
      }));
    },
  };
}

/** The server-wide client used by the GitHub webhook flow. */
export const serverGitHub = github(config.githubToken || undefined);

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub PR URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export function verifySignature(body: string, signature: string | null): boolean {
  if (!config.webhookSecret) return true;
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
