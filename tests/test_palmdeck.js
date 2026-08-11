// PalmDeck jsdom smoke test — verifies autosave draft round-trip, Reset confirmation guard,
// CV-registry persistence across loadCvIndex() rebuild (fresh boot AND periodic reload), and
// the CV-autofill custom-skill bug found via static read.
// Run: node test_palmdeck.js
const fs = require('fs');
const { JSDOM } = require('jsdom');

const HTML_PATH = '/Users/leonardobergonzidesouzajunior/Desktop/simpalm-official-rebuild/SIMPALM/EmailBuilder/index.html';
const html = fs.readFileSync(HTML_PATH, 'utf8');
const URL = 'https://ldsjunior-ui.github.io/simpalm-email-builder/';
const MOCK_CV_INDEX = [
  { filename: 'jane-doe.pdf', name: 'Jane Doe', location: 'Brazil', years_experience: 5,
    skills: ['Immigration Law', 'Some Totally Custom Niche Skill Not In Any Dropdown List'] },
  { filename: 'other.pdf', name: 'Other Person', location: 'Colombia', years_experience: 3, skills: [] },
  { filename: 'evil.pdf', name: 'Evil Person', title: '<img src=x onerror=alert(1)>', location: '', years_experience: 0, skills: [] },
];

let pass = 0, fail = 0;
function assert(cond, label, evidence) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n      evidence: ${evidence}`); }
}

async function makeDom() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: URL });
  const win = dom.window;
  win.fetch = (url) => {
    if (String(url).includes('index.json')) {
      return Promise.resolve({ ok: true, json: async () => MOCK_CV_INDEX });
    }
    return Promise.reject(new Error('offline (test harness — no network) for ' + url));
  };
  win.onerror = (msg) => console.log('  [window.onerror]', msg);
  win.Notification = undefined; // skip the notification-permission branch entirely
  win.Element.prototype.scrollIntoView = function () {}; // jsdom doesn't implement layout/scrolling —
                                                          // real browsers do, this is a test-env gap only
  // Give jsdom's internal task queue a tick to dispatch DOMContentLoaded (fires the boot handler
  // that wires #btn-copy/#btn-preview/#btn-reset/#btn-logout — needed for the Reset-click tests).
  await new Promise(r => setTimeout(r, 30));
  return dom;
}

(async () => {
  // ── STAGE 1: log in, fill a form, pick a CV via the real pipeline, save draft ────────────────
  const dom1 = await makeDom();
  const win1 = dom1.window, doc1 = win1.document;

  win1.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win1.showApp();
  await win1.loadCvIndex(); // populate the real internal cvIndex via the mocked fetch

  doc1.getElementById('f-c2n').value = 'Draft Test Candidate';
  doc1.getElementById('f-c2r').value = '2500';
  doc1.getElementById('toggle-c3').checked = true;
  doc1.getElementById('toggle-c3').dispatchEvent(new win1.Event('change'));
  // `skills`/`customSkills`/`cvIndex` are module-level `const`/`let` inside the inline <script> —
  // not exposed as window properties (only `function` declarations are), so drive them through
  // the same public functions/DOM events the real UI uses, never by poking internals directly.
  const c2SkillSel = doc1.getElementById('f-c2-skill');
  c2SkillSel.value = 'Immigration Law';
  win1.addSkill('c2', c2SkillSel);
  doc1.getElementById('f-c2-custom').value = 'Custom Freeform Skill';
  win1.addCustomSkill('c2');

  // Pick a CV for candidate 1 exactly as pickCandidate() (closure-local, not exposed) would:
  // set the registry value now that loadCvIndex() has populated real <option>s, show the chip.
  doc1.getElementById('f-c1-cv-registry').value = 'jane-doe.pdf';
  doc1.getElementById('f-c1-cv-chip-name').textContent = 'Jane Doe';
  doc1.getElementById('f-c1-cv-chip').style.display = 'flex';
  doc1.getElementById('f-c1-cv-search').style.display = 'none';

  win1.saveDraft();
  const raw = win1.localStorage.getItem('palmdeck_draft_v1');
  assert(!!raw, 'saveDraft() writes to localStorage', `raw=${raw ? raw.slice(0,60)+'…' : raw}`);

  const parsed = JSON.parse(raw);
  assert(parsed.fields['f-c2n'] === 'Draft Test Candidate', 'draft captures plain field f-c2n', JSON.stringify(parsed.fields['f-c2n']));
  assert(parsed.fields['f-c2r'] === '2500', 'draft captures plain field f-c2r', JSON.stringify(parsed.fields['f-c2r']));
  assert(parsed.toggles.c3 === true, 'draft captures toggle-c3 checked state', JSON.stringify(parsed.toggles));
  assert(Array.isArray(parsed.skills.c2) && parsed.skills.c2.includes('Immigration Law'), 'draft captures skills.c2', JSON.stringify(parsed.skills.c2));
  assert(Array.isArray(parsed.customSkills.c2) && parsed.customSkills.c2.includes('Custom Freeform Skill'), 'draft captures customSkills.c2', JSON.stringify(parsed.customSkills.c2));
  assert(parsed.cv.c1 && parsed.cv.c1.filename === 'jane-doe.pdf' && parsed.cv.c1.name === 'Jane Doe', 'draft captures cv.c1 pick', JSON.stringify(parsed.cv.c1));

  // ── STAGE 2: fresh page load, seed localStorage (simulates browser restart), restore ─────────
  const dom2 = await makeDom();
  const win2 = dom2.window, doc2 = win2.document;
  win2.localStorage.setItem('palmdeck_draft_v1', raw);
  win2.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win2.showApp();              // internally: restoreDraft() then a fire-and-forget loadCvIndex()
  await win2.loadCvIndex();    // deterministically wait for the same async populate to settle

  assert(doc2.getElementById('f-c2n').value === 'Draft Test Candidate', 'restoreDraft() rehydrates f-c2n', doc2.getElementById('f-c2n').value);
  assert(doc2.getElementById('f-c2r').value === '2500', 'restoreDraft() rehydrates f-c2r', doc2.getElementById('f-c2r').value);
  assert(doc2.getElementById('toggle-c3').checked === true, 'restoreDraft() rehydrates toggle-c3 checked', doc2.getElementById('toggle-c3').checked);
  assert(!doc2.getElementById('fsec-c3').classList.contains('candidate-hidden'), 'restoreDraft() expands fsec-c3 panel', doc2.getElementById('fsec-c3').className);
  assert(doc2.getElementById('c2-skills').textContent.includes('Immigration Law'), 'restoreDraft() rehydrates skills.c2 (via chip DOM)', doc2.getElementById('c2-skills').textContent);
  assert(doc2.getElementById('c2-custom-chips').textContent.includes('Custom Freeform Skill'), 'restoreDraft() rehydrates customSkills.c2 (via chip DOM)', doc2.getElementById('c2-custom-chips').textContent);
  assert(doc2.getElementById('f-c1-cv-chip-name').textContent === 'Jane Doe', 'restoreDraft() rehydrates CV chip name text', doc2.getElementById('f-c1-cv-chip-name').textContent);
  assert(doc2.getElementById('f-c1-cv-chip').style.display === 'flex', 'restoreDraft() shows the CV chip', doc2.getElementById('f-c1-cv-chip').style.display);

  // This is the one that broke WITHOUT the loadCvIndex()/_pendingCvDraft fix: on a fresh boot the
  // <select> only has the static "Loading…" placeholder when restoreDraft() runs, so a synchronous
  // reg.value=filename assignment is a silent no-op — the value must be (re)applied once
  // loadCvIndex() has actually populated real <option>s.
  const regValue = doc2.getElementById('f-c1-cv-registry').value;
  assert(regValue === 'jane-doe.pdf', 'CV registry value ends up correct once loadCvIndex() populates real <option>s', `sel.value = "${regValue}"`);
  const shareUrl = win2.getCvShareUrl('c1');
  assert(!!shareUrl && shareUrl.includes('jane-doe.pdf'), 'getCvShareUrl(c1) resolves correctly (email "View CV" link stays intact)', shareUrl);

  // Simulate the periodic 30s re-poll (setInterval(loadCvIndex, 30000)) happening again later —
  // the pick must survive a SECOND rebuild too, now via the prevValue-preservation path.
  await win2.loadCvIndex();
  assert(doc2.getElementById('f-c1-cv-registry').value === 'jane-doe.pdf', 'CV registry value survives a SECOND loadCvIndex() rebuild (periodic 30s poll)', doc2.getElementById('f-c1-cv-registry').value);

  // ── STAGE 3: Reset button requires confirm(); cancel must NOT wipe the form ──────────────────
  win2.confirm = () => false;
  doc2.getElementById('btn-reset').dispatchEvent(new win2.Event('click', { bubbles: true }));
  assert(doc2.getElementById('f-c2n').value === 'Draft Test Candidate', 'Reset click with confirm()=false leaves form untouched', doc2.getElementById('f-c2n').value);
  assert(win2.localStorage.getItem('palmdeck_draft_v1') !== null, 'Reset click with confirm()=false leaves draft in localStorage', win2.localStorage.getItem('palmdeck_draft_v1') !== null);

  // ── STAGE 4: Reset confirmed — form AND draft AND CV chip must all clear ─────────────────────
  win2.confirm = () => true;
  doc2.getElementById('btn-reset').dispatchEvent(new win2.Event('click', { bubbles: true }));
  assert(doc2.getElementById('f-c2n').value === '', 'Reset click with confirm()=true clears f-c2n', JSON.stringify(doc2.getElementById('f-c2n').value));
  assert(win2.localStorage.getItem('palmdeck_draft_v1') === null, 'Reset click with confirm()=true clears the autosave draft', win2.localStorage.getItem('palmdeck_draft_v1'));
  assert(doc2.getElementById('f-c1-cv-registry').value === '', 'Reset clears the CV registry select (previously survived Reset)', doc2.getElementById('f-c1-cv-registry').value);
  assert(doc2.getElementById('f-c1-cv-chip').style.display === 'none', 'Reset hides the CV chip', doc2.getElementById('f-c1-cv-chip').style.display);
  assert(doc2.getElementById('fsec-c3').classList.contains('candidate-hidden'), 'Reset re-collapses fsec-c3', doc2.getElementById('fsec-c3').className);

  // ── STAGE 5: private-browsing / localStorage-unavailable must not crash the app ──────────────
  const dom3 = await makeDom();
  const win3 = dom3.window, doc3 = win3.document;
  Object.defineProperty(win3, 'localStorage', { get() { throw new Error('SecurityError: localStorage disabled (private mode simulation)'); } });
  let threw = false;
  try {
    win3.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
    win3.showApp();
    doc3.getElementById('f-c2n').value = 'x';
    win3.saveDraft();
  } catch (e) { threw = true; console.log('  [unexpected throw]', e.message); }
  assert(!threw, 'saveDraft()/restoreDraft() never throw when localStorage is unavailable (private browsing)', threw ? 'threw' : 'no throw');

  // ── STAGE 6: autoFillFromCv skills bug — was: 100% broken (2 independent root causes), now fixed
  const dom4 = await makeDom();
  const win4 = dom4.window, doc4 = win4.document;
  win4.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win4.showApp();
  await win4.loadCvIndex();
  doc4.getElementById('f-c1-cv-registry').value = 'jane-doe.pdf'; // has 1 std-dropdown skill + 1 non-dropdown skill
  win4.autoFillFromCv('c1');
  const stdCaptured = doc4.getElementById('c1-skills').textContent.includes('Immigration Law');
  const customCaptured = doc4.getElementById('c1-custom-chips').textContent.includes('Some Totally Custom Niche Skill Not In Any Dropdown List');
  assert(stdCaptured, 'FIXED: autoFillFromCv() adds a std-dropdown-matched skill to the chip DOM (was always empty — stdOptions.find() always matched the placeholder\'s empty value first)', doc4.getElementById('c1-skills').textContent);
  assert(customCaptured, 'FIXED: autoFillFromCv() adds a non-dropdown-matched skill as a custom chip (was always dropped — wrong element IDs f-c1-custom-skill-inp/-add vs actual f-c1-custom/btn-c1-add)', doc4.getElementById('c1-custom-chips').textContent || '(still empty)');

  // Escaping hardening — a skill containing HTML must render as inert text, not break the chip markup
  const dom5 = await makeDom();
  const win5 = dom5.window, doc5 = win5.document;
  win5.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win5.showApp();
  doc5.getElementById('f-c1-custom').value = '<img src=x onerror=alert(1)>"quoted"';
  win5.addCustomSkill('c1');
  const chipWrap = doc5.getElementById('c1-custom-chips');
  const chipText = chipWrap.textContent;
  // The real check is DOM structure, not the serialized innerHTML string — <img src=x onerror=...>
  // appearing INSIDE an already-quote-delimited attribute value is inert HTML serialization, not
  // an injection; what actually matters is whether a genuine <img> ELEMENT exists in the chip tree.
  assert(chipWrap.querySelector('img') === null, 'FIXED: a skill containing raw HTML no longer creates a live <img> (or any) element in the chip DOM', chipWrap.innerHTML);
  assert(chipWrap.children.length === 1 && chipWrap.children[0].tagName === 'SPAN', 'chip DOM still has exactly the expected single <span class="skill-chip"> wrapper, nothing extra injected', `children=[${[...chipWrap.children].map(c=>c.tagName)}]`);
  assert(chipText.includes('<img src=x onerror=alert(1)>"quoted"'), 'the HTML-looking skill still renders as visible inert text (not silently dropped)', chipText);
  // Round-trip: removing the chip must still work now that the value is HTML-escaped in the DOM attribute
  const rmBtn = doc5.querySelector('#c1-custom-chips .skill-rm');
  rmBtn.dispatchEvent(new win5.Event('click', { bubbles: true }));
  assert(doc5.getElementById('c1-custom-chips').textContent === '', 'removing an escaped chip still works (dataset round-trips the decoded value correctly)', doc5.getElementById('c1-custom-chips').textContent);

  // ── STAGE 7: regression — candidates up to 6, outbound-email escaping, formatRate, rate/email build
  const dom6 = await makeDom();
  const win6 = dom6.window, doc6 = win6.document;
  win6.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win6.showApp();

  // 7a. Candidate 6 (this session's first fix) — toggle on, fill, must render in buildEmail() output
  doc6.getElementById('toggle-c6').checked = true;
  doc6.getElementById('toggle-c6').dispatchEvent(new win6.Event('change'));
  doc6.getElementById('f-c6n').value = 'Sixth Candidate Regression Check';
  doc6.getElementById('f-c6r').value = '3200';
  const emailHtml6 = win6.buildEmail(win6.getData());
  assert(emailHtml6.includes('Sixth Candidate Regression Check'), 'Candidate 6 (toggled on) renders in buildEmail() output', emailHtml6.includes('Sixth Candidate Regression Check'));
  assert(emailHtml6.includes('US$ 3.200,00/month'), 'formatRate() still converts a plain number for candidate 6', (emailHtml6.match(/US\$[^<]*3\.200[^<]*/)||[])[0]);

  // 7b. formatRate() direct unit checks — the "type 1000, renders as US$ 1.000,00/month" feature
  assert(win6.formatRate('1000') === 'US$ 1.000,00/month', 'formatRate("1000")', win6.formatRate('1000'));
  assert(win6.formatRate('2500.50') === 'US$ 2.500,50/month', 'formatRate("2500.50")', win6.formatRate('2500.50'));
  assert(win6.formatRate('') === 'US$ —', 'formatRate("") shows an em-dash placeholder, not a broken string', win6.formatRate(''));
  assert(win6.formatRate('negotiable') === 'negotiable', 'formatRate() passes through already-worded input untouched', win6.formatRate('negotiable'));
  assert(win6.formatRate('2500.50') === 'US$ 2.500,50/month', 'FIXED: formatRate("2500.50") — US-style decimal no longer misread as thousands separator', win6.formatRate('2500.50'));
  assert(win6.formatRate('2500.5') === 'US$ 2.500,50/month', 'formatRate("2500.5") — single trailing decimal digit', win6.formatRate('2500.5'));
  assert(win6.formatRate('2.500') === 'US$ 2.500,00/month', 'formatRate("2.500") — BR-style thousands separator UNCHANGED (original documented behavior)', win6.formatRate('2.500'));
  assert(win6.formatRate('2.500,50') === 'US$ 2.500,50/month', 'formatRate("2.500,50") — unambiguous BR/EU full format', win6.formatRate('2.500,50'));
  assert(win6.formatRate('12000') === 'US$ 12.000,00/month', 'formatRate("12000") — 5-digit plain integer', win6.formatRate('12000'));

  // 7c. Outbound email skill-pill escaping (skillPills() → the actual client-facing surface, separate
  // from the sidebar chip fix above) — must stay escaped, this was already correct, confirm no regression
  const c1SkillSel6 = doc6.getElementById('f-c1-skill');
  c1SkillSel6.value = 'Immigration Law';
  win6.addSkill('c1', c1SkillSel6);
  doc6.getElementById('f-c1-custom').value = '<script>alert(1)</scr' + 'ipt>';
  win6.addCustomSkill('c1');
  const emailHtml6b = win6.buildEmail(win6.getData());
  assert(emailHtml6b.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'outbound email HTML escapes an injected skill (skillPills()/esc() — no regression)', (emailHtml6b.match(/&lt;script.*?&lt;\/script&gt;/)||['NOT FOUND'])[0]);
  assert(!emailHtml6b.includes('<script>alert(1)</scr' + 'ipt>'), 'outbound email HTML contains no live unescaped <script> tag from the injected skill', !emailHtml6b.includes('<script>alert(1)</scr' + 'ipt>'));

  // 7d. A fresh manual CV pick for a candidate must NOT be clobbered by an unrelated candidate's
  // pending draft restore (draft only had c1; c2 gets a live pick here — must not interfere)
  const dom7 = await makeDom();
  const win7 = dom7.window, doc7 = win7.document;
  win7.localStorage.setItem('palmdeck_draft_v1', raw); // reuse Stage 1's draft (has a c1 CV pick only)
  win7.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win7.showApp();
  await win7.loadCvIndex();
  doc7.getElementById('f-c2-cv-registry').value = 'other.pdf'; // live pick, unrelated to the c1 draft pick
  await win7.loadCvIndex(); // simulate a periodic reload happening right after
  assert(doc7.getElementById('f-c1-cv-registry').value === 'jane-doe.pdf', 'restored c1 CV pick and a fresh unrelated c2 pick coexist without clobbering each other (c1)', doc7.getElementById('f-c1-cv-registry').value);
  assert(doc7.getElementById('f-c2-cv-registry').value === 'other.pdf', 'restored c1 CV pick and a fresh unrelated c2 pick coexist without clobbering each other (c2)', doc7.getElementById('f-c2-cv-registry').value);

  // ── STAGE 8: improvement-sweep fixes — interval leak, CV-pipeline XSS, stale hidden-candidate data
  const dom8 = await makeDom();
  const win8 = dom8.window, doc8 = win8.document;

  // 8a. Interval leak on re-login: showApp() called twice must register the 3 pollers only once
  let intervalCalls = 0;
  const origSetInterval = win8.setInterval.bind(win8);
  win8.setInterval = (...args) => { intervalCalls++; return origSetInterval(...args); };
  win8.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win8.showApp();               // 1st call — should register 3 intervals (30s/3s/90s)
  const afterFirst = intervalCalls;
  win8.doLogout();
  win8.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win8.showApp();               // 2nd call (re-login, same tab) — must NOT register 3 more
  const afterSecond = intervalCalls;
  assert(afterFirst === 3, 'FIXED: first showApp() registers exactly the 3 expected pollers (30s/3s/90s)', `afterFirst=${afterFirst}`);
  assert(afterSecond === afterFirst, 'FIXED: re-login (2nd showApp() call, same tab) registers ZERO additional intervals — was: 3 more every cycle, stacking indefinitely', `afterFirst=${afterFirst}, afterSecond=${afterSecond}`);

  // 8b. CV-pipeline XSS — cv.title in search results, fileName in "Sending...", found.name in "ready" + toastReady
  await win8.loadCvIndex(); // MOCK_CV_INDEX already includes an 'evil.pdf' entry with an HTML-injecting title
  const searchInp8 = doc8.getElementById('f-c2-cv-search');
  searchInp8.value = 'evil';
  searchInp8.dispatchEvent(new win8.Event('input'));
  const resultsWrap = doc8.getElementById('f-c2-cv-results');
  assert(resultsWrap.querySelector('img') === null, 'FIXED: CV search result cv.title no longer creates a live element (was unescaped innerHTML)', resultsWrap.innerHTML);
  assert(resultsWrap.textContent.includes('<img src=x onerror=alert(1)>'), 'the malicious-looking title still renders as visible inert text', resultsWrap.textContent);

  // 8c. Stale hidden-candidate resurrection — build a draft where c3 has leftover data from a PRIOR
  // client but is toggled OFF, and c2 is toggled ON with current data. Restoring in a fresh session
  // must bring back c2's data (still-active candidate) but leave c3's fields BLANK (hidden candidate),
  // while still correctly showing c3's toggle as off.
  const domA = await makeDom();
  const winA = domA.window, docA = winA.document;
  winA.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  winA.showApp();
  docA.getElementById('f-c2n').value = 'Current Active Candidate';
  docA.getElementById('toggle-c3').checked = true; // toggle ON first so the field is actually editable/visible
  docA.getElementById('toggle-c3').dispatchEvent(new winA.Event('change'));
  docA.getElementById('f-c3n').value = 'Stale Client A Candidate';
  docA.getElementById('f-c3r').value = '4000';
  docA.getElementById('toggle-c3').checked = false; // then toggled back OFF — data left behind, as a real user would do
  docA.getElementById('toggle-c3').dispatchEvent(new winA.Event('change'));
  winA.saveDraft();
  const staleRaw = winA.localStorage.getItem('palmdeck_draft_v1');
  const staleParsed = JSON.parse(staleRaw);
  assert(staleParsed.toggles.c3 === false, 'sanity: saved draft correctly records c3 as toggled off', JSON.stringify(staleParsed.toggles));
  assert(staleParsed.fields['f-c3n'] === 'Stale Client A Candidate', 'sanity: saved draft still captured c3\'s leftover field value (as before the fix)', staleParsed.fields['f-c3n']);

  const domB = await makeDom();
  const winB = domB.window, docB = winB.document;
  winB.localStorage.setItem('palmdeck_draft_v1', staleRaw);
  winB.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  winB.showApp();
  assert(docB.getElementById('f-c2n').value === 'Current Active Candidate', 'FIXED regression check: an active (toggled-on) candidate still restores normally', docB.getElementById('f-c2n').value);
  assert(docB.getElementById('f-c3n').value === '', 'FIXED: a hidden (toggled-off) candidate\'s stale field data is NOT resurrected on restore', JSON.stringify(docB.getElementById('f-c3n').value));
  assert(docB.getElementById('f-c3r').value === '', 'FIXED: hidden candidate\'s rate field also stays blank', JSON.stringify(docB.getElementById('f-c3r').value));
  assert(docB.getElementById('toggle-c3').checked === false, 'the toggle-off state itself still restores correctly', docB.getElementById('toggle-c3').checked);
  assert(docB.getElementById('fsec-c3').classList.contains('candidate-hidden'), 'the panel is still correctly shown collapsed', docB.getElementById('fsec-c3').className);

  // ── STAGE 9: "faça todos" round — security, email-output, accessibility, UX fixes ────────────
  const dom9 = await makeDom();
  const win9 = dom9.window, doc9 = win9.document;
  win9.doLogin('SimpalmStaff', 'Simpalmstaff@2026');
  win9.showApp();
  await win9.loadCvIndex(); // deterministically populate cvIndex before 9c's search-box test depends on it

  // 9a. sanitizeUrl() — the Interview URL scheme-injection fix
  assert(win9.sanitizeUrl('javascript:alert(1)') === '#', 'sanitizeUrl rejects javascript: scheme', win9.sanitizeUrl('javascript:alert(1)'));
  assert(win9.sanitizeUrl('  JavaScript:alert(1)  ') === '#', 'sanitizeUrl rejects javascript: case/whitespace variants', win9.sanitizeUrl('  JavaScript:alert(1)  '));
  assert(win9.sanitizeUrl('data:text/html,<script>alert(1)</script>') === '#', 'sanitizeUrl rejects data: scheme', win9.sanitizeUrl('data:text/html,x'));
  assert(win9.sanitizeUrl('vbscript:msgbox(1)') === '#', 'sanitizeUrl rejects vbscript: scheme', win9.sanitizeUrl('vbscript:msgbox(1)'));
  assert(win9.sanitizeUrl('https://app.ducknowl.com/interview/xyz') === 'https://app.ducknowl.com/interview/xyz', 'sanitizeUrl passes through a normal https:// URL unchanged', win9.sanitizeUrl('https://app.ducknowl.com/interview/xyz'));
  assert(win9.sanitizeUrl('http://example.com') === 'http://example.com', 'sanitizeUrl passes through http:// unchanged', win9.sanitizeUrl('http://example.com'));
  assert(win9.sanitizeUrl('//app.ducknowl.com/x') === 'https://app.ducknowl.com/x', 'sanitizeUrl normalizes protocol-relative //host to https:', win9.sanitizeUrl('//app.ducknowl.com/x'));
  assert(win9.sanitizeUrl('app.ducknowl.com/interview/xyz') === 'https://app.ducknowl.com/interview/xyz', 'sanitizeUrl auto-prepends https:// to a bare domain (no scheme) rather than dropping the link', win9.sanitizeUrl('app.ducknowl.com/interview/xyz'));
  assert(win9.sanitizeUrl('') === '#', 'sanitizeUrl("") falls back to #', win9.sanitizeUrl(''));
  assert(win9.sanitizeUrl('#') === '#', 'sanitizeUrl("#") stays #', win9.sanitizeUrl('#'));

  // getCandidateData actually calls sanitizeUrl on the Interview URL field end to end
  doc9.getElementById('f-c1u').value = 'javascript:alert(document.cookie)';
  const emailWithBadUrl = win9.buildEmail(win9.getData());
  assert(!emailWithBadUrl.includes('javascript:alert'), 'end to end: a javascript: Interview URL never reaches the outbound email href', emailWithBadUrl.includes('javascript:alert'));
  doc9.getElementById('f-c1u').value = '';

  // 9b. Outbound email head — dark-mode meta tags + gradient stripe fallback + VML buttons
  const email9 = win9.buildEmail(win9.getData());
  assert(email9.includes('<meta name="color-scheme" content="light">'), 'buildEmail() head declares color-scheme=light (prevents Gmail/Apple Mail forced inversion)', email9.includes('color-scheme'));
  assert(email9.includes('<meta name="supported-color-schemes" content="light">'), 'buildEmail() head declares supported-color-schemes=light', email9.includes('supported-color-schemes'));
  assert(!email9.includes('undefined'), 'FIXED: buildEmail() head no longer leaks the literal string "undefined" from the removed d.company field', email9.includes('undefined') ? '"undefined" found in output' : 'clean');
  assert(email9.includes('bgcolor="#6B9080"'), 'top brand stripe has a solid bgcolor Outlook fallback alongside the CSS gradient', email9.includes('bgcolor="#6B9080"'));
  assert(email9.includes('<v:roundrect'), 'CTA buttons include a VML <v:roundrect> fallback for Outlook desktop', email9.includes('<v:roundrect'));
  assert(email9.includes('<!--[if mso]>') && email9.includes('<!--[if !mso]><!-->'), 'VML is properly wrapped in mso/non-mso conditional comments (never double-renders)', email9.includes('[if mso]') && email9.includes('[if !mso]'));
  assert(email9.match(/<v:roundrect/g).length >= 2, 'multiple candidates (c1 + default-included c2) each get a "Watch Interview" VML fallback button', (email9.match(/<v:roundrect/g) || []).length);

  // 9c. Accessibility — CV combobox ARIA wiring, toggle focus-visible, country select aria-label
  const c1Search = doc9.getElementById('f-c1-cv-search');
  assert(c1Search.getAttribute('role') === 'combobox', 'CV search input has role=combobox', c1Search.getAttribute('role'));
  assert(c1Search.getAttribute('aria-expanded') === 'false', 'CV search input starts aria-expanded=false', c1Search.getAttribute('aria-expanded'));
  c1Search.value = 'jane';
  c1Search.dispatchEvent(new win9.Event('input'));
  assert(c1Search.getAttribute('aria-expanded') === 'true', 'aria-expanded flips to true when results open', c1Search.getAttribute('aria-expanded'));
  const c1Results = doc9.getElementById('f-c1-cv-results');
  assert(c1Results.getAttribute('role') === 'listbox', 'results container has role=listbox', c1Results.getAttribute('role'));
  const firstOption = c1Results.querySelector('.cv-result-item');
  assert(firstOption && firstOption.getAttribute('role') === 'option', 'each result item has role=option', firstOption && firstOption.getAttribute('role'));
  assert(!!firstOption.id, 'each result item has a stable id (needed for aria-activedescendant)', firstOption.id);
  c1Search.dispatchEvent(new win9.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert(c1Search.getAttribute('aria-activedescendant') === firstOption.id, 'ArrowDown sets aria-activedescendant to the now-highlighted option', c1Search.getAttribute('aria-activedescendant'));
  assert(firstOption.getAttribute('aria-selected') === 'true', 'the highlighted option gets aria-selected=true', firstOption.getAttribute('aria-selected'));
  c1Search.dispatchEvent(new win9.Event('blur'));
  await new Promise(r => setTimeout(r, 200)); // blur handler closes on a 160ms setTimeout
  assert(c1Search.getAttribute('aria-expanded') === 'false', 'blur closes the listbox and resets aria-expanded', c1Search.getAttribute('aria-expanded'));
  assert(!c1Search.hasAttribute('aria-activedescendant'), 'blur clears aria-activedescendant', c1Search.hasAttribute('aria-activedescendant'));

  assert(doc9.getElementById('f-c1c').getAttribute('aria-label') === 'Country', 'country select has an accessible name via aria-label', doc9.getElementById('f-c1c').getAttribute('aria-label'));

  // 9d. Contrast fixes actually landed in the CSS (not just claimed) — spot check the raw source
  const rawHtml9 = fs.readFileSync(HTML_PATH, 'utf8');
  assert(rawHtml9.includes('--gold-dark:  #765911'), 'gold-dark CSS variable was actually darkened for contrast', rawHtml9.includes('#765911'));
  assert(rawHtml9.includes('--muted:      #636882'), 'muted CSS variable was actually darkened for contrast', rawHtml9.includes('#636882'));
  assert(rawHtml9.includes('.btn-primary { background: var(--green-dark)'), 'btn-primary resting background uses --green-dark, not --green', rawHtml9.includes('.btn-primary { background: var(--green-dark)'));

  // 9e. UX — candidate count badge, autofill confirm gate
  assert(doc9.getElementById('candidate-count-badge').textContent === '2 of 6 included', 'candidate count badge reflects c1 (always) + c2 (default-checked) on fresh boot', doc9.getElementById('candidate-count-badge').textContent);
  doc9.getElementById('toggle-c3').checked = true;
  doc9.getElementById('toggle-c3').dispatchEvent(new win9.Event('change'));
  assert(doc9.getElementById('candidate-count-badge').textContent === '3 of 6 included', 'badge updates live when a toggle changes', doc9.getElementById('candidate-count-badge').textContent);

  // Autofill confirm gate: candidate 1 already has a name typed -> confirm() must be asked
  doc9.getElementById('f-c1n').value = 'Hand Typed Name';
  doc9.getElementById('f-c1-cv-registry').value = 'jane-doe.pdf';
  let confirmCalled = false;
  win9.confirm = () => { confirmCalled = true; return false; }; // user cancels
  win9.autoFillFromCv('c1');
  assert(confirmCalled, 'autoFillFromCv() asks for confirmation when the field already has data', confirmCalled);
  assert(doc9.getElementById('f-c1n').value === 'Hand Typed Name', 'canceling the confirm leaves the hand-typed name untouched', doc9.getElementById('f-c1n').value);
  win9.confirm = () => true; // user confirms this time
  win9.autoFillFromCv('c1');
  assert(doc9.getElementById('f-c1n').value === 'Jane Doe', 'confirming proceeds with the overwrite as before', doc9.getElementById('f-c1n').value);

  // Autofill on a genuinely blank candidate must NOT prompt at all (no nagging on first use)
  doc9.getElementById('f-c2-cv-registry').value = 'other.pdf';
  let confirmCalledForBlank = false;
  win9.confirm = () => { confirmCalledForBlank = true; return true; };
  win9.autoFillFromCv('c2');
  assert(!confirmCalledForBlank, 'autoFillFromCv() does NOT prompt when the candidate fields are empty', confirmCalledForBlank);

  // 9f. Preview popup-blocked parity with Copy Email
  win9.URL.createObjectURL = () => 'blob:mock-url'; // jsdom doesn't implement Blob URLs — stub it
  win9.URL.revokeObjectURL = () => {};
  win9.window.open = () => null; // simulate a blocked popup
  let threw9f = false;
  try { win9.openPreview(); } catch (e) { threw9f = true; console.log('  [openPreview threw]', e.message); }
  assert(!threw9f, 'openPreview() with a blocked popup does not throw', threw9f);
  const toastEl9 = doc9.getElementById('toast');
  assert(toastEl9.textContent.includes('Popup bloqueado'), 'FIXED: openPreview() now shows the same popup-blocked toast copyHTML() already had', toastEl9.textContent);
  assert(toastEl9.className.includes('err'), 'the popup-blocked toast is styled as an error', toastEl9.className);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
