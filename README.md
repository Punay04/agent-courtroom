# ⚖️ Agent Courtroom

**Every pull request gets a trial.** When a PR is opened, a **prosecutor** agent writes code to break it and a **defender** agent writes code to prove it. Each runs in its own isolated **CreateOS micro-VM**, in parallel. A **judge** agent rules on the execution evidence (exit codes, timings, output) and posts the verdict back to the PR as a comment with a runnable reproducer, plus a red/green commit status.

> *CI was green. The court wasn't.*

## How it works

```
GitHub ──webhook──▶  Bun server
                       ├─▶ Gemini API     prosecutor / defender (gemini-3.5-flash-lite), judge (gemini-3.8-flash)
                       ├─▶ CreateOS API   2 micro-VMs per trial; all agent-written code runs here
                       └─▶ GitHub API     PR comment + commit status
Browser ◀── SSE ── live courtroom at /trial/:id
```

1. **Bailiff:** downloads the base and head tarballs on the host (the GitHub token never enters a sandbox), creates two sandboxes with egress locked to PyPI, unpacks both checkouts, installs deps, and runs the existing test suite on both (Exhibit 0).
2. **Clerk:** turns the PR into a charge sheet of falsifiable criteria.
3. **Two rounds, prosecution and defense in parallel.** Each side can `inspect` the repo (not evidence) and file up to 3 `run_exhibit`s per round. `checkout: both` runs the same script on base and head, which proves regressions or pre-existing conditions.
4. **Judge:** rules BROKEN / UPHELD / INCONCLUSIVE from the raw evidence only.

## Languages

The bailiff detects the stack from marker files, weighted by which languages the PR touches:

| Stack | Detected by | Install | Exhibit 0 | Agents write exhibits in |
|---|---|---|---|---|
| Python | `requirements*.txt`, `pyproject.toml`, `setup.py`, `.py` files | pip (requirements + project extras `test/tests/testing/dev`) | `pytest` | python |
| JS / TS | `package.json` | bun / pnpm / yarn / npm by lockfile, per checkout | `npm test` (or `bun test`) | javascript (node), typescript (bun) |
| Go | `go.mod` | `go mod download` | `go test ./...` | bash → temporary `_test.go` |
| Rust | `Cargo.toml` | `cargo fetch` | `cargo test` | bash → temporary `tests/*.rs` |
| C / C++ | `Makefile` with `test:` | none | `make test` | bash (gcc, g++, make) |

Sandbox egress is limited to PyPI, npm, the Go module proxy and crates.io.

## Run it

```bash
bun install
cp .env.example .env      # fill in GEMINI_API_KEY, CREATEOS_SANDBOX_API_KEY, GITHUB_TOKEN, WEBHOOK_SECRET, PUBLIC_URL
bun src/smoke.ts          # proves sandboxes + Gemini work
ngrok http 3000           # put the https URL in PUBLIC_URL
bun src/server.ts         # http://localhost:3000
```

Start a trial from the docket page by pasting a PR URL, or by HTTP request:
`bun -e 'console.log(await (await fetch("http://localhost:3000/api/trials",{method:"POST",body:JSON.stringify({prUrl:"https://github.com/OWNER/REPO/pull/1"})})).json())'`

