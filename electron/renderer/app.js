"use strict";
const API = window.api.backendBase;
const $ = (id) => document.getElementById(id);
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const state = {
  view: "upload",
  userName: localStorage.getItem("hf_uploader_name") || "",
  repoType: "model",
  mode: "Create new",
  repoName: "",
  existingRepo: "",
  existingList: [],     // editable repos for the current user (own + unclaimed)
  visibility: "Public",
  license: "cc-by-4.0",
  sdk: "gradio",
  description: "",
  tags: "",
  commitMsg: "",
  files: [],            // {path, rel, size}
  closedFolders: {},
  history: [],
};

// ─────────────── window controls ───────────────
// In a browser there is no frameless window to control, so hide the chrome.
if (!window.api.isElectron) document.body.classList.add("web");
$("win-close").onclick = () => window.api.close();
$("win-min").onclick = () => window.api.minimize();
$("win-max").onclick = () => window.api.maximize();

// ─────────────── desktop ⇄ web link ───────────────
// The desktop app's own backend also serves the browser build at its base URL,
// so "Open in browser" hands the current context to that same server in the
// user's default browser — both then talk to one backend. Staged files (local
// paths) and any secret are deliberately never placed in the URL.
const INCOMING = (() => {
  const q = new URLSearchParams(location.search);
  return [...q.keys()].length ? q : null;
})();

const openWebBtn = $("open-web");
if (openWebBtn) openWebBtn.onclick = () => {
  const p = new URLSearchParams();
  p.set("view", state.view);
  p.set("repo_type", state.repoType);
  p.set("mode", state.mode);
  if (state.userName) p.set("name", state.userName);
  if (state.mode === "Create new") {
    if (state.repoName.trim()) p.set("repo_name", state.repoName.trim());
    p.set("visibility", state.visibility);
  } else if (state.existingRepo) {
    p.set("existing_repo", state.existingRepo);
    if (state.commitMsg.trim()) p.set("commit_msg", state.commitMsg.trim());
  }
  p.set("license", state.license);
  if (state.repoType === "space") p.set("sdk", state.sdk);
  if (state.description.trim()) p.set("description", state.description.trim());
  if (state.tags.trim()) p.set("tags", state.tags.trim());
  window.api.openExternal(`${API}/?${p.toString()}`);
};

function setSelectValue(sel, val) {
  const opt = Array.from(sel.options).find((o) => o.value === val);
  if (opt) sel.value = val;
}

// Apply context handed over from the desktop app (query params) once the main
// screen is shown. Files can't cross (a browser has no local paths); everything
// else is restored so you continue on the same repo and view.
async function applyIncoming(q) {
  const rt = q.get("repo_type");
  if (rt && ["model", "dataset", "space"].includes(rt) && rt !== state.repoType) {
    document.querySelectorAll("#repo-type .seg").forEach((x) => x.classList.remove("active"));
    document.querySelector(`#repo-type .seg[data-v='${rt}']`)?.classList.add("active");
    state.repoType = rt;
    $("sdk-wrap").classList.toggle("hidden", state.repoType !== "space");
    await refreshExisting();
  }
  const mode = q.get("mode");
  if (mode === "Update existing" || mode === "Create new") {
    document.querySelectorAll("#mode .seg").forEach((x) => x.classList.remove("active"));
    document.querySelector(`#mode .seg[data-v='${mode}']`)?.classList.add("active");
    state.mode = mode;
    $("new-fields").classList.toggle("hidden", state.mode !== "Create new");
    $("existing-fields").classList.toggle("hidden", state.mode !== "Update existing");
  }
  const set = (key, apply) => { const v = q.get(key); if (v) apply(v); };
  set("repo_name", (v) => { state.repoName = v; $("repo-name").value = v; });
  set("existing_repo", (v) => { state.existingRepo = v; setSelectValue($("existing-repo"), v); });
  set("visibility", (v) => { if (["Public", "Private"].includes(v)) { state.visibility = v; $("visibility").value = v; } });
  set("license", (v) => { state.license = v; setSelectValue($("license"), v); });
  set("sdk", (v) => { state.sdk = v; setSelectValue($("sdk"), v); });
  set("description", (v) => { state.description = v; $("description").value = v; });
  set("tags", (v) => { state.tags = v; $("tags").value = v; });
  set("commit_msg", (v) => { state.commitMsg = v; $("commit-msg").value = v; });
  const view = q.get("view");
  if (view === "history" || view === "projects") {
    document.querySelectorAll("[data-view]").forEach((x) => x.classList.remove("active"));
    document.querySelector(`[data-view='${view}']`)?.classList.add("active");
    state.view = view;
    $("view-upload").classList.toggle("hidden", view !== "upload");
    $("view-history").classList.toggle("hidden", view !== "history");
    $("view-projects").classList.toggle("hidden", view !== "projects");
    if (view === "history") renderHistory();
    if (view === "projects") renderProjects();
  }
}

