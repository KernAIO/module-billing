---
'@kernhq/module-billing': minor
---

Make the subscription lifecycle actually happen. Kern Cloud could not learn that anybody had paid.

**There was no webhook endpoint.** `handleWebhook` was correct and had zero callers — no contract
route, nothing in the router, no raw-body route — so `https://<instance>/api/billing/webhook`, the
URL `selfhost/.env.example` tells every operator to paste into Stripe, answered 404. Checkout
completed, the card was charged, and nothing downstream of that webhook had ever run: the plan never
changed, invoices were never mirrored, and no workspace could become past due or suspended. It is
mounted now as a `raw` module route, so the signature is checked against the exact bytes Stripe sent.

- **A cancelled or suspended workspace resolved to *unlimited*** — every limit null and `sso: true`,
  because "not entitled" fell through to `PlanLimits.parse({})`. Not paying bought more than paying
  did: a customer on a plan *without* single sign-on could cancel and register an identity provider.
  Freezing `sso` off is what stops that, and it has to be the entitlement rather than the write gate,
  because `/sso/register` is a Better Auth route outside `workspaceScoped` — no write gate ever sees
  it, and `entitlements.has('sso')` is the only thing standing there. A non-entitled status now keeps
  the plan's limits with nothing left that lets the workspace grow: seats frozen, storage 0, SSO off.
  `apiRateLimit` and `auditRetentionDays` are deliberately untouched, because narrowing either would
  break reading and exporting — the one thing suspension promises (ADR 0003 §6). The same merge also
  took the plan branch whenever an override was present, so an operator who had comped one limit
  handed back the whole plan on cancellation; an override no longer outlives the status.
- **Trials never ended.** Signup wrote `trialing` with a `trialEndsAt` that nothing ever read again,
  and `trialing` is entitled — so every signup was on the trial plan for ever, free, with no card.
  `billing.expire-trials` suspends a trial with no Stripe subscription behind it and emits
  `billing.subscription.suspended`. A trial Stripe is running is left to Stripe.
- **Stripe's own event wiped the grace period.** `applySubscription` wrote `graceEndsAt: null` every
  time, and Stripe emits `customer.subscription.updated` for the same failed payment as
  `invoice.payment_failed`, in no guaranteed order — so the clock the dunning job requires was
  usually gone and `past_due → suspended` never fired. The clock now belongs to the status: past due
  keeps a clock that is running and starts one if there is none. `unpaid` — Stripe saying it has
  given up — maps to `suspended` instead of to another open-ended `past_due`.
- **An upgrade opened a second subscription and never cancelled the first.** Checkout in
  `subscription` mode creates a new subscription every time, and `applySubscription` then overwrote
  `stripeSubscriptionId`, so the old one kept charging with nothing pointing at it — the customer
  billed twice, for ever, against a pricing page promising "change any time; we bill the difference
  pro rata". A workspace that already has a subscription is repriced in place with
  `create_prorations`; Checkout is only for a first subscription.
- **The first checkout billed one seat** whatever the size of the workspace, because the quantity was
  `input.seats ?? 1` and no caller has ever passed `seats`. It is the workspace's real billable seat
  count now, taken from core, and synced again after `checkout.session.completed`.
- **The post-checkout redirect 404'd.** `${baseUrl}/settings/billing` is not a route in Kern. The
  caller passes `returnPath` exactly as it already does for the portal, and the plan screen renders
  what `?checkout=` says — including the honest middle state, where Stripe has taken the money and
  the webhook has not landed yet.
- **A failed webhook lost its event for ever.** The claim was inserted before the handler ran, so a
  throw left the id claimed and Stripe's retry was answered "already applied". The claim is released
  on failure. Relatedly, a Stripe SDK error carries Stripe's own status, and rethrowing it answered
  Stripe **404** — which Stripe reads as "do not send this again". The route answers 500 explicitly.
- **A missing default plan was a `warn`.** With `STRIPE_SECRET_KEY` set and `KERN_DEFAULT_PLAN_SLUG`
  empty, every new workspace got no subscription row and resolved to unlimited. That refuses to
  boot now. A slug naming a plan that does not exist logs an error and refuses the
  `core.workspace.created` handler, so the bus retries and the workspace picks up its subscription
  once the plan exists. `KERN_PLANS_FILE` seeds the catalogue at boot, creating only slugs that do
  not exist, so a fresh instance is not one hand-typed console entry away from giving everything
  away — and never overwrites what an admin has since edited.

`checkout` and `portal` carry the kernel's new `allowWhileSuspended`: they are the two procedures
whose purpose is to end a suspension, and gating them would spring the trap on the customer trying
to pay. Requires `@kernhq/kernel` with `allowWhileSuspended`.
