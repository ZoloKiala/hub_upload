"""IWMI Hub Uploader — upload models, datasets and Spaces to IWMIHQ in a few clicks.

Team token comes from the environment (HF_TOKEN); users only enter their name,
which is recorded in every commit message for attribution.
"""

import os
import pathlib

import gradio as gr
from dotenv import load_dotenv
from huggingface_hub import HfApi, whoami

load_dotenv()

TOKEN = os.environ.get("HF_TOKEN", "").strip()
ORG = os.environ.get("HF_ORG", "IWMIHQ").strip()

if not TOKEN:
    raise SystemExit(
        "HF_TOKEN is not set. Copy .env.example to .env and paste the team token."
    )

api = HfApi(token=TOKEN)

LICENSES = ["cc-by-4.0", "cc-by-sa-4.0", "apache-2.0", "mit", "cc0-1.0", "other"]
SDKS = ["gradio", "streamlit", "docker", "static"]
LFS_NOTE = "Files over 10 MB upload via git LFS automatically. Folder structure is kept."


def token_identity() -> str:
    try:
        info = whoami(token=TOKEN)
        return info.get("name", "unknown")
    except Exception as exc:  # invalid/revoked token
        return f"token error: {exc}"


def list_existing(repo_type: str) -> list[str]:
    """Existing IWMIHQ repos of the given type."""
    try:
        if repo_type == "model":
            items = api.list_models(author=ORG)
        elif repo_type == "dataset":
            items = api.list_datasets(author=ORG)
        else:
            items = api.list_spaces(author=ORG)
        return [i.id.split("/", 1)[1] for i in items]
    except Exception:
        return []


def build_readme(repo_name: str, repo_type: str, license_id: str,
                 description: str, tags: str, files: list[str],
                 sdk: str = "gradio") -> str:
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
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
    title = repo_name.replace("-", " ").replace("_", " ").title()
    body = [f"# {title}", "", description.strip() or "(No description provided.)", ""]
    if files:
        body += ["## Files", ""] + [f"- `{f}`" for f in files] + [""]
    body.append("Maintained by the International Water Management Institute (IWMI).")
    return "\n".join(front) + "\n\n" + "\n".join(body) + "\n"


def refresh_existing(repo_type: str):
    repos = list_existing(repo_type)
    return gr.Dropdown(
        choices=repos,
        value=repos[0] if repos else None,
        label="Existing repository",
        info=None if repos else "No repositories of this type yet. Create a new one instead.",
    )


def preview_readme(repo_name, existing_repo, mode, repo_type, license_id,
                   description, tags, file_objs, sdk):
    name = repo_name if mode == "Create new" else (existing_repo or "")
    names = [pathlib.Path(f.name).name for f in (file_objs or [])]
    return build_readme(name or "untitled", repo_type, license_id, description,
                        tags, names, sdk)


def do_upload(user_name, repo_type, mode, repo_name, existing_repo, visibility,
              license_id, description, tags, commit_msg, file_objs,
              generate_readme, sdk, progress=gr.Progress()):
    if not user_name.strip():
        raise gr.Error("Enter your name. It is recorded in the commit message.")
    if not file_objs:
        raise gr.Error("Add at least one file.")

    name = repo_name.strip() if mode == "Create new" else (existing_repo or "").strip()
    if not name:
        raise gr.Error("Enter a repository name or pick an existing repository.")

    repo_id = f"{ORG}/{name}"
    message = (commit_msg.strip() or "Upload files") + f" — by {user_name.strip()}"

    progress(0.05, desc="Preparing repository…")
    if mode == "Create new":
        api.create_repo(
            repo_id=repo_id,
            repo_type=repo_type,
            private=(visibility == "Private"),
            exist_ok=True,
            space_sdk=sdk if repo_type == "space" else None,
        )

    ops_total = len(file_objs) + (1 if generate_readme else 0)
    done = 0

    if generate_readme:
        names = [pathlib.Path(f.name).name for f in file_objs]
        readme = build_readme(name, repo_type, license_id, description, tags,
                              names, sdk)
        api.upload_file(
            path_or_fileobj=readme.encode(),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type=repo_type,
            commit_message=message,
        )
        done += 1
        progress(done / ops_total, desc="README.md uploaded…")

    for f in file_objs:
        local = pathlib.Path(f.name)
        # Gradio keeps the original filename; preserve any relative folder
        # structure encoded in the orig_name when a folder was dropped.
        rel = getattr(f, "orig_name", None) or local.name
        api.upload_file(
            path_or_fileobj=str(local),
            path_in_repo=rel,
            repo_id=repo_id,
            repo_type=repo_type,
            commit_message=message,
        )
        done += 1
        progress(done / ops_total, desc=f"Uploading {rel}…")

    prefix = {"model": "", "dataset": "datasets/", "space": "spaces/"}[repo_type]
    url = f"https://huggingface.co/{prefix}{repo_id}"
    return f"Upload complete. [{repo_id}]({url}) is live on the Hub. ({len(file_objs)} files · {message})"


with gr.Blocks(title="IWMI Hub uploader") as demo:
    gr.Markdown(f"## Hub uploader\nUploads go to the **{ORG}** organization. "
                f"Connected via team token (`{token_identity()}`).")

    with gr.Row():
        with gr.Column(scale=1):
            user_name = gr.Textbox(label="Your name", placeholder="Shown in the upload history")
            repo_type = gr.Radio(["model", "dataset", "space"], value="model",
                                 label="Repository type")
            sdk = gr.Dropdown(SDKS, value="gradio", label="Space SDK",
                              info="How the Hub runs the app.", visible=False)
            mode = gr.Radio(["Create new", "Update existing"], value="Create new",
                            label="Repository")
            repo_name = gr.Textbox(label=f"Repository name ({ORG}/…)",
                                   placeholder="e.g. limpopo-suitability")
            existing_repo = gr.Dropdown(choices=list_existing("model"),
                                        label="Existing repository", visible=False)
            visibility = gr.Radio(["Public", "Private"], value="Public", label="Visibility")
            license_id = gr.Dropdown(LICENSES, value="cc-by-4.0", label="License")
            description = gr.Textbox(label="Short description", lines=2,
                                     placeholder="One or two sentences describing this repository.")
            tags = gr.Textbox(label="Tags", placeholder="irrigation, remote-sensing, limpopo")
            commit_msg = gr.Textbox(label="Commit message", placeholder="Update files")

        with gr.Column(scale=2):
            files = gr.File(label=f"Files — {LFS_NOTE}", file_count="multiple")
            generate_readme = gr.Checkbox(value=True, label="Generate README.md from the card details")
            readme_preview = gr.Code(label="Generated README.md", language="markdown")
            upload_btn = gr.Button("Upload to Hub", variant="primary")
            result = gr.Markdown()

    def _mode_vis(m):
        return gr.update(visible=m == "Create new"), gr.update(visible=m == "Update existing")

    mode.change(_mode_vis, mode, [repo_name, existing_repo])
    repo_type.change(refresh_existing, repo_type, existing_repo)
    repo_type.change(lambda t: gr.update(visible=t == "space"), repo_type, sdk)

    preview_inputs = [repo_name, existing_repo, mode, repo_type, license_id,
                      description, tags, files, sdk]
    for comp in preview_inputs:
        comp.change(preview_readme, preview_inputs, readme_preview)

    upload_btn.click(
        do_upload,
        [user_name, repo_type, mode, repo_name, existing_repo, visibility,
         license_id, description, tags, commit_msg, files, generate_readme, sdk],
        result,
    )

if __name__ == "__main__":
    demo.launch()