// ─────────────── helpers ───────────────
function fmtSize(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
const totalSize = () => state.files.reduce((s, f) => s + (f.size || 0), 0);
const nameValid = () => NAME_RE.test(state.repoName.trim());
const isLfs = (f) => f.size > 10 * 1024 * 1024;
// owner key derived from the typed name (mirrors backend _slug)
const slug = (s) => (((s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "unknown");

async function jget(path) { return (await fetch(API + path)).json(); }
async function jpost(path, body) {
  return (await fetch(API + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json();
}

// ─────────────── connect screen ───────────────
const nameInput = $("connect-name");
nameInput.value = state.userName;

function connectValid() { return !!nameInput.value.trim(); }
function refreshConnectBtn() { $("connect-btn").disabled = !connectValid(); }
nameInput.oninput = refreshConnectBtn;

// open the Hugging Face sign-up page in the user's browser
const registerLink = $("register-link");
if (registerLink) registerLink.onclick = () => window.api.openExternal("https://huggingface.co/join");

$("connect-btn").onclick = async () => {
  if (!connectValid()) return;
  state.userName = nameInput.value.trim();
  localStorage.setItem("hf_uploader_name", state.userName);
  $("connect-status").textContent = "";
  enterApp();
}

async function enterApp() {
  $("screen-connect").classList.add("hidden");
  $("screen-main").classList.remove("hidden");
  setConnLabel();
  await refreshExisting();
  if (INCOMING) await applyIncoming(INCOMING);
  render();
}

// identity is fetched once at boot (org name, token status, license/sdk options)
let identityData = null;
async function loadIdentity() {
  for (let i = 0; i < 40; i++) {
    try {
      identityData = await jget("/api/identity");
      populateSelect($("license"), identityData.licenses, state.license);
      populateSelect($("sdk"), identityData.sdks, state.sdk);
      $("error-explain").classList.toggle("hidden", !identityData.ai_available);
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
function setConnLabel() {
  const d = identityData || { org: "IWMIHQ", token_ok: false };
  const tokenNote = d.token_ok ? "" : ` <span class="warn-pill">token not set</span>`;
  $("conn-label").innerHTML = `Connected as ${state.userName} · org ${d.org}${tokenNote}`;
}

function populateSelect(sel, opts, value) {
  sel.innerHTML = "";
  (opts || []).forEach((o) => {
    const el = document.createElement("option");
    el.value = o; el.textContent = o.toUpperCase();
    if (o === value) el.selected = true;
    sel.appendChild(el);
  });
}

// ─────────────── sidebar controls ───────────────
document.querySelectorAll("#repo-type .seg").forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll("#repo-type .seg").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.repoType = b.dataset.v;
    $("sdk-wrap").classList.toggle("hidden", state.repoType !== "space");
    await refreshExisting();
    render();
  };
});
document.querySelectorAll("#mode .seg").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#mode .seg").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.mode = b.dataset.v;
    $("new-fields").classList.toggle("hidden", state.mode !== "Create new");
    $("existing-fields").classList.toggle("hidden", state.mode !== "Update existing");
    render();
  };
});
$("repo-name").oninput = (e) => { state.repoName = e.target.value; render(); };
$("visibility").onchange = (e) => { state.visibility = e.target.value; };
$("license").onchange = (e) => { state.license = e.target.value; render(); };
$("sdk").onchange = (e) => { state.sdk = e.target.value; render(); };
$("commit-msg").oninput = (e) => { state.commitMsg = e.target.value; };
$("description").oninput = (e) => { state.description = e.target.value; render(); };
$("tags").oninput = (e) => { state.tags = e.target.value; render(); };

async function refreshExisting() {
  const sel = $("existing-repo");
  sel.innerHTML = "<option>Loading…</option>";
  try {
    const d = await jget(`/api/repos?repo_type=${state.repoType}&owner=${encodeURIComponent(slug(state.userName))}`);
    // you may only pick projects you can edit: your own, or unclaimed ones
    const editable = (d.repos || []).filter((r) => r.editable);
    state.existingList = editable;
    sel.innerHTML = "";
    if (!editable.length) {
      sel.innerHTML = "<option value=''>No projects you can edit yet</option>";
      state.existingRepo = "";
    } else {
      editable.forEach((r, i) => {
        const o = document.createElement("option");
        o.value = r.name;
        o.textContent = r.owner ? r.name : `${r.name} — unclaimed`;
        if (i === 0) o.selected = true;
        sel.appendChild(o);
      });
      state.existingRepo = editable[0].name;
    }
  } catch (_) { sel.innerHTML = "<option value=''>Could not load</option>"; }
}
$("existing-repo").onchange = (e) => { state.existingRepo = e.target.value; render(); };

// ─────────────── file staging ───────────────
function addFiles(list) {
  const seen = new Set(state.files.map((f) => f.rel));
  for (const f of list) {
    if (f && f.path && !seen.has(f.rel)) { state.files.push(f); seen.add(f.rel); }
  }
  render();
}

const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault(); dz.classList.remove("drag");
  if (e.dataTransfer.files.length) addFiles(await window.api.stageDropped(e.dataTransfer.files));
});

