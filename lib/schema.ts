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

/**
 * One-click "quick login": a template 1ops fills per seeded user to drop you on a
 * PRE-FILLED login screen. Placeholders: {url} {email} {password}. Apps opt in by
 * honoring the convention (reading the query params / deep-link to prefill the form).
 *   web:      "{url}/login?email={email}&password={password}"   (opens in browser)
 *   deepLink: "crewchamp://login?email={email}&password={password}"  (fired at a booted sim)
 * Only ever built for envs whose creds 1ops legitimately holds (dev seeded users).
 */
export interface QuickLogin {
  web?: string; // URL template, opened in a new tab
  deepLink?: string; // custom-scheme template, opened on a simulator/device
}

export interface EnvSpec {
  url?: string;
  start?: string; // command to bring the env up (mostly dev)
  seedCmd?: string; // command that (re)seeds this env's data, e.g. "pnpm db:seed"
  accounts?: AccountSource;
  /** Template(s) for one-click pre-filled login. Dev only (public seeded creds). */
  quickLogin?: QuickLogin;
  /** Per-env health endpoint (website). Falls back to the project-level health. */
  health?: HealthCheck;
  /** Per-env third-party deps — dev's ephemeral DB is a different vendor than staging's. */
  integrations?: Integration[];
  /** "What's live" — deploy pointers + optional last-known deployed state. */
  deploy?: DeployInfo;
  gotchas?: string[];
}

/**
 * "What's live" for an environment. Pointers (where the deploy lives, which branch
 * ships to it) plus an optional last-known deployed state. The point, for the
 * change→push-to-staging loop, is to confirm the commit you just pushed is the one
 * serving — so you don't screenshot a stale build.
 */
