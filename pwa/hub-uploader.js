/* IWMI Hub Uploader — the app behind the PWA redesign.
 *
 * Ported from the design prototype, with two deliberate departures:
 *
 * 1. THE TOKEN IS THE USER'S OWN. The prototype took one IWMIHQ write token as a
 *    prop and shipped it to every client; in a browser-only app that means anyone
 *    who opens the page holds a key to the whole organization. Here each person
 *    pastes their own write token, it is kept in this browser only, and the Hub
 *    records who actually committed. That is also why there is no server: nothing
 *    secret has to live anywhere else.
 *
 * 2. NO FRAMEWORK. The prototype needed React, Babel and a design-tool runtime off
 *    a CDN before it could draw. Here the markup is in index.html and this file
 *    moves it: ~40 KB of app instead of ~400 KB of framework, and the shell works
 *    offline. Text inputs are read on demand rather than re-rendered per keystroke,
 *    so nothing steals the caret.
 *
 * The Hub client itself is imported on first use from jsDelivr, pinned. Uploading
 * needs the network anyway, and vendoring it would mean vendoring its WASM chunker
 * too. Everything before the upload works with no network at all.
 */
'use strict';

const HUB_ESM = 'https://cdn.jsdelivr.net/npm/@huggingface/hub@2.15.0/+esm';
// Where a problem goes. Two routes because not everybody here is on GitHub.
const ISSUES_URL = 'https://github.com/ZoloKiala/hub_upload/issues/new';
const CONTACT_EMAIL = 'z.kiala@cgiar.org';
// A GitHub issue arrives as a URL, and a URL that is too long is silently truncated
// by the browser rather than by us.
const REPORT_LIMIT = 5500;
const ORG = 'IWMIHQ';
const LFS_BYTES = 10 * 1024 * 1024;
// How far the repository picker reads. High enough that IWMIHQ fits several times
// over; a cap at all only so a runaway listing cannot hang the menu.
const LIST_CAP = 200;
const KEY = { token: 'hu_token', name: 'hu_name', history: 'hu_history',
              theme: 'hu_theme' };

const state = {
  token: '',
  name: '',
  whoami: null,
  tab: 'upload',
  repoType: 'model',
  repoMode: 'create',
  visibility: 'public',
  files: [],
  root: '',
  keepRoot: false,
  skipped: [],
  refused: [],
  tags: [],
  history: [],
  projects: [],
  target: null,
  search: '',
  logLines: [],
  issues: [],
  installEvent: null,
  lastRepo: null,
};

/* ── plumbing ───────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
const show = (el, yes) => { if (el) el.hidden = !yes; };
const val = (id) => ($(id) ? $(id).value : '');

function icon(name, cls) {
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' +
         '<use href="assets/icons.svg#i-' + name + '"/></svg>';
}

/** Text into HTML. Repository names, file paths, error messages and GitHub input
 *  all reach the DOM, and any of them can contain a bracket. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

function ago(iso) {
  const then = new Date(iso).getTime();
  if (!then) return '—';
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { /* private browsing: the app still works, it just forgets */ }
}
function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

let hub = null;
async function getHub() {
  if (!hub) hub = await import(HUB_ESM);
  return hub;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  show(el, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(el, false), 3000);
}

/* ── connect ────────────────────────────────────────────────────────────── */
async function connect() {
  const token = val('f-token').trim();
  const error = $('connect-error');
  show(error, false);
  if (!token) {
    error.textContent = 'Paste your Hugging Face access token to continue.';
    show(error, true);
    return;
  }
  const button = $('connect-btn');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const h = await getHub();
    const who = await h.whoAmI({ accessToken: token });
    // A read-only token gets you in and then fails at the upload, which is the
    // worst moment to find out. Say it now.
    const scope = who && who.auth && who.auth.accessToken && who.auth.accessToken.role;
    if (scope && scope === 'read') {
      throw new Error('That token is read-only. Create a write token and paste that instead.');
    }
    state.token = token;
    state.whoami = who;
    state.name = (val('f-name').trim() || who.fullname || who.name || '').trim();
    store(KEY.token, token);
    store(KEY.name, state.name);
    enterApp();
  } catch (e) {
    error.textContent = (e && e.message) ? e.message
      : 'Could not reach Hugging Face with that token.';
    show(error, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Continue';
  }
}

function enterApp() {
  show($('screen-connect'), false);
  show($('screen-app'), true);
  $('f-name-2').value = state.name;
  $('who').textContent = state.whoami
    ? (state.whoami.fullname || state.whoami.name || state.name || '—')
    : (state.name || '—');
  $('token-mask').textContent = state.token
    ? state.token.slice(0, 3) + '…' + state.token.slice(-4)
    : '—';
  $('app-mode').textContent = 'v1.0.0 · ' +
    (isStandalone() ? 'Installed app' : 'Progressive Web App');
  renderHistory();
  loadProjects();
}

function signOut() {
  store(KEY.token, null);
  state.token = '';
  state.whoami = null;
  closeModals();
  show($('screen-app'), false);
  show($('screen-connect'), true);
  $('f-token').value = '';
  toast('Signed out. The token was removed from this browser.');
}

function isStandalone() {
  try {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  } catch (e) { return false; }
}

/* ── appearance ─────────────────────────────────────────────────────────────
 * Light, Dark, or follow the system. Stored, because a tool people keep open all
 * day should not have to be told twice; and applied by one attribute on <html>,
 * so every colour comes from the tokens and no component knows the difference.
 */
/** What is stored: 'light', 'dark', or nothing at all — nothing meaning "whatever
 *  this machine is asking for", which is the state before anyone chooses. */
function chosenTheme() {
  const stored = read(KEY.theme);
  return (stored === 'light' || stored === 'dark') ? stored : null;
}

/** Which look is actually on screen. The toggle shows this, so before a choice is
 *  made it still points at the right half. */
function activeTheme() {
  const chosen = chosenTheme();
  if (chosen) return chosen;
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  } catch (e) { return 'light'; }
}

function setTheme(look) {
  if (look === 'light' || look === 'dark') {
    document.documentElement.setAttribute('data-theme', look);
    store(KEY.theme, look);
  } else {
    document.documentElement.removeAttribute('data-theme');
    store(KEY.theme, null);
  }
  paintTheme();
}

/** Reflect the look in the toggle, the settings row and the browser's own chrome. */
function paintTheme() {
  const active = activeTheme();
  document.querySelectorAll('.theme-toggle button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.look === active));
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', active === 'dark' ? '#0f1620' : '#28537D');
  const label = $('theme-label');
  if (label) {
    label.textContent = (active === 'dark' ? 'Dark' : 'Light') +
      (chosenTheme() ? '' : ' · from your system');
  }
}

/* ── tabs and modals ────────────────────────────────────────────────────── */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  document.querySelectorAll('[data-menu-tab]').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.menuTab === tab));
  });
  show($('tab-upload'), tab === 'upload');
  show($('tab-history'), tab === 'history');
  show($('tab-projects'), tab === 'projects');
  if (tab === 'projects' && !state.projects.length) loadProjects();
}

