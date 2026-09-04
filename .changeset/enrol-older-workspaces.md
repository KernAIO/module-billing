---
'@kernhq/module-billing': patch
---

A workspace that existed before the instance's default plan was configured is put on it by the
nightly job, trial and all. A workspace with no subscription row resolves to unlimited, and on an
instance that takes payments such a workspace had been entitled to everything with no trial and no
bill, with nothing that would ever change it. Instances with no default plan are unaffected.
