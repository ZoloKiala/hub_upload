"""FastAPI backend for the Electron IWMI Hub Uploader.

Wraps huggingface_hub: identity, list existing repos, README preview, and
upload-with-progress. The team token comes from HF_TOKEN (.env); the uploader's
name is recorded in every commit message for attribution.

Run standalone:  py -3 backend.py            (serves on 127.0.0.1:8765)
Electron main.js spawns this and talks to it over HTTP.
"""

import base64
import hmac
import json
import os
import pathlib
import re
import shutil
import tarfile
import tempfile
import threading
import urllib.request
import uuid
from datetime import datetime, timezone

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from huggingface_hub import HfApi, whoami

load_dotenv()

TOKEN = os.environ.get("HF_TOKEN", "").strip()
ORG = os.environ.get("HF_ORG", "IWMIHQ").strip()
# BACKEND_PORT (desktop) wins; PORT is what hosts like Railway inject; else default.
PORT = int(os.environ.get("BACKEND_PORT") or os.environ.get("PORT") or "8765")
# 127.0.0.1 for local/desktop; set BACKEND_HOST=0.0.0.0 when hosting publicly.
HOST = os.environ.get("BACKEND_HOST", "127.0.0.1")
# Optional shared access code for public/hosted deploys (e.g. Railway). When set,
# the ENTIRE app (UI + API) requires HTTP Basic auth with this as the password.
# Unset (desktop/local) = no gate, so it never affects local use.
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()

api = HfApi(token=TOKEN)

LICENSES = ["cc-by-4.0", "cc-by-sa-4.0", "apache-2.0", "mit", "cc0-1.0", "other"]
SDKS = ["gradio", "streamlit", "docker", "static"]
LFS_THRESHOLD = 10 * 1024 * 1024  # 10 MB

app = FastAPI(title="IWMI Hub Uploader backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _access_gate(request, call_next):
    """When ACCESS_CODE is set (hosted deploys), require HTTP Basic auth on
    everything except the health probe. No-op when ACCESS_CODE is empty."""
    if ACCESS_CODE and request.method != "OPTIONS" and request.url.path != "/api/health":
        ok = False
        auth = request.headers.get("authorization", "")
        if auth.startswith("Basic "):
            try:
                pw = base64.b64decode(auth[6:]).decode("utf-8", "ignore").partition(":")[2]
                ok = hmac.compare_digest(pw, ACCESS_CODE)
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401,
                            headers={"WWW-Authenticate": 'Basic realm="IWMI Hub Uploader"'})
    return await call_next(request)

# job_id -> progress dict
JOBS: dict[str, dict] = {}


# ────────────────────────────── helpers ──────────────────────────────
def token_identity() -> tuple[str, bool]:
    """Return (display name, token_ok)."""
    try:
        info = whoami(token=TOKEN)
        return info.get("name", "unknown"), True
    except Exception:
        return "not connected", False