function toggleMenu(open) {
  const menu = $('menu');
  const button = $('menu-btn');
  const show_it = open === undefined ? menu.hidden : open;
  show(menu, show_it);
  button.setAttribute('aria-expanded', String(show_it));
  if (show_it) {
    const first = menu.querySelector('.menu-item');
    if (first) first.focus();
  }
}

function openModal(id) {
  closeModals();
  show($(id), true);
}
function closeModals() {
  ['modal-help', 'modal-settings', 'modal-install', 'modal-github', 'modal-upload',
   'modal-log', 'modal-report'].forEach((id) => show($(id), false));
}

/* ── destination ────────────────────────────────────────────────────────── */
function setRepoType(type) {
  state.repoType = type;
  state.target = null;
  show($('owner-note'), false);
  show($('confirm-row'), false);
  document.querySelectorAll('#repo-type button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.type === type));
  });
  show($('sdk-row'), type === 'space');
  if (state.repoMode === 'update') loadExisting();
  refresh();
}

function setRepoMode(mode) {
  state.repoMode = mode;
  state.target = null;
  show($('owner-note'), false);
  show($('confirm-row'), false);
  document.querySelectorAll('#repo-mode button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  show($('create-fields'), mode === 'create');
  show($('update-fields'), mode === 'update');
  if (mode === 'update') loadExisting();
  refresh();
}

function setVisibility(vis) {
  state.visibility = vis;
  document.querySelectorAll('#visibility button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.vis === vis));
  });
}

function target() {
  return state.repoMode === 'create'
    ? val('f-repo').trim()
    : val('f-existing').trim();
}
function fullName() {
  const t = target();
  if (!t) return '';
  return state.repoMode === 'create' ? ORG + '/' + t : t;
}

async function loadExisting() {
  const select = $('f-existing');
  select.innerHTML = '<option value="">Loading repositories…</option>';
  try {
    const h = await getHub();
    const list = state.repoType === 'model' ? h.listModels
               : state.repoType === 'dataset' ? h.listDatasets : h.listSpaces;
    const found = [];
    let truncated = false;
    for await (const repo of list({ search: { owner: ORG }, accessToken: state.token })) {
      // `name` is the "IWMIHQ/thing" path; `id` is an internal hex string. Reading
      // id here filled this menu with hex and would have committed to a repository
      // that does not exist.
      found.push(repo.name || repo.id);
      if (found.length >= LIST_CAP) { truncated = true; break; }
    }
    found.sort();
    if (truncated) {
      issue('warn', 'The repository list stopped at ' + LIST_CAP + ' ' +
                    state.repoType + 's — if yours is missing, that is why.');
    }

    // Two groups rather than a filter. What this device has uploaded to is a useful
    // shortcut and a bad definition of "mine" -- it is empty on a new machine -- so
    // it goes first and everything else stays visible under it. The note below the
    // picker is what actually reads a repository's maintainers.
    const uploaded = {};
    state.history.forEach((h) => { uploaded[h.repo] = true; });
    const mine = found.filter((id) => uploaded[id]);
    const rest = found.filter((id) => !uploaded[id]);

    const option = (id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>';
    const kind = state.repoType === 'model' ? 'models'
               : state.repoType === 'dataset' ? 'datasets' : 'Spaces';
    let html = '<option value="">' +
      (found.length ? 'Select one of ' + found.length + ' ' + kind + '…'
                    : 'No ' + kind + ' found in ' + ORG) + '</option>';
    if (mine.length) {
      html += '<optgroup label="Uploaded from this device">' +
              mine.map(option).join('') + '</optgroup>' +
              '<optgroup label="All ' + ORG + ' ' + kind + '">' +
              rest.map(option).join('') + '</optgroup>';
    } else {
      html += found.map(option).join('');
    }
    select.innerHTML = html;
  } catch (e) {
    select.innerHTML = '<option value="">Could not list repositories</option>';
  }
  refresh();
}

/* ── who maintains what ─────────────────────────────────────────────────────
 * The Hub has no per-repository owner inside an organization: everything in IWMIHQ
 * belongs to IWMIHQ, and org write access reaches all of it. So ownership is a
 * convention kept where everyone can see it — a `maintainers:` list in the README
 * front matter this app already writes.
 *
 * None of this prevents anything. It makes the common accident — uploading into a
 * name that looked free, or someone else's work in flight — visible before it
 * happens, and asks you to type the name if you go ahead anyway.
 */
function myHandles() {
  const who = state.whoami || {};
  return [who.name, who.fullname, state.name]
    .filter(Boolean).map((s) => String(s).trim().toLowerCase());
}

function readsAsMine(maintainers) {
  if (!maintainers.length) return true;          // nobody claimed it
  const mine = myHandles();
  return maintainers.some((m) => mine.indexOf(String(m).trim().toLowerCase()) !== -1);
}

/** Pull `maintainers:` out of a README's YAML front matter. Deliberately small: a
 *  block list or an inline one, and nothing else — this is a convention, not a
 *  schema, and a README that does not follow it simply has no maintainers. */
function parseMaintainers(readmeText) {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(readmeText || '');
  if (!front) return [];
  const body = front[1];
  const inline = /^maintainers:\s*\[([^\]]*)\]\s*$/m.exec(body);
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const block = /^maintainers:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(body);
  if (!block) return [];
  return block[1].split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

async function inspectTarget() {
  const note = $('owner-note');
  const name = val('f-existing').trim();
  state.target = null;
  show(note, false);
  show($('confirm-row'), false);
  if (!name) { refresh(); return; }

  note.className = 'owner-note';
  note.innerHTML = 'Checking ' + esc(name) + '…';
  show(note, true);

  try {
    const h = await getHub();
    const repo = { type: state.repoType, name };

    // Access first: better to hear it now than after a long upload.
    let writable = true;
    try {
      const access = await h.checkRepoAccess({ repo, accessToken: state.token });
      writable = !(access && access.writeAccess === false);
    } catch (e) {
      writable = false;
    }
    if (!writable) {
      note.className = 'owner-note blocked';
      note.innerHTML = '<strong>You cannot write to this repository.</strong> ' +
        'Your token has no write access to it — ask an admin, or choose another.';
      state.target = { name: name, writable: false, maintainers: [], mine: false };
      refresh();
      return;
    }

    let maintainers = [];
    let existing = '';
    try {
      existing = await (await h.downloadFile({ repo, path: 'README.md',
                                               accessToken: state.token })).text();
      maintainers = parseMaintainers(existing);
    } catch (e) { /* no README, or not readable: treat as unclaimed */ }

    const mine = readsAsMine(maintainers);
    state.target = { name: name, writable: true, maintainers: maintainers, mine: mine,
                     readme: existing };
    // A repository that already documents itself keeps its README unless somebody
    // deliberately says otherwise.
    const box = $('f-write-readme');
    if (box) box.checked = !existing;

    if (!maintainers.length) {
      note.className = 'owner-note';
      note.innerHTML = '<strong>No maintainer is recorded</strong> for this repository. ' +
        'Uploading adds you to its README, so the next person can see who to ask.';
    } else if (mine) {
      note.className = 'owner-note';
      note.innerHTML = 'Maintained by <strong>' + esc(maintainers.join(', ')) +
        '</strong> — including you.';
    } else {
      note.className = 'owner-note theirs';
      note.innerHTML = '<strong>This is not your repository.</strong> Maintained by ' +
        esc(maintainers.join(', ')) + '. You can still add to it — type the name below ' +
        'to confirm, and your commit will say it was you.';
      $('confirm-name').textContent = name;
      $('f-confirm').value = '';
      show($('confirm-row'), true);
    }
  } catch (e) {
    note.className = 'owner-note';
    note.innerHTML = 'Could not check this repository. ' +
      esc((e && e.message) || 'The upload will still say who you are.');
  }
  refresh();
}

/* ── files ──────────────────────────────────────────────────────────────── */
/* Nothing here belongs in a repository, and every one of these arrived in a real
   upload or is one directory away from doing so. */
const JUNK = [
  /(^|\/)__pycache__\//, /\.py[co]$/, /(^|\/)\.git\//, /(^|\/)\.svn\//,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/,
  /(^|\/)node_modules\//, /(^|\/)\.ipynb_checkpoints\//, /\.egg-info\//,
  /(^|\/)\.venv\//, /(^|\/)venv\//, /(^|\/)\.mypy_cache\//,
  /(^|\/)\.pytest_cache\//, /(^|\/)\.terraform\//, /(^|\/)\.next\//,
];

/* These are refused outright rather than filtered: a token pushed to a public
   repository is not a tidiness problem. */
const SECRETS = [
  /(^|\/)\.env($|\.)/, /\.pem$/, /\.key$/, /(^|\/)id_[a-z]*rsa$/,
  /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/, /(^|\/)credentials(\.json)?$/,
  /(^|\/)service[-_]account.*\.json$/, /(^|\/)\.aws\//,
];

function matchesAny(path, patterns) {
  return patterns.some((re) => re.test(path));
}

/** The single folder every path in a batch starts with, if there is one.
 *  Picking a folder gives every file that folder's name as a prefix, and what
 *  people mean is almost always "put what is inside it at the root". */
function commonRoot(paths) {
  const withFolder = paths.filter((p) => p.indexOf('/') !== -1);
  if (!withFolder.length || withFolder.length !== paths.length) return '';
  const first = withFolder[0].slice(0, withFolder[0].indexOf('/'));
  return withFolder.every((p) => p.slice(0, p.indexOf('/')) === first) ? first : '';
}

function addFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;

  const secrets = [];
  const junk = [];
  const keep = [];
  arr.forEach((file) => {
    const path = file.webkitRelativePath || file.name;
    if (matchesAny(path, SECRETS)) secrets.push(path);
    else if (matchesAny(path, JUNK)) junk.push(path);
    else keep.push({ file: file, base: path });
  });

  state.skipped = junk;
  state.refused = secrets;

  if (junk.length) {
    issue('info', junk.length + ' build artefact(s) not staged: ' +
                  junk.slice(0, 4).join(', ') + (junk.length > 4 ? ', …' : ''));
  }
  if (secrets.length) {
    issue('error', 'Refused as secrets, not staged: ' + secrets.join(', '));
  }

  const root = commonRoot(keep.map((k) => k.base));
  if (root) {
    state.root = root;
    issue('warn', 'Staged the contents of ' + root + '/ — the folder itself is not ' +
                  'part of the path. Use "Keep the folder" if that was wrong.');
  }

  keep.forEach((k) => {
    state.files.push({
      id: 'f' + Date.now() + Math.random().toString(36).slice(2, 7),
      base: k.base,
      path: pathFor(k.base),
      size: k.file.size,
      isLarge: k.file.size > LFS_BYTES,
      file: k.file,
    });
  });
  refresh();
}

