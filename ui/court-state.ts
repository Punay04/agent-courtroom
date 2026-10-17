import type { Checkout, ExecResult, TrialEvent } from "../src/types.ts";

export type Tone = "live" | "settled" | "quiet";

export type TermPart = { key: number; kind: "label" | "out" | "err"; text: string };

export type Badge = {
  checkout: string;
  text: string;
  running: boolean;
  title?: string;
};

export type SpeechBlock = { kind: "speech"; id: string; text: string };
export type MarkerBlock = { kind: "marker"; id: string; text: string };
export type InspectBlock = { kind: "inspect"; id: string; command: string; output: string; open: boolean };
export type TypingBlock = { kind: "typing"; id: string; code: string };
export type ExhibitBlock = {
  kind: "exhibit";
  id: string;
  argument: string;
  language: string;
  checkout: string;
  code: string;
  terminal: TermPart[];
  badges: Badge[];
  decisive: boolean;
  lastCheckout: string | null;
};

export type Block = SpeechBlock | MarkerBlock | InspectBlock | TypingBlock | ExhibitBlock;

export type SideState = {
  active: boolean;
  phase: string;
  composing: boolean;
  blocks: Block[];
};

export type BenchCard =
  | {
      kind: "tests";
      id: string;
      framework: string;
      tests: { checkout: string; passed: number; failed: number; exitCode: number }[];
    }
  | { kind: "charge"; id: string; summary: string; criteria: string[] }
  | {
      kind: "verdict";
      id: string;
      ruling: string;
      label: string;
      confidence: string;
      headline: string;
      reasoning: string;
      decisive: string | null;
      recommendation: string;
      blocking: { title: string; exhibit_id: string }[];
    }
  | { kind: "error"; id: string; message: string };

export type CourtState = {
  n: number;
  title: string;
  sub: string;
  prUrl: string;
  chip: string;
  chipTone: Tone;
  round: number;
  settled: boolean;
  deliberating: boolean;
  status: string[];
  cards: BenchCard[];
  overlay: { label: string; headline: string } | null;
  missing: boolean;
  bead: "prosecution" | "defense" | "bench" | null;
  prosecution: SideState;
  defense: SideState;
};

const RULING: Record<string, string> = {
  BROKEN: "Claim broken",
  UPHELD: "Claim upheld",
  INCONCLUSIVE: "Inconclusive",
};

const RECOMMEND: Record<string, string> = {
  merge: "Merge",
  request_changes: "Request changes",
  needs_human_review: "Needs a person",
};

function side(): SideState {
  return { active: false, phase: "Waiting", composing: false, blocks: [] };
}

export const initialCourt: CourtState = {
  n: 0,
  title: "Convening",
  sub: "The clerk is opening the record.",
  prUrl: "",
  chip: "In session",
  chipTone: "live",
  round: 0,
  settled: false,
  deliberating: false,
  status: [],
  cards: [],
  overlay: null,
  missing: false,
  bead: null,
  prosecution: side(),
  defense: side(),
};

function nid(state: CourtState) {
  state.n += 1;
  return `b${state.n}`;
}

function patchSide(state: CourtState, role: "prosecution" | "defense", fn: (side: SideState) => void) {
  fn(state[role]);
}

function runningBadge(checkout: string): Badge {
  return { checkout, text: "Running", running: true };
}

function resultBadge(checkout: string, result: ExecResult): Badge {
  if (result.timed_out) return { checkout, text: `Timeout · ${result.exec_ms}ms`, running: false };
  const word = result.exit_code === 0 ? "Exit 0" : `Exit ${result.exit_code}`;
  return { checkout, text: `${word} · ${result.exec_ms}ms`, running: false };
}

function locateExhibit(state: CourtState, id: string) {
  for (const role of ["prosecution", "defense"] as const) {
    const index = state[role].blocks.findIndex((item) => item.kind === "exhibit" && item.id === id);
    const block = state[role].blocks[index];
    if (block?.kind === "exhibit") return { role, index, exhibit: { ...block, terminal: block.terminal.slice(), badges: block.badges.slice() } };
  }
  return undefined;
}

