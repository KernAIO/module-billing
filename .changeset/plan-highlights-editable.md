---
'@kernhq/module-billing': patch
---

Admin → Plans can edit a plan's highlights — the lines the pricing page lists under it — one per
line. Until now the form had no field for them and sent an empty list on every save, so changing a
plan's price silently wiped what the pricing page said about it, and the only way to put the words
back was the API.
