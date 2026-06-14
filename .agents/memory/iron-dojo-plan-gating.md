---
name: Iron Dojo plan gating
description: How dev-mode plan limits are implemented and the s-banner tone constraint
---

## Rule
`CURRENT_PLAN` in `app/lib/scoring.ts` is the single flip-switch for plan tier (FREE=5, STARTER=25, PRO=Infinity). Change that one constant to change the visible product limit across both the dashboard and the detail page gate.

**Why:** Milestone 5 deliberately avoids Shopify Billing API and DB tables — gating is code-only until billing is wired up.

**How to apply:** When adding real billing, replace `CURRENT_PLAN` with a value derived from the Shopify subscription response in the loader, not a constant.

## s-banner tone constraint
`s-banner` accepts: `"info" | "success" | "critical" | "auto" | "warning" | undefined`.
It does NOT accept `"caution"` (that tone is for `s-badge` only). Use `"warning"` for amber/cautionary banners.

**Why:** Caught as a TS2322 error during M5 build — easy to get wrong since s-badge uses "caution".