$("browse-files").onclick = async () => addFiles(await window.api.openFiles());
$("browse-folder").onclick = async () => addFiles(await window.api.openFolder());
$("example-files").onclick = async () => {
  const d = await jpost("/api/example_files", {});
  if (d.files) addFiles(d.files);
};
$("clear-all").onclick = () => { state.files = []; render(); };

$("gh-import").onclick = async () => {
  const url = $("gh-url").value.trim();
  if (!url) return;
  const btn = $("gh-import"); btn.textContent = "Importing…"; btn.disabled = true;
  try {
    const d = await jpost("/api/github_import", { url });
    if (d.error) { alert(d.error); }
    else {
      // GitHub import defaults the repo type to Space and suggests a name
      document.querySelector("#repo-type .seg[data-v='space']").click();
      if (d.suggested_name && !state.repoName) {
        state.repoName = d.suggested_name; $("repo-name").value = d.suggested_name;
      }
      addFiles(d.files);
    }
  } finally { btn.textContent = "Import"; btn.disabled = false; }
};

// ─────────────── README (built client-side for live preview) ───────────────
function buildReadme() {
  const name = state.mode === "Create new" ? state.repoName : state.existingRepo;
  const tags = state.tags.split(",").map((t) => t.trim()).filter(Boolean);
  const front = ["---", `license: ${state.license}`];
  if (tags.length) { front.push("tags:"); tags.forEach((t) => front.push(`  - ${t}`)); }
  if (state.repoType === "space") {
    front.push(`sdk: ${state.sdk}`);
    if (["gradio", "streamlit"].includes(state.sdk)) front.push("app_file: app.py");
    else if (state.sdk === "static") front.push("app_file: index.html");
  }
  front.push("---");
  const title = (name || "untitled").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const body = [`# ${title}`, "", state.description.trim() || "(No description provided.)", ""];
  if (state.files.length) {
    body.push("## Files", "");
    state.files.forEach((f) => body.push("- `" + f.rel + "`"));
    body.push("");
  }
  body.push("Maintained by the International Water Management Institute (IWMI).");
  return front.join("\n") + "\n\n" + body.join("\n") + "\n";
}

// ─────────────── render ───────────────
const ICONS = { ".py": "bi-filetype-py", ".md": "bi-filetype-md", ".json": "bi-filetype-json",
  ".csv": "bi-filetype-csv", ".txt": "bi-filetype-txt", ".yml": "bi-filetype-yml",
  ".yaml": "bi-filetype-yml", ".html": "bi-filetype-html", ".png": "bi-filetype-png",
  ".jpg": "bi-filetype-jpg", ".safetensors": "bi-box", ".bin": "bi-box", ".pt": "bi-box" };
