#!/usr/bin/env node
/**
 * 1ops CLI — the agent collaboration kit.
 *
 *   1ops list                          list known apps
 *   1ops creds <app> [--env dev]       dev logins (REDACTED by default)
 *                    [--reveal|--json] full values (dev only — stg/prod are pointers)
 *   1ops run <app> [--env dev]         run the app's start cmd, capturing logs
 *   1ops logs <app> [--errors]         read captured logs (you OR an agent)
 *                   [--since 5m] [--follow] [--json] [--lines N]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadPlaybooks } from "../lib/playbooks";
import { planEnv, renderEnvBlock } from "../lib/env";
import type { Project, Repo } from "../lib/schema";
import {
  appendLogSync,
  detectLevel,
  logPath,
  parseSince,
  readLogs,
  type Level,
} from "../lib/logs";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd?: string; positional: string[]; flags: Flags } {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function die(msg: string): never {
  console.error(`1ops: ${msg}`);
  process.exit(1);
}

interface Target {
  repo: Repo;
  project: Project;
}

/** Resolve "repo/project", a bare project name, or a repo name (→ its first project). */
async function findApp(name: string): Promise<Target> {
  const { repos } = await loadPlaybooks();
  for (const repo of repos) {
    for (const project of repo.projects) {
      if (project.name === name || `${repo.repo}/${project.name}` === name) return { repo, project };
    }
  }
  const repo = repos.find((r) => r.repo === name);
  if (repo && repo.projects[0]) return { repo, project: repo.projects[0] };
  const names =
    repos.flatMap((r) => r.projects.map((p) => (r.projects.length > 1 ? `${r.repo}/${p.name}` : p.name))).join(", ") ||
    "(none found)";
  die(`unknown target "${name}". Known: ${names}`);
}

function envName(flags: Flags): "dev" | "staging" | "prod" {
  const e = (flags.env as string) || "dev";
  if (e !== "dev" && e !== "staging" && e !== "prod") die(`--env must be dev|staging|prod`);
  return e;
}

/** Best-effort repo root for running commands: strip a trailing /.ops. */
function repoRoot(repo: Repo): string {
  if (repo.repoRoot) return repo.repoRoot;
  const dir = repo._file ? path.dirname(repo._file) : process.cwd();
  return path.basename(dir) === ".ops" ? path.dirname(dir) : dir;
}

const HELP = `1ops — your dev keyring + agent collaboration kit

  1ops list
  1ops creds <app> [--env dev] [--reveal|--json]
  1ops env   <app> [--write] [--json]
  1ops run   <app> [--env dev]
  1ops logs  <app> [--errors] [--since 5m] [--follow] [--json] [--lines N]
`;

async function cmdList() {
  const { repos, isExample, dir } = await loadPlaybooks();
  const count = repos.reduce((n, r) => n + r.projects.length, 0);
  console.log(`${count} product(s) across ${repos.length} repo(s) from ${dir}${isExample ? " (example data)" : ""}:`);
  for (const r of repos) {
    console.log(`  📦 ${r.repo}`);
    for (const p of r.projects) {
      const envs = Object.keys(p.envs).join(", ");
      const label = r.projects.length > 1 ? `${r.repo}/${p.name}` : p.name;
      console.log(`     ${label.padEnd(24)} ${p.type ?? ""}  [${envs}]  ${p.description ?? ""}`);
    }
  }
}

async function cmdCreds(name: string, flags: Flags) {
  const { project } = await findApp(name);
  const env = envName(flags);
  const acct = project.envs[env]?.accounts;
  const json = !!flags.json;
  const reveal = !!flags.reveal || json;

  if (!acct) return json ? out({ app: name, env, accounts: null }) : console.log(`No accounts for ${name}/${env}.`);

  // The bright line: only dev seeded users carry values. stg/prod are pointers.
  if (acct.source === "vault") {
    const payload = { app: name, env, source: "vault", vaultItem: acct.vaultItem };
    if (json) return out(payload);
    return console.log(`🔐 ${name}/${env}: open 1Password item "${acct.vaultItem}" (1ops never stores the value)`);
  }
  if (acct.source === "inline-nonsecret") {
    if (json) return out({ app: name, env, source: "inline-nonsecret", note: acct.note });
    return console.log(`👤 ${name}/${env}: ${acct.note}`);
  }

  // seed (dev)
  const users = acct.users ?? [];
  if (json) return out({ app: name, env, source: "seed", seedFile: acct.seedFile, users });
  if (!users.length) return console.log(`🌱 ${name}/${env}: seeded — see ${acct.seedFile} (no users mirrored yet)`);
  console.log(`🌱 ${name}/${env} dev logins${reveal ? "" : "  (run with --reveal or --json for passwords)"}:`);
  for (const u of users) {
    const id = u.email ?? u.username ?? "?";
    const pw = reveal ? (u.password ?? u.note ?? "—") : "••••••••";
    console.log(`  ${id.padEnd(28)} ${pw.padEnd(16)} ${u.role ?? ""}`);
  }
}

