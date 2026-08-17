/**
 * Live deployment status — "did anything fail, and how long since it last shipped?"
 *
 * Provider-agnostic. Two adapters:
 *   - vercel    : calls the Vercel API for the latest deployment of a project/target.
 *                 1ops uses its OWN token (process.env.VERCEL_TOKEN) — the playbook
 *                 stores only a pointer (provider + projectId), never the token.
 *   - statusUrl : GETs a JSON endpoint that returns this contract (or a Vercel-ish
 *                 body). Lets any platform — or a test source — report in.
 * Falls back to inline last-known fields on the playbook, else "unknown".
 *
 * Read-only and defensive: any failure becomes state "unknown" with a reason,
 * never a thrown error — a broken probe must not take down the Flow page.
 */

import type { DeployInfo } from "./schema";

export type DeployState = "ready" | "building" | "queued" | "canceled" | "error" | "unknown";

export interface DeployStatus {
  state: DeployState;
  deployedAt?: string; // ISO of the latest deploy
  ageMs?: number; // now - deployedAt
  url?: string;
  commit?: string;
  commitMessage?: string;
  source: "vercel" | "statusUrl" | "inline" | "none";
  reason?: string;
}

const TIMEOUT_MS = 4000;

/** Map Vercel's READY/ERROR/BUILDING/… onto our lowercase states. */
function normalizeState(s: unknown): DeployState {
  const v = String(s ?? "").toUpperCase();
  if (v === "READY") return "ready";
  if (v === "ERROR") return "error";
  if (v === "BUILDING" || v === "INITIALIZING") return "building";
  if (v === "QUEUED") return "queued";
  if (v === "CANCELED") return "canceled";
  return "unknown";
}

function withAge(s: DeployStatus, now: number): DeployStatus {
  if (s.deployedAt) {
    const t = new Date(s.deployedAt).getTime();
    if (!Number.isNaN(t)) s.ageMs = now - t;
  }
  return s;
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a normalized status out of a Vercel `/v6/deployments` response (latest first). */
function fromVercelBody(body: any): DeployStatus | null {
  const d = body?.deployments?.[0];
  if (!d) return null;
  const created = d.created ?? d.createdAt ?? d.ready ?? d.buildingAt;
  return {
    state: normalizeState(d.state ?? d.readyState),
    deployedAt: created ? new Date(created).toISOString() : undefined,
    url: d.url ? (d.url.startsWith("http") ? d.url : `https://${d.url}`) : undefined,
    commit: d.meta?.githubCommitSha ?? d.meta?.gitCommitSha,
    commitMessage: d.meta?.githubCommitMessage ?? d.meta?.gitCommitMessage,
    source: "vercel",
  };
}

export async function getDeployStatus(
  deploy: DeployInfo | undefined,
  opts?: { vercelToken?: string; now?: number }
): Promise<DeployStatus> {
  const now = opts?.now ?? Date.now();
  if (!deploy) return { state: "unknown", source: "none", reason: "no deploy config" };

  // 1) Generic JSON status endpoint (also how we test the whole chain).
  if (deploy.statusUrl) {
    try {
      const body = await fetchJson(deploy.statusUrl);
      // Accept either our own contract or a Vercel-shaped body.
      if (body?.deployments) {
        const v = fromVercelBody(body);
        if (v) return withAge(v, now);
      }
      if (body?.state) {
        return withAge(
          {
            state: normalizeState(body.state),
            deployedAt: body.deployedAt,
            url: body.url,
            commit: body.commit,
            commitMessage: body.commitMessage,
            source: "statusUrl",
          },
          now
        );
      }
      return { state: "unknown", source: "statusUrl", reason: "unrecognized status body" };
    } catch (e) {
      return { state: "unknown", source: "statusUrl", reason: e instanceof Error ? e.message : "fetch failed" };
    }
  }

  // 2) Vercel API (1ops's own token).
  if (deploy.provider === "vercel") {
    const token = opts?.vercelToken ?? process.env.VERCEL_TOKEN;
    if (!token) return { state: "unknown", source: "vercel", reason: "no VERCEL_TOKEN configured in 1ops" };
    if (!deploy.projectId) return { state: "unknown", source: "vercel", reason: "deploy.projectId not set" };
    try {
      const params = new URLSearchParams({ projectId: deploy.projectId, limit: "1" });
      if (deploy.target) params.set("target", deploy.target);
      const body = await fetchJson(`https://api.vercel.com/v6/deployments?${params}`, {
        Authorization: `Bearer ${token}`,
      });
      const v = fromVercelBody(body);
      return v ? withAge(v, now) : { state: "unknown", source: "vercel", reason: "no deployments found" };
    } catch (e) {
      return { state: "unknown", source: "vercel", reason: e instanceof Error ? e.message : "vercel api failed" };
    }
  }

  // 3) Inline last-known fields on the playbook.
  if (deploy.status || deploy.deployedAt || deploy.commit) {
    return withAge(
      { state: normalizeState(deploy.status), deployedAt: deploy.deployedAt, commit: deploy.commit, source: "inline" },
      now
    );
  }

  return { state: "unknown", source: "none", reason: "no deploy status available" };
}

/** Compact relative age: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeAge(ageMs?: number): string | undefined {
  if (ageMs == null) return undefined;
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
