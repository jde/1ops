import type { Dependency } from "./schema";

/** Anything that carries declared dependencies — a Repo (deps are repo-level/shared). */
interface HasDependencies {
  dependencies?: Dependency[];
}

export interface EnvKey {
  key: string;
  value: string;
  from: string; // which dependency populated it
}

/** The env vars 1ops can generate from declared deps, with {port} substituted. */
export function managedEnv(pb: HasDependencies): EnvKey[] {
  const out: EnvKey[] = [];
  for (const d of pb.dependencies ?? []) {
    for (const [k, v] of Object.entries(d.env ?? {})) {
      const value = d.port != null ? v.replaceAll("{port}", String(d.port)) : v;
      out.push({ key: k, value, from: `${d.name} (${d.kind})` });
    }
  }
  return out;
}

/** Parse KEY=VALUE lines into a map (ignores comments/blanks). */
export function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    m.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return m;
}

export interface EnvPlan {
  managed: (EnvKey & { status: "new" | "kept" })[];
  /** keys in .env.example that no dep populates and .env hasn't set — 1ops won't invent these */
  needsValue: string[];
}

/**
 * Compute what `1ops env` would do without touching anything. Merge-safe:
 * a key already set in .env is KEPT, never overwritten.
 */
export function planEnv(pb: HasDependencies, existingEnv: string, exampleEnv: string): EnvPlan {
  const existing = parseEnv(existingEnv);
  const example = parseEnv(exampleEnv);
  const managed = managedEnv(pb).map((e) => ({
    ...e,
    status: (existing.has(e.key) && existing.get(e.key) !== "" ? "kept" : "new") as "new" | "kept",
  }));
  const managedKeys = new Set(managed.map((m) => m.key));
  const needsValue = [...example.keys()].filter(
    (k) => !managedKeys.has(k) && (!existing.has(k) || existing.get(k) === "")
  );
  return { managed, needsValue };
}

/** Render the .env block 1ops appends (only NEW managed keys; never rewrites existing lines). */
export function renderEnvBlock(plan: EnvPlan): string {
  const fresh = plan.managed.filter((m) => m.status === "new");
  if (!fresh.length) return "";
  const lines = ["", "# --- 1ops-managed: local dependency connection strings (public, localhost) ---"];
  for (const m of fresh) lines.push(`${m.key}=${m.value}`);
  return lines.join("\n") + "\n";
}
