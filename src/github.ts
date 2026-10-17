import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { PRInfo } from "./types";

const API = "https://api.github.com";

function headers(accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-courtroom",
  };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

async function gh(path: string, init: RequestInit = {}, accept?: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(accept), ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub PR URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export async function getPR(owner: string, repo: string, number: number): Promise<PRInfo> {
  const pr: any = await (await gh(`/repos/${owner}/${repo}/pulls/${number}`)).json();
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
  };
}

export async function getDiff(pr: PRInfo): Promise<string> {
  return (await gh(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {}, "application/vnd.github.diff")).text();
}

/** Downloaded on the host so the GitHub token never enters a sandbox. */
export async function getTarball(pr: PRInfo, sha: string): Promise<ArrayBuffer> {
  // The head commit may live in a fork; the base repo serves PR head commits too.
  return (await gh(`/repos/${pr.owner}/${pr.repo}/tarball/${sha}`)).arrayBuffer();
}

export const canWrite = () => Boolean(config.githubToken);

export async function upsertComment(pr: PRInfo, body: string, commentId?: number): Promise<number | undefined> {
  if (!canWrite()) return undefined;
  const path = commentId
    ? `/repos/${pr.owner}/${pr.repo}/issues/comments/${commentId}`
    : `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const res = await gh(path, { method: commentId ? "PATCH" : "POST", body: JSON.stringify({ body }) });
  return ((await res.json()) as any).id;
}

export async function setStatus(
  pr: PRInfo,
  state: "pending" | "success" | "failure" | "error",
  description: string,
  targetUrl: string,
): Promise<void> {
  if (!canWrite()) return;
  await gh(`/repos/${pr.owner}/${pr.repo}/statuses/${pr.head_sha}`, {
    method: "POST",
    body: JSON.stringify({ state, description: description.slice(0, 139), context: "agent-courtroom", target_url: targetUrl }),
  });
}

export function verifySignature(body: string, signature: string | null): boolean {
  if (!config.webhookSecret) return true;
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
