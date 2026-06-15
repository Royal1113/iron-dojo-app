---
name: Iron Dojo feature inventory and tier-gating plan
description: Accepted plan for future tier gating — feature keys, tier model, permission axes, gating architecture. Do not implement until explicitly approved per feature.
---

## Status: ACCEPTED (no implementation yet)

## Tier model

FREE → STARTER → GROWTH → SCALE → ENTERPRISE / WHITE GLOVE

Do NOT use "Pro" in tier names or locked messages.

## Four permission axes (do not conflate)

- `maxProducts` — how many products in the assigned batch
- `visibleFeatures` — which UI sections/features are shown
- `applyPermissions` — which fields can be written back to Shopify
- `automationPermissions` — whether background/bulk actions can run
- `externalIntegrations` — GSC, Bing, etc.

## Locked message language rule

Always say "Growth and higher plans", never "Pro plans".
Example: "Collection recommendations are available on Growth and higher plans."

## Recommended architecture (do not build yet)

File: `app/lib/features.ts`
Exports: `FEATURE_KEYS`, `PLAN_FEATURES`, `PLAN_LIMITS`, `canUseFeature(plan, key)`, `getLockedMessage(key)`

## Gating rules when built

1. Gate display before writeback — teaser shown, never real data to lower tiers.
2. Never rely on hidden UI alone — action handlers must also check `canUseFeature`.
3. Dev mode (`CURRENT_PLAN` flip-switch) stays fully unlocked until launch.
4. Centralise all plan checks — no scattered `if (plan === "FREE")` in components.
5. Suggested Collections display gating is the first lock to add (M19 decision).

## Feature-to-tier summary

- Read-only scoring/dashboard: FREE+
- AI generate + apply (single product): FREE+
- Suggested Collections view: GROWTH+
- Collection apply/writeback: GROWTH+
- Bulk audit: GROWTH+
- GSC / Bing integrations: GROWTH+
- Store-wide optimization: SCALE+
- Automated jobs: SCALE+
- Competitor analysis: SCALE+
- White-glove support: ENTERPRISE only