function fileIcon(rel) {
  const dot = rel.lastIndexOf(".");
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
  return ICONS[ext] || "bi-file-earmark";
}

function renderTree() {
  const wrap = $("file-tree"); wrap.innerHTML = "";
  const folders = {}; const roots = [];
  for (const f of state.files) {
    const parts = f.rel.split("/");
    if (parts.length === 1) roots.push(f);
    else (folders[parts[0]] ||= []).push(f);
  }
  const fileRow = (f) => {
    const row = document.createElement("div"); row.className = "tree-file";
    row.innerHTML =
      `<i class="bi ${fileIcon(f.rel)} ft"></i>` +
      `<span class="fname">${f.rel.split("/").slice(-1)[0]}</span>` +
      (isLfs(f) ? `<span class="lfs">LFS</span>` : "") +
      `<span class="fsize">${fmtSize(f.size)}</span>` +
      `<button class="rm" title="Remove"><i class="bi bi-x-lg"></i></button>`;
    row.querySelector(".rm").onclick = () => {
      state.files = state.files.filter((x) => x.rel !== f.rel); render();
    };
    return row;
  };
  Object.keys(folders).sort().forEach((name) => {
    const closed = state.closedFolders[name];
    const fh = document.createElement("div");
    fh.className = "tree-folder" + (closed ? " closed" : "");
    fh.innerHTML = `<i class="bi bi-chevron-down chev"></i><i class="bi bi-folder2-open"></i>` +
      `<span class="fname">${name}/</span><span class="count">${folders[name].length} files</span>`;
    fh.onclick = () => { state.closedFolders[name] = !state.closedFolders[name]; render(); };
    wrap.appendChild(fh);
    if (!closed) {
      const kids = document.createElement("div"); kids.className = "tree-children";
      folders[name].forEach((f) => kids.appendChild(fileRow(f)));
      wrap.appendChild(kids);
    }
  });
  roots.forEach((f) => wrap.appendChild(fileRow(f)));
}

function renderChecks() {
  const c = $("checks"); c.innerHTML = "";
  const add = (kind, icon, text) => {
    const d = document.createElement("div"); d.className = "check " + kind;
    d.innerHTML = `<i class="bi ${icon}"></i><span>${text}</span>`; c.appendChild(d);
  };
  if (state.mode === "Create new") {
    if (!state.repoName.trim()) add("warn", "bi-exclamation-triangle-fill", "Enter a repository name.");
    else if (!nameValid()) add("warn", "bi-exclamation-triangle-fill", "Invalid repository name — use letters, numbers, . _ - (must start alphanumeric).");
    else add("pass", "bi-check-circle-fill", `Repository name IWMIHQ/${state.repoName.trim()} is valid.`);
  } else {
    if (state.existingRepo) {
      add("pass", "bi-check-circle-fill", `Updating IWMIHQ/${state.existingRepo}.`);
      const sel = (state.existingList || []).find((r) => r.name === state.existingRepo);
      if (sel && !sel.owner) add("info", "bi-info-circle", "This project is unclaimed — uploading will make you its owner.");
    } else {
      add("warn", "bi-exclamation-triangle-fill", "Pick an existing repository.");
    }
  }
  if (!state.description.trim()) add("warn", "bi-exclamation-triangle-fill", "Add a short description for a better README.");
  else add("pass", "bi-check-circle-fill", "Description provided.");
  const lfs = state.files.filter(isLfs).length;
  if (lfs) add("info", "bi-info-circle", `${lfs} file${lfs > 1 ? "s" : ""} over 10 MB will upload via git LFS.`);
  add("pass", "bi-check-circle-fill", `${state.files.length} file${state.files.length === 1 ? "" : "s"} staged.`);
}

function uploadEnabled() {
  if (!state.files.length || !state.userName.trim()) return false;
  return state.mode === "Create new" ? nameValid() : !!state.existingRepo;
}

