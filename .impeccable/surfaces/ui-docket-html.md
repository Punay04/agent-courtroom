---
version: 1
slug: "ui-docket-html"
primary_target: "ui/docket.html"
related_targets: ["ui/trial.html"]
---

# Docket and courtroom

Mode: operate

Audience: a developer running Agent Courtroom locally. Job: place a pull request on the desk, follow both sides, read the verdict. Action: summon, open a case, replay, leave.

## Direction contract

THESIS: A tally desk with two open books and a stamp. It refuses the metric-card dashboard and the cartoon courtroom.

OWN-WORLD: Screenpipe dark contract, translated from the tally desk's paper. Canvas #0A0A0A, work surface #141414, line #333333, ink #F5F5F5, secondary #A3A3A3, trace evidence #8A8A80, phosphor #C7FF3E only while a side is executing or the judge is weighing. Space Grotesk for the interface, Crimson Text for argument and the verdict headline, IBM Plex Mono for code, commands, shas, and timings. Work surfaces 8px, controls 6px, the window edge and the verdict seal sharp. Elevation is a soft vertical shadow, never a hard offset.

STORY: The operator sees an empty desk, sets a pull request on it, and watches two books fill with runs. They leave knowing the ruling came from exit codes and output.

FIRST VIEWPORT: Docket: a 232px charcoal rail, sharp against the ink canvas, with the name Agent Courtroom and one health line. The desk holds a 40px heading, a 56px summon field, and a ruled case list. Counts sit in the list's caption as one baseline of tabular figures, not cards. The Summon control is bone-on-ink and only turns quiet while the request is in flight. Courtroom: the same rail, then the case name, then three books — prosecution, the bench, defense. The bench is the narrower minute. Each book that is executing shows a phosphor rule. One shared bead springs to the book that just began, and onto the bench while the judge weighs.

SIGNATURE INTERACTION: Prosecution and defense run together, so a live book keeps a phosphor rule for as long as it is executing. The shared bead springs to whichever book just took the floor, then to the bench during deliberation, and clears when the ruling is settled. The verdict seal then takes the frame: scale and blur settle on a spring with slight momentum, dismissible immediately. Reduced motion cross-fades the bead and the seal. Pressing Summon scales to 0.97 on pointer-down.

FORM: Assigned tally desk, candidate 6 of the grounded list, seed 827d59dd. Materials translated into the pinned Screenpipe palette. Raises kept from declined challengers: one mark retargets the whole desk (type specimen); exhibits share one measure (botanical folio); the speaking book sits forward and the verdict owns the frame (vertical feed).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