function saveExhibit(state: CourtState, role: "prosecution" | "defense", index: number, exhibit: ExhibitBlock) {
  const blocks = state[role].blocks.slice();
  blocks[index] = exhibit;
  state[role] = { ...state[role], blocks };
}

export function reduceCourt(state: CourtState, event: TrialEvent): CourtState {
  const next: CourtState = {
    ...state,
    status: state.status.slice(),
    cards: state.cards.slice(),
    prosecution: { ...state.prosecution, blocks: state.prosecution.blocks.slice() },
    defense: { ...state.defense, blocks: state.defense.blocks.slice() },
  };

  switch (event.t) {
    case "trial_start": {
      const pr = event.pr;
      next.title = pr.title;
      next.sub = `${pr.owner}/${pr.repo} #${pr.number} by ${pr.author} · head ${pr.head_sha.slice(0, 7)} vs base ${pr.base_sha.slice(0, 7)}`;
      next.prUrl = pr.html_url;
      next.missing = false;
      return next;
    }
    case "status": {
      next.status = [...next.status, event.message].slice(-5);
      return next;
    }
    case "exhibit0": {
      next.cards.push({
        kind: "tests",
        id: nid(next),
        framework: event.tests[0]?.framework ?? "none",
        tests: event.tests.map((test) => ({
          checkout: test.checkout,
          passed: test.passed,
          failed: test.failed,
          exitCode: test.exit_code,
        })),
      });
      return next;
    }
    case "charge": {
      next.cards.push({
        kind: "charge",
        id: nid(next),
        summary: event.sheet.summary,
        criteria: event.sheet.falsifiable_criteria,
      });
      return next;
    }
    case "turn_start": {
      next.round = event.round;
      next.bead = event.role;
      patchSide(next, event.role, (book) => {
        book.active = true;
        book.phase = `Round ${event.round} · arguing`;
        book.composing = false;
        book.blocks.push({
          kind: "marker",
          id: nid(next),
          text: event.round > 1 ? `Round ${event.round} · rebuttal` : `Round ${event.round}`,
        });
      });
      return next;
    }
    case "speech": {
      patchSide(next, event.role, (book) => {
        const last = book.blocks.at(-1);
        if (book.composing && last?.kind === "speech") {
          book.blocks[book.blocks.length - 1] = { ...last, text: last.text + event.text };
          return;
        }
        book.composing = true;
        book.blocks.push({ kind: "speech", id: nid(next), text: event.text });
      });
      return next;
    }
    case "inspect": {
      patchSide(next, event.role, (book) => {
        book.composing = false;
        book.blocks.push({
          kind: "inspect",
          id: nid(next),
          command: event.command,
          output: event.output,
          open: false,
        });
      });
      return next;
    }
    case "exhibit_code": {
      patchSide(next, event.role, (book) => {
        const last = book.blocks.at(-1);
        if (last?.kind === "typing") {
          book.blocks[book.blocks.length - 1] = { ...last, code: event.code };
          return;
        }
        book.blocks.push({ kind: "typing", id: nid(next), code: event.code });
      });
      return next;
    }
    case "exhibit_start": {
      const checkouts = event.checkout === "both" ? ["base", "head"] : [event.checkout];
      patchSide(next, event.role, (book) => {
        book.composing = false;
        book.blocks = book.blocks.filter((block) => block.kind !== "typing");
        book.blocks.push({
          kind: "exhibit",
          id: event.id,
          argument: event.argument,
          language: event.language,
          checkout: event.checkout === "both" ? "base vs head" : event.checkout,
          code: event.code,
          terminal: [],
          badges: checkouts.map(runningBadge),
          decisive: false,
          lastCheckout: null,
        });
      });
      return next;
    }
    case "exhibit_output": {
      const found = locateExhibit(next, event.id);
      if (!found) return next;
      const exhibit = found.exhibit;
      if (exhibit.lastCheckout !== event.checkout) {
        next.n += 1;
        exhibit.terminal.push({ key: next.n, kind: "label", text: `${exhibit.lastCheckout ? "\n" : ""}$ run on ${event.checkout}\n` });
        exhibit.lastCheckout = event.checkout;
      }
      next.n += 1;
      exhibit.terminal.push({ key: next.n, kind: event.stream === "stderr" ? "err" : "out", text: event.data });
      saveExhibit(next, found.role, found.index, exhibit);
      return next;
    }
    case "exhibit_result": {
      const found = locateExhibit(next, event.id);
      if (!found) return next;
      const exhibit = found.exhibit;
      exhibit.badges = exhibit.badges.map((badge) => (badge.checkout === event.checkout ? resultBadge(event.checkout, event.result) : badge));
      if (exhibit.lastCheckout !== event.checkout && !event.result.stdout && !event.result.stderr) {
        next.n += 1;
        exhibit.terminal.push({ key: next.n, kind: "label", text: `$ run on ${event.checkout}: (no output)\n` });
        exhibit.lastCheckout = event.checkout;
      }
      saveExhibit(next, found.role, found.index, exhibit);
      return next;
    }
    case "turn_end": {
      patchSide(next, event.role, (book) => {
        book.active = false;
        book.phase = `Round ${event.round} · rests`;
        book.composing = false;
        book.blocks = book.blocks.filter((block) => block.kind !== "typing");
      });
      if (next.bead === event.role) {
        const other = event.role === "prosecution" ? next.defense : next.prosecution;
        next.bead = other.active ? (event.role === "prosecution" ? "defense" : "prosecution") : null;
      }
      return next;
    }
    case "deliberating": {
      next.deliberating = true;
      next.bead = "bench";
      return next;
    }
    case "verdict": {
      const verdict = event.verdict;
      const label = RULING[verdict.ruling] ?? verdict.ruling;
      next.deliberating = false;
      next.settled = true;
      next.bead = null;
      next.chip = label;
      next.chipTone = "settled";
      next.overlay = { label, headline: verdict.headline };
      next.cards = next.cards.filter((card) => card.kind !== "error");
      next.cards.push({
        kind: "verdict",
        id: nid(next),
        ruling: verdict.ruling,
        label,
        confidence: verdict.confidence,
        headline: verdict.headline,
        reasoning: verdict.reasoning,
        decisive: verdict.decisive_exhibit,
        recommendation: RECOMMEND[verdict.recommendation] ?? verdict.recommendation,
        blocking: verdict.blocking_issues,
      });
      for (const assessment of verdict.exhibit_assessments) {
        const found = locateExhibit(next, assessment.exhibit_id);
        if (!found) continue;
        found.exhibit.badges.push({
          checkout: `judge-${assessment.exhibit_id}`,
          text: assessment.valid ? "Judge: valid" : "Judge: rejected",
          running: false,
          title: assessment.note,
        });
        if (verdict.decisive_exhibit === assessment.exhibit_id) found.exhibit.decisive = true;
        saveExhibit(next, found.role, found.index, found.exhibit);
      }
      if (verdict.decisive_exhibit) {
        const found = locateExhibit(next, verdict.decisive_exhibit);
        if (found && !found.exhibit.decisive) {
          found.exhibit.decisive = true;
          saveExhibit(next, found.role, found.index, found.exhibit);
        }
      }
      return next;
    }
    case "error": {
      next.cards.push({ kind: "error", id: nid(next), message: event.message });
      next.chip = "Mistrial";
      next.chipTone = "quiet";
      next.deliberating = false;
      next.bead = null;
      return next;
    }
    case "trial_end": {
      for (const role of ["prosecution", "defense"] as const) {
        const book = next[role];
        book.active = false;
        if (!book.phase.includes("rests")) book.phase = "Adjourned";
      }
      next.status = [...next.status, "Court adjourned. Sandboxes destroyed."].slice(-5);
      next.bead = null;
      return next;
    }
    default:
      return next;
  }
}

export function toggleInspect(state: CourtState, id: string): CourtState {
  const map = (book: SideState): SideState => ({
    ...book,
    blocks: book.blocks.map((block) => (block.kind === "inspect" && block.id === id ? { ...block, open: !block.open } : block)),
  });
  return { ...state, prosecution: map(state.prosecution), defense: map(state.defense) };
}

export type { Checkout };