function render() {
  const has = state.files.length > 0;
  $("empty-state").classList.toggle("hidden", has);
  $("staged-card").classList.toggle("hidden", !has);
  $("checks-card").classList.toggle("hidden", !has);
  $("readme-card").classList.toggle("hidden", !has);
  if (has) { renderTree(); renderChecks(); $("readme-pre").textContent = buildReadme(); }

  const name = state.mode === "Create new" ? state.repoName.trim() : state.existingRepo;
  $("footer-summary").textContent = has
    ? `${state.files.length} file${state.files.length === 1 ? "" : "s"} · ${fmtSize(totalSize())} · destination IWMIHQ/${name || "…"}`
    : "Add files to enable upload.";
  $("upload-btn").disabled = !uploadEnabled();
}

// ─────────────── nav / views / help ───────────────
document.querySelectorAll("[data-view]").forEach((p) => {
  p.onclick = () => {
    document.querySelectorAll("[data-view]").forEach((x) => x.classList.remove("active"));
    p.classList.add("active");
    state.view = p.dataset.view;
    $("view-upload").classList.toggle("hidden", state.view !== "upload");
    $("view-history").classList.toggle("hidden", state.view !== "history");
    $("view-projects").classList.toggle("hidden", state.view !== "projects");
    if (state.view === "history") renderHistory();
    if (state.view === "projects") renderProjects();
  };
});
$("help-btn").onclick = () => $("modal-help").classList.remove("hidden");
$("help-close").onclick = () => $("modal-help").classList.add("hidden");

// three-dot overflow menu in the top nav
const navMenuBtn = $("nav-menu-btn");
const navMenu = $("nav-menu");
function closeNavMenu() { navMenu.classList.add("hidden"); navMenuBtn.classList.remove("open"); }
navMenuBtn.onclick = (e) => {
  e.stopPropagation();
  const open = navMenu.classList.toggle("hidden") === false;
  navMenuBtn.classList.toggle("open", open);
};
document.querySelectorAll(".nav-menu-item").forEach((b) => b.addEventListener("click", closeNavMenu));
document.addEventListener("click", (e) => {
  if (!navMenu.classList.contains("hidden") && !e.target.closest(".nav-menu-wrap")) closeNavMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNavMenu(); });

// ─────────────── settings / updates / uninstall ───────────────
const APP_VERSION = "0.1.0";
// Release/download page for "Download latest version".
const DOWNLOAD_URL = "https://github.com/ZoloKiala/hub_upload/releases";

$("settings-btn").onclick = () => {
  const d = identityData || {};
  $("set-org").textContent = d.org || "IWMIHQ";
  $("set-identity").textContent = d.token_ok ? (d.name || "unknown") : "token not set";
  $("set-backend").textContent = API || location.origin;
  $("set-version").textContent = "v" + APP_VERSION;
  $("set-name").value = state.userName || "";
  $("modal-settings").classList.remove("hidden");
};
$("settings-close").onclick = () => $("modal-settings").classList.add("hidden");
$("set-name-save").onclick = () => {
  const v = $("set-name").value.trim();
  if (!v) return;
  state.userName = v;
  localStorage.setItem("hf_uploader_name", v);
  setConnLabel();
  refreshExisting();   // ownership of the editable list depends on the name
  $("modal-settings").classList.add("hidden");
};
$("set-signout").onclick = () => {
  localStorage.removeItem("hf_uploader_name");
  state.userName = "";
  nameInput.value = "";
  $("modal-settings").classList.add("hidden");
  $("screen-main").classList.add("hidden");
  $("screen-connect").classList.remove("hidden");
  refreshConnectBtn();
};

function checkForUpdate() {
  if (DOWNLOAD_URL) { window.api.openExternal(DOWNLOAD_URL); return; }
  alert(`IWMI Hub Uploader — version ${APP_VERSION}.\n\n`
    + "This build has no update source configured yet, so there's nothing new to download. "
    + "Once a release URL is set, this will fetch the latest version.");
}
$("update-btn").onclick = checkForUpdate;

const uninstallBtn = $("uninstall-btn");
if (uninstallBtn) uninstallBtn.onclick = () => {
  const ok = confirm('Uninstall IWMI Hub Uploader?\n\n'
    + 'This opens Windows "Apps & features", where you can remove the app. '
    + 'Your projects on the Hugging Face Hub are not affected.');
  if (ok) window.api.openExternal("ms-settings:appsfeatures");
};

