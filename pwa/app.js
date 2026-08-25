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
const ORG = 'IWMIHQ';
const LFS_BYTES = 10 * 1024 * 1024;
const KEY = { token: 'hu_token', name: 'hu_name', history: 'hu_history' };

const state = {
  token: '',
  name: '',
  whoami: null,
  tab: 'upload',
  repoType: 'model',
  repoMode: 'create',
  visibility: 'public',
  files: [],
  tags: [],
  history: [],
  projects: [],
  search: '',
  logLines: [],
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

/* ── tabs and modals ────────────────────────────────────────────────────── */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  show($('tab-upload'), tab === 'upload');
  show($('tab-history'), tab === 'history');
  show($('tab-projects'), tab === 'projects');
  if (tab === 'projects' && !state.projects.length) loadProjects();
}

function openModal(id) {
  closeModals();
  show($(id), true);
}
function closeModals() {
  ['modal-help', 'modal-settings', 'modal-install', 'modal-github', 'modal-upload']
    .forEach((id) => show($(id), false));
}

/* ── destination ────────────────────────────────────────────────────────── */
function setRepoType(type) {
  state.repoType = type;
  document.querySelectorAll('#repo-type button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.type === type));
  });
  show($('sdk-row'), type === 'space');
  if (state.repoMode === 'update') loadExisting();
  refresh();
}

function setRepoMode(mode) {
  state.repoMode = mode;
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
    for await (const repo of list({ search: { owner: ORG }, accessToken: state.token })) {
      // `name` is the "IWMIHQ/thing" path; `id` is an internal hex string. Reading
      // id here filled this menu with hex and would have committed to a repository
      // that does not exist.
      found.push(repo.name || repo.id);
      if (found.length >= 60) break;
    }
    found.sort();
    select.innerHTML = '<option value="">' +
      (found.length ? 'Select a repository…' : 'No ' + state.repoType + 's found in ' + ORG) +
      '</option>' + found.map((id) => '<option value="' + esc(id) + '">' + esc(id) + '</option>').join('');
  } catch (e) {
    select.innerHTML = '<option value="">Could not list repositories</option>';
  }
  refresh();
}

/* ── files ──────────────────────────────────────────────────────────────── */
function addFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  arr.forEach((file) => {
    state.files.push({
      id: 'f' + Date.now() + Math.random().toString(36).slice(2, 7),
      path: file.webkitRelativePath || file.name,
      size: file.size,
      isLarge: file.size > LFS_BYTES,
      file: file,
    });
  });
  refresh();
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  refresh();
}

function exampleFiles() {
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

  const odd = state.files.filter((f) => !/^[\w\-. /]+$/.test(f.path));
  out.push(odd.length ? warn(odd.length + ' file name(s) may need cleanup')
                      : pass('File names are valid'));

  const big = state.files.filter((f) => f.isLarge);
  out.push(big.length ? warn(big.length + ' file(s) will upload via git LFS')
                      : pass('No files require git LFS'));

  out.push(val('f-desc').trim() ? pass('Repository card has a description')
                                : warn('Add a short description for the README'));
  out.push(pass('README.md will be generated automatically'));
  return out;
}

function readme() {
  const name = state.repoMode === 'create' ? target() : target().split('/').pop();
  let front = '---\n';
  if (state.repoMode === 'create') {
    const license = val('f-license');
    if (license) front += 'license: ' + license + '\n';
  }
  if (state.tags.length) front += 'tags:\n' + state.tags.map((t) => '  - ' + t).join('\n') + '\n';
  if (state.repoType === 'space') front += 'sdk: ' + val('f-sdk') + '\n';
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

  show($('readme-empty'), !has);
  show($('readme-out'), has);
  if (has) $('readme-out').textContent = readme();

  $('tag-list').innerHTML = state.tags.map((t, i) =>
    '<span class="tag">' + esc(t) +
    '<button data-tag="' + i + '" aria-label="Remove tag ' + esc(t) + '">' + icon('x') + '</button></span>'
  ).join('');

  show($('log-card'), state.logLines.length > 0);
  $('log-lines').innerHTML = state.logLines.map((l) => '<div>' + esc(l) + '</div>').join('');

  const ready = has && !!target();
  $('upload-btn').disabled = !ready;
  $('upload-hint').textContent = !has ? 'Add files to enable upload.'
    : !target() ? 'Choose or name a repository first.'
    : files.length + ' file(s) staged, ready to upload.';
}

