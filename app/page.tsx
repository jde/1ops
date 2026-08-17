import Link from "next/link";
import QRCode from "qrcode";
import { loadPlaybooks, readSeed } from "@/lib/playbooks";
import {
  ENV_ORDER,
  type Command,
  type Dependency,
  type EnvSpec,
  type Integration,
  type Project,
  type Repo,
} from "@/lib/schema";
import { scanContract, writeContractNote, isMet, type CheckResult } from "@/lib/contract";
import { HealthLight } from "./HealthLight";
import { SimDeck } from "./SimDeck";
import { OpenOnSim } from "./OpenOnSim";
import { Nav } from "./Nav";

/** Fill a quick-login template: {url} raw, {email}/{password} URL-encoded. */
function fillTemplate(tpl: string, vars: { url?: string; email?: string; password?: string }): string {
  return tpl
    .replaceAll("{url}", vars.url ?? "")
    .replaceAll("{email}", encodeURIComponent(vars.email ?? ""))
    .replaceAll("{password}", encodeURIComponent(vars.password ?? ""));
}

export const dynamic = "force-dynamic"; // always read fresh from disk + live git

export default async function Home() {
  const { repos, isExample, dir, errors } = await loadPlaybooks();

  return (
    <main className="wrap">
      <header className="top">
        <h1>🔑 1ops</h1>
        <span className="tag">your dev keyring — every repo, every product, every env, zero secrets stored</span>
      </header>

      <Nav active="ops" />

      {isExample && (
        <div className="banner warn">
          Showing bundled <strong>example</strong> data (all fake). Point <code>ONEOPS_PLAYBOOKS_DIR</code> at your
          symlink farm — or drop playbooks in <code>~/playbooks</code> — to see your real repos.
        </div>
      )}
      {!isExample && (
        <div className="banner">
          Reading {repos.length} repo{repos.length === 1 ? "" : "s"} from <code>{dir}</code>.
        </div>
      )}

      {errors.map((e) => (
        <div className="banner err" key={e.file}>
          <strong>{e.file}</strong>: {e.message}
        </div>
      ))}

      {repos.map((repo) => (
        <RepoCard key={repo._file ?? repo.repo} repo={repo} />
      ))}

      <footer className="foot">
        1ops stores pointers, never secrets. Dev creds are read live from your seed files; staging shows only the name
        of the vault item to open; production logins are never stored here at all.
      </footer>
    </main>
  );
}

/* ───────────────────────────── Repo ───────────────────────────── */