/** Where a file lands, given whether the picked folder is being kept. */
function pathFor(base) {
  if (!state.root || state.keepRoot) return base;
  const prefix = state.root + '/';
  return base.indexOf(prefix) === 0 ? base.slice(prefix.length) : base;
}

function restage() {
  state.files.forEach((f) => { f.path = pathFor(f.base || f.path); });
  refresh();
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  refresh();
}

function exampleFiles() {
  state.root = '';
  addFiles([
    new File(['# Example dataset\n\nSample files staged by Hub uploader.\n'],
             'NOTES.md', { type: 'text/markdown' }),
    new File([JSON.stringify({ generated_by: 'Hub uploader', version: '1.0.0' }, null, 2)],
             'config.json', { type: 'application/json' }),
    new File(['id,value\n1,0.42\n2,0.87\n3,0.13\n'], 'sample.csv', { type: 'text/csv' }),
  ]);
}

/* ── checks and README ──────────────────────────────────────────────────── */
function checks() {
  if (!state.files.length) return [];
  const out = [];
  const pass = (label) => ({ level: 'pass', icon: 'check-circle-fill', label });
  const warn = (label) => ({ level: 'warn', icon: 'exclamation-triangle-fill', label });
  const fail = (label) => ({ level: 'fail', icon: 'x-circle-fill', label });

  const t = target();
  out.push(t ? pass('Repository target set — ' + fullName()) : fail('Choose or name a repository'));

  // Ownership, when updating something that already exists.
  if (state.repoMode === 'update' && state.target) {
    const info = state.target;
    if (!info.writable) {
      out.push(fail('You cannot write to ' + info.name));
    } else if (!info.maintainers.length) {
      out.push(pass('No maintainer recorded — you will be added'));
    } else if (info.mine) {
      out.push(pass('You maintain this repository'));
    } else if (confirmedTarget()) {
      out.push(warn('Not your repository — confirmed by name'));
    } else {
      out.push(fail('Not your repository — type its name to confirm'));
    }
  }

  const odd = state.files.filter((f) => !/^[\w\-. /]+$/.test(f.path));
  out.push(odd.length ? warn(odd.length + ' file name(s) may need cleanup')
                      : pass('File names are valid'));

  const big = state.files.filter((f) => f.isLarge);
  out.push(big.length ? warn(big.length + ' file(s) will upload via git LFS')
                      : pass('No files require git LFS'));

  // A Space that cannot build is worse than one that was never created, so the
  // entry point its SDK needs is checked here rather than discovered on the Hub.
  if (state.repoType === 'space') {
    const sdk = val('f-sdk');
    const spec = SPACE_ENTRY[sdk] || SPACE_ENTRY.gradio;
    const entry = spaceEntry();
    if (entry) {
      out.push(pass('Space entry point — ' + entry));
    } else if (state.files.length) {
      out.push(fail('This ' + sdk + ' Space needs ' + spec.wants + ' — none staged'));
    }
    if (state.repoMode === 'update' && existingReadme() &&
        !/^sdk:/m.test(existingReadme())) {
      out.push(warn('This Space has no configuration in its README — it will not ' +
                    'build until one is added'));
    }
  }

  const existing = existingReadme();
  if (!willWriteReadme()) {
    out.push(pass(existing ? 'Existing README.md left untouched'
                           : 'No README.md will be written'));
  } else if (existing) {
    out.push(warn('README.md front matter updated — its text is kept'));
  } else {
    out.push(val('f-desc').trim() ? pass('Repository card has a description')
                                  : warn('Add a short description for the README'));
    out.push(pass('README.md will be generated'));
  }
  if (state.refused.length) {
    out.push(fail(state.refused.length + ' file(s) refused as secrets — they are not staged'));
  }
  return out;
}

