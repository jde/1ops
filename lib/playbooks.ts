import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  findSecrets,
  PlaybookSecretError,
  validate,
  type EnvName,
  type Project,
  type Repo,
} from "./schema";

const exec = promisify(execFile);

/**
 * Where to look for playbooks, in order:
 *   1. $ONEOPS_PLAYBOOKS_DIR  (your symlink farm, e.g. ~/playbooks)
 *   2. ~/playbooks            (the convention)
 *   3. ./examples/playbooks   (bundled safe demo data, so a fresh clone Just Works)
 */
export async function playbooksDir(): Promise<{ dir: string; isExample: boolean }> {
  const candidates = [
    process.env.ONEOPS_PLAYBOOKS_DIR,
    path.join(os.homedir(), "playbooks"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (await hasYaml(dir)) return { dir, isExample: false };
  }
  return { dir: path.join(process.cwd(), "examples", "playbooks"), isExample: true };
}

async function hasYaml(dir: string): Promise<boolean> {
  try {
    const files = await fs.readdir(dir);
    return files.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return false;
  }
}

export interface LoadResult {
  repos: Repo[];
  isExample: boolean;
  dir: string;
  errors: { file: string; message: string }[];
}

export async function loadPlaybooks(): Promise<LoadResult> {
  const { dir, isExample } = await playbooksDir();
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  // Only the COMMITTED base files; their .local.yaml siblings are overlays.
  const baseFiles = files.filter((f) => !f.includes(".local."));

  const repos: Repo[] = [];
  const errors: { file: string; message: string }[] = [];

  for (const f of baseFiles) {
    const full = path.join(dir, f);
    try {
      const raw = await fs.readFile(full, "utf8");

      // The committed file is the one that must never hold a secret — it goes
      // to git. Trip hard if it does.
      const hits = findSecrets(raw);
      if (hits.length) throw new PlaybookSecretError(f, hits);

      let merged = validate(YAML.parse(raw) ?? {}, full);

      // Overlay the gitignored local file if present. This is the sanctioned
      // home for sensitive bits, so it is NOT secret-scanned — it never reaches git.
      const overlay = await readLocalOverlay(full);
      if (overlay) merged = mergeRepo(merged, overlay);

      // Auto-derive repoRoot from the symlink's real location (walk up to .git),
      // so seed paths and git activity resolve without committing an absolute path.
      if (!merged.repoRoot) {
        const rr = await deriveRepoRoot(full);
        if (rr) merged.repoRoot = rr;
      }

      repos.push(merged);
    } catch (e) {
      errors.push({ file: f, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { repos: await dedupeWorktrees(repos), isExample, dir, errors };
}

/**
 * The git identity of a working dir, shared across ALL its worktrees:
 * `--git-common-dir` resolves to the SAME path for the main checkout and every
 * `git worktree`, whereas `--git-dir` differs per worktree. So it's the right key
 * to recognize "these two folders are the same repo."
 */
async function gitCommonDir(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return await fs.realpath(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * Collapse worktrees: a `git worktree` is its own folder but the SAME repo, so it
 * must not appear as a second repo card. Group by git-common-dir; keep one repo
 * per group, preferring the MAIN worktree's playbook (its root is the parent of
 * the common dir). Repos that aren't git (no common dir) are always kept as-is.
 */
async function dedupeWorktrees(repos: Repo[]): Promise<Repo[]> {
  const keyed = await Promise.all(
    repos.map(async (repo) => ({ repo, key: repo.repoRoot ? await gitCommonDir(repo.repoRoot) : undefined }))
  );

  const out: Repo[] = [];
  const indexByKey = new Map<string, number>();

  for (const { repo, key } of keyed) {
    if (!key) {
      out.push(repo); // not a git repo — nothing to dedupe against
      continue;
    }
    const mainRoot = path.basename(key) === ".git" ? path.dirname(key) : undefined;
    const existingIdx = indexByKey.get(key);

    if (existingIdx === undefined) {
      indexByKey.set(key, out.length);
      out.push(repo);
      continue;
    }

    // Same repo seen via another worktree. Prefer the main worktree's playbook;
    // otherwise keep the first and drop this duplicate.
    if (mainRoot && repo.repoRoot === mainRoot && out[existingIdx].repoRoot !== mainRoot) {
      out[existingIdx] = repo;
    }
    // else: drop `repo` — it's a worktree of an already-loaded repo.
  }

  return out;
}

/**
 * Resolve the repo root for a playbook: follow the symlink to the real file, then
 * walk up until we find a `.git`. Lets a `.ops/playbook.yaml` symlinked into the
 * playbooks dir still resolve its seed files and git history correctly.
 */
async function deriveRepoRoot(full: string): Promise<string | undefined> {
  let real = full;
  try {
    real = await fs.realpath(full);
  } catch {
    /* not a symlink — fine */
  }
  let dir = path.dirname(real);
  for (let i = 0; i < 10; i++) {
    try {
      await fs.stat(path.join(dir, ".git"));
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Find the gitignored local overlay for a base playbook. We look both next to
 * the file as named in the dir AND next to the symlink's real target (so a repo
 * can keep `.ops/playbook.local.yaml` and only symlink the base file).
 */
async function readLocalOverlay(baseFull: string): Promise<Partial<Repo> | null> {
  const candidates = new Set<string>();
  const toLocal = (p: string) => p.replace(/(\.ya?ml)$/, ".local$1");
  candidates.add(toLocal(baseFull));
  try {
    const real = await fs.realpath(baseFull);
    if (real !== baseFull) candidates.add(toLocal(real));
  } catch {
    /* not a symlink / unreadable — fine */
  }
  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c, "utf8");
      return (YAML.parse(raw) ?? {}) as Partial<Repo>;
    } catch {
      /* no overlay here */
    }
  }
  return null;
}

/**
 * Overlay `local` onto a `Repo`: repo scalars/arrays from local win; PROJECTS merge
 * by name, and within a matched project its ENVS merge per-env. So a local overlay
 * can patch just one env of one project without restating the rest.
 */
function mergeRepo(base: Repo, local: Partial<Repo>): Repo {
  const out: Repo = { ...base, ...local, _file: base._file, projects: base.projects };
  if (local.projects) {
    const byName = new Map<string, Project>(base.projects.map((p) => [p.name, p]));
    for (const lp of local.projects) {
      const bp = byName.get(lp.name);
      if (!bp) {
        byName.set(lp.name, lp);
        continue;
      }
      const mergedProject: Project = { ...bp, ...lp, envs: { ...bp.envs } };
      for (const k of Object.keys(lp.envs ?? {}) as EnvName[]) {
        mergedProject.envs[k] = { ...bp.envs[k], ...lp.envs![k] };
      }
      byName.set(lp.name, mergedProject);
    }
    out.projects = Array.from(byName.values());
  }
  return out;
}

/**
 * Read dev credentials live from the committed seed file. We return the raw
 * snippet rather than trying to parse arbitrary seed code — the human reads it,
 * and it is always current because it IS the source of truth.
 */
export async function readSeed(
  repo: Repo,
  seedFile: string
): Promise<{ ok: true; content: string; path: string } | { ok: false; error: string }> {
  const base = repo.repoRoot
    ? repo.repoRoot
    : repo._file
      ? path.dirname(repo._file)
      : process.cwd();
  const resolved = path.resolve(base, seedFile);
  try {
    const content = await fs.readFile(resolved, "utf8");
    return { ok: true, content, path: resolved };
  } catch {
    return { ok: false, error: `Could not read seed file at ${resolved}` };
  }
}
