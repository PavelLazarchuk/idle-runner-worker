---
'@idle-runner/worker': patch
---

Remove the "Not in v1" section from the README. The scope decisions it described — no worker pool, no priorities, no automatic restart after a crash, no `timeout` — still stand; they just don't need a dedicated section to remain true.
