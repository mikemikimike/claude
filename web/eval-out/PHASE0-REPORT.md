# Phase 0 — cross-layout guided-vision eval (first read)

**Question:** does guided vision, given the curated `purchase_agreement` field set (79 fields),
locate those fields on a *different brokerage's* purchase agreement well enough to trust the
pipeline? **Go/no-go for building out vision-on-upload.**

## Method (and its honest limits)
- **Real pipeline.** Drove the production `detectGuided` (same prompt, locate-tool, render path)
  via `claude-opus-4-8` on two real, different-brokerage PAs: **Baldwin BR** (14pp) and
  **ValleyMLS Financed** (6pp). Not a proxy.
- **No cheating.** Queried *every page with the full 79-field list and zero position hints* —
  on a real upload we don't know a field's page. (The same-doc eval leaked both.)
- **Independent ground truth.** Two reviewers per form decided, blind to vision's output and
  grounded in the printed text + clean page images, whether each field *actually exists as a
  fillable blank* on that form and where. This separates "vision missed it" from "it isn't there."
- **Placement verified by eye.** Every located box was drawn on the rendered page (`overlay-*.png`)
  and judged on_field / near / misplaced / wrong_field / not_real, with signer-correctness on every
  party field. (Spot-checked 3 overlays by hand — matched the panel.)
- **Limits:** n=2 forms, single run, high variance; GT had a few borderline existence calls
  (reconciled conservatively — counted against recall); placement verdicts are vision-assisted.
  A third form would tighten the band. This is a *first read*, not a definitive study.

## Results

| Metric | Baldwin BR (14pp, dense) | ValleyMLS (6pp) |
|---|---|---|
| Core fields that *exist* (of 38) | 37 | 27 |
| **CORE-RECALL — found AND well-placed** | **73% (27/37)** | **89% (24/27)** |
| &nbsp;&nbsp;core *found but mis-placed* | 10 | 1 |
| &nbsp;&nbsp;core *not found at all* | **0** | 2 |
| Full fields that exist (of 79) | 62 | 43 |
| **FULL-RECALL — found AND well-placed** | **65% (40/62)** | **84% (36/43)** |
| Box placement clean (on_field/near) | 65% | 83% |
| **MIS-SIGNER (box on wrong party)** | **0 / 32** | **1 / 15** |
| False-locate (phantom box, no blank) | 5 | 2 |

## What it means

1. **Finding fields is essentially solved.** Vision located **100%** of Baldwin's existing core
   fields (0 missed) and **93%** of ValleyMLS's (2 missed). Guided locate is not blind and does not
   over-detect. Recall, in the "did it find it" sense, is not the problem.
2. **Placement is the bottleneck — and it's layout-dependent.** Clean / spread-out forms place
   ~83% of boxes cleanly; a dense form drags to ~65%. The single worst case is a tight row of 7
   financing checkboxes (Baldwin p2): **all found, all boxed on the printed labels instead of the
   tiny ☐**. Write-in fields (price, loan amount, address, dates) place well; small clustered
   checkboxes are where it degrades (the ~1.15MP vision downscale can't pin them without a hint).
3. **The dangerous failure barely happens.** Mis-signer ≈ **0** (1 in 47 party boxes across both
   forms). Vision does **not** put the buyer's signature on the seller's line. That's the failure
   that would actually hurt, and it's essentially absent.
4. **False-locates are few and obvious** (5 + 2): a box floating on a clause with no blank —
   trivially caught in review.

## Verdict: **GO — build it out, but only behind the mandatory overlay review.**

The data says vision is a strong **first draft** (finds ~everything, places most, never swaps
signers) and a poor **final** (1 in 3 boxes on a dense form needs a nudge). That is exactly the
design already committed: **vision drafts, the agent completes it in the box-overlay review.** It
is **not** trustworthy enough to auto-place-and-send without review, and we should not pretend it
is. Core-recall of **73–89%** with **0–2 actual misses** and **~0 mis-signers** clears the bar for
a review-gated draft; it would fail an auto-send bar.

## Levers (post-go optimizations, non-blocking because the overlay catches them)
- **Dense checkbox clusters** are the #1 fixable drag: locate the cluster region, then subdivide;
  or feed a per-field position hint (we have them for known layouts; for new ones, a cluster pass).
- **Apply the ~15pt `calibrateY`** — moves some "near" boxes to "on_field".
- **A third+ form** to tighten the variance band before wide rollout.
