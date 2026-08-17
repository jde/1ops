"use client";

import { useEffect, useState } from "react";

/** Mirror of the /api/health response (a superset of HealthReport). */
interface Probe {
  status: "up" | "degraded" | "down" | "unknown" | string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  ts?: string;
  url?: string;
  probedAt?: string;
  httpStatus?: number;
  reason?: string;
}

const POLL_MS = 5000;

const LABEL: Record<string, string> = {
  up: "up",
  degraded: "degraded",
  down: "down",
  unknown: "no sensor",
  checking: "checking…",
};

/**
 * A live status light. Polls 1ops's own /api/health?app= route every few
 * seconds (1ops does the cross-origin probe), so the dot reflects the app's
 * real state right now — not whatever was true when the page was rendered.
 */
export function HealthLight({ repo, project, env }: { repo: string; project?: string; env?: string }) {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [loading, setLoading] = useState(true);

  const qs = new URLSearchParams({ repo });
  if (project) qs.set("project", project);
  if (env) qs.set("env", env);
  const query = qs.toString();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/health?${query}`, { cache: "no-store" });
        const j = (await res.json()) as Probe;
        if (alive) {
          setProbe(j);
          setLoading(false);
        }
      } catch {
        if (alive) {
          setProbe({ status: "down", reason: "probe failed" });
          setLoading(false);
        }
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [query]);

  const status = loading ? "checking" : (probe?.status ?? "unknown");
  const checks = probe?.checks;
  const detail =
    probe?.reason ??
    (probe?.httpStatus ? `HTTP ${probe.httpStatus}` : undefined) ??
    (checks
      ? Object.entries(checks)
          .map(([k, v]) => `${v.ok ? "✓" : "✗"} ${k}${v.detail ? ` (${v.detail})` : ""}`)
          .join("\n")
      : undefined);

  const title = [
    probe?.url ? `health: ${probe.url}` : "no health endpoint declared",
    detail,
    probe?.probedAt ? `probed ${new Date(probe.probedAt).toLocaleTimeString()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className={`health health-${status}`} title={title}>
      <span className="health-dot" />
      {LABEL[status] ?? status}
      {checks && (status === "degraded" || status === "down") && (
        <span className="health-checks">
          {Object.entries(checks)
            .filter(([, v]) => !v.ok)
            .map(([k]) => k)
            .join(" ")}
        </span>
      )}
    </span>
  );
}
