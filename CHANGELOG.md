# @kernhq/module-billing

## 0.5.6

### Patch Changes

- b9c843b: The plan cards on the billing screen breathe again: the _Choose_ button sat flush against the last
  highlight with the card's padding pooled beneath it, because the grid that was meant to space them
  was declared on the card itself, which is a block. The layout now lives on an element inside it.

## 0.5.5

### Patch Changes

- f022108: Coming back from a Checkout that started a trial, the billing screen says "Card saved — your trial
  has started; nothing is charged until it ends" rather than "Payment received", which was untrue for
  the fourteen days it was on screen.

## 0.5.4

### Patch Changes

- 754b739: A plan's description and highlights read the right way round on a Persian or Arabic screen. They
  are free text an administrator typed, usually in English, and rendered inside a right-to-left block
  they came out reversed — "2 GB of storage" with the 2 at the far end. Each line now follows its own
  direction.

## 0.5.3

### Patch Changes

- chore(mock): the demo plan stops promising single sign-on

## 0.5.2

### Patch Changes

- 3f942fd: Admin → Plans can edit a plan's highlights — the lines the pricing page lists under it — one per
  line. Until now the form had no field for them and sent an empty list on every save, so changing a
  plan's price silently wiped what the pricing page said about it, and the only way to put the words
  back was the API.

## 0.5.1

### Patch Changes

- test(billing): bless the permission matrix and a neighbour's subscription

## 0.5.0

### Minor Changes

- 7e61be1: Make the subscription lifecycle actually happen. Kern Cloud could not learn that anybody had paid.

  **There was no webhook endpoint.** `handleWebhook` was correct and had zero callers — no contract
  route, nothing in the router, no raw-body route — so `https://<instance>/api/billing/webhook`, the
  URL `selfhost/.env.example` tells every operator to paste into Stripe, answered 404. Checkout
  completed, the card was charged, and nothing downstream of that webhook had ever run: the plan never
  changed, invoices were never mirrored, and no workspace could become past due or suspended. It is
  mounted now as a `raw` module route, so the signature is checked against the exact bytes Stripe sent.

  - **A cancelled or suspended workspace resolved to _unlimited_** — every limit null and `sso: true`,
    because "not entitled" fell through to `PlanLimits.parse({})`. Not paying bought more than paying
    did: a customer on a plan _without_ single sign-on could cancel and register an identity provider.
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

## 0.4.1

### Patch Changes

- fix(deps): resolve stripe to 22.6.0 so every environment shares one API version

## 0.4.0

### Minor Changes

- 54aab83: Billing has a message catalogue: 127 keys in all five locales.

  `en` was an empty `{}`, so every string this module drew rendered as its own key — and one of them,
  `billing.settings_nav`, is the module's entry in the settings sidebar. Settings is a section with a
  persistent sidebar, so that single key reached every settings and admin page, and `ux.spec.ts`'s
  `untranslated` rule failed **152 route renderings** in `shell` on the strength of it.

  The key existed in the file only inside a doc comment describing how `scopedT('billing')` works,
  which is the same shape as a string that exists as documentation and not as data — it reads as
  present and resolves to nothing.

## 0.3.6

### Patch Changes

