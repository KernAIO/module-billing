---
'@kernhq/module-billing': patch
---

The first invoice of a new subscription is no longer lost. Stripe sends `invoice.paid` for it before
`checkout.session.completed`, so no subscription row carried the customer yet and the invoice was
dropped as applied. The invoice is now placed by the subscription metadata Stripe snapshots on it,
refused for retry when nothing can place it, mirrored again when checkout completes, and backfilled
nightly for every workspace with a Stripe customer — which restores the ones already missing.
