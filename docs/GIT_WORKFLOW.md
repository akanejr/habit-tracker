# Git Workflow

Established for Bloom phased development. Simple, reliable, and auditable.

## Authentication

GitHub access uses a **fine-grained Personal Access Token (PAT)** scoped to `akanejr/habit-tracker` with `Contents: Read and write` permission only.

### Session Setup

At the start of each working session, the PAT is provided through Arena chat. Configure git credentials for the session:

```bash
cd /home/user/habit-tracker
git config credential.helper 'store --file=.git/credentials'
echo "https://x-access-token:<PAT>@github.com" > .git/credentials
```

The `.git/credentials` file is ephemeral (excluded from workspace snapshots) and never committed. The remote URL stays clean:

```
origin  https://github.com/akanejr/habit-tracker.git (fetch)
origin  https://github.com/akanejr/habit-tracker.git (push)
```

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Accepted, merged work. Never pushed to directly except via merge commits. |
| `bloom/phase-N-*` | Isolated feature branches, one per phase. |

### Branch Creation

Every phase branch is created from the latest `main`:

```bash
git checkout main
git pull origin main
git checkout -b bloom/phase-N-scope-name
```

## Push and Verify

Every push must be:

1. **Pushed to GitHub** — `git push origin <branch>`
2. **Verified on GitHub** — confirm commit SHA and branch exist via GitHub API
3. **Deployed to Vercel Preview** — automatic on push
4. **Preview SHA matched** — Vercel deployment commit SHA must match GitHub commit SHA

Local commits alone are **not delivered**. A commit is only considered delivered when:
- It is on GitHub (verified via API)
- Vercel Preview is READY with matching SHA

## Merge Process

When a phase is accepted:

```bash
git checkout main
git pull origin main
git merge --no-ff bloom/phase-N-scope-name -m "Merge Phase N: <description>"
git push origin main
```

- Use `--no-ff` to create an explicit merge commit
- Verify merge commit on GitHub (check it has two parents)
- Vercel creates a Preview for main but does **not** auto-deploy to Production

## Production Deployment

Production deployments are **manual only** via Vercel promotion. They are never triggered by git pushes.

## Safeguards

- **Preview environment**: Simulation-only (synthetic Supabase URL, placeholder anon key, `BLOOM_PHASE1_DEMO=1`)
- **Production environment**: Hosted Supabase credentials, unchanged by branch pushes
- **No service role key** in Preview
- **No paid infrastructure**