async function RepoCard({ repo }: { repo: Repo }) {
  return (
    <section className="repo-card" id={repo.repo}>
      <div className="repo-head">
        <span className="repo-glyph">📦</span>
        <h2>{repo.repo}</h2>
        {repo.packageManager && <span className="pm">{repo.packageManager}</span>}
        {repo.description && <span className="desc">{repo.description}</span>}
        {repo.repoUrl && (
          <span className="desc">
            · <a href={repo.repoUrl}>git ↗</a>
          </span>
        )}
        <Link className="cross-link" href={`/flow#${repo.repo}`}>
          🚦 flow ↗
        </Link>
      </div>

      {repo.commands && repo.commands.length > 0 && (
        <CommandRow title="shared commands" commands={repo.commands} />
      )}
      {repo.dependencies && repo.dependencies.length > 0 && (
        <DepRow title="shared deps" deps={repo.dependencies} />
      )}

      <div className="projects">
        {repo.projects.map((p) => (
          <ProjectCard key={p.name} repo={repo} project={p} />
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────── Project ─────────────────────────── */

async function ProjectCard({ repo, project }: { repo: Repo; project: Project }) {
  const isPipeline = project.type === "data-pipeline";
  // Scan the app's real code for 1ops-contract conformance, and write the TODO
  // note into its .ops/ folder. The UI below gates affordances on `contract`.
  const contract = await scanContract(repo, project);
  await writeContractNote(repo, project, contract);
  const unmet = contract.filter((c) => !c.met).length;

  return (
    <section className="project-card">
      <div className="project-head">
        <h3>{project.name}</h3>
        {project.type && <span className="type">{project.type}</span>}
        {project.description && <span className="desc">{project.description}</span>}
        {contract.length > 0 && (
          <span
            className={`contract ${unmet ? "contract-unmet" : "contract-ok"}`}
            title={contract.map((c) => `${c.met ? "✓" : "✗"} ${c.title}`).join("\n")}
          >
            {unmet ? `contract ${contract.length - unmet}/${contract.length} · ${unmet} todo` : `contract ✓`}
          </span>
        )}
        {/* data-pipeline health is project-level (one process); website health is per-env. */}
        {isPipeline && project.health?.url && (
          <span className="head-health">
            <HealthLight repo={repo.repo} project={project.name} />
          </span>
        )}
      </div>

      {project.devices && project.devices.length > 0 && <SimDeck devices={project.devices} />}

      {project.commands && project.commands.length > 0 && (
        <CommandRow title="commands" commands={project.commands} />
      )}

      <div className="envs">
        {ENV_ORDER.filter((name) => project.envs[name]).map((name) => (
          <EnvCell key={name} repo={repo} project={project} name={name} env={project.envs[name]!} contract={contract} />
        ))}
      </div>

      {project.integrations && project.integrations.length > 0 && (
        <div className="integrations">
          <span className="int-title">integrations</span>
          {project.integrations.map((it, i) => (
            <IntegrationChip key={i} it={it} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ──────────────────────────── Env cell ───────────────────────── */

async function EnvCell({
  repo,
  project,
  name,
  env,
  contract,
}: {
  repo: Repo;
  project: Project;
  name: "dev" | "staging" | "prod";
  env: EnvSpec;
  contract: CheckResult[];
}) {
  const isWebsite = project.type === "website";
  const realUrl = env.url && !/^TODO/i.test(env.url) ? env.url : null;
  const remote = realUrl ? !/localhost|127\.0\.0\.1/.test(realUrl) : false;
  // QR only helps for a real, remote URL you'd open on your phone (staging/prod).
  const qr = remote && realUrl ? await QRCode.toDataURL(realUrl, { margin: 1, width: 132 }) : null;

  return (
    <div className={`env ${name}`}>
      <div className="env-top">
        <div className="name">{name}</div>
        {/* website health is declared per-env; only render a light where one exists. */}
        {isWebsite && env.health?.url && <HealthLight repo={repo.repo} project={project.name} env={name} />}
      </div>

      {realUrl ? (
        <a className="url" href={realUrl}>
          {realUrl}
        </a>
      ) : (
        env.url && <div className="row muted">url: {env.url}</div>
      )}

      {env.start && (
        <div className="row">
          start: <code>{env.start}</code>
        </div>
      )}
      {env.seedCmd && (
        <div className="row">
          seed: <code>{env.seedCmd}</code>
        </div>
      )}

      <Accounts env={env} name={name} repo={repo} contract={contract} />

      {env.integrations && env.integrations.length > 0 && (
        <div className="env-ints">
          {env.integrations.map((it, i) => (
            <IntegrationChip key={i} it={it} />
          ))}
        </div>
      )}

      {qr && (
        <div className="qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt={`QR code for ${realUrl}`} width={132} height={132} />
          <span className="qr-cap">open on your phone</span>
        </div>
      )}

      {env.gotchas && env.gotchas.length > 0 && (
        <ul className="gotchas">
          {env.gotchas.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── Accounts ────────────────────────── */

async function Accounts({
  env,
  name,
  repo,
  contract,
}: {
  env: EnvSpec;
  name: "dev" | "staging" | "prod";
  repo: Repo;
  contract: CheckResult[];
}) {
  const acct = env.accounts;

  // Hard rule: production logins are NEVER stored in 1ops. A vault POINTER (item
  // name) is fine — that's a label, not a credential. Anything else is suppressed.
  if (name === "prod") {
    if (acct?.source === "vault") {
      return (
        <div className="row">
          🔐 <span className="vault">1Password → {acct.vaultItem}</span>
        </div>
      );
    }
    return <div className="row prod-nologin">🔒 production — no login stored in 1ops</div>;
  }

  if (!acct) return null;

  if (acct.source === "vault") {
    return (
      <div className="row">
        🔐 <span className="vault">1Password → {acct.vaultItem}</span>
      </div>
    );
  }
  if (acct.source === "inline-nonsecret") {
    return <div className="row">👤 {acct.note}</div>;
  }
  // seed: structured users (agent-readable) + the live seed file underneath.
  const seed = acct.seedFile ? await readSeed(repo, acct.seedFile) : null;
  const ql = env.quickLogin;
  // Only offer quick-login if the APP actually honors the contract for it.
  const webOk = !!ql?.web && isMet(contract, "quick-login-web");
  const deepOk = !!ql?.deepLink && isMet(contract, "quick-login-deeplink");
  const declaredButUnmet = (!!ql?.web && !webOk) || (!!ql?.deepLink && !deepOk);
  return (
    <div>
      {acct.users && acct.users.length > 0 && (
        <table className="users">
          <tbody>
            {acct.users.map((u, i) => {
              const creds = { url: env.url, email: u.email ?? u.username, password: u.password };
              const canFill = !!(creds.email && creds.password);
              return (
                <tr key={i}>
                  <td>{u.email ?? u.username}</td>
                  <td>
                    <code>{u.password ?? u.note ?? "—"}</code>
                  </td>
                  <td className="role">{u.role}</td>
                  <td className="ql">
                    {canFill && webOk && (
                      <a className="ql-link" href={fillTemplate(ql!.web!, creds)} target="_blank" rel="noreferrer">
                        → login
                      </a>
                    )}
                    {canFill && deepOk && <OpenOnSim deepLink={fillTemplate(ql!.deepLink!, creds)} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {declaredButUnmet && (
        <div className="row ql-unmet">
          ⚠ quick-login defined but the app doesn&apos;t read prefill creds yet — see <code>.ops/1ops-contract.md</code>
        </div>
      )}
      {seed && seed.ok && (
        <details className="seed">
          <summary>🌱 source of truth: {acct.seedFile}</summary>
          <pre>{seed.content.trim()}</pre>
        </details>
      )}
      {seed && !seed.ok && <div className="row">🌱 seed: {seed.error}</div>}
      {!acct.users && !seed && <div className="row">🌱 seed (no users mirrored)</div>}
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function CommandRow({ title, commands }: { title: string; commands: Command[] }) {
  return (
    <div className="commands">
      <span className="commands-title">{title}</span>
      {commands.map((c, i) => (
        <div className="cmd" key={i}>
          <span className="cmd-label">{c.label}</span>
          <code>{c.run}</code>
          {c.cwd && <span className="cmd-cwd">in {c.cwd}/</span>}
        </div>
      ))}
    </div>
  );
}

function DepRow({ title, deps }: { title: string; deps: Dependency[] }) {
  return (
    <div className="deps">
      <span className="deps-title">{title}</span>
      {deps.map((d, i) => (
        <span className="dep" key={i}>
          {d.kind}
          {d.version ? ` ${d.version}` : ""}
          {d.port ? <span className="dep-port">:{d.port}</span> : null}
          {d.seed ? <span className="dep-seed">🌱</span> : null}
        </span>
      ))}
    </div>
  );
}

function IntegrationChip({ it }: { it: Integration }) {
  const label = it.url ? <a href={it.url}>{it.name} ↗</a> : <span>{it.name}</span>;
  return (
    <span className="int" title={it.note}>
      {label}
      {it.vaultItem && <span className="int-vault">🔐 {it.vaultItem}</span>}
    </span>
  );
}
