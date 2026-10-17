import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/crimson-text/latin-400.css";
import "@fontsource/crimson-text/latin-400-italic.css";
import "@fontsource/crimson-text/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { IconChevron, IconExternal, IconReplay } from "./icons.tsx";
import { Shell, useHealth } from "./shell.tsx";
import {
  initialCourt,
  reduceCourt,
  toggleInspect,
  type Block,
  type CourtState,
  type ExhibitBlock,
  type SideState,
} from "./court-state.ts";
import type { TrialEvent } from "../src/types.ts";

hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);

type Action =
  | { t: "event"; event: TrialEvent }
  | { t: "inspect"; id: string }
  | { t: "dismiss" }
  | { t: "missing" };

function reducer(state: CourtState, action: Action): CourtState {
  if (action.t === "event") return reduceCourt(state, action.event);
  if (action.t === "inspect") return toggleInspect(state, action.id);
  if (action.t === "dismiss") return { ...state, overlay: null };
  return {
    ...state,
    missing: true,
    title: "This trial is not on the desk.",
    sub: "The address may be wrong or the recording is gone. Trials on private repositories are visible only to the GitHub account that ran them, so sign in with that account.",
    chip: "Missing",
    chipTone: "quiet",
  };
}

function testScore(test: { passed: number; failed: number; exitCode: number }, framework: string) {
  if (framework === "none") return "—";
  if (test.passed || test.failed) return `${test.passed} passed${test.failed ? ` · ${test.failed} failed` : ""}`;
  if (test.exitCode === 0) return "Pass";
  if (test.exitCode === 124) return "Timeout";
  return `Exit ${test.exitCode}`;
}

function highlight(code: string, language: string) {
  const lang = { bash: "bash", javascript: "javascript", typescript: "typescript" }[language] ?? "python";
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return code.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
  }
}

function useStick(watch: string) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [watch]);
  return { ref, onScroll };
}

const settle = { type: "spring" as const, bounce: 0, duration: 0.35 };
const land = { type: "spring" as const, bounce: 0.18, duration: 0.45 };

function Mark({ live, bead, reduce }: { live: boolean; bead: boolean; reduce: boolean | null }) {
  if (!live && !bead) return null;
  return (
    <span className="relative mt-2 block h-px w-full bg-line">
      <motion.span
        className="absolute inset-y-0 left-0 origin-left bg-phosphor"
        initial={false}
        animate={{ scaleX: live ? 1 : 0 }}
        transition={reduce ? { duration: 0.15 } : settle}
      />
      {bead ? (
        <motion.span
          layoutId={reduce ? undefined : "bead"}
          className="absolute -top-[3px] left-0 size-1.5 bg-phosphor"
          transition={reduce ? { duration: 0.15 } : settle}
        />
      ) : null}
    </span>
  );
}