/** Typing the repository name is what turns "somebody else's" into a deliberate
 *  act rather than a mis-click in a list of sixty. */
/** The list to write: whoever was there, plus you. */
function maintainerList() {
  const me = (state.name || (state.whoami && (state.whoami.fullname || state.whoami.name)) || '').trim();
  const existing = (state.repoMode === 'update' && state.target)
    ? state.target.maintainers.slice() : [];
  if (me && !readsAsMine(existing.length ? existing : [])) existing.push(me);
  else if (me && !existing.length) existing.push(me);
  return existing;
}

function confirmedTarget() {
  const info = state.target;
  if (!info || info.mine || !info.maintainers.length) return true;
  const typed = val('f-confirm').trim();
  return typed === info.name || typed === info.name.split('/').pop();
}

/** Does the repository we are updating already have a README? */
function existingReadme() {
  return (state.repoMode === 'update' && state.target && state.target.readme) || '';
}

/** Whether a README will be written at all. Off by default when one exists: the
 *  Space this rule comes from had its title, emoji, sdk, sdk_version and app_file in
 *  that file, and replacing it changed what the Hub builds. */
function willWriteReadme() {
  const box = $('f-write-readme');
  return box ? box.checked : true;
}

/** Merge into an existing README instead of replacing it: keep every front-matter
 *  key it already has, refresh only `maintainers:`, and leave the prose alone. We
 *  do not rewrite words we did not write. */
function mergedReadme(existing) {
  // Deliberately tight: \s* after the closing --- swallows the blank line that
  // follows it, and the body has to come back byte for byte.
  const front = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(existing);
  const maintainers = maintainerList();
  const block = maintainers.length
    ? 'maintainers:\n' + maintainers.map((m) => '  - ' + m).join('\n') + '\n'
    : '';

  if (!front) {
    // No front matter at all: add one and keep the body untouched.
    return block ? '---\n' + block + '---\n\n' + existing : existing;
  }

  // Drop any maintainers block, keep every other line exactly as it was.
  const lines = front[1].split('\n');
  const kept = [];
  let inList = false;
  lines.forEach((line) => {
    if (/^maintainers:/.test(line)) { inList = true; return; }
    if (inList && /^\s+-\s/.test(line)) return;
    inList = false;
    kept.push(line);
  });
  const head = kept.join('\n').replace(/\n+$/, '');
  return '---\n' + (head ? head + '\n' : '') + block + '---\n' +
         existing.slice(front[0].length);
}

/* What each SDK needs at the root of the repository. The Hub decides whether a Space
 * builds from these, so the app should be the one to notice they are missing. */
const SPACE_ENTRY = {
  gradio: { field: 'app_file', names: ['app.py', 'main.py', 'gradio_app.py'],
            wants: 'a Python entry point (app.py)' },
  streamlit: { field: 'app_file', names: ['streamlit_app.py', 'app.py', 'main.py'],
               wants: 'a Python entry point (streamlit_app.py or app.py)' },
  static: { field: null, names: ['index.html'], wants: 'index.html at the root' },
  docker: { field: null, names: ['Dockerfile'], wants: 'a Dockerfile at the root' },
};

/** The staged file that serves as the Space's entry point, if one was staged. Root
 *  level only: the Hub does not look in subdirectories for it. */
function spaceEntry() {
  const spec = SPACE_ENTRY[val('f-sdk')] || SPACE_ENTRY.gradio;
  const root = state.files.map((f) => f.path).filter((p) => p.indexOf('/') === -1);
  for (const name of spec.names) {
    if (root.indexOf(name) !== -1) return name;
  }
  // Any single root-level .py is a better guess than nothing for the Python SDKs.
  if (spec.field === 'app_file') {
    const py = root.filter((p) => /\.py$/.test(p));
    if (py.length === 1) return py[0];
  }
  return '';
}

/** Title from the repository name: "yield_forest_test" reads better as
 *  "Yield forest test" on a Space card, and the Hub shows this verbatim. */