function renderHistory() {
  const rows = state.history;
  show($('history-empty'), !rows.length);
  $('history-list').innerHTML = rows.map((h) =>
    '<div class="row-card">' +
    icon(h.type === 'dataset' ? 'database-fill' : h.type === 'space' ? 'rocket-takeoff-fill' : 'box-seam', 'ic-lead') +
    '<div class="row-main"><a href="' + esc(h.url) + '" target="_blank" rel="noopener">' +
    esc(h.repo) + '</a><div class="row-sub">' + esc(h.message) + ' · ' + h.files + ' file(s)</div></div>' +
    '<span class="row-when">' + ago(h.time) + '</span>' +
    '<span class="badge done">Complete</span></div>').join('');
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

  state.logLines = [];
  uploadState('uploading');
  progress(4);
  log('Preparing ' + (state.files.length + 1) + ' file(s)…');

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
    const files = [{ path: 'README.md', content: new Blob([readme()], { type: 'text/markdown' }) }]
      .concat(state.files.map((f) => ({ path: f.path, content: f.file })));
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
    });
    state.history = state.history.slice(0, 25);
    store(KEY.history, JSON.stringify(state.history));

    $('done-repo').textContent = name;
    $('done-link').href = url;
    uploadState('success');
    renderHistory();
    loadProjects();
  } catch (e) {
    const why = (e && e.message) ? e.message
      : 'The upload failed. Check your token and try again.';
    log('Error: ' + why);
    $('fail-why').textContent = why;
    uploadState('failed');
  }
}

function uploadAnother() {
  state.files = [];
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
  document.querySelectorAll('#repo-type button').forEach((b) =>
    on(b, 'click', () => setRepoType(b.dataset.type)));
  document.querySelectorAll('#repo-mode button').forEach((b) =>
    on(b, 'click', () => setRepoMode(b.dataset.mode)));
  document.querySelectorAll('#visibility button').forEach((b) =>
    on(b, 'click', () => setVisibility(b.dataset.vis)));

  on($('help-btn'), 'click', () => openModal('modal-help'));
  on($('settings-btn'), 'click', () => openModal('modal-settings'));
  on($('github-btn'), 'click', () => { show($('github-error'), false); openModal('modal-github'); });
  on($('install-btn'), 'click', () => {
    if (state.installEvent) {
      state.installEvent.prompt();
      state.installEvent.userChoice.then(() => {
        state.installEvent = null;
        $('install-btn').classList.remove('is-ready');
      });
    } else openModal('modal-install');
  });
  document.querySelectorAll('[data-close]').forEach((b) => on(b, 'click', closeModals));
  document.querySelectorAll('.scrim').forEach((s) => on(s, 'click', (e) => {
    // Clicking the backdrop dismisses, except mid-upload where it would look
    // like a cancel and is not one.
    if (e.target === s && !(s.id === 'modal-upload' && !$('state-uploading').hidden)) closeModals();
  }));
  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal-upload').hidden && $('state-uploading').hidden === false) return;
    closeModals();
  });

  on($('pick-files'), 'click', () => $('in-files').click());
  on($('pick-folder'), 'click', () => $('in-folder').click());
  on($('in-files'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  on($('in-folder'), 'change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  on($('example-btn'), 'click', exampleFiles);
  on($('clear-files'), 'click', () => { state.files = []; refresh(); });

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
  on($('f-existing'), 'change', refresh);

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
}

boot();
