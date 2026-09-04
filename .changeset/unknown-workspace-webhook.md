---
'@kernhq/module-billing': patch
---

A Stripe event for a workspace this instance does not have is logged and skipped instead of being
written. One Stripe account delivers every event to every endpoint on it, so a checkout run from a
developer's machine against a shared sandbox reached the cloud, which mirrored an invoice for a
workspace id it had never seen.
