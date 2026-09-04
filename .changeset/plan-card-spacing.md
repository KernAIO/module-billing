---
'@kernhq/module-billing': patch
---

The plan cards on the billing screen breathe again: the *Choose* button sat flush against the last
highlight with the card's padding pooled beneath it, because the grid that was meant to space them
was declared on the card itself, which is a block. The layout now lives on an element inside it.
