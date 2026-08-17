import { NextRequest } from "next/server";
import { loadPlaybooks } from "@/lib/playbooks";
import type { HealthReport } from "@/lib/schema";

export const dynamic = "force-dynamic"; // never cache a liveness probe

const TIMEOUT_MS = 2500;

/**
 * Probe one app's health endpoint and report a normalized result the dashboard
 * can render. The browser only ever talks to 1ops's own origin (this route);
 * 1ops does the cross-origin fetch server-side. We never hold the app's secrets
 * to do this — we just GET a URL the playbook points at.
 *
 * GET /api/health?app=logos
 *   -> { status, checks?, ts?, url, probedAt, httpStatus?, reason? }
 *
 * Honesty rules, matching 1ops's "no healthy without a sensor reading":
 *   - no health url declared   -> status "unknown" (we have no sensor)
 *   - fetch throws / times out  -> status "down"    (with the reason)
 *   - non-2xx                   -> status "down"    (with the httpStatus)
 *   - 2xx + our HealthReport    -> pass the app's own verdict through (incl. "degraded")
 *   - 2xx + unrecognized body   -> status "up"      (the process answered 200)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const repoName = params.get("repo") ?? params.get("app"); // `app` kept for back-compat
  const projectName = params.get("project");
  const envName = params.get("env");
  const probedAt = new Date().toISOString();

  if (!repoName) {
    return Response.json({ status: "unknown", reason: "no repo specified", probedAt }, { status: 400 });
  }

  const { repos } = await loadPlaybooks();
  const repo = repos.find((r) => r.repo === repoName);
  if (!repo) {
    return Response.json({ status: "unknown", reason: `no repo "${repoName}"`, probedAt }, { status: 404 });
  }
  // Default to the first project if none named (single-project repos / legacy).
  const project = projectName ? repo.projects.find((p) => p.name === projectName) : repo.projects[0];
  if (!project) {
    return Response.json({ status: "unknown", reason: `no project "${projectName}" in "${repoName}"`, probedAt }, { status: 404 });
  }
  // Per-env health wins (website); fall back to the project-level health (data-pipeline).
  const env = envName ? project.envs[envName as "dev" | "staging" | "prod"] : undefined;
  const url = env?.health?.url ?? project.health?.url;
  if (!url) {
    return Response.json({ status: "unknown", reason: "no health endpoint declared", probedAt });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);

    if (!res.ok) {
      return Response.json({ status: "down", httpStatus: res.status, url, probedAt });
    }

    const body = (await res.json().catch(() => null)) as Partial<HealthReport> | null;
    if (body && (body.status === "up" || body.status === "degraded" || body.status === "down")) {
      return Response.json({ ...body, url, probedAt });
    }
    // The process answered 200 but doesn't speak our contract — it's at least alive.
    return Response.json({ status: "up", url, probedAt });
  } catch (e) {
    clearTimeout(timer);
    const reason =
      e instanceof Error && e.name === "AbortError"
        ? `no response in ${TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : "unreachable";
    return Response.json({ status: "down", reason, url, probedAt });
  }
}
