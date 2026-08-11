PalmDeck jsdom regression suite (58 assertions as of 2026-08-11).

Setup (once): cd tests && npm init -y && npm install jsdom
Run: node test_palmdeck.js

Tests the REAL index.html end to end via jsdom (login, showApp, autosave draft
save/restore, Reset confirm gate, CV registry persistence across loadCvIndex()
rebuilds, autoFillFromCv skill matching, formatRate BR/US disambiguation,
outbound email escaping, setInterval-leak-on-relogin guard, CV-pipeline XSS
escaping, stale-hidden-candidate-data restore guard).

Gotcha: top-level const/let inside index.html's inline <script> are NOT window
properties (only `function` declarations are) — never poke win.skills/win.cvIndex
directly from a test; always drive state through the exposed window.<fn> API,
same as a real user action would.

Not committed to the git repo (no package.json/jsdom dependency wired into this
repo yet) — kept here on disk so it survives past the Claude session scratchpad.
Full writeup of what it caught: reference_technical_patterns.md in Claude's
project memory, section "PalmDeck ... 3 real bugs found via jsdom testing".
