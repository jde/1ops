/**
 * Repo-level "state of work" — GitHub status crossed with a deployment visualizer.
 *
 * Answers, at a glance, the question "did my work make it as far as possible?":
 *   - how many open branches, and which are STALE (long-standing, unmerged) → deal with them
 *   - how much is in staging but NOT yet in production (staged, not shipped)
 *   - what's sitting OUTSIDE staging entirely (branches not merged to staging)
 *
 * Computed live by shelling git in the repo's `repoRoot`. Read-only: only
 * `rev-parse`, `for-each-ref`, `rev-list`, `branch --merged` — never mutating.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_STALE_DAYS = 14;

export interface BranchInfo {
  name: string;
  lastCommitISO: string;
  ageDays: number;
  aheadOfProd: number; // commits on this branch not in production
  inStaging: boolean; // fully contained in the staging ref
  stale: boolean; // old + not yet in production
  worktree?: string; // path of the worktree this branch is checked out in, if any
}

export interface Worktree {
  path: string;
  branch?: string; // short branch name, or undefined if detached
  isMain: boolean; // the primary checkout (not a `git worktree add`)
  detached: boolean;
}

export interface RepoActivity {
  ok: boolean;
  reason?: string;
  productionRef: string;
  stagingRef?: string; // undefined if the repo has no staging branch yet
  branchCount: number;
  branches: BranchInfo[];
  staleBranches: BranchInfo[];
  /** commits in staging not yet in production — "staged, not shipped". */
  stagingAheadOfProd?: number;
  /** branches with work not yet merged into staging — "outside staging". */
  branchesOutsideStaging: number;
  /** parallel checkouts — `git worktree` holds branch progress side by side. */
  worktrees: Worktree[];
  staleThresholdDays: number;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoRoot, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** First existing ref from a candidate list (handles `main` vs `master`, etc). */
async function firstRef(repoRoot: string, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) {
    if (await refExists(repoRoot, c)) return c;
  }
  return undefined;
}

export async function getRepoActivity(
  repoRoot: string,
  opts?: { production?: string; staging?: string; staleDays?: number; now?: number }
): Promise<RepoActivity> {
  const staleThresholdDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;
  const now = opts?.now ?? Date.now();
  const base: RepoActivity = {
    ok: false,
    productionRef: opts?.production ?? "main",
    branchCount: 0,
    branches: [],
    staleBranches: [],
    branchesOutsideStaging: 0,
    worktrees: [],
    staleThresholdDays,
  };

  try {
    await git(repoRoot, ["rev-parse", "--git-dir"]);
  } catch {
    return { ...base, reason: `not a git repo: ${repoRoot}` };
  }

  const productionRef =
    (opts?.production && (await refExists(repoRoot, opts.production)) ? opts.production : undefined) ??
    (await firstRef(repoRoot, ["main", "master", "production", "prod"]));
  if (!productionRef) return { ...base, reason: "no production branch (main/master) found" };

  const stagingRef =
    (opts?.staging && (await refExists(repoRoot, opts.staging)) ? opts.staging : undefined) ??
    (await firstRef(repoRoot, ["staging", "stage"]));

  // Worktrees: parallel checkouts holding branch progress side by side.
  const worktrees = await listWorktrees(repoRoot);
  const branchWorktree = new Map<string, string>();
  for (const w of worktrees) {
    if (w.branch && !w.isMain) branchWorktree.set(w.branch, w.path);
  }

  // All local branches + their last-commit time, one record per line.
  const raw = await git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%1f%(committerdate:iso8601-strict)",
    "refs/heads",
  ]);

  const branches: BranchInfo[] = [];
  let branchesOutsideStaging = 0;

  for (const line of raw.split("\n").filter(Boolean)) {
    const [name, iso] = line.split("\x1f");
    if (name === productionRef) continue; // production isn't an "open branch"

    const ageDays = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
    const aheadOfProd = Number(await git(repoRoot, ["rev-list", "--count", `${productionRef}..${name}`]));

    let inStaging = false;
    if (stagingRef && name !== stagingRef) {
      // contained in staging when it has nothing staging doesn't already have
      const aheadOfStaging = Number(await git(repoRoot, ["rev-list", "--count", `${stagingRef}..${name}`]));
      inStaging = aheadOfStaging === 0;
      if (!inStaging && aheadOfProd > 0) branchesOutsideStaging++;
    }

    const isFlowRef = name === stagingRef;
    const stale = !isFlowRef && aheadOfProd > 0 && ageDays >= staleThresholdDays;

    branches.push({ name, lastCommitISO: iso, ageDays, aheadOfProd, inStaging, stale, worktree: branchWorktree.get(name) });
  }

  branches.sort((a, b) => b.ageDays - a.ageDays);

  const stagingAheadOfProd = stagingRef
    ? Number(await git(repoRoot, ["rev-list", "--count", `${productionRef}..${stagingRef}`]))
    : undefined;

  return {
    ok: true,
    productionRef,
    stagingRef,
    branchCount: branches.filter((b) => b.name !== stagingRef).length,
    branches,
    staleBranches: branches.filter((b) => b.stale),
    stagingAheadOfProd,
    branchesOutsideStaging,
    worktrees,
    staleThresholdDays,
  };
}

/** Parse `git worktree list --porcelain` into structured worktrees. */
async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  let raw: string;
  try {
    raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const worktrees: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur?.path) worktrees.push({ path: cur.path, branch: cur.branch, detached: !!cur.detached, isMain: false });
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      if (cur) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      if (cur) cur.detached = true;
    }
  }
  if (cur?.path) worktrees.push({ path: cur.path, branch: cur.branch, detached: !!cur.detached, isMain: false });
  // The first entry git reports is always the main checkout.
  if (worktrees.length) worktrees[0].isMain = true;
  return worktrees;
}
