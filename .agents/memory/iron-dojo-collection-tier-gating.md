---
name: Iron Dojo collection tier gating
description: Architectural decision for how collection/category suggestions are gated by plan tier — display layer first, writeback later.
---

## Decision

Collection recommendations (M19) are visible to all tiers during development so the feature can be verified end-to-end.

## Future tier behavior

- **Top tier / dev mode**: show full collection/category suggestions (names + reasons).
- **Lower tiers**: show a locked teaser only — e.g. *"Collection recommendations are available on Growth and Pro plans."* Do NOT show actual collection names or reasons (merchant could copy/paste them manually to bypass the gate).

## Implementation order when tier gating is added

1. **Display layer first** — gate the `suggestedCollections` UI block based on plan.
2. **Writeback permissions later** — gate apply/writeback after display gating is stable.
3. Do NOT add billing, Stripe, or writeback locks in the same milestone as display gating.

**Why:** The feature set must be stable and verified before locking it. Showing actual names/reasons to lower tiers would let merchants bypass the paywall manually.

## Current state

`CURRENT_PLAN` in `scoring.ts` is the single flip-switch for tier (FREE=5, STARTER=25, PRO=Infinity). During development it is set to top tier, so all features including collections are visible.