def _slug(name: str) -> str:
    """A stable, tag-safe owner key derived from the name the user typed."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return s or "unknown"


def _owner_tag(name: str) -> str:
    return f"owner-{_slug(name)}"


def _owner_of_tags(tags) -> str | None:
    for t in (tags or []):
        if t.startswith("owner-"):
            return t[len("owner-"):]
    return None


def list_existing(repo_type: str) -> list[dict]:
    """Existing IWMIHQ repos of the given type, each with its owner slug (or None
    if unclaimed). Ownership is stored as an ``owner-<slug>`` tag on the repo card."""
    try:
        if repo_type == "model":
            items = api.list_models(author=ORG)
        elif repo_type == "dataset":
            items = api.list_datasets(author=ORG)
        else:
            items = api.list_spaces(author=ORG)
        out = []
        for it in items:
            name = it.id.split("/", 1)[1]
            if repo_type == "space" and name == "README":
                continue  # org profile card, not a project
            out.append({"name": name, "owner": _owner_of_tags(getattr(it, "tags", None))})
        return out
    except Exception:
        return []


def _repo_owner(repo_type: str, name: str) -> str | None:
    """Fetch one repo's owner slug directly (fresher than the list index).
    Returns None if the repo is unclaimed or does not exist yet."""
    try:
        rid = f"{ORG}/{name}"
        if repo_type == "model":
            info = api.model_info(rid)
        elif repo_type == "dataset":
            info = api.dataset_info(rid)
        else:
            info = api.space_info(rid)
        return _owner_of_tags(getattr(info, "tags", None))
    except Exception:
        return None


def build_readme(repo_name, repo_type, license_id, description, tags, files, sdk="gradio"):
    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
    front = ["---", f"license: {license_id}"]
    if tag_list:
        front.append("tags:")
        front += [f"  - {t}" for t in tag_list]
    if repo_type == "space":
        front.append(f"sdk: {sdk}")
        if sdk in ("gradio", "streamlit"):
            front.append("app_file: app.py")
        elif sdk == "static":
            front.append("app_file: index.html")
    front.append("---")
    title = (repo_name or "untitled").replace("-", " ").replace("_", " ").title()
    body = [f"# {title}", "", (description or "").strip() or "(No description provided.)", ""]
    if files:
        body += ["## Files", ""] + [f"- `{f}`" for f in files] + [""]
    body.append("Maintained by the International Water Management Institute (IWMI).")
    return "\n".join(front) + "\n\n" + "\n".join(body) + "\n"


def _deploy_log_path() -> pathlib.Path:
    """Persistent, user-writable deployment log (works in dev and packaged)."""
    base = os.environ.get("APPDATA") or str(pathlib.Path.home())
    d = pathlib.Path(base) / "IWMI Hub Uploader"
    d.mkdir(parents=True, exist_ok=True)
    return d / "deployments.jsonl"


def log_deployment(record: dict) -> None:
    """Append one deployment record as a line of JSON."""
    try:
        with open(_deploy_log_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as exc:
        print(f"[deploy] could not write log: {exc}", flush=True)


# ────────────────────────────── models ──────────────────────────────
class StagedFile(BaseModel):
    path: str          # absolute local path (read directly for upload)
    rel: str           # path-in-repo (preserves folder structure)
    size: int = 0


class PreviewReq(BaseModel):
    repo_name: str = ""
    existing_repo: str = ""
    mode: str = "Create new"
    repo_type: str = "model"
    license: str = "cc-by-4.0"
    description: str = ""
    tags: str = ""
    sdk: str = "gradio"
    files: list[str] = []


class UploadReq(BaseModel):
    user_name: str
    repo_type: str
    mode: str
    repo_name: str = ""
    existing_repo: str = ""
    visibility: str = "Public"
    license: str = "cc-by-4.0"
    description: str = ""
    tags: str = ""
    commit_msg: str = ""
    sdk: str = "gradio"
    generate_readme: bool = True
    files: list[StagedFile] = []


class ExplainReq(BaseModel):
    error: str
    context: dict = {}


# ────────────────────────────── routes ──────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/identity")
def identity():
    name, ok = token_identity()
    return {"name": name, "org": ORG, "token_ok": ok,
            "licenses": LICENSES, "sdks": SDKS,
            "ai_available": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())}


@app.get("/api/repos")
def repos(repo_type: str = "model", owner: str = ""):
    """List repos of a type. Each item carries its owner plus, for the requesting
    user (``owner`` query param), whether it is theirs and whether they may edit it
    (their own, or unclaimed — claimable on first commit)."""
    me = _slug(owner) if owner.strip() else None
    result = []
    for it in list_existing(repo_type):
        mine = me is not None and it["owner"] == me
        result.append({**it, "mine": mine, "editable": it["owner"] is None or mine})
    return {"repos": result}


@app.post("/api/preview")
def preview(req: PreviewReq):
    name = req.repo_name if req.mode == "Create new" else req.existing_repo
    return {"readme": build_readme(name, req.repo_type, req.license,
                                   req.description, req.tags, req.files, req.sdk)}


@app.post("/api/github_import")
def github_import(payload: dict):
    """Fetch a GitHub repo tarball, stage its file tree. Best-effort."""
    url = (payload.get("url") or "").strip().rstrip("/")
    if not url:
        return {"error": "Enter a GitHub URL."}
    part = url.replace("https://github.com/", "").replace("http://github.com/", "")
    if part.endswith(".git"):
        part = part[:-4]
    bits = part.split("/")
    if len(bits) < 2:
        return {"error": "URL must look like https://github.com/org/repo."}
    owner, repo = bits[0], bits[1]
    dest = pathlib.Path(tempfile.mkdtemp(prefix="ghimport_"))
    for branch in ("main", "master"):
        tar_url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{branch}"
        try:
            tmp = dest / "repo.tar.gz"
            urllib.request.urlretrieve(tar_url, tmp)
            with tarfile.open(tmp) as tf:
                tf.extractall(dest)
            tmp.unlink()
            roots = [p for p in dest.iterdir() if p.is_dir()]
            if not roots:
                continue
            root = roots[0]
            files = []
            for f in root.rglob("*"):
                if f.is_file() and ".git" not in f.parts:
                    files.append({"path": str(f), "rel": str(f.relative_to(root)).replace("\\", "/"),
                                  "size": f.stat().st_size})
            return {"files": files, "suggested_name": repo}
        except Exception:
            continue
    return {"error": f"Could not fetch {owner}/{repo} (tried main and master)."}


@app.post("/api/stage")
async def stage(files: list[UploadFile] = File(...), rels: str = Form(None)):
    """Browser file staging: receive uploaded bytes and write them to a temp dir,
    preserving relative paths. Returns descriptors the upload flow can consume,
    exactly like the Electron path-based flow."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="hf_web_"))
    rel_list = json.loads(rels) if rels else None
    out = []
    for i, uf in enumerate(files):
        rel = (rel_list[i] if rel_list and i < len(rel_list) else uf.filename) or uf.filename
        rel = rel.replace("\\", "/").lstrip("/")
        fp = d / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        with open(fp, "wb") as w:
            shutil.copyfileobj(uf.file, w)
        out.append({"path": str(fp), "rel": rel, "size": fp.stat().st_size})
    return {"files": out}