function spaceTitle(name) {
  const words = String(name || 'Untitled').replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readme() {
  const existing = existingReadme();
  if (existing) return mergedReadme(existing);
  const name = state.repoMode === 'create' ? target() : target().split('/').pop();
  let front = '---\n';
  if (state.repoMode === 'create') {
    const license = val('f-license');
    if (license) front += 'license: ' + license + '\n';
  }
  if (state.tags.length) front += 'tags:\n' + state.tags.map((t) => '  - ' + t).join('\n') + '\n';

  // A Space is configured by this block. Missing any of it and the Hub answers
  // "Configuration error -- Missing configuration in README" instead of building.
  if (state.repoType === 'space') {
    const sdk = val('f-sdk');
    const spec = SPACE_ENTRY[sdk] || SPACE_ENTRY.gradio;
    front += 'title: ' + spaceTitle(name) + '\n';
    front += 'emoji: 💧\n';
    front += 'colorFrom: blue\n';
    front += 'colorTo: green\n';
    front += 'sdk: ' + sdk + '\n';
    if (spec.field) {
      const entry = spaceEntry();
      if (entry) front += spec.field + ': ' + entry + '\n';
    }
    front += 'pinned: false\n';
  }
  // Who to ask about this repository, kept in the repository itself. Existing
  // maintainers are never dropped -- adding files does not take a repository over.
  const maintainers = maintainerList();
  if (maintainers.length) {
    front += 'maintainers:\n' + maintainers.map((m) => '  - ' + m).join('\n') + '\n';
  }
  front += '---\n\n';

  let body = '# ' + (name || 'untitled-repository') + '\n\n';
  body += (val('f-desc').trim() || '_No description yet._') + '\n\n';
  if (state.name) body += 'Uploaded by ' + state.name + ' via the IWMI Hub uploader.\n\n';
  if (state.files.length) {
    body += '## Files\n\n' + state.files.map((f) => '- `' + f.path + '`').join('\n') + '\n';
  }
  return front + body;
}

/* ── rendering ──────────────────────────────────────────────────────────── */
function refresh() {
  const files = state.files;
  const has = files.length > 0;

  $('file-count').textContent = has ? '(' + files.length + ')' : '';
  show($('files-empty'), !has);
  show($('clear-files'), has);
  $('file-list').innerHTML = files.map((f) =>
    '<div class="file">' + icon('file-earmark') +
    '<div class="file-name" title="' + esc(f.path) + '">' + esc(f.path) + '</div>' +
    '<span class="file-size">' + bytes(f.size) + '</span>' +
    (f.isLarge ? '<span class="tag-lfs">LFS</span>' : '') +
    '<button class="x-btn" data-remove="' + f.id + '" aria-label="Remove ' + esc(f.path) + '">' +
    icon('x-lg') + '</button></div>').join('');

  const list = checks();
  show($('checks-empty'), !list.length);
  $('check-list').innerHTML = list.map((c) =>
    '<div class="check ' + c.level + '">' + icon(c.icon) + '<span>' + esc(c.label) + '</span></div>'
  ).join('');

  // The README panel says what will actually happen to the file.
  const existing = existingReadme();
  const writing = willWriteReadme();
  const choice = $('readme-choice');
  if (choice) {
    choice.textContent = existing
      ? 'Update README.md (it already has one)'
      : 'Write README.md';
  }
  if (!writing) {
    show($('readme-empty'), true);
    show($('readme-out'), false);
    $('readme-empty').textContent = existing
      ? 'Leaving the existing README.md untouched.'
      : 'No README.md will be written.';
  } else if (!has) {
    show($('readme-empty'), true);
    show($('readme-out'), false);
    $('readme-empty').textContent =
      'Nothing staged yet. Add files to see the generated README.';
  } else {
    show($('readme-empty'), false);
    show($('readme-out'), true);
    $('readme-out').textContent = existing
      ? readme() + '\n\n' +
        '[the rest of the existing README is kept exactly as it is]'
      : readme();
  }

  // What was dropped on the way in.
  const rootNote = $('root-note');
  if (state.root && state.files.length) {
    rootNote.innerHTML = (state.keepRoot
      ? 'Keeping the folder: files land under <code>' + esc(state.root) + '/</code>.'
      : 'Uploading the <strong>contents</strong> of <code>' + esc(state.root) +
        '/</code> — the folder itself is not part of the path.') +
      '<button class="btn-quiet" id="root-toggle">' +
      (state.keepRoot ? 'Drop the folder' : 'Keep the folder') + '</button>';
    show(rootNote, true);
  } else {
    show(rootNote, false);
  }

  const skipNote = $('skip-note');
  if (state.skipped.length) {
    skipNote.innerHTML = state.skipped.length + ' build artefact(s) skipped — ' +
      esc(state.skipped.slice(0, 3).join(', ')) +
      (state.skipped.length > 3 ? ', …' : '');
    show(skipNote, true);
  } else {
    show(skipNote, false);
  }

  const secretNote = $('secret-note');
  if (state.refused.length) {
    secretNote.innerHTML = '<strong>Not staged — these look like secrets:</strong> ' +
      esc(state.refused.join(', ')) + '. Remove them from the folder if you need them here.';
    show(secretNote, true);
  } else {
    show(secretNote, false);
  }

  $('tag-list').innerHTML = state.tags.map((t, i) =>
    '<span class="tag">' + esc(t) +
    '<button data-tag="' + i + '" aria-label="Remove tag ' + esc(t) + '">' + icon('x') + '</button></span>'
  ).join('');

  show($('log-card'), state.logLines.length > 0);
  $('log-lines').innerHTML = state.logLines.map((l) => '<div>' + esc(l) + '</div>').join('');

  const blocked = state.repoMode === 'update' && state.target &&
                  (state.target.writable === false || !confirmedTarget());
  const ready = has && !!target() && !blocked;
  $('upload-btn').disabled = !ready;
  $('upload-hint').textContent = !has ? 'Add files to enable upload.'
    : !target() ? 'Choose or name a repository first.'
    : (state.target && state.target.writable === false)
      ? 'You cannot write to ' + state.target.name + '.'
    : blocked ? 'Type the repository name to confirm this is deliberate.'
    : files.length + ' file(s) staged, ready to upload.';
}

function renderHistory() {
  const rows = state.history;
  show($('history-empty'), !rows.length);
  $('history-list').innerHTML = rows.map((h, index) => {
    const issues = h.issues || [];
    const notable = issues.filter((i) => i.level !== 'info').length;
    return '<div class="row-card' + (issues.length ? ' has-log' : '') +
      '" data-row="' + index + '"' +
      (issues.length ? ' title="Show what this upload did"' : '') + '>' +
      icon(h.type === 'dataset' ? 'database-fill'
           : h.type === 'space' ? 'rocket-takeoff-fill' : 'box-seam', 'ic-lead') +
      '<div class="row-main"><a href="' + esc(h.url) + '" target="_blank" rel="noopener">' +
      esc(h.repo) + '</a><div class="row-sub">' + esc(h.message) + ' · ' +
      h.files + ' file(s)</div></div>' +
      '<span class="row-when">' + ago(h.time) + '</span>' +
      (notable ? '<span class="row-count">' + notable + ' to note</span>' : '') +
      '<span class="badge done">Complete</span>' +
      (issues.length
        ? '<div class="row-open"><div class="issues" style="margin:0">' +
          issues.map((i) => '<div class="issue ' + i.level + '">' +
            icon(ISSUE_ICON[i.level] || 'file-earmark') + '<span>' + esc(i.text) +
            '</span></div>').join('') + '</div></div>'
        : '') +
      '</div>';
  }).join('');
}

async function loadProjects() {
  show($('projects-loading'), true);
  show($('projects-error'), false);
  show($('projects-empty'), false);
  $('projects-list').innerHTML = '';
  try {
    const h = await getHub();
    const kinds = [
      ['model', h.listModels, 'box-seam', 'Model'],
      ['dataset', h.listDatasets, 'database-fill', 'Dataset'],
      ['space', h.listSpaces, 'rocket-takeoff-fill', 'Space'],
    ];
    const all = [];
    for (const [type, fn, ico, label] of kinds) {
      try {
        let n = 0;
        for await (const repo of fn({ search: { owner: ORG }, accessToken: state.token })) {
          const path = repo.name || repo.id;
          const prefix = type === 'model' ? '' : type + 's/';
          all.push({
            id: path, type, icon: ico, label,
            url: 'https://huggingface.co/' + prefix + path,
            // The Hub calls it updatedAt on list entries; lastModified is what a
            // single-repo lookup returns. Reading only the latter showed "—" on
            // every card.
            when: repo.updatedAt || repo.lastModified || '',
            private: !!repo.private,
          });
          if (++n >= 15) break;
        }
      } catch (e) { /* one kind failing should not empty the page */ }
    }
    all.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
    state.projects = all;
    show($('projects-loading'), false);
    renderProjects();
  } catch (e) {
    show($('projects-loading'), false);
    $('projects-error').textContent = 'Could not load IWMIHQ projects. ' +
      ((e && e.message) ? e.message : '');
    show($('projects-error'), true);
  }
}

/** Filtering happens here rather than at the Hub: the whole list is already in
 *  memory, so a keystroke costs nothing, works offline, and does not rate-limit.
 *  A query matches the repository path or its kind, so "space" and "water" both
 *  narrow usefully. */
function matches(project, query) {
  if (!query) return true;
  const haystack = (project.id + ' ' + project.label +
                    (project.private ? ' private' : ' public')).toLowerCase();
  // Every word must appear: "water kenya" should find one repository, not fifteen.
  return query.split(/\s+/).filter(Boolean).every((word) => haystack.indexOf(word) !== -1);
}

function renderProjects() {
  const query = state.search.trim().toLowerCase();
  const all = state.projects;
  const shown = all.filter((p) => matches(p, query));

  show($('search-clear'), !!state.search);
  $('projects-count').textContent = !all.length ? ''
    : query ? shown.length + ' of ' + all.length + ' shown'
    : all.length + ' project' + (all.length === 1 ? '' : 's');

  show($('projects-empty'), all.length === 0);
  show($('projects-nomatch'), all.length > 0 && shown.length === 0);

  $('projects-list').innerHTML = shown.map((p) =>
    '<a class="proj" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
    '<div class="proj-head"><span class="badge ' + p.type + '">' + icon(p.icon) + p.label + '</span>' +
    (p.private ? '<span class="badge private" title="Private">' + icon('lock-fill') + 'Private</span>' : '') +
    icon('box-arrow-up-right') + '</div>' +
    '<div class="proj-id" title="' + esc(p.id) + '">' + esc(p.id) + '</div>' +
    '<div class="proj-when">Updated ' + (p.when ? ago(p.when) : '—') + '</div></a>').join('');
}

/* ── upload ─────────────────────────────────────────────────────────────── */
/* Every decision worth questioning later. `level` is one of info, warn, error --
 * the same three the pre-flight checks use, so the vocabulary does not change
 * between before and after. */
function issue(level, text) {
  state.issues.push({ level: level, text: text });
  log((level === 'info' ? '' : level.toUpperCase() + ': ') + text);
  paintLogBadge();
}

// A grey tick beside "not staged" reads as a pass; a dash reads as what it is.
const ISSUE_ICON = { info: 'dash-lg', warn: 'exclamation-triangle-fill',
                     error: 'x-circle-fill' };

function renderIssues(into, issues) {
  const el = $(into);
  if (!el) return;
  if (!issues || !issues.length) { show(el, false); return; }
  el.innerHTML = issues.map((i) =>
    '<div class="issue ' + i.level + '">' + icon(ISSUE_ICON[i.level] || 'file-earmark') +
    '<span>' + esc(i.text) + '</span></div>').join('');
  show(el, true);
}

/** Anything a person should look at, as opposed to a note they can ignore. */
function notableIssues() {
  return state.issues.filter((i) => i.level !== 'info');
}

/** Mark the button when something worth reading has happened. */
function paintLogBadge() {
  const notable = notableIssues().length;
  show($('log-dot'), notable > 0);
  const menuDot = $('menu-log-dot');
  if (menuDot) menuDot.style.visibility = notable ? 'visible' : 'hidden';
  const button = $('log-btn');
  if (button) {
    button.title = notable
      ? 'Activity log — ' + notable + ' thing(s) to note'
      : 'Activity log';
  }
}

function openLog() {
  renderIssues('log-issues', state.issues);
  show($('log-empty'), !state.issues.length && !state.logLines.length);
  const transcript = $('log-transcript');
  if (state.logLines.length) {
    transcript.innerHTML = state.logLines.map((l) => '<div>' + esc(l) + '</div>').join('');
    show(transcript, true);
  } else {
    show(transcript, false);
  }
  $('log-scope').textContent = state.lastRepo
    ? 'The last upload was to ' + state.lastRepo.name + '.'
    : 'What this app has done since you opened it.';
  openModal('modal-log');
}

function clearLog() {
  state.issues = [];
  state.logLines = [];
  paintLogBadge();
  refresh();
  openLog();
  toast('Log cleared.');
}

/** Strip anything shaped like an access token. A report is going somewhere public,
 *  and while the app never logs the token itself, a Hub error message is not ours to
 *  vouch for. */
function scrub(text) {
  return String(text).replace(/\bhf_[A-Za-z0-9]{6,}/g, 'hf_[removed]');
}

/** What the report will say, so the person can read it before it goes. */
function reportBody() {
  const said = val('f-report').trim();
  const parts = ['### What happened', '', said || '_(not described)_', ''];

  if ($('f-report-log') && $('f-report-log').checked) {
    parts.push('### Context', '');
    parts.push('| | |', '| --- | --- |');
    parts.push('| app | Hub uploader v1.0.0 (' +
               (isStandalone() ? 'installed' : 'in browser') + ') |');
    parts.push('| appearance | ' + activeTheme() +
               (chosenTheme() ? '' : ' (from the system)') + ' |');
    parts.push('| target | ' + (fullName() || state.repoMode + ', none chosen') + ' |');
    parts.push('| staged | ' + state.files.length + ' file(s)' +
               (state.root ? ' from ' + state.root + '/' : '') + ' |');
    parts.push('| window | ' + window.innerWidth + '×' + window.innerHeight + ' |');
    parts.push('| browser | ' + (navigator.userAgent || '—') + ' |');
    parts.push('');

    if (state.issues.length) {
      parts.push('### What the app reported', '');
      state.issues.forEach((i) => parts.push('- **' + i.level + '** ' + i.text));
      parts.push('');
    }
    if (state.logLines.length) {
      parts.push('### Log', '', '```', ...state.logLines, '```', '');
    }
  }

  let body = scrub(parts.join('\n'));
  if (body.length > REPORT_LIMIT) {
    body = body.slice(0, REPORT_LIMIT) +
           '\n\n_(cut here — the full log is on the reporter\'s clipboard if needed)_\n';
  }
  return body;
}

function reportTitle() {
  const said = val('f-report').trim().split('\n')[0];
  const where = state.lastRepo ? ' (' + state.lastRepo.name + ')' : '';
  return 'Hub uploader: ' + (said ? said.slice(0, 70) : 'a problem') + where;
}

function refreshReport() {
  const body = reportBody();
  $('report-preview').textContent = body;
  $('report-github').href = ISSUES_URL +
    '?labels=bug&title=' + encodeURIComponent(reportTitle()) +
    '&body=' + encodeURIComponent(body);
  $('report-email').href = 'mailto:' + CONTACT_EMAIL +
    '?subject=' + encodeURIComponent(reportTitle()) +
    '&body=' + encodeURIComponent(body);
}

function openReport() {
  refreshReport();
  openModal('modal-report');
  const box = $('f-report');
  if (box) box.focus();
}

/** The log as text, for pasting into a message to whoever can help. */
function logText() {
  const head = ['Hub uploader log',
                'repo: ' + (state.lastRepo ? state.lastRepo.name : fullName() || '—'),
                'by:   ' + (state.name || '—'),
                'when: ' + new Date().toISOString(), ''];
  const issues = state.issues.map((i) => '[' + i.level + '] ' + i.text);
  return head.concat(issues, [''], ['transcript:'], state.logLines).join('\n');
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText());
    toast('Log copied.');
  } catch (e) {
    // Clipboard blocked (an insecure origin, usually). Show it instead of failing.
    window.prompt('Copy the log:', logText());
  }
}