export interface DeployInfo {
  provider?: string; // "vercel" | "fly" | "netlify" | …
  branch?: string; // git branch that deploys to this env, e.g. "staging"
  dashboardUrl?: string; // link to the deploy dashboard (e.g. the Vercel project)
  /** Vercel project id — a pointer. 1ops calls the API with its OWN token, never one stored here. */
  projectId?: string;
  /** Vercel deployment target to query, e.g. "production" | "preview". */
  target?: string;
  statusUrl?: string; // optional JSON endpoint 1ops can probe for live deploy state
  // Last-known deployed state (optional; inline fallback when no live source):
  commit?: string;
  deployedAt?: string; // ISO timestamp
  status?: string; // "ready" | "building" | "error" | …
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

/**
 * A dev-environment dependency 1ops can stand up locally (db, cache, queue,
 * object storage…). The `env` map is the magic: the connection strings this
 * dep populates in your `.env`. These are LOCAL and PUBLIC (localhost, default
 * local passwords) — safe to generate, just like seeded users.
 */
export interface Dependency {
  name: string; // "db", "cache", "queue", "storage"
  kind: string; // "postgres" | "mysql" | "redis" | "rabbitmq" | "minio" | …
  version?: string; // image tag, e.g. "16"
  port?: number; // host port; substituted for {port} in env values
  /** Env vars this dependency populates. `{port}` is replaced with `port`. */
  env?: Record<string, string>;
  /** True if this dep needs the app's seed step after it comes up. */
  seed?: boolean;
}

/**
 * What KIND of app this is. The type drives which command contract 1ops expects
 * and publishes on the card. Each type owes a different shape, and conformance is
 * judged against the type — never a universal yardstick:
 *   - `data-pipeline` — agent-operated; owes the operational triad run / see / grow
 *     as CLI verbs (health / status / sources).
 *   - `website` — owes a dev→staging(→prod) flow built for the change→screenshot→
 *     push-to-staging loop: dev on an ephemeral DB, deploy-on-push staging, a live
 *     URL. prod is allowed to be absent until the app actually grows one.
 *   - `static-site` / `library` / `tool` — owe progressively less.
 */
export type AppType =
  | "website"
  | "data-pipeline"
  | "mobile"
  | "static-site"
  | "library"
  | "tool";

/**
 * A target a `mobile` app runs on — a simulator/emulator or a physical device.
 * "Launch dev" for mobile means booting one or more of these (iOS + Android,
 * different dimensions). 1ops shows them with a LIVE booted/offline light
 * (matched on `udid`) — the mobile analog of a health check.
 */
export interface Device {
  platform: "ios" | "android";
  name: string; // "iPhone 16", "iPad Pro 13-inch (M4)", "Pixel 7"
  kind?: "simulator" | "device"; // default simulator
  dimension?: string; // "phone" | "tablet" | screen size — the thing that varies
  udid?: string; // iOS sim UDID / android serial — used to match live booted state
}

/**
 * The known statuses an app's health endpoint can report. `degraded` is the
 * important middle: the app's own process answered, but a dependency it needs
 * (db, queue, an upstream host) is unreachable. Up/down alone would lie about that.
 */
export type HealthStatus = "up" | "degraded" | "down";

/**
 * A health endpoint 1ops pings DIRECTLY to render a live up/degraded/down light.
 * Pointer only: just a URL 1ops fetches server-side. The APP decides what healthy
 * means and returns a `HealthReport`; 1ops never holds the app's secrets to do this.
 */
export interface HealthCheck {
  url: string; // e.g. http://localhost:3141/health
  env?: EnvName; // which env this checks; defaults to dev
}

/** The body an app's health endpoint should return. All fields optional but `status`. */
export interface HealthReport {
  status: HealthStatus;
  /** Per-dependency reachability, keyed by name: { db: {ok}, redis: {ok}, … }. */
  checks?: Record<string, { ok: boolean; detail?: string }>;
  ts?: string; // ISO timestamp the app produced this report
}

/**
 * A PROJECT is one product/surface within a repo (e.g. logos's `pipeline` and its
 * `visualizer`). It has its own type, environments, and command contract. The
 * `type` decides what it owes (a data-pipeline owes run/see/grow; a website owes
 * the dev→staging→prod loop).
 */
export interface Project {
  /** Product name within the repo, e.g. "pipeline", "visualizer". Unique per repo. */
  name: string;
  type?: AppType;
  description?: string;
  /** Project-level health endpoint (data-pipeline). A website uses per-env env.health. */
  health?: HealthCheck;
  /** This product's commands — incl. its type's contract verbs (e.g. `logos health`). */
  commands?: Command[];
  /** Project-level integrations (data-pipeline). A website prefers per-env integrations. */
  integrations?: Integration[];
  /** mobile: the simulators/devices "launch dev" boots, shown with live booted status. */
  devices?: Device[];
  envs: Partial<Record<"dev" | "staging" | "prod", EnvSpec>>;
}

/**
 * A REPO is the top of the hierarchy: one git repository, wrapping the PROJECTS
 * inside it. Repo-level things — the git remote, the package manager, the SHARED
 * database, and shared tooling (db:ephemeral / db:reset) — live here, because they
 * cut across every product in the repo. Projects nest beneath.
 */
export interface Repo {
  /** Repo name/id — the top of the hierarchy, e.g. "logos". */
  repo: string;
  /** Git remote URL. */
  repoUrl?: string;
  description?: string;
  /** npm | pnpm | yarn | bun — repo-wide. */
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Resolve relative seedFile paths against this. Defaults to the file's own dir. */
  repoRoot?: string;
  /** Repo-level shared commands: install, and the shared-DB tools (db:ephemeral, db:reset). */
  commands?: Command[];
  /** Repo-level SHARED dependencies — e.g. the one database every product uses. */
  dependencies?: Dependency[];
  /** The products/surfaces within the repo. */
  projects: Project[];
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

/**
 * Validate + normalize a parsed playbook into a `Repo`. Accepts two shapes:
 *   - NEW:    { repo, projects: [...] }      — the repo→projects hierarchy
 *   - LEGACY: { app, envs, ... }             — a flat single-app playbook (the 18
 *             generated stubs). Wrapped as a one-project repo so nothing breaks.
 * Fails loud on anything else.
 */
export function validate(p: unknown, file: string): Repo {
  if (typeof p !== "object" || p === null) throw new Error(`${file}: not an object`);
  const obj = p as Record<string, any>;

  // NEW shape: repo + projects[]
  if (Array.isArray(obj.projects)) {
    if (typeof obj.repo !== "string" || !obj.repo) throw new Error(`${file}: missing "repo"`);
    if (obj.projects.length === 0) throw new Error(`${file}: "projects" is empty`);
    obj.projects.forEach((pr: any, i: number) => {
      if (typeof pr?.name !== "string" || !pr.name) throw new Error(`${file}: projects[${i}] missing "name"`);
      if (typeof pr?.envs !== "object" || pr.envs === null) throw new Error(`${file}: projects[${i}] missing "envs"`);
    });
    return { ...(obj as object), _file: file } as Repo;
  }

  // LEGACY shape: app + envs -> wrap as a single-project repo.
  if (typeof obj.app === "string" && obj.app) {
    if (typeof obj.envs !== "object" || obj.envs === null) throw new Error(`${file}: missing "envs"`);
    const project: Project = {
      name: obj.app,
      type: obj.type,
      description: obj.description,
      health: obj.health,
      commands: obj.commands,
      integrations: obj.integrations,
      envs: obj.envs,
    };
    return {
      repo: obj.app,
      repoUrl: obj.repo, // legacy `repo:` was the git URL
      description: obj.description,
      packageManager: obj.packageManager,
      repoRoot: obj.repoRoot,
      dependencies: obj.dependencies,
      projects: [project],
      _file: file,
    };
  }

  throw new Error(`${file}: needs either "repo" + "projects" (new) or "app" + "envs" (legacy)`);
}
