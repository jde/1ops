# 🔑 1ops

**1Password's chaotic dev cousin.**

You have a dozen apps. Each has a dev URL, a staging URL, a prod URL, a package
manager you can never remember, a seed script that creates dev logins you've
forgotten, and three integrations whose dashboards live in your browser history.
1Password is great for the stable secrets — and useless for all of *that*,
because *that* changes every week.

1ops is the place you look first and always get where you're going. It's a
dashboard of every app: URLs, the commands (and which folder to run them in),
your seeded dev logins, and a cue for where the real creds live — **without ever
storing a single secret.**

> It's like a password manager, except it refuses to know any passwords. By
> design. We talked about it in therapy.

## The trick: it stores pointers, not values

A dev environment is chaos because its *values* churn — ports move, databases
get reseeded, previews get torn down. So 1ops never stores values. It stores the
**source** of the value, which doesn't churn:

| Thing you forget | What 1ops stores | Why it never goes stale |
|---|---|---|
| Dev login | The path to your committed `seed.ts` | It's the actual source of truth; read live |
| Staging / prod creds | The **name** of the 1Password item | A label, not a secret |
| Which command, which folder | `pnpm dev` in `apps/web/` | It's in your repo already |
| That one integration dashboard | Its URL + vault item name | Just a bookmark |

Seeded dev users are **public** — they only work on `localhost` and they already
live in your committed code. So 1ops shows them to you directly. Everything
genuinely sensitive stays in 1Password, or in a per-repo file git never sees.

## Where data lives (and what this repo is)

**This repo** ships the dashboard + the LLM skills + the docs. It contains **no
data about your apps.** The data lives in each of *your* repos:

```
your-app/
  .ops/
    playbook.yaml         ✅ committed — the maximum safe-to-publish info
    playbook.local.yaml   🚫 gitignored — the rare sensitive bit, never leaves your machine
```

We never store anything sensitive — not in this repo, not in any database, and
nothing that belongs to anyone else. There is no central database. It's your
files, on your machine, rendered.

## Quickstart

```sh
pnpm install
pnpm dev          # http://localhost:3000 — boots with fake EXAMPLE data
```

Point it at your real apps:

```sh
export ONEOPS_PLAYBOOKS_DIR="$HOME/playbooks"   # or anywhere
# then, in each app, generate a playbook (see below) and symlink it in
```

## Onboarding a repo

In any app's repo, run the **`generate-playbook`** skill (in `skills/`). It reads
your `package.json`, `.env`, and seed files, writes `.ops/playbook.yaml`, makes
sure `.ops/*.local.yaml` is gitignored, and symlinks it into your playbooks dir.

Do it for all twelve apps and your dashboard fills itself in.

## Security promise

- Playbooks store **pointers, never secrets**.
- The loader **hard-refuses** any committed playbook that looks like it contains
  a key, token, or private key.
- The only sanctioned home for sensitive values is `playbook.local.yaml`, which
  is gitignored and never reaches this repo or any server.
- Deploy it if you want it on your phone — but it only ever renders pointers, so
  there's nothing to leak.

See [`docs/SCHEMA.md`](docs/SCHEMA.md) for the full contract.

## License

MIT. Go nuts.
