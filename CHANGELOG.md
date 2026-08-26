# @kernhq/module-billing

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
