const id = location.pathname.split("/").pop();
const $ = (sel) => document.getElementById(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const side = {
  prosecution: { feed: $("feedP"), state: $("stateP"), speech: null, typing: null },
  defense: { feed: $("feedD"), state: $("stateD"), speech: null, typing: null },
};
const bench = $("bench");
const exhibits = new Map(); // id -> { card, term, badges, lastCheckout, role }
let rounds = 2;
let gavel = null;

function stick(feed, fn) {
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  fn();
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function highlight(code, lang) {
  try {
    return hljs.highlight(code, { language: lang === "bash" ? "bash" : "python" }).value;
  } catch {
    return esc(code);
  }
}

function status(message) {
  const log = $("statusLog");
  log.appendChild(el("div", "statusline", esc(message)));
  while (log.children.length > 5) log.firstChild.remove();
}

function setRounds(active) {
  $("rounds").innerHTML = Array.from({ length: rounds }, (_, i) => `<span class="${i < active ? "on" : ""}"></span>`).join("");
}

function badge(result) {
  if (!result) return `<span class="badge running">running…</span>`;
  if (result.timed_out) return `<span class="badge timeout">⏱ TIMEOUT · ${result.exec_ms}ms</span>`;
  return `<span class="badge ${result.exit_code === 0 ? "ok" : "fail"}">exit ${result.exit_code} · ${result.exec_ms}ms</span>`;
}

const handlers = {
  trial_start(e) {
    const pr = e.pr;
    $("caseTitle").textContent = pr.title;
    $("caseSub").innerHTML = `${esc(pr.owner)}/${esc(pr.repo)} #${pr.number} by ${esc(pr.author)} · head <code>${pr.head_sha.slice(0, 7)}</code> vs base <code>${pr.base_sha.slice(0, 7)}</code>`;
    $("prLink").href = pr.html_url;
    document.title = `${pr.title} · Agent Courtroom`;
    setRounds(0);
  },
  status(e) {
    status(e.message);
  },
  exhibit0(e) {
    const cells = e.tests.map((t) => `<div><b>${t.passed}✓ ${t.failed ? t.failed + "✗" : ""}</b>${t.checkout}</div>`).join("");
    bench.appendChild(el("div", "card", `<h4>Exhibit 0 · existing test suite</h4><div class="tests">${cells}</div>`));
  },
  charge(e) {
    const s = e.sheet;
    bench.appendChild(
      el(
        "div",
        "card",
        `<h4>Charge sheet</h4><p>${esc(s.summary)}</p><h4 style="margin-top:10px">Falsifiable criteria</h4><ul>${s.falsifiable_criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`,
      ),
    );
  },
  turn_start(e) {
    const s = side[e.role];
    s.state.textContent = `round ${e.round} · arguing`;
    s.state.classList.add("active");
    s.speech = null;
    stick(s.feed, () => s.feed.appendChild(el("div", "round-marker", `Round ${e.round}${e.round > 1 ? " · rebuttal" : ""}`)));
    setRounds(e.round);
  },
  speech(e) {
    const s = side[e.role];
    stick(s.feed, () => {
      if (!s.speech) {
        s.speech = el("div", "speech");
        s.feed.appendChild(s.speech);
      }
      s.speech.textContent += e.text;
    });
  },
  inspect(e) {
    const s = side[e.role];
    s.speech = null;
    const row = el("div", "inspect", `🔍 ${esc(e.command)}<div class="out">${esc(e.output)}</div>`);
    row.onclick = () => row.classList.toggle("open");
    stick(s.feed, () => s.feed.appendChild(row));
  },
  exhibit_code(e) {
    const s = side[e.role];
    stick(s.feed, () => {
      if (!s.typing) {
        s.typing = el("div", "typing");
        s.feed.appendChild(s.typing);
      }
      s.typing.textContent = e.code;
      s.typing.scrollTop = s.typing.scrollHeight;
    });
  },
  exhibit_start(e) {
    const s = side[e.role];
    s.speech = null;
    s.typing?.remove();
    s.typing = null;
    const card = el(
      "div",
      "exhibit",
      `<div class="eh"><span class="eid">${esc(e.id)}</span><span class="co">${e.checkout === "both" ? "base vs head" : e.checkout}</span></div>
       <div class="arg">“${esc(e.argument)}”</div>
       <pre><code class="hljs">${highlight(e.code, e.language)}</code></pre>
       <div class="terminal"></div>
       <div class="badges">${(e.checkout === "both" ? ["base", "head"] : [e.checkout]).map((c) => `<span data-co="${c}"><span class="badge">${c}</span> ${badge(null)}</span>`).join("")}</div>`,
    );
    exhibits.set(e.id, { card, term: card.querySelector(".terminal"), badges: card.querySelector(".badges"), lastCheckout: null, role: e.role });
    stick(s.feed, () => s.feed.appendChild(card));
  },
  exhibit_output(e) {
    const x = exhibits.get(e.id);
    if (!x) return;
    stick(side[x.role].feed, () => {
      if (x.lastCheckout !== e.checkout) {
        x.term.appendChild(el("span", "lbl", `${x.lastCheckout ? "\n" : ""}$ run on ${e.checkout}\n`));
        x.lastCheckout = e.checkout;
      }
      x.term.appendChild(el("span", e.stream === "stderr" ? "err" : "", esc(e.data)));
      x.term.scrollTop = x.term.scrollHeight;
    });
  },
  exhibit_result(e) {
    const x = exhibits.get(e.id);
    if (!x) return;
    const slot = x.badges.querySelector(`[data-co="${e.checkout}"]`);
    if (slot) slot.innerHTML = `<span class="badge">${e.checkout}</span> ${badge(e.result)}`;
    if (x.lastCheckout !== e.checkout && !e.result.stdout && !e.result.stderr) {
      x.term.appendChild(el("span", "lbl", `$ run on ${e.checkout}: (no output)\n`));
      x.lastCheckout = e.checkout;
    }
  },
  turn_end(e) {
    const s = side[e.role];
    s.state.textContent = `round ${e.round} · rests`;
    s.state.classList.remove("active");
    s.speech = null;
    s.typing?.remove();
    s.typing = null;
  },
  deliberating() {
    gavel = el("div", "card", `<div class="gavel">🔨</div><p style="text-align:center">The judge is weighing the evidence…</p>`);
    bench.appendChild(gavel);
    bench.scrollTop = bench.scrollHeight;
  },
  verdict(e) {
    const v = e.verdict;
    gavel?.remove();
    const label = { BROKEN: "CLAIM BROKEN", UPHELD: "CLAIM UPHELD", INCONCLUSIVE: "INCONCLUSIVE" }[v.ruling];
    bench.appendChild(
      el(
        "div",
        "card verdict-card",
        `<h4>Verdict · ${esc(v.confidence)} confidence</h4>
         <div class="ruling ${v.ruling}">${label}</div>
         <div class="headline">${esc(v.headline)}</div>
         <p>${esc(v.reasoning)}</p>
         ${v.decisive_exhibit ? `<p style="margin-top:8px">Decisive evidence: <b>${esc(v.decisive_exhibit)}</b></p>` : ""}`,
      ),
    );
    bench.scrollTop = bench.scrollHeight;
    for (const a of v.exhibit_assessments) {
      const x = exhibits.get(a.exhibit_id);
      if (!x) continue;
      x.badges.insertAdjacentHTML("beforeend", `<span class="badge ${a.valid ? "ok" : "fail"}" title="${esc(a.note)}">judge: ${a.valid ? "valid" : "rejected"}</span>`);
    }
    const decisive = exhibits.get(v.decisive_exhibit);
    if (decisive) {
      decisive.card.classList.add("decisive");
      decisive.card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const chip = $("caseChip");
    chip.className = `chip ${v.ruling}`;
    chip.textContent = label;
    $("stamp").className = `stamp ${v.ruling}`;
    $("stamp").innerHTML = `${label}<small>${esc(v.headline)}</small>`;
    $("overlay").classList.add("show");
  },
  error(e) {
    bench.appendChild(el("div", "card", `<h4>Mistrial</h4><p>${esc(e.message)}</p>`));
    const chip = $("caseChip");
    chip.className = "chip error";
    chip.textContent = "MISTRIAL";
  },
  trial_end() {
    for (const s of Object.values(side)) {
      s.state.classList.remove("active");
      if (!/rests/.test(s.state.textContent)) s.state.textContent = "adjourned";
    }
    status("Court adjourned. Sandboxes destroyed.");
  },
};

$("overlay").onclick = () => $("overlay").classList.remove("show");
$("replay").href = location.pathname;

// EventSource auto-reconnects and the server replays from the start, so skip events we've already seen.
let seen = 0;
let idx = 0;
const es = new EventSource(`/api/trials/${id}/events`);
es.onopen = () => (idx = 0);
es.onmessage = (m) => {
  idx++;
  if (idx <= seen) return;
  seen = idx;
  const e = JSON.parse(m.data);
  try {
    handlers[e.t]?.(e);
  } catch (err) {
    console.error("render error", e, err);
  }
  if (e.t === "trial_end") es.close();
};
