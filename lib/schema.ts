/**
 * The 1ops contract.
 *
 * A playbook describes how to GET INTO an app across environments. It stores
 * POINTERS, never secrets:
 *   - dev creds  -> the path to the committed seed file that defines them
 *   - stg/prod   -> the NAME of the 1Password item that holds them
 *
 * If a value would be unsafe to publish to a public repo, it does not belong
 * in a playbook. `assertNoSecrets()` below is the tripwire that enforces this.
 */

/**
 * A dev login an AGENT can drive with. Safe to publish: seeded dev users only
 * work on localhost and already live in committed code. Mirror them here (the
 * generate-playbook skill does this from the seed file) so agents get a
 * reliable, structured handle instead of parsing seed code at runtime.
 */
export interface DevUser {
  email?: string;
  username?: string;
  password?: string;
  role?: string;
  note?: string;
}

export type AccountSource =
  | { source: "seed"; seedFile?: string; users?: DevUser[] } // dev: from committed code; mirror users for agents
  | { source: "vault"; vaultItem: string } //  stg/prod: a 1Password item NAME, not its contents
  | { source: "inline-nonsecret"; note: string }; // e.g. "anyone@example.com / no password in dev"

export interface EnvSpec {
  url?: string;
  start?: string; // command to bring the env up (mostly dev)
  seedCmd?: string; // command that (re)seeds this env's data, e.g. "pnpm db:seed"
  accounts?: AccountSource;
  gotchas?: string[];
}

/** A key command and — crucially for monorepos — the folder you run it in. */
export interface Command {
  label: string; // "dev", "build", "test", "db reset"…
  run: string; // "pnpm dev"
  cwd?: string; // folder relative to repo root; omitted means repo root
}

/** A third-party service this app depends on. Pointers only, like everything else. */
export interface Integration {
  name: string; // "Stripe", "Sentry", "Resend"…
  url?: string; // dashboard URL
  vaultItem?: string; // 1Password item NAME for the account/keys (never the keys)
  note?: string; // e.g. "test mode keys in .env.example"
}

export interface Playbook {
  app: string;
  description?: string;
  repo?: string;
  /** Resolve relative seedFile paths against this. Defaults to the playbook's own dir. */
  repoRoot?: string;
  /** npm | pnpm | yarn | bun — so you stop guessing which one this repo uses. */
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Key commands and where to run them. The monorepo lifesaver. */
  commands?: Command[];
  envs: Partial<Record<"dev" | "staging" | "prod", EnvSpec>>;
  /** Third-party services/accounts (Stripe, Sentry, …) — names & dashboards, never keys. */
  integrations?: Integration[];
  /** Internal: filled by the loader, not authored by hand. */
  _file?: string;
}

export const ENV_ORDER = ["dev", "staging", "prod"] as const;
export type EnvName = (typeof ENV_ORDER)[number];

/**
 * Patterns that look like real secrets. A playbook that trips these is
 * rejected at load time — we would rather show an error than publish a leak.
 * (Seed FILE PATHS and 1Password item NAMES are fine; secret VALUES are not.)
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "OpenAI/Anthropic-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "bearer/jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

export interface SecretHit {
  pattern: string;
  context: string;
}

/** Scan a raw playbook string for things that should never be committed. */
export function findSecrets(raw: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = raw.match(re);
    if (m) hits.push({ pattern: name, context: m[0].slice(0, 12) + "…" });
  }
  return hits;
}

export class PlaybookSecretError extends Error {
  constructor(file: string, hits: SecretHit[]) {
    super(
      `Refusing to load "${file}": it looks like it contains ${hits
        .map((h) => h.pattern)
        .join(", ")}. Playbooks store POINTERS, not secrets. ` +
        `Replace the value with a seedFile path (dev) or a 1Password item name (stg/prod).`
    );
    this.name = "PlaybookSecretError";
  }
}

/** Minimal shape validation so the dashboard fails loud, not weird. */
export function validate(p: unknown, file: string): Playbook {
  if (typeof p !== "object" || p === null) throw new Error(`${file}: not an object`);
  const obj = p as Record<string, unknown>;
  if (typeof obj.app !== "string" || !obj.app) throw new Error(`${file}: missing "app"`);
  if (typeof obj.envs !== "object" || obj.envs === null) throw new Error(`${file}: missing "envs"`);
  return { ...(obj as object), _file: file } as Playbook;
}
