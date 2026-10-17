// bun src/db-import.ts: copy existing file recordings (recordings/ and data/recordings/) into Postgres.
// Safe to re-run: trials already in the database are skipped.
import { listRecordings, readRecording } from "./events";
import { store } from "./store";
import type { StampedEvent } from "./types";

if (store.kind !== "postgres") {
  console.error("DATABASE_URL is not set; nothing to import into.");
  process.exit(1);
}
await store.init();

let imported = 0;
let skipped = 0;
for (const id of listRecordings()) {
  if (await store.getSummary(id)) {
    skipped++;
    continue;
  }
  const events = readRecording(id) ?? [];
  const start = events.find((e) => e.t === "trial_start");
  if (!start || start.t !== "trial_start") continue;
  const isPrivate = start.visibility === "private" || Boolean(start.pr.private);
  for (const e of events) store.record(id, isPrivate, e);
  if (!events.some((e) => e.t === "trial_end")) store.record(id, isPrivate, { t: "trial_end", ts: events.at(-1)!.ts } as StampedEvent);
  imported++;
}
await store.drain();
console.log(`imported ${imported} trial(s), skipped ${skipped} already in the database`);
process.exit(0);
