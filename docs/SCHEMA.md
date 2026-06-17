# The 1ops playbook contract

One playbook per repo, at `/.ops/playbook.yaml`. It stores **pointers, never
secrets**. The dashboard reads many playbooks and renders one card per app.

## Two files per repo

| File | Committed? | Holds |
|---|---|---|
| `.ops/playbook.yaml` | ✅ yes | Everything safe to publish: commands, URLs, seed-file pointer, **seeded dev users (public)**, integration names |
| `.ops/playbook.local.yaml` | 🚫 never (gitignored) | The rare genuinely-sensitive bit you still want on your dashboard |

The dashboard merges them (local overlays base). The goal: **check in the
maximum amount of information**, and quarantine only the little that's sensitive
into a file git never sees.

## Fields

```yaml
app: acme-web                      # required. one per repo.
description: Marketing + dashboard # optional
repo: https://github.com/acme/web  # optional
packageManager: pnpm               # npm | pnpm | yarn | bun

# Key commands and WHICH FOLDER to run them in (monorepo lifesaver)
commands:
  - { label: install, run: pnpm install }
  - { label: dev (web), run: pnpm dev, cwd: apps/web }

envs:                              # required. dev | staging | prod, all optional.
  dev:
    url: http://localhost:3000
    start: pnpm dev
    seedCmd: pnpm db:seed
    accounts:
      source: seed                 # read live from committed code…
      seedFile: prisma/seed.ts     # …this file. Path only, never the values.
    gotchas:
      - run docker compose up db first
  staging:
    url: https://staging.acme.dev
    accounts:
      source: vault                # a 1Password item NAME
      vaultItem: Acme — staging
  prod:
    url: https://acme.com
    accounts: { source: vault, vaultItem: Acme — production }

# Third-party services. Names + dashboards + vault item names. Never keys.
integrations:
  - { name: Stripe, url: https://dashboard.stripe.com, vaultItem: Acme — Stripe }
```

## `accounts.source` values

| source | use for | what you write |
|---|---|---|
| `seed` | dev | `seedFile:` — path to the committed seed file. Read live. |
| `vault` | staging / prod | `vaultItem:` — the 1Password item NAME, never its contents |
| `inline-nonsecret` | dev with no auth | `note:` — e.g. "no auth in dev" |

## The one rule

If a value would be unsafe in a public repo, it does not go in `playbook.yaml`.
It goes in `playbook.local.yaml` (gitignored) or stays in 1Password. The loader
hard-refuses any committed playbook that trips its secret scanner.