function CodeWell({ code, language }: { code: string; language: string }) {
  const reduce = useReducedMotion();
  const pre = useRef<HTMLPreElement>(null);
  const done = useRef(false);
  const shown = useRef(0);

  useEffect(() => {
    const node = pre.current;
    if (!node) return;
    if (reduce) {
      node.innerHTML = highlight(code, language);
      return;
    }
    const duration = Math.min(2600, 400 + code.length * 5);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const count = Math.floor(code.length * Math.min(1, (now - start) / duration));
      shown.current = count;
      if (count < code.length) {
        node.textContent = code.slice(0, count);
        const caret = document.createElement("span");
        caret.className = "caret-blink ml-px inline-block h-[1em] w-px translate-y-px bg-phosphor align-text-bottom";
        node.appendChild(caret);
        node.scrollTop = node.scrollHeight;
        frame = requestAnimationFrame(tick);
      } else if (!done.current) {
        done.current = true;
        node.innerHTML = highlight(code, language);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [code, language, reduce]);

  return (
    <pre
      ref={pre}
      className="mt-3 max-h-64 overflow-auto bg-canvas px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink"
    />
  );
}

function ExhibitView({ exhibit }: { exhibit: ExhibitBlock }) {
  return (
    <article
      id={`exhibit-${exhibit.id}`}
      className={`border-b border-line py-4 ${exhibit.decisive ? "desk-shadow -mx-4 border border-phosphor bg-raise px-4" : ""}`}
    >
      <p className="font-serif text-[1.125rem] leading-snug text-ink italic">“{exhibit.argument}”</p>
      <p className="mt-1 font-mono text-[12px] text-muted">
        {exhibit.id} · {exhibit.checkout}
      </p>
      <CodeWell code={exhibit.code} language={exhibit.language} />
      {exhibit.terminal.length > 0 ? (
        <pre className="mt-px max-h-52 overflow-auto bg-[#070707] px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#d6d6d0]">
          {exhibit.terminal.map((part) => (
            <span key={part.key} className={part.kind === "err" ? "font-medium text-ink" : part.kind === "label" ? "text-muted" : undefined}>
              {part.text}
            </span>
          ))}
        </pre>
      ) : (
        <div className="mt-px bg-[#070707] px-3 py-2.5 font-mono text-[12px] text-muted">Waiting for output</div>
      )}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {exhibit.badges.map((badge) => (
          <li
            key={badge.checkout}
            title={badge.title}
            className={`rounded-[6px] border border-line px-2 py-0.5 font-mono text-[11px] ${badge.running ? "text-phosphor" : "text-muted"}`}
          >
            {badge.checkout.startsWith("judge-") ? badge.text : `${badge.checkout} · ${badge.text}`}
          </li>
        ))}
      </ul>
    </article>
  );
}

function Blocks({
  blocks,
  onInspect,
}: {
  blocks: Block[];
  onInspect: (id: string) => void;
}) {
  if (!blocks.length) {
    return <p className="py-2 text-[14px] text-muted">Waiting for argument.</p>;
  }
  return (
    <>
      {blocks.map((block) => {
        if (block.kind === "marker") {
          return (
            <p key={block.id} className="py-2 text-center font-mono text-[11px] text-muted">
              {block.text}
            </p>
          );
        }
        if (block.kind === "speech") {
          return (
            <p key={block.id} className="max-w-[68ch] py-1 font-serif text-[1.125rem] leading-relaxed whitespace-pre-wrap text-ink">
              {block.text}
            </p>
          );
        }
        if (block.kind === "typing") {
          return (
            <pre key={block.id} className="max-h-56 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-muted">
              {block.code}
            </pre>
          );
        }
        if (block.kind === "inspect") {
          return (
            <div key={block.id} className="border-b border-line py-2">
              <button
                type="button"
                aria-expanded={block.open}
                onClick={() => onInspect(block.id)}
                className="flex w-full items-center gap-2 text-left font-mono text-[12px] text-muted hover:text-ink"
              >
                <IconChevron open={block.open} />
                <span className="min-w-0 truncate">{block.command}</span>
              </button>
              {block.open ? (
                <pre className="mt-2 max-h-56 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-ink">{block.output}</pre>
              ) : null}
            </div>
          );
        }
        return <ExhibitView key={block.id} exhibit={block} />;
      })}
    </>
  );
}

function Book({
  name,
  title,
  book,
  bead,
  forward,
  hidden,
  onInspect,
}: {
  name: string;
  title: string;
  book: SideState;
  bead: boolean;
  forward: boolean;
  hidden: boolean;
  onInspect: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const watch = book.blocks
    .map((block) => (block.kind === "speech" ? block.text.length : block.kind === "exhibit" ? block.terminal.length : block.id))
    .join("|");
  const scroller = useStick(watch);
  return (
    <section
      aria-label={title}
      className={`${hidden ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-line bg-surface lg:flex ${forward ? "desk-shadow" : ""}`}
    >
      <header className="border-b border-line px-4 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium tracking-[-0.02em]">{title}</h2>
          <span className={`font-mono text-[12px] ${book.active ? "text-phosphor" : "text-muted"}`}>{book.phase}</span>
        </div>
        <Mark live={book.active} bead={bead} reduce={reduce} />
      </header>
      <Feed scroller={scroller}>
        <Blocks blocks={book.blocks} onInspect={onInspect} />
      </Feed>
      <span className="sr-only">{name}</span>
    </section>
  );
}

function Feed({
  scroller,
  children,
  live,
}: {
  scroller: { ref: RefObject<HTMLDivElement | null>; onScroll: () => void };
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller.ref} onScroll={scroller.onScroll} className="h-full overflow-auto px-4 py-3" aria-live={live ? "polite" : undefined}>
        {children}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-linear-to-b from-surface to-transparent" />
    </div>
  );
}

function Trial() {
  const health = useHealth();
  const reduce = useReducedMotion();
  const [state, dispatch] = useReducer(reducer, initialCourt);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const [pane, setPane] = useReducer((_: string, next: string) => next, "bench");
  const replay = typeof location === "undefined" ? "/trial" : location.pathname;

  useEffect(() => {
    const id = location.pathname.split("/").pop();
    let seen = 0;
    let idx = 0;
    let opened = false;
    const source = new EventSource(`/api/trials/${id}/events`);
    source.onopen = () => {
      opened = true;
      idx = 0;
    };
    source.onmessage = (message) => {
      opened = true;
      idx += 1;
      if (idx <= seen) return;
      seen = idx;
      const event = JSON.parse(message.data) as TrialEvent;
      dispatch({ t: "event", event });
      if (event.t === "trial_end") source.close();
    };
    source.onerror = () => {
      if (!opened && seen === 0) dispatch({ t: "missing" });
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    if (state.title && state.title !== "Convening") document.title = `${state.title} · Agent Courtroom`;
  }, [state.title]);

  useEffect(() => {
    if (!state.overlay) return;
    dismissRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ t: "dismiss" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.overlay]);

  const decisive = [...state.prosecution.blocks, ...state.defense.blocks].find((block) => block.kind === "exhibit" && block.decisive);
  useEffect(() => {
    if (!decisive || decisive.kind !== "exhibit") return;
    document.getElementById(`exhibit-${decisive.id}`)?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "center",
    });
  }, [decisive, reduce]);

  const benchWatch = `${state.status.join("|")}|${state.cards.length}|${state.deliberating}`;
  const benchScroll = useStick(benchWatch);
  const onInspect = (id: string) => dispatch({ t: "inspect", id });

  const tabs = [
    ["prosecution", "Prosecution", state.prosecution.active],
    ["bench", "The bench", state.bead === "bench"],
    ["defense", "Defense", state.defense.active],
  ] as const;

  return (
    <>
      <Shell health={health.text} ready={health.ready} inert={!!state.overlay}>
        <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:px-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-[1.35rem] leading-tight font-medium tracking-[-0.03em]">{state.title}</h1>
            <p className="mt-1 font-mono text-[12px] text-muted">{state.sub}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className={`font-mono text-[12px] ${state.chipTone === "live" ? "text-phosphor" : state.chipTone === "settled" ? "text-ink" : "text-muted"}`}>
              {state.chip}
            </span>
            {state.prUrl ? (
              <>
                <a href={replay} className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-line px-3 text-[13px] no-underline hover:bg-ink hover:text-canvas">
                  <IconReplay />
                  Replay
                </a>
                <a
                  href={state.prUrl}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-line px-3 text-[13px] no-underline hover:bg-ink hover:text-canvas"
                >
                  <IconExternal />
                  Pull request
                </a>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex gap-2 px-4 pt-3 lg:hidden">
          {tabs.map(([id, label, live]) => (
            <button
              key={id}
              type="button"
              aria-pressed={pane === id}
              onClick={() => setPane(id)}
              className={`inline-flex h-9 items-center gap-2 rounded-[6px] border px-3 text-[13px] ${pane === id ? "border-ink bg-ink text-canvas" : "border-line text-muted"}`}
            >
              {live ? <span className="size-1.5 bg-phosphor" /> : null}
              {label}
            </button>
          ))}
        </div>

        <LayoutGroup>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.86fr)_minmax(0,1fr)]">
            <Book
              name="prosecution"
              title="Prosecution"
              book={state.prosecution}
              bead={state.bead === "prosecution"}
              forward={state.prosecution.active}
              hidden={pane !== "prosecution"}
              onInspect={onInspect}
            />
            <section
              aria-label="The bench"
              className={`${pane === "bench" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-line bg-surface lg:flex ${state.deliberating ? "desk-shadow" : ""}`}
            >
              <header className="border-b border-line px-4 pt-3 pb-2.5 text-center">
                <h2 className="text-[15px] font-medium tracking-[-0.02em]">The bench</h2>
                <div className="mt-2 flex justify-center gap-1.5" aria-label={`Round ${state.round || 0} of 2`}>
                  {[0, 1].map((index) => {
                    const filled = index < state.round;
                    const current = filled && index === state.round - 1 && !state.settled;
                    return <span key={index} className={`size-1.5 ${current ? "bg-phosphor" : filled ? "bg-ink" : "bg-line"}`} />;
                  })}
                </div>
                <div className="flex justify-center">
                  <Mark live={state.deliberating} bead={state.bead === "bench"} reduce={reduce} />
                </div>
              </header>
              <Feed scroller={benchScroll} live>
                {state.deliberating ? (
                  <p className="py-2 font-serif text-[1.125rem] text-ink">The judge is weighing exit codes, timings, and output.</p>
                ) : null}
                {state.status.length === 0 && state.cards.length === 0 && !state.deliberating ? (
                  <p className="py-2 text-[14px] text-muted">The clerk will record the case here.</p>
                ) : null}
                <ul className="space-y-1">
                  {state.status.map((line, index) => (
                    <li key={`${index}-${line}`} className="font-mono text-[12px] leading-relaxed text-muted">
                      {line}
                    </li>
                  ))}
                </ul>
                {state.cards.map((card) => {
                  if (card.kind === "tests") {
                    const suite = card.framework !== "none" ? ` · ${card.framework}` : " · none found";
                    return (
                      <div key={card.id} className="border-b border-line py-4">
                        <h3 className="text-[15px] font-medium tracking-[-0.02em]">Existing tests{suite}</h3>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          {card.tests.map((test) => (
                            <p key={test.checkout} className="font-mono text-[12px] text-muted">
                              <span className="block text-[1.25rem] text-ink tabular-nums">{testScore(test, card.framework)}</span>
                              {test.checkout}
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  if (card.kind === "charge") {
                    return (
                      <div key={card.id} className="border-b border-line py-4">
                        <h3 className="font-serif text-[1.25rem] leading-snug">{card.summary}</h3>
                        <h4 className="mt-4 text-[15px] font-medium">What would falsify it</h4>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-ink">
                          {card.criteria.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  }
                  if (card.kind === "error") {
                    return (
                      <div key={card.id} className="border-b border-line py-4" role="alert">
                        <h3 className="text-[15px] font-medium">Mistrial</h3>
                        <p className="mt-2 text-[14px] leading-relaxed">{card.message}</p>
                      </div>
                    );
                  }
                  return (
                    <div key={card.id} className="border-b border-line py-4">
                      <h3 className="text-[1.75rem] leading-none font-medium tracking-[-0.04em]">{card.label}</h3>
                      <p className="mt-3 font-serif text-[1.2rem] leading-snug">{card.headline}</p>
                      <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink">{card.reasoning}</p>
                      <p className="mt-3 font-mono text-[12px] text-muted">
                        {card.confidence} confidence · {card.recommendation}
                        {card.decisive ? ` · decisive ${card.decisive}` : ""}
                      </p>
                      {card.blocking.length ? (
                        <ul className="mt-3 list-disc space-y-1 pl-5 text-[14px]">
                          {card.blocking.map((issue) => (
                            <li key={issue.exhibit_id}>
                              {issue.title} · {issue.exhibit_id}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </Feed>
            </section>
            <Book
              name="defense"
              title="Defense"
              book={state.defense}
              bead={state.bead === "defense"}
              forward={state.defense.active}
              hidden={pane !== "defense"}
              onInspect={onInspect}
            />
          </div>
        </LayoutGroup>
      </Shell>

      <AnimatePresence>
        {state.overlay ? (
          <motion.div
            className="fixed inset-0 z-20 flex items-center justify-center bg-black/80 p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => dispatch({ t: "dismiss" })}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="seal-title"
              onClick={(event) => event.stopPropagation()}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.06, filter: "blur(10px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, filter: "blur(6px)" }}
              transition={reduce ? { duration: 0.2 } : land}
              className="w-full max-w-xl border border-ink bg-surface px-8 py-10 text-center"
            >
              <h2 id="seal-title" className="text-[3rem] leading-none font-medium tracking-[-0.04em]">
                {state.overlay.label}
              </h2>
              <p className="mx-auto mt-5 max-w-[34ch] font-serif text-[1.35rem] leading-snug">{state.overlay.headline}</p>
              <button
                ref={dismissRef}
                type="button"
                onClick={() => dispatch({ t: "dismiss" })}
                className="mt-8 rounded-[6px] border border-line px-4 py-2 text-[14px] hover:bg-ink hover:text-canvas"
              >
                Dismiss
              </button>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Trial />);
