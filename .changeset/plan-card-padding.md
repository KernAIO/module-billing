---
'@kernhq/module-billing': patch
---

The billing cards carry one consistent 20px of padding instead of the card's own 14px fighting a
second layer, and the plan price no longer leaves a hole above its digits. Both were invisible
until the shell started generating the utilities module screens use.