function out(o: unknown) {
  console.log(JSON.stringify(o, null, 2));
}

async function cmdEnv(name: string, flags: Flags) {
  const { repo } = await findApp(name);
  const root = repoRoot(repo);
  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const example = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";

  const plan = planEnv(repo, existing, example);
  if (flags.json) return out(plan);

  console.log(`.env plan for ${name}  (${envPath})`);
  if (!plan.managed.length) console.log("  (no dependencies declared)");
  for (const m of plan.managed) {
    const tag = m.status === "new" ? "＋ new " : "= kept";
    console.log(`  ${tag} ${m.key.padEnd(16)} ${m.value}   ← ${m.from}`);
  }
  if (plan.needsValue.length) {
    console.log(`\n  needs a value (1ops won't invent these — fill from .env.example / 1Password):`);
    for (const k of plan.needsValue) console.log(`    • ${k}`);
  }

  if (flags.write) {
    const block = renderEnvBlock(plan);
    if (!block) return console.log(`\n✓ nothing to add — .env already has every managed key.`);
    if (existing) copyFileSync(envPath, envPath + ".bak");
    writeFileSync(envPath, existing + block, "utf8");
    console.log(`\n✓ wrote ${plan.managed.filter((m) => m.status === "new").length} key(s)${existing ? " (backed up .env → .env.bak)" : ""}.`);
  } else {
    console.log(`\n(dry run — re-run with --write to apply, merge-safe)`);
  }
}

async function cmdRun(name: string, flags: Flags) {
  const { repo, project } = await findApp(name);
  const env = envName(flags);
  const start = project.envs[env]?.start;
  if (!start) die(`${name}/${env} has no "start" command in its playbook`);
  const cwd = repoRoot(repo);

  console.error(`1ops: running "${start}" in ${cwd}  (logs → ${logPath(name)})`);
  const child = spawn(start, { cwd, shell: true, stdio: ["inherit", "pipe", "pipe"] });

  const pipe = (stream: NodeJS.ReadableStream, which: "out" | "err") => {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
      const level: Level = detectLevel(line, which);
      appendLogSync(name, { ts: Date.now(), level, line, stream: which });
      // pass through so the human still sees normal output
      (which === "err" ? process.stderr : process.stdout).write(line + "\n");
    });
  };
  pipe(child.stdout!, "out");
  pipe(child.stderr!, "err");

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
}

async function cmdLogs(name: string, flags: Flags) {
  const level: Level | undefined = flags.errors ? "error" : (flags.level as Level) || undefined;
  const sinceMs = parseSince(flags.since as string);
  const lines = flags.lines ? Number(flags.lines) : undefined;
  const json = !!flags.json;

  const render = (entries: Awaited<ReturnType<typeof readLogs>>) => {
    if (json) return out(entries);
    for (const e of entries) {
      const t = new Date(e.ts).toISOString().slice(11, 19);
      console.log(`${t} ${e.level.toUpperCase().padEnd(5)} ${e.line}`);
    }
  };

  const entries = await readLogs(name, { level, sinceMs, lines });
  render(entries);

  if (flags.follow && !json) {
    let lastTs = entries.length ? entries[entries.length - 1].ts : sinceMs ?? Date.now();
    setInterval(async () => {
      const fresh = (await readLogs(name, { level })).filter((e) => e.ts > lastTs);
      if (fresh.length) {
        lastTs = fresh[fresh.length - 1].ts;
        render(fresh);
      }
    }, 700);
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "list":
      return cmdList();
    case "creds":
      return cmdCreds(positional[0] ?? die("usage: 1ops creds <app>"), flags);
    case "env":
      return cmdEnv(positional[0] ?? die("usage: 1ops env <app> [--write]"), flags);
    case "run":
      return cmdRun(positional[0] ?? die("usage: 1ops run <app>"), flags);
    case "logs":
      return cmdLogs(positional[0] ?? die("usage: 1ops logs <app>"), flags);
    case "help":
    case undefined:
      return console.log(HELP);
    default:
      die(`unknown command "${cmd}". Try: 1ops help`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
