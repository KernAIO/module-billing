---
'@kernhq/module-billing': patch
---

A plan's description and highlights keep the card's alignment on a Persian or Arabic screen while
still reading in their own order. The previous fix (`dir="auto"` on each line) got the order right
and left the lines as a left-aligned island inside a right-aligned card; the text is now isolated
with `<bdi>` instead.