### Storage (Postgres)
Set `DATABASE_URL` to use Postgres (Bun's built-in client, no extra dependency). The schema is created on boot: `trials` (one row per trial with PR, owner, visibility, status and verdict), `trial_events` (every streamed event, for replays) and `sessions` (OAuth tokens encrypted with `SESSION_SECRET`). Trials interrupted by a restart are marked as mistrials. Run `bun src/db-import.ts` once to copy existing file recordings into the database. Without `DATABASE_URL`, everything is stored in `recordings/` and `data/`.

### Sign in with GitHub (repo browser + auto-trial)
1. github.com/settings/developers → **OAuth Apps → New OAuth App**. Homepage URL: `$PUBLIC_URL`. Callback URL: `$PUBLIC_URL/auth/github/callback`.
2. Put `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and a random `SESSION_SECRET` in `.env`, then restart.
3. Open the app via `$PUBLIC_URL` (the cookie and callback live on that host) and click **Sign in with GitHub**.

Signed-in users get:
- **My PRs**: their open PRs across GitHub, with trial status chips. **Auto-trial** puts every new PR they open, and every new commit pushed to one, on trial within `POLL_INTERVAL_SEC`. PRs that existed before sign-in are left alone; "Run on all my open PRs" covers those.
- **My repos**: public and private repositories. Expand one to see its open PRs, put any of them on trial, or try them all (capped at 10).
- Results stay in the UI. Signed-in trials never comment on or set statuses on GitHub.
- Trials on **private** repos are visible only to the user who ran them, and are recorded in gitignored `data/recordings/`. Sessions, including OAuth tokens, are stored AES-256-GCM-encrypted in `data/sessions.json`. Tokens never reach the browser or the sandboxes.

Use an ngrok static domain (`ngrok http --url=<name>.ngrok-free.app 3000`) so the OAuth callback URL never changes.

### GitHub webhook
Repo → Settings → Webhooks → Add:
- Payload URL: `$PUBLIC_URL/api/github/webhook`
- Content type: `application/json`
- Secret: `$WEBHOOK_SECRET`
- Events: **Pull requests** and **Issue comments**

Commenting `/court` on a PR re-runs the trial.

## Deploy to Cloud Run
The whole app (UI, API, trial engine, watcher) ships as one container. Live trials and the queue are in memory, so run **exactly one always-on instance**.

```bash
gcloud auth login && gcloud config set project <PROJECT>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# one Secret Manager secret per sensitive value, e.g.
printf %s "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
# ...createos-sandbox-api-key, github-token, github-client-secret-prod, session-secret, webhook-secret, database-url
gcloud projects add-iam-policy-binding <PROJECT> \
  --member serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com --role roles/secretmanager.secretAccessor

gcloud run deploy agent-courtroom --source . --region <REGION> \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 1Gi \
  --timeout 3600 --session-affinity --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,GITHUB_CLIENT_ID=<prod OAuth app client id> \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest,CREATEOS_SANDBOX_API_KEY=createos-sandbox-api-key:latest,GITHUB_TOKEN=github-token:latest,GITHUB_CLIENT_SECRET=github-client-secret-prod:latest,SESSION_SECRET=session-secret:latest,WEBHOOK_SECRET=webhook-secret:latest,DATABASE_URL=database-url:latest

# then point PUBLIC_URL at the printed https://...run.app URL
gcloud run services update agent-courtroom --region <REGION> --update-env-vars PUBLIC_URL=<url>
```

- **Cloud SQL:** add `--add-cloudsql-instances <PROJECT:REGION:INSTANCE>` and `--update-env-vars DATABASE_SOCKET_PATH=/cloudsql/<PROJECT:REGION:INSTANCE>/.s.PGSQL.5432` to connect over the private socket.
- Use a separate GitHub OAuth app for production (callback `<url>/auth/github/callback`), and point the repo webhook at `<url>/api/github/webhook`.
- The instance is billed while it runs. Delete it with `gcloud run services delete agent-courtroom --region <REGION>`.

## Layout
`src/server.ts` (HTTP, SSE, webhook, OAuth) · `trial.ts` (orchestrator) · `counsel.ts` (prosecutor/defender tool loop) · `judge.ts` · `clerk.ts` · `bailiff.ts` (sandbox setup) · `courthouse.ts` (CreateOS SDK) · `llm.ts` (Gemini) · `github.ts` · `auth.ts` · `watcher.ts` (auto-trial) · `store.ts` (Postgres / files) · `render.ts` (PR comment) · `ui/` (React docket + courtroom) · `Dockerfile` (Cloud Run)
