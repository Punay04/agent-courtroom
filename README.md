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

### GitHub webhook
Repo → Settings → Webhooks → Add:
- Payload URL: `$PUBLIC_URL/api/github/webhook`
- Content type: `application/json`
- Secret: `$WEBHOOK_SECRET`
- Events: **Pull requests** and **Issue comments**

Commenting `/court` on a PR re-runs the trial.

## Layout
`src/server.ts` (HTTP, SSE, webhook) · `trial.ts` (orchestrator) · `counsel.ts` (prosecutor/defender tool loop) · `judge.ts` · `clerk.ts` · `bailiff.ts` (sandbox setup) · `courthouse.ts` (CreateOS SDK) · `llm.ts` (Gemini Interactions API) · `github.ts` · `render.ts` (PR comment) · `public/` (docket + courtroom UI) · `recordings/` (every trial, replayable)
