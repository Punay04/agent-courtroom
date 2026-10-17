# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing Bun server (`src/server.ts`) serves the docket and live courtroom and exposes the trial HTTP and SSE APIs. UI rebuild uses Tailwind CSS and Motion (Framer Motion) on that server. Confirmed by the user.

## Users

A developer running Agent Courtroom locally. They paste a GitHub pull request, watch prosecution and defense argue from sandbox evidence, and read the judge's verdict. Confirmed from the repository and the user's approval to rebuild both screens for that job.

## Product Purpose

Every pull request gets a trial. A prosecutor agent writes code to break the change. A defender agent writes code to prove it. Both run in isolated CreateOS micro-VMs. A judge rules from exit codes, timings, and output, then the result can be posted back to GitHub. Success is a verdict grounded in executed evidence, visible while it happens.

## Positioning

The courtroom runs adversarial code in two sandboxes and rules on execution evidence. Neighboring review bots can comment. They cannot truthfully claim a side-by-side micro-VM trial whose ruling is exit codes and timings.

## Operating Context

Local Bun process, typically behind a public URL for GitHub webhooks. The operator starts a trial from the docket or from a pull request event or a `/court` comment. The live page is an SSE stream of the recording. Recordings replay. GitHub receives a PR comment and a commit status when a token is configured.

## Capabilities and Constraints

- Docket: health, summon by PR URL, counts, case list linking to `/trial/:id`.
- Courtroom: case title, PR link, replay, prosecution feed, defense feed, bench (clerk, exhibit 0, charge sheet, rounds, verdict), live speech, inspect output, exhibit code and terminal output, verdict overlay.
- Rulings: BROKEN, UPHELD, INCONCLUSIVE. In session and mistrial are states, not rulings.
- Do not invent customers, benchmarks, or capabilities the server does not have.
- Visual constraint, user-binding: Screenpipe on a white coding desk. Bone canvas, white work surfaces, black text, phosphor `#C7FF3E` only as a fill for live actions and the output label (never as text on white). Space Grotesk for the interface, IBM Plex Mono for code and timings. Tailwind, Motion, and interruptible springs stay.

## Brand Commitments

Name: Agent Courtroom. Voice in the product is direct and specific: summon, prosecution, defense, the bench, exhibit, verdict. Courtroom roles stay. The light Screenpipe coding desk the user asked for is binding.

## Evidence on Hand

README, `ui/docket.html`, `ui/trial.html`, and `src/server.ts`. No logos, testimonials, or press. Do not fabricate any.

## Product Principles

- Show the trial, do not narrate it.
- Evidence outranks opinion: exit codes, timings, and output stay visible.
- The operator can start, follow, replay, and leave without a dead end.
- Live work is marked as live. A settled verdict reads as settled.
- Keep the language of the court. Do not add marketing claims.