- 447fcbd: Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

  `^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
  module from the registry would be told it needs a contracts two releases behind the one every
  service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
  only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
  first and compiling second compiles against the old copy and proves nothing.

  The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
  a range edit alone fails install before anything is built.

## 0.3.5

### Patch Changes

- 1d178b7: Make every migration survive being applied twice.

  `create policy` and `add constraint` have no `if not exists` at all, and `create table` and
  `create index` do not get one by default — so a replay throws. A module migration that throws takes
  down the **whole host service**, not just its own module; `core` hosts five, so one module's replay
  is an outage for every other module in the process.

  A replay is not hypothetical, and this change causes one: drizzle keys applied migrations by content
  hash, so editing these files makes them all run again against schemas that already have their
  objects. That is exactly the case they now survive.

  `src/server/migrations.test.ts` applies the whole folder to a database created from nothing, applies
  it a second time, and asserts each policy exists once and that RLS is forced on every table carrying
  one. Calling `migrateModule` twice does not test this — the second call reads `__migrations`, sees
  the work is done and returns.

## 0.3.4

### Patch Changes

- 5204d7c: fix: raise @kernhq ranges to what is published

  A caret on 0.x never crosses a minor, so `@kernhq/ui: ^0.8.0` and `@kernhq/contracts: ^0.5.1` could not install the published 0.9.0 and 0.6.1. Raised both to `^0.9.0` and `^0.6.1`.

- 2d0b1ea: Reach the published framework, and refresh the lockfile that the range edit invalidated.

  `^0.9.0` cannot install `@kernhq/ui@0.10.0` — a caret on 0.x never crosses a minor — so a consumer
  installing this module from the registry resolved a framework it was not built against. Raising the
  range then leaves the committed `pnpm-lock.yaml` out of date with the manifest, and
  `--frozen-lockfile` compares specifiers, so the next publish dies at install having built nothing.
  Both halves are here because one without the other is not a fix.

  `scripts/check-ranges.mjs` now checks the lockfile as well, so the second half cannot be forgotten
  again — and checks this package's hosts against its peers, which `pnpm install` does not: pnpm 10
  resolved a `^0.6.1` peer against `contracts@0.5.2` and exited 0 without a warning.

## 0.3.3

### Patch Changes

- fix: declare @kernhq/kernel and @kernhq/contracts as peerDependencies

## 0.3.2

### Patch Changes

- chore: refresh the lockfile for the changesets dependency

## 0.3.1

### Patch Changes

- fix(deps): reach the framework that was just published

## 0.3.0

### Minor Changes

- 364ca52: Billing ships its own screens.

  The workspace plan page and both instance console pages move into this package, with the module's
  strings in all five locales and its API instance. The shell mounts whatever the manifest declares.

  Instance pages needed the shell to learn something new: they are **not** filtered on whether the
  current workspace has billing enabled, and never on a capability. The console is not about a
  workspace — an operator looking at what every workspace is billed must still see the screen from a
  workspace that has billing switched off.

  `index.ts` no longer defines the formatting helpers; they live in `format.ts` and the barrel
  re-exports them. The barrel now reaches the client module, and through it Svelte components and the
  framework's rune-backed singletons — so importing one pure helper through it dragged all of that in,
  and `format.test.ts` started failing with "$state is not defined". Import the file, not the barrel.

## 0.2.0

### Minor Changes

- 5137cc7: A Kern instance can sell seats on itself.

  Adds `@kernhq/module-billing`: a plan catalogue, per-workspace subscriptions, usage counters and
  Stripe. It ships in the ordinary image and does nothing until an instance gives it a plan and a key,
  so a self-hosted Kern is unaffected — and an operator who wants to run Kern as a service does not
  need a fork to do it.

  Plans are **data**, not code. An instance admin creates them, sets what each one costs and what it
  allows, and publishes; `plans.public` serves the published ones unauthenticated so a marketing site
  renders prices from the same row the instance charges against, rather than from a second copy that
  drifts.

  What a plan may limit is fixed, though: the keys mirror `Entitlement` in `@kernhq/kernel`, and each
  one has a single place that enforces it. A plan can therefore be edited freely without ever being
  able to promise something nothing checks.

  Two decisions worth knowing before reading the schema:

  - **Seats are recounted, not adjusted.** `core.member.removed` does not say what role the person had
    and `core.member.updated` does not say what role they had before, so neither can be turned into a
    safe delta — a guest being promoted or a member leaving would each be counted wrongly. Storage does
    use deltas, because summing a workspace's files on every upload is a scan; a nightly job recounts
    and _logs_ the drift rather than quietly correcting it.
  - **Most of `mod_billing` is deliberately not row-level secured.** A subscription is the operator's
    record about a workspace, not the workspace's own data, and the console that lists every workspace
    and the jobs that enumerate them cannot run under a policy that returns nothing when
    `app.workspace_id` is unset. `invoices` is the customer's own record and is a proper tenant table.
    The reasoning is written at the top of `src/server/schema.ts`, where it will be read.

  A failed payment starts a clock rather than closing the workspace: `past_due` still entitles, the
  grace period is what ends, and a suspended workspace can still be read and exported from.
