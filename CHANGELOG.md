# @kernhq/module-billing

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