async function renderHistory() {
  const el = $("history-list");
  el.innerHTML = `<div class="history-row"><span class="muted-cap">Loading…</span></div>`;
  let items = [];
  try { items = (await jget("/api/deployments")).deployments || []; } catch (_) {}
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<div class="history-row"><span class="muted-cap">No deployments logged yet.</span></div>`;
    return;
  }
  const iconOf = { model: "bi-cpu", dataset: "bi-database", space: "bi-rocket-takeoff" };
  items.forEach((h) => {
    const row = document.createElement("div"); row.className = "history-row";
    const icon = iconOf[h.repo_type] || "bi-box";
    const when = (h.time || "").replace("T", " ").replace("+00:00", " UTC");
    row.innerHTML = `<i class="bi ${icon}"></i><span>${h.user || "someone"} uploaded ` +
      `<a data-url="${h.url}">${h.repo_id}</a></span><span class="ht-time">${when}</span>`;
    row.querySelector("a").onclick = () => window.api.openExternal(h.url);
    el.appendChild(row);
  });
}

// read-only browse of every IWMIHQ project — you see all, edit only your own
async function renderProjects() {
  const el = $("projects-list");
  el.innerHTML = `<div class="history-row"><span class="muted-cap">Loading projects…</span></div>`;
  const me = slug(state.userName);
  const types = [["model", "bi-cpu"], ["dataset", "bi-database"], ["space", "bi-rocket-takeoff"]];
  const prefix = { model: "", dataset: "datasets/", space: "spaces/" };
  try {
    const all = [];
    for (const [t, icon] of types) {
      const d = await jget(`/api/repos?repo_type=${t}&owner=${encodeURIComponent(me)}`);
      (d.repos || []).forEach((r) => all.push({ ...r, type: t, icon }));
    }
    el.innerHTML = "";
    if (!all.length) {
      el.innerHTML = `<div class="history-row"><span class="muted-cap">No projects in IWMIHQ yet.</span></div>`;
      $("projects-note").textContent = "";
      return;
    }
    all.forEach((r) => {
      const row = document.createElement("div"); row.className = "history-row";
      const url = `https://huggingface.co/${prefix[r.type]}IWMIHQ/${r.name}`;
      const badge = r.mine
        ? `<span class="tag-badge mine">yours</span>`
        : (r.owner ? `<span class="tag-badge">owner: ${r.owner}</span>` : `<span class="tag-badge">unclaimed</span>`);
      row.innerHTML = `<i class="bi ${r.icon}"></i><span><a data-url="${url}">IWMIHQ/${r.name}</a></span>` +
        `<span class="ht-time">${badge}</span>`;
      row.querySelector("a").onclick = () => window.api.openExternal(url);
      el.appendChild(row);
    });
    const mineCount = all.filter((r) => r.mine).length;
    $("projects-note").textContent = `${all.length} projects · ${mineCount} yours · edit only your own`;
  } catch (_) {
    el.innerHTML = `<div class="history-row"><span class="muted-cap">Could not load projects.</span></div>`;
  }
}

// ─────────────── upload flow ───────────────
$("upload-btn").onclick = async () => {
  if (!uploadEnabled()) return;
  const payload = {
    user_name: state.userName,
    repo_type: state.repoType, mode: state.mode,
    repo_name: state.repoName.trim(), existing_repo: state.existingRepo,
    visibility: state.visibility, license: state.license, description: state.description,
    tags: state.tags, commit_msg: state.commitMsg, sdk: state.sdk, generate_readme: true,
    files: state.files.map((f) => ({ path: f.path, rel: f.rel, size: f.size })),
  };
  const name = state.mode === "Create new" ? state.repoName.trim() : state.existingRepo;
  showOverlay("overlay-uploading");
  $("up-title").textContent = `Uploading to IWMIHQ/${name}…`;
  $("up-sub").textContent = "Preparing repository…";
  $("up-files").innerHTML = `<div class="up-track"><div class="up-fill" id="up-fill"></div></div>`;

  try {
    const { job_id } = await jpost("/api/upload", payload);
    await pollProgress(job_id, name);
  } catch (e) {
    $("error-msg").textContent = String(e); showOverlay("overlay-error");
  }
};