function log(line) {
  state.logLines.push(line);
  $('log-lines').innerHTML = state.logLines.map((l) => '<div>' + esc(l) + '</div>').join('');
  show($('log-card'), true);
  $('mini-log').innerHTML = state.logLines.slice(-12).map((l) => '<div>' + esc(l) + '</div>').join('');
  const mini = $('mini-log');
  mini.scrollTop = mini.scrollHeight;
}

function progress(pct) {
  $('upload-bar').style.width = pct + '%';
  $('upload-pct').textContent = pct + '%';
}

function uploadState(which) {
  show($('state-uploading'), which === 'uploading');
  show($('state-success'), which === 'success');
  show($('state-failed'), which === 'failed');
  show($('modal-upload'), true);
}

async function upload() {
  const name = fullName();
  if (!state.files.length || !name) return;
  const commit = val('f-commit').trim() ||
    ('Add files via Hub uploader' + (state.name ? ' (' + state.name + ')' : ''));

  // Staging issues are kept; the transcript starts fresh.
  state.logLines = [];
  state.issues = state.issues.filter((i) => i.stage !== 'upload');
  uploadState('uploading');
  progress(4);
  log('Preparing ' + state.files.length + ' file(s)…');

  const existing = existingReadme();
  if (!willWriteReadme()) {
    issue('info', existing ? 'Left the existing README.md untouched.'
                           : 'No README.md was written.');
  } else if (existing) {
    issue('warn', 'Updated README.md front matter (maintainers); its text was kept.');
  } else if (state.repoType === 'space') {
    const entry = spaceEntry();
    issue('info', 'Generated README.md with the Space configuration (' + val('f-sdk') +
                  (entry ? ', ' + entry : '') + ').');
  } else {
    issue('info', 'Generated README.md.');
  }
  const big = state.files.filter((f) => f.isLarge);
  if (big.length) {
    issue('info', big.length + ' file(s) over 10 MB uploaded via git LFS.');
  }
  if (state.repoMode === 'update' && state.target && !state.target.mine &&
      state.target.maintainers.length) {
    issue('warn', 'Added to a repository maintained by ' +
                  state.target.maintainers.join(', ') + '.');
  }

  try {
    const h = await getHub();
    const repo = { type: state.repoType, name };

    if (state.repoMode === 'create') {
      log('Creating ' + state.repoType + ' repository ' + name + '…');
      try {
        await h.createRepo({
          repo, accessToken: state.token,
          license: val('f-license') || undefined,
          private: state.visibility === 'private',
          sdk: state.repoType === 'space' ? val('f-sdk') : undefined,
        });
        log('Repository created.');
      } catch (e) {
        // Already there is not a failure: the intent was "put these files in it".
        if (/exist/i.test(e && e.message ? e.message : '')) log('Repository already exists — updating it.');
        else throw e;
      }
    }

    progress(18);
    const files = state.files.map((f) => ({ path: f.path, content: f.file }));
    if (willWriteReadme()) {
      files.unshift({ path: 'README.md',
                      content: new Blob([readme()], { type: 'text/markdown' }) });
    }
    log('Uploading ' + files.length + ' file(s) via the commit API…');

    let seen = 0;
    try {
      const events = await h.uploadFilesWithProgress({
        repo, accessToken: state.token, files, commitTitle: commit,
      });
      for await (const ev of events) {
        seen++;
        progress(Math.min(96, 18 + Math.round((seen / (files.length * 3)) * 78)));
      }
    } catch (e) {
      // The progress API is newer than the plain one; fall back rather than fail.
      log('Falling back to a plain commit…');
      await h.uploadFiles({ repo, accessToken: state.token, files, commitTitle: commit });
    }

    progress(100);
    log('Upload complete.');

    const prefix = state.repoType === 'model' ? '' : state.repoType + 's/';
    const url = 'https://huggingface.co/' + prefix + name;
    state.lastRepo = { name, url };
    state.history.unshift({
      repo: name, url, type: state.repoType, message: commit,
      files: files.length, time: new Date().toISOString(),
      issues: state.issues.slice(),
    });
    state.history = state.history.slice(0, 25);
    store(KEY.history, JSON.stringify(state.history));

    $('done-repo').textContent = name;
    $('done-link').href = url;
    issue('info', 'Committed ' + files.length + ' file(s).');
    renderIssues('done-issues', state.issues);
    uploadState('success');
    renderHistory();
    loadProjects();
  } catch (e) {
    const why = (e && e.message) ? e.message
      : 'The upload failed. Check your token and try again.';
    issue('error', why);
    $('fail-why').textContent = why;
    renderIssues('fail-issues', state.issues);
    uploadState('failed');
  }
}

