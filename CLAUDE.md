# CLAUDE.md

Instructions for all work in this repo.

## 1. Minimize comments

Keep comments to an absolute minimum. Code should be clear enough to understand on its own.

Do not write a comment that restates what the code already says. Instead:

- Name things so the name is the explanation — `nextRev`, `applyPendingRemote`, `isNewer` need no gloss.
- Split a function that needs a comment to explain its middle.
- Delete section-header banners, restated signatures, and narration of the obvious.

A comment earns its place only when the code genuinely cannot carry the information: a non-obvious
constraint, a landmine that will be "cleaned up" and break something, or a decision whose
alternative looks equally valid. If you write one, say the *why* — never the *what* — and keep it to
a line or two.

Note that much of the existing code is heavily commented in the older style. Match this policy in
new and edited code rather than the surrounding density; do not go reformat untouched files.