function pollProgress(jobId, name) {
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      let j;
      try { j = await jget("/api/progress/" + jobId); } catch (_) { return; }
      const pct = Math.round((j.pct || 0) * 100);
      const fill = $("up-fill"); if (fill) fill.style.width = pct + "%";
      if (j.current) $("up-sub").textContent = `Uploading ${j.current} — ${j.done}/${j.total} (${pct}%)`;
      if (j.state === "done") {
        clearInterval(timer);
        recordHistory(name, j);
        $("done-link").innerHTML = `<a id="done-a">${j.url.replace("https://huggingface.co/", "")}</a>`;
        $("done-a").onclick = () => window.api.openExternal(j.url);
        $("done-summary").textContent = j.message;
        $("done-view").onclick = () => window.api.openExternal(j.url);
        showOverlay("overlay-done");
        resolve();
      } else if (j.state === "error") {
        clearInterval(timer);
        $("error-msg").textContent = j.error || "Unknown error";
        showOverlay("overlay-error");
        resolve();
      }
    }, 400);
  });
}

function recordHistory(name, job) {
  state.history.unshift({
    user: state.userName, repoType: state.repoType,
    repoId: `IWMIHQ/${name}`, url: job.url, time: "just now",
  });
}

$("done-again").onclick = () => {
  state.files = []; state.closedFolders = {};
  hideOverlays(); render();
};
$("error-back").onclick = () => {
  $("error-explanation").classList.add("hidden");
  $("error-explanation").innerHTML = "";
  hideOverlays();
};

// ─────────────── AI: explain an upload error ───────────────
function renderExplanation(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return (md || "").split("\n").map((line) => {
    const t = line.trim();
    if (!t) return "";
    if (/^#{1,6}\s/.test(t)) return `<div class="ex-h">${inline(t.replace(/^#{1,6}\s/, ""))}</div>`;
    if (/^[-*]\s/.test(t)) return `<div class="ex-li">• ${inline(t.replace(/^[-*]\s/, ""))}</div>`;
    if (/^\d+\.\s/.test(t)) return `<div class="ex-li">${inline(t)}</div>`;
    return `<div class="ex-p">${inline(t)}</div>`;
  }).join("");
}

const errExplainBtn = $("error-explain");
if (errExplainBtn) errExplainBtn.onclick = async () => {
  const box = $("error-explanation");
  const err = ($("error-msg").textContent || "").trim();
  if (!err) return;
  errExplainBtn.disabled = true;
  errExplainBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Analyzing…';
  box.classList.remove("hidden");
  box.innerHTML = '<div class="ex-p muted-cap">Asking Claude to explain…</div>';
  try {
    const ctx = {
      repo_type: state.repoType,
      mode: state.mode,
      repo: state.mode === "Create new" ? state.repoName : state.existingRepo,
      visibility: state.visibility,
      files: state.files.length,
    };
    const r = await jpost("/api/explain", { error: err, context: ctx });
    box.innerHTML = r.ok
      ? renderExplanation(r.explanation)
      : `<div class="ex-p muted-cap">${r.error || "Could not get an explanation."}</div>`;
  } catch (_) {
    box.innerHTML = '<div class="ex-p muted-cap">Could not reach the AI helper.</div>';
  } finally {
    errExplainBtn.disabled = false;
    errExplainBtn.innerHTML = '<i class="bi bi-stars"></i> Explain this error';
  }
};

function showOverlay(id) {
  hideOverlays();
  $(id).classList.remove("hidden");
}
function hideOverlays() {
  ["overlay-uploading", "overlay-done", "overlay-error"].forEach((i) => $(i).classList.add("hidden"));
}

// ─────────────── boot ───────────────
(async function boot() {
  await loadIdentity();
  if (INCOMING && INCOMING.get("name") && !nameInput.value) {
    nameInput.value = INCOMING.get("name");
    state.userName = INCOMING.get("name");
  }
  refreshConnectBtn();
  // skip the connect screen when a name is already stored
  if (state.userName) enterApp();
})();
