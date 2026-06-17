import { loadPlaybooks, readSeed } from "@/lib/playbooks";
import { ENV_ORDER, type EnvSpec, type Integration, type Playbook } from "@/lib/schema";

export const dynamic = "force-dynamic"; // always read fresh from disk

export default async function Home() {
  const { playbooks, isExample, dir, errors } = await loadPlaybooks();

  return (
    <main className="wrap">
      <header className="top">
        <h1>🔑 1ops</h1>
        <span className="tag">your dev keyring — every app, every env, zero secrets stored</span>
      </header>

      {isExample && (
        <div className="banner warn">
          Showing bundled <strong>example</strong> data (all fake). Point{" "}
          <code>ONEOPS_PLAYBOOKS_DIR</code> at your symlink farm — or drop playbooks in{" "}
          <code>~/playbooks</code> — to see your real apps.
        </div>
      )}
      {!isExample && (
        <div className="banner">
          Reading {playbooks.length} playbook{playbooks.length === 1 ? "" : "s"} from <code>{dir}</code>.
        </div>
      )}

      {errors.map((e) => (
        <div className="banner err" key={e.file}>
          <strong>{e.file}</strong>: {e.message}
        </div>
      ))}

      {playbooks.map((pb) => (
        <AppCard key={pb._file ?? pb.app} pb={pb} />
      ))}

      <footer className="foot">
        1ops stores pointers, never secrets. Dev creds are read live from your seed files; staging &
        prod show only the name of the vault item to open.
      </footer>
    </main>
  );
}

async function AppCard({ pb }: { pb: Playbook }) {
  return (
    <section className="app-card">
      <div className="head">
        <h2>{pb.app}</h2>
        {pb.packageManager && <span className="pm">{pb.packageManager}</span>}
        {pb.description && <span className="desc">{pb.description}</span>}
        {pb.repo && (
          <span className="desc">
            · <a href={pb.repo}>repo ↗</a>
          </span>
        )}
      </div>

      {pb.commands && pb.commands.length > 0 && (
        <div className="commands">
          {pb.commands.map((c, i) => (
            <div className="cmd" key={i}>
              <span className="cmd-label">{c.label}</span>
              <code>{c.run}</code>
              {c.cwd && <span className="cmd-cwd">in {c.cwd}/</span>}
            </div>
          ))}
        </div>
      )}

      <div className="envs">
        {ENV_ORDER.filter((name) => pb.envs[name]).map((name) => (
          <EnvCell key={name} name={name} env={pb.envs[name]!} pb={pb} />
        ))}
      </div>

      {pb.integrations && pb.integrations.length > 0 && (
        <div className="integrations">
          <span className="int-title">integrations</span>
          {pb.integrations.map((it, i) => (
            <IntegrationChip key={i} it={it} />
          ))}
        </div>
      )}
    </section>
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

async function EnvCell({ name, env, pb }: { name: string; env: EnvSpec; pb: Playbook }) {
  return (
    <div className={`env ${name}`}>
      <div className="name">{name}</div>
      {env.url && (
        <a className="url" href={env.url}>
          {env.url}
        </a>
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
      <Accounts env={env} pb={pb} />
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

async function Accounts({ env, pb }: { env: EnvSpec; pb: Playbook }) {
  const acct = env.accounts;
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
  // seed: show structured users (agent-readable) + the live seed file underneath.
  const seed = acct.seedFile ? await readSeed(pb, acct.seedFile) : null;
  return (
    <div>
      {acct.users && acct.users.length > 0 && (
        <table className="users">
          <tbody>
            {acct.users.map((u, i) => (
              <tr key={i}>
                <td>{u.email ?? u.username}</td>
                <td>
                  <code>{u.password ?? u.note ?? "—"}</code>
                </td>
                <td className="role">{u.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