@app.post("/api/example_files")
def example_files(payload: dict = None):
    """Write a few small, real example files to a temp dir so upload works end-to-end."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="hf_example_"))
    samples = {
        "config.json": '{\n  "name": "example-model",\n  "framework": "pytorch",\n  "task": "regression"\n}\n',
        "data/sample.csv": "site_id,ndvi,date\n1,0.62,2026-01-01\n2,0.71,2026-01-01\n",
        "notes.md": "# Example upload\n\nThese sample files were generated by the IWMI Hub Uploader.\n",
    }
    out = []
    for rel, content in samples.items():
        fp = d / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
        out.append({"path": str(fp), "rel": rel, "size": fp.stat().st_size})
    return {"files": out}


@app.post("/api/upload")
def upload(req: UploadReq):
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"state": "running", "done": 0, "total": 0,
                    "current": "", "pct": 0.0, "url": None, "message": None, "error": None}
    threading.Thread(target=_run_upload, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/progress/{job_id}")
def progress(job_id: str):
    return JOBS.get(job_id, {"state": "error", "error": "unknown job"})


@app.get("/api/deployments")
def deployments(limit: int = 50):
    """Recent deployments (newest first) from the persistent log."""
    try:
        p = _deploy_log_path()
        if not p.exists():
            return {"deployments": []}
        lines = p.read_text(encoding="utf-8").splitlines()
        recs = []
        for ln in lines[-limit:]:
            try:
                recs.append(json.loads(ln))
            except Exception:
                pass
        recs.reverse()
        return {"deployments": recs}
    except Exception:
        return {"deployments": []}


EXPLAIN_SYSTEM = (
    "You are a debugging assistant embedded in the IWMI Hub Uploader — a desktop and web app "
    "(Electron front-end + FastAPI backend using huggingface_hub) that uploads models, datasets "
    "and Spaces to the IWMIHQ organization on the Hugging Face Hub.\n\n"
    "A user hit an error and asked you to explain it. Given the error message and context, reply with:\n"
    "1. A one-sentence, plain-language summary of what went wrong.\n"
    "2. The most likely cause.\n"
    "3. Concrete steps to fix it, specific to this app where possible. Useful facts: repository names "
    "must match letters/numbers/._- and start alphanumeric; uploads use a shared team token (HF_TOKEN) "
    "that needs write access to IWMIHQ; files over 10 MB upload via git LFS automatically; a user can only "
    "edit projects they own or that are unclaimed.\n\n"
    "Keep it short, friendly and non-technical. Use brief markdown (short headings or bullets). "
    "Do not invent details the error does not support."
)


@app.post("/api/explain")
def explain(req: ExplainReq):
    """AI helper: explain an upload/deployment error and suggest a fix, via Claude."""
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return {"ok": False, "error": "AI help isn't configured on this server (set ANTHROPIC_API_KEY)."}
    if not (req.error or "").strip():
        return {"ok": False, "error": "No error message to explain."}
    try:
        import anthropic
    except ImportError:
        return {"ok": False, "error": "The AI helper dependency (anthropic) isn't installed in this build."}
    try:
        client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
        ctx = "\n".join(f"- {k}: {v}" for k, v in (req.context or {}).items()
                        if v not in (None, "", [], 0))
        user = ("An upload to the Hugging Face Hub failed in the IWMI Hub Uploader.\n\n"
                f"Error message:\n{req.error.strip()}\n"
                + (f"\nContext:\n{ctx}\n" if ctx else ""))
        msg = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=2000,
            thinking={"type": "adaptive"},
            output_config={"effort": "low"},
            system=EXPLAIN_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
        return {"ok": True, "explanation": text or "No explanation was returned."}
    except anthropic.APIStatusError as exc:
        return {"ok": False, "error": f"AI service error ({exc.status_code})."}
    except Exception as exc:
        return {"ok": False, "error": f"Could not get an explanation: {exc}"}


def _run_upload(job_id: str, req: UploadReq):
    job = JOBS[job_id]
    try:
        name = (req.repo_name if req.mode == "Create new" else req.existing_repo).strip()
        if not req.user_name.strip():
            raise ValueError("Enter your name. It is recorded in the commit message.")
        if not req.files:
            raise ValueError("Add at least one file.")
        if not name:
            raise ValueError("Enter a repository name or pick an existing repository.")

        repo_id = f"{ORG}/{name}"
        message = (req.commit_msg.strip() or "Upload files") + f" — by {req.user_name.strip()}"

        job["total"] = len(req.files) + (1 if req.generate_readme else 0)

        if req.mode == "Create new":
            job["current"] = "Preparing repository…"
            api.create_repo(
                repo_id=repo_id,
                repo_type=req.repo_type,
                private=(req.visibility == "Private"),
                exist_ok=True,
                space_sdk=req.sdk if req.repo_type == "space" else None,
            )

        if req.generate_readme:
            names = [f.rel for f in req.files]
            readme = build_readme(name, req.repo_type, req.license, req.description,
                                  req.tags, names, req.sdk)
            api.upload_file(
                path_or_fileobj=readme.encode(),
                path_in_repo="README.md",
                repo_id=repo_id,
                repo_type=req.repo_type,
                commit_message=message,
            )
            job["done"] += 1
            job["current"] = "README.md"
            job["pct"] = job["done"] / job["total"]

        for f in req.files:
            job["current"] = f.rel
            api.upload_file(
                path_or_fileobj=f.path,
                path_in_repo=f.rel,
                repo_id=repo_id,
                repo_type=req.repo_type,
                commit_message=message,
            )
            job["done"] += 1
            job["pct"] = job["done"] / job["total"]

        prefix = {"model": "", "dataset": "datasets/", "space": "spaces/"}[req.repo_type]
        job["url"] = f"https://huggingface.co/{prefix}{repo_id}"
        job["message"] = message
        job["state"] = "done"
        job["pct"] = 1.0
        # log the deployment and print the link
        record = {
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "user": req.user_name.strip(),
            "repo_id": repo_id,
            "repo_type": req.repo_type,
            "url": job["url"],
            "files": len(req.files),
            "mode": req.mode,
        }
        log_deployment(record)
        # never let logging/printing (e.g. a console encoding error) fail the upload
        try:
            print(f"[deploy] upload successful -> {job['url']}  "
                  f"(by {record['user']}, {record['files']} files)", flush=True)
        except Exception:
            pass
    except Exception as exc:
        job["state"] = "error"
        job["error"] = str(exc)


# Serve the recreated UI as a static web app (browser version). Mounted LAST so
# it never shadows the /api routes above. Open http://127.0.0.1:8765 in a browser.
RENDERER_DIR = pathlib.Path(__file__).parent / "electron" / "renderer"
if RENDERER_DIR.exists():
    app.mount("/", StaticFiles(directory=str(RENDERER_DIR), html=True), name="web")


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
