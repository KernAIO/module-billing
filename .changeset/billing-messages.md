---
'@kernhq/module-billing': minor
---

Billing has a message catalogue: 127 keys in all five locales.

`en` was an empty `{}`, so every string this module drew rendered as its own key — and one of them,
`billing.settings_nav`, is the module's entry in the settings sidebar. Settings is a section with a
persistent sidebar, so that single key reached every settings and admin page, and `ux.spec.ts`'s
`untranslated` rule failed **152 route renderings** in `shell` on the strength of it.

The key existed in the file only inside a doc comment describing how `scopedT('billing')` works,
which is the same shape as a string that exists as documentation and not as data — it reads as
present and resolves to nothing.
