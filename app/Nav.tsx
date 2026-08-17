import Link from "next/link";

/**
 * Two top-level pages, two different jobs:
 *   - Ops   (/)      — day-to-day: get into the running thing (urls, logins, health, run).
 *   - Flow  (/flow)  — planning product arcs: branches, staging→prod, deploy status.
 * They are cross-linked per-repo so you can jump between "operate it" and "where is it".
 */
export function Nav({ active }: { active: "ops" | "flow" }) {
  return (
    <nav className="nav">
      <Link className={active === "ops" ? "nav-tab on" : "nav-tab"} href="/">
        🔑 Ops
      </Link>
      <Link className={active === "flow" ? "nav-tab on" : "nav-tab"} href="/flow">
        🚦 Git &amp; Deploys
      </Link>
    </nav>
  );
}