function uploadAnother() {
  state.files = [];
  state.root = '';
  state.skipped = [];
  state.refused = [];
  state.issues = [];
  state.tags = [];
  state.logLines = [];
  $('f-repo').value = '';
  $('f-desc').value = '';
  closeModals();
  refresh();
}

function clearSearch() {
  state.search = '';
  $('f-search').value = '';
  renderProjects();
  $('f-search').focus();
}

/* ── github import ──────────────────────────────────────────────────────── */
async function importGithub() {
  const raw = val('f-github').trim()
    .replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const parts = raw.split('/').filter(Boolean);
  const error = $('github-error');
  show(error, false);
  if (parts.length < 2) {
    error.textContent = 'Enter a repository as owner/repo.';
    show(error, true);
    return;
  }
  const [owner, name] = parts;
  const button = $('import-btn');
  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    const info = await fetch('https://api.github.com/repos/' + owner + '/' + name)
      .then((r) => { if (!r.ok) throw new Error('Repository not found.'); return r.json(); });
    const branch = info.default_branch || 'main';
    const treeRes = await fetch('https://api.github.com/repos/' + owner + '/' + name +
                                '/git/trees/' + branch + '?recursive=1');
    if (!treeRes.ok) throw new Error('Could not read repository contents.');
    const tree = await treeRes.json();
    const blobs = (tree.tree || [])
      .filter((t) => t.type === 'blob' && t.size && t.size < 5 * 1024 * 1024)
      .slice(0, 25);
    const staged = [];
    for (const blob of blobs) {
      const res = await fetch('https://raw.githubusercontent.com/' + owner + '/' + name +
                              '/' + branch + '/' + blob.path);
      if (!res.ok) continue;
      const file = new File([await res.blob()], blob.path.split('/').pop(), {});
      Object.defineProperty(file, 'webkitRelativePath', { value: blob.path });
      staged.push(file);
    }
    addFiles(staged);
    closeModals();
    toast('Imported ' + staged.length + ' file(s) from ' + owner + '/' + name + '.');
  } catch (e) {
    error.textContent = (e && e.message) ? e.message : 'Import failed.';
    show(error, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Import';
  }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */
function wire() {
  on($('connect-btn'), 'click', connect);
  on($('f-token'), 'keydown', (e) => { if (e.key === 'Enter') connect(); });
  on($('f-name'), 'keydown', (e) => { if (e.key === 'Enter') connect(); });

  document.querySelectorAll('.tabs button').forEach((b) =>
    on(b, 'click', () => setTab(b.dataset.tab)));

  on($('menu-btn'), 'click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.querySelectorAll('[data-menu-tab]').forEach((b) =>
    on(b, 'click', () => { setTab(b.dataset.menuTab); toggleMenu(false); }));
  on($('menu-help'), 'click', () => { toggleMenu(false); openModal('modal-help'); });
  on($('menu-settings'), 'click', () => { toggleMenu(false); openModal('modal-settings'); });
  // Clicking the appearance toggle inside the menu should not close it: you may
  // want to see what the other look does to the page behind.
  on($('menu'), 'click', (e) => { if (e.target.closest('.theme-toggle')) e.stopPropagation(); });
  on(document, 'click', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#menu-btn')) {
      toggleMenu(false);
    }
  });
  document.querySelectorAll('#repo-type button').forEach((b) =>
    on(b, 'click', () => setRepoType(b.dataset.type)));
  document.querySelectorAll('#repo-mode button').forEach((b) =>
    on(b, 'click', () => setRepoMode(b.dataset.mode)));
  document.querySelectorAll('#visibility button').forEach((b) =>
    on(b, 'click', () => setVisibility(b.dataset.vis)));

  document.querySelectorAll('.theme-toggle button').forEach((b) =>
    on(b, 'click', () => setTheme(b.dataset.look)));

  // With no explicit choice, follow the machine when it changes at dusk.
  try {
    const watch = window.matchMedia('(prefers-color-scheme: dark)');
    const react = () => { if (!chosenTheme()) paintTheme(); };
    if (watch.addEventListener) watch.addEventListener('change', react);
    else if (watch.addListener) watch.addListener(react);
  } catch (e) { /* older browser: the choice still works, it just will not follow */ }
  on($('log-btn'), 'click', openLog);
  on($('report-from-log'), 'click', openReport);
  on($('report-btn-2'), 'click', openReport);
  on($('menu-report'), 'click', () => { toggleMenu(false); openReport(); });
  on($('f-report'), 'input', refreshReport);
  on($('f-report-log'), 'change', refreshReport);
  on($('report-copy'), 'click', async () => {
    try {
      await navigator.clipboard.writeText(reportTitle() + '\n\n' + reportBody());
      toast('Report copied.');
    } catch (e) {
      window.prompt('Copy the report:', reportBody());
    }
  });
  on($('menu-log'), 'click', () => { toggleMenu(false); openLog(); });
  on($('copy-log-3'), 'click', copyLog);
  on($('clear-log'), 'click', clearLog);
  on($('help-btn'), 'click', () => openModal('modal-help'));
  on($('settings-btn'), 'click', () => openModal('modal-settings'));
  on($('github-btn'), 'click', () => { show($('github-error'), false); openModal('modal-github'); });
  // Two ways in: the bar, and Settings — which is the only one on a phone, where
  // the bar has no room for it.
  const install = () => {
    if (state.installEvent) {
      state.installEvent.prompt();
      state.installEvent.userChoice.then(() => {
        state.installEvent = null;
        $('install-btn').classList.remove('is-ready');
      });
    } else openModal('modal-install');
  };
  on($('install-btn'), 'click', install);
  on($('install-btn-2'), 'click', install);
  on($('menu-install'), 'click', () => { toggleMenu(false); install(); });
  document.querySelectorAll('[data-close]').forEach((b) => on(b, 'click', closeModals));
  document.querySelectorAll('.scrim').forEach((s) => on(s, 'click', (e) => {
    // Clicking the backdrop dismisses, except mid-upload where it would look
    // like a cancel and is not one.
    if (e.target === s && !(s.id === 'modal-upload' && !$('state-uploading').hidden)) closeModals();
  }));
  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('menu').hidden) { toggleMenu(false); $('menu-btn').focus(); return; }
    if (!$('modal-upload').hidden && $('state-uploading').hidden === false) return;
    closeModals();
  });

  on($('pick-files'), 'click', () => $('in-files').click());
  on($('pick-folder'), 'click', () => $('in-folder').click());
  on($('in-files'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  on($('in-folder'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  on($('example-btn'), 'click', exampleFiles);
  on($('clear-files'), 'click', () => {
    state.files = [];
    state.root = '';
    state.skipped = [];
    state.refused = [];
    state.issues = [];
    refresh();
  });
  on($('file-list'), 'click', () => {});
  // The root-folder toggle is rebuilt on every refresh, so the listener lives on
  // the note rather than the button.
  on($('root-note'), 'click', (e) => {
    if (!e.target.closest('#root-toggle')) return;
    state.keepRoot = !state.keepRoot;
    restage();
  });
  on($('f-write-readme'), 'change', refresh);

  const zone = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => on(zone, ev, (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  }));
  ['dragleave', 'dragend'].forEach((ev) => on(zone, ev, () => zone.classList.remove('is-over')));
  on(zone, 'drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });
  // A file dropped outside the zone would otherwise navigate the window away.
  ['dragover', 'drop'].forEach((ev) => on(document, ev, (e) => {
    if (!zone.contains(e.target)) e.preventDefault();
  }));

  on($('file-list'), 'click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) removeFile(b.dataset.remove);
  });
  on($('tag-list'), 'click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    state.tags.splice(parseInt(b.dataset.tag, 10), 1);
    refresh();
  });
  on($('f-tag'), 'keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = e.target.value.trim();
    if (t && state.tags.indexOf(t) === -1) state.tags.push(t);
    e.target.value = '';
    refresh();
  });

  // The README, checks and upload hint all read these, so they refresh as you
  // type — but nothing re-renders the field itself, so the caret stays put.
  ['f-repo', 'f-desc', 'f-license', 'f-existing', 'f-sdk', 'f-commit']
    .forEach((id) => on($(id), 'input', refresh));
  on($('f-existing'), 'change', inspectTarget);
  on($('f-confirm'), 'input', refresh);


  on($('f-search'), 'input', (e) => {
    state.search = e.target.value;
    renderProjects();
  });
  on($('f-search'), 'keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); }
  });
  on($('search-clear'), 'click', clearSearch);

  on($('upload-btn'), 'click', upload);
  on($('again-btn'), 'click', uploadAnother);
  on($('copy-log'), 'click', copyLog);
  on($('copy-log-2'), 'click', copyLog);
  on($('history-list'), 'click', (e) => {
    const row = e.target.closest('.row-card.has-log');
    // A link inside the row is still a link.
    if (!row || e.target.closest('a')) return;
    row.classList.toggle('is-open');
  });
  on($('back-btn'), 'click', closeModals);
  on($('import-btn'), 'click', importGithub);
  on($('f-github'), 'keydown', (e) => { if (e.key === 'Enter') importGithub(); });

  on($('save-settings'), 'click', () => {
    state.name = val('f-name-2').trim();
    store(KEY.name, state.name);
    closeModals();
    refresh();
    toast('Saved.');
  });
  on($('signout-btn'), 'click', signOut);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    $('install-btn').classList.add('is-ready');
  });

  // Leaving mid-upload loses the commit; leaving with files staged loses the queue.
  window.addEventListener('beforeunload', (e) => {
    const busy = !$('modal-upload').hidden && !$('state-uploading').hidden;
    if (!busy && !state.files.length) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function boot() {
  wire();
  paintTheme();
  paintLogBadge();

  state.name = read(KEY.name) || '';
  $('f-name').value = state.name;
  try { state.history = JSON.parse(read(KEY.history) || '[]'); } catch (e) { state.history = []; }

  const saved = read(KEY.token);
  if (saved) {
    state.token = saved;
    $('f-token').value = saved;
    enterApp();
    // Confirm the token still works, quietly. A revoked one should not first
    // surface as a failed upload.
    getHub()
      .then((h) => h.whoAmI({ accessToken: saved }))
      .then((who) => {
        state.whoami = who;
        $('who').textContent = who.fullname || who.name || state.name || '—';
      })
      .catch(() => toast('Your saved token no longer works. Sign out and paste a new one.'));
  }

  setTab('upload');
  refresh();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Read by the guard in index.html: reaching here means every handler is attached.
  window.__booted = true;
}

boot();
