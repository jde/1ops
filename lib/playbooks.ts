import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import {
  findSecrets,
  PlaybookSecretError,
  validate,
  type Playbook,
} from "./schema";

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
  playbooks: Playbook[];
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

  const playbooks: Playbook[] = [];
  const errors: { file: string; message: string }[] = [];

  for (const f of baseFiles) {
    const full = path.join(dir, f);
    try {
      const raw = await fs.readFile(full, "utf8");

      // The committed file is the one that must never hold a secret — it goes
      // to git. Trip hard if it does.
      const hits = findSecrets(raw);
      if (hits.length) throw new PlaybookSecretError(f, hits);

      let merged = validate(YAML.parse(raw) ?? {}, full) as Playbook;

      // Overlay the gitignored local file if present. This is the sanctioned
      // home for sensitive bits, so it is NOT secret-scanned — it never reaches git.
      const overlay = await readLocalOverlay(full);
      if (overlay) merged = mergePlaybook(merged, overlay);

      playbooks.push(merged);
    } catch (e) {
      errors.push({ file: f, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { playbooks, isExample, dir, errors };
}

/**
 * Find the gitignored local overlay for a base playbook. We look both next to
 * the file as named in the dir AND next to the symlink's real target (so a repo
 * can keep `.ops/playbook.local.yaml` and only symlink the base file).
 */
async function readLocalOverlay(baseFull: string): Promise<Partial<Playbook> | null> {
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
      return (YAML.parse(raw) ?? {}) as Partial<Playbook>;
    } catch {
      /* no overlay here */
    }
  }
  return null;
}

/** Overlay `local` onto `base`: scalars and arrays from local win; envs merge per-env. */
function mergePlaybook(base: Playbook, local: Partial<Playbook>): Playbook {
  const out: Playbook = { ...base, ...local, _file: base._file };
  out.envs = { ...base.envs };
  for (const k of Object.keys(local.envs ?? {}) as (keyof typeof out.envs)[]) {
    out.envs[k] = { ...base.envs[k], ...local.envs![k] };
  }
  return out;
}

/**
 * Read dev credentials live from the committed seed file. We return the raw
 * snippet rather than trying to parse arbitrary seed code — the human reads it,
 * and it is always current because it IS the source of truth.
 */
export async function readSeed(
  pb: Playbook,
  seedFile: string
): Promise<{ ok: true; content: string; path: string } | { ok: false; error: string }> {
  const base = pb.repoRoot
    ? pb.repoRoot
    : pb._file
      ? path.dirname(pb._file)
      : process.cwd();
  const resolved = path.resolve(base, seedFile);
  try {
    const content = await fs.readFile(resolved, "utf8");
    return { ok: true, content, path: resolved };
  } catch {
    return { ok: false, error: `Could not read seed file at ${resolved}` };
  }
}
