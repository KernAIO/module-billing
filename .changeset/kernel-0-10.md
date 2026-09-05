---
'@kernhq/module-billing': patch
---

Peer `@kernhq/kernel` at `^0.10.0`.

A caret on 0.x does not cross a minor, so `^0.9.1` stopped reaching the framework the moment 0.10.0
was published — `check-ranges.mjs` fails on it, and CI stops at the lint step before a single test
runs. The module builds and tests against 0.10.0 unchanged.
