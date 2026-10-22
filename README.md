# oss-contributor

An autonomous open-source contribution agent. It finds promising projects,
decides where to spend effort, looks for real bugs, tries to disprove its own
findings, and only then writes a fix. Every public action (pushing a branch,
opening a PR) waits for a human to approve the exact artifact.

## The four roles

| Role | What it does | Code | Look at it |
|---|---|---|---|
| 1. Discoverer | Searches GitHub, applies hard gates (stars, license, activity, size) and a deterministic score | `src/workflows/discover.ts`, `src/discovery/scoring.ts` | `pnpm discover` |
| 2. Selector | Analyzes each project once per commit, then ranks which ones deserve budget (maintenance health, small contribution areas, runnable tests) | `src/workflows/analyzeProject.ts`, `src/selection/shortlist.ts` | `pnpm shortlist` |
| 3. Bug finder | Reads issues and code and writes falsifiable bug hypotheses (candidates) | `src/agents/hypothesis.ts`, `src/workflows/generateHypotheses.ts` | `pnpm hypotheses` |
| 4. Verifier | A skeptical validator tries to disprove each candidate, a sandbox reproduction runs it, duplicates and maintainer context are checked, and rules produce a decision | `src/agents/validator.ts`, `reproduction.ts`, `duplicate.ts`, `decision.ts` | `pnpm investigate`, `pnpm pipeline --verified` |

Only candidates the verifier marks `IMPLEMENT` move on: implementation in a
Docker sandbox, four independent reviewers (correctness, security,
maintainability, adversarial), and gated submission.

```
discover -> analyze -> shortlist -> hypotheses -> investigate -> implement -> review -> approve -> publish
```

State changes go through a state machine (`src/domain/states.ts`); illegal
transitions throw. Work is a Postgres-backed queue (`src/worker`).

## Quick start

Requires Node 22, pnpm, Docker.

```bash
pnpm local            # Postgres in Docker, .env, migrations, health check
# edit .env: GITHUB_TOKEN, FIREWORKS_API_KEY
pnpm doctor           # verify setup
pnpm worker           # run the pipeline (or: pnpm local --run)
```

Defaults are conservative: `AUTONOMY_LEVEL=approval_required`, a $5/day and
$60/month AI budget, no network inside the sandbox.

## Commands

| Command | Purpose |
|---|---|
| `pnpm doctor` | Check env, database, tokens, Docker |
| `pnpm discover` | Run one discovery cycle |
| `pnpm shortlist` | Ranked projects worth investigating, with reasons |
| `pnpm pipeline` | Counts per role; `--verified` shows verifier decisions |
| `pnpm advance` | Queue the next stage for idle work (`--dry-run` to preview) |
| `pnpm budget` | AI spend against limits |
| `pnpm status --contribution <id>` | Full view of one contribution |
| `pnpm approve` / `pnpm publish` | Human approval and publishing |
| `pnpm test` | Unit and integration tests (integration needs `TEST_DATABASE_URL`) |

## Safety model

- Repository content is treated as untrusted in every prompt.
- Sandbox commands go through an allowlist and run in a container without network.
- Approvals bind to a hash of repo, branch, base/head SHA, diff and PR text; any change invalidates them.
- Review aggregation is rule-based: one evidenced major defect blocks, style notes never do.
- Spend counters live in the database and are checked before every model call.
