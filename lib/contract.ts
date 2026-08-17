/**
 * The 1ops contract + conformance scanner.
 *
 * Each 1ops feature places an obligation on the app ("to get a quick-login link,
 * your login screen must read email/password from the URL"). This module:
 *   1. defines those obligations as CHECKS, scoped to when they apply,
 *   2. SCANS the app's real source to see which are met (heuristic, git-grep based),
 *   3. lets the UI gate affordances on what's met (no button the app can't honor),
 *   4. writes the unmet items as a TODO into the app's own `.ops/1ops-contract.md`.
 *
 * Read-only scanning; the only write is the contract note (idempotent).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project, Repo } from "./schema";

const exec = promisify(execFile);

export interface CheckResult {
  id: string;
  title: string;
  capability: string; // the 1ops feature this unlocks
  met: boolean;
  evidence?: string; // file that satisfies it
  remedy: string; // what to implement to satisfy it
}

/** Tracked files matching any pathspec whose CONTENT matches `pattern`. */
async function grepFiles(repoRoot: string, pattern: string, pathspecs: string[]): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "grep", "-lEI", "--", pattern, ...pathspecs], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match
  }
}

const LOGIN_PATHS = ["*login*", "*Login*", "*signin*", "*SignIn*", "*auth*", "*Auth*"];
const PARAM_READ = "useSearchParams|URLSearchParams|searchParams|useLocalSearchParams|useGlobalSearchParams";

/**
 * Does some login/auth file read credentials (email + password) from URL params
 * and use them? Heuristic: a login-ish file that reads params AND references both
 * email and password (so token-only flows don't count as satisfying it).
 */
/** Real source only — never docs, planning notes, or tests (their CODE EXAMPLES lie). */
function isSourceFile(f: string): boolean {
  return (
    /\.(tsx?|jsx?)$/.test(f) &&
    !/(^|\/)\.planning\//.test(f) &&
    !/(^|\/)(docs?|\.next)\//.test(f) &&
    !/(__tests__|\.test\.|\.spec\.|\.stories\.)/.test(f) &&
    !/\.md$/.test(f)
  );
}

async function loginReadsCreds(repoRoot: string): Promise<{ met: boolean; evidence?: string }> {
  const candidates = (await grepFiles(repoRoot, PARAM_READ, LOGIN_PATHS)).filter(isSourceFile);
  // The decisive signal is reading a PASSWORD from the URL — distinctive to
  // quick-login and absent from token/forgot/reset flows (which deliberately never
  // put a password in a URL). We require `password` as a read KEY, not a stray
  // union value like `mode: 'email' | 'password'`.
  const readsPasswordParam = (c: string): boolean =>
    /\.get\(\s*['"`]password['"`]\s*\)/i.test(c) || // searchParams.get('password')
    /\b(searchParams|params|query)\.password\b/i.test(c) || // params.password
    /\{[^}]*\bpassword\b[^}]*\}\s*=\s*(use(Local|Global)?SearchParams\s*[(<]|new\s+URLSearchParams)/i.test(c) || // const { password } = useSearchParams()
    /use(Local|Global)?SearchParams\s*<\s*\{[^}]*\bpassword\s*[?:]/i.test(c); // useLocalSearchParams<{ password: ... }>

  for (const f of candidates) {
    try {
      const c = await fs.readFile(path.join(repoRoot, f), "utf8");
      if (readsPasswordParam(c)) return { met: true, evidence: f };
    } catch {
      /* unreadable — skip */
    }
  }
  return { met: false };
}

/** The contract: obligations, each scoped to when it's relevant for a project. */
const CHECKS: {
  id: string;
  title: string;
  capability: string;
  remedy: string;
  appliesTo: (project: Project) => boolean;
  scan: (repoRoot: string, project: Project) => Promise<{ met: boolean; evidence?: string }>;
}[] = [
  {
    id: "quick-login-web",
    title: "Login reads credentials from the URL",
    capability: 'the dashboard "→ login" quick-login link',
    remedy:
      "In the web login screen, read `?email=` and `?password=` from the URL (e.g. `useSearchParams`) and prefill the form fields.",
    appliesTo: (p) => Object.values(p.envs).some((e) => e?.quickLogin?.web),
    scan: (root) => loginReadsCreds(root),
  },
  {
    id: "quick-login-deeplink",
    title: "App handles a login deep link with credentials",
    capability: 'the mobile "open on sim" quick-login',
    remedy:
      "Handle the `…://login?email=&password=` deep link (e.g. expo-router `useLocalSearchParams` on an auth route) and prefill the login form.",
    appliesTo: (p) => Object.values(p.envs).some((e) => e?.quickLogin?.deepLink),
    scan: (root) => loginReadsCreds(root), // same heuristic: a login screen that reads params + creds
  },
];

export async function scanContract(repo: Repo, project: Project): Promise<CheckResult[]> {
  if (!repo.repoRoot) return [];
  const applicable = CHECKS.filter((c) => c.appliesTo(project));
  return Promise.all(
    applicable.map(async (c) => {
      const { met, evidence } = await c.scan(repo.repoRoot!, project).catch(() => ({ met: false, evidence: undefined }));
      return { id: c.id, title: c.title, capability: c.capability, met, evidence, remedy: c.remedy };
    })
  );
}

export function isMet(results: CheckResult[], id: string): boolean {
  return results.some((r) => r.id === id && r.met);
}

/** Render the contract note for an app and write it idempotently to .ops/1ops-contract.md. */
export async function writeContractNote(repo: Repo, project: Project, results: CheckResult[]): Promise<void> {
  if (!repo.repoRoot || results.length === 0) return;
  const unmet = results.filter((r) => !r.met);
  const met = results.filter((r) => r.met);

  const lines = [
    `# 1ops contract — ${repo.repo}/${project.name}`,
    "",
    "_Generated by 1ops. Items below are obligations this app must meet to unlock 1ops features._",
    "_1ops hides any affordance whose obligation is unmet, and regenerates this file on scan._",
    "",
  ];
  if (unmet.length) {
    lines.push("## ❌ To do — unmet obligations");
    for (const r of unmet) {
      lines.push("", `### ${r.title}`, `Unlocks: **${r.capability}**.`, "", `- [ ] ${r.remedy}`);
    }
    lines.push("");
  } else {
    lines.push("## ✅ All obligations met. Nothing to do.", "");
  }
  if (met.length) {
    lines.push("## ✅ Satisfied");
    for (const r of met) lines.push(`- [x] ${r.title}${r.evidence ? ` — \`${r.evidence}\`` : ""}`);
    lines.push("");
  }
  const body = lines.join("\n");

  // Project-scoped filename so multiple products in one repo don't clobber each other.
  const opsDir = path.join(repo.repoRoot, ".ops");
  const file = path.join(opsDir, `1ops-contract.${project.name}.md`);
  try {
    const existing = await fs.readFile(file, "utf8").catch(() => null);
    if (existing === body) return; // idempotent: no churn
    await fs.mkdir(opsDir, { recursive: true });
    await fs.writeFile(file, body, "utf8");
  } catch {
    /* best-effort — never break the dashboard over a note write */
  }
}
