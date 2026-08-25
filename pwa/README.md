# Hub uploader — the PWA

The redesigned app: upload models, datasets and Spaces to the **IWMIHQ** organization
on the Hugging Face Hub. Static files only — no Python, no Node, no server.

```
pwa/
  index.html   every screen, as markup
  app.css      the design system (navy #28537D, DM Serif Text + Source Sans 3)
  app.js       state, Hub calls, staging, checks, README generation
  sw.js        service worker: the shell works offline
  manifest.json
  assets/      icon sprite, app icons, the two web fonts
  build_icons.py   rebuilds assets/icons.svg (only when the icon list changes)
```

## The one thing to understand: the token is each person's own

Every upload uses **the token of whoever is using the app**, pasted once on the connect
screen and kept in that browser's `localStorage`. Nothing is stored on a server, because
there is no server.

That is a deliberate change from the design prototype, which took a single IWMIHQ write
token and shipped it to every client. In a browser-only app that token cannot be kept
secret — anyone who opens the page can read it out of devtools — and it grants write and
delete across the whole organization. Per-user tokens also mean the Hub records who
actually committed, which is what the history and the commit messages claim.

What this needs from an admin: each person has a Hugging Face account, is a member of
IWMIHQ with write access, and makes themselves a **write** token
(`huggingface.co/settings/tokens`). The app checks the token on connect and refuses a
read-only one straight away, rather than at the end of a long upload.

## Run it

Any static server; a service worker will not install over `file://`.

```bash
cd pwa
python -m http.server 8099        # then open http://127.0.0.1:8099/
```

## Deploy it

The whole app is static, so anything that serves files will do.

- **Railway** — the repo already deploys; point a static service at `pwa/`, or keep
  `backend.py` only as a file server.
- **GitHub Pages / any web host** — copy `pwa/` as-is.
- **A private Space in IWMIHQ** — a static Space, `pwa/` as its contents.

There is no `HF_TOKEN` to set anywhere, and no `ACCESS_CODE` needed to protect one: a
visitor without their own token can look at the connect screen and nothing else.

## Install it

Chrome or Edge on desktop: the install icon at the right of the address bar. Safari on
iPadOS/macOS: Share → Add to Dock. Installed, it opens in its own window, and everything
up to the upload works offline — staging files, the pre-flight checks, the generated
README.

## What it talks to

| Origin | When | Why |
| --- | --- | --- |
| `huggingface.co` | connect, listing, upload | the Hub itself |
| `cdn.jsdelivr.net` | first Hub call | `@huggingface/hub@2.15.0`, pinned, imported lazily |
| `api.github.com`, `raw.githubusercontent.com` | GitHub import only | staging files from a public repo |

Fonts and icons ship with the app, so the shell needs none of these to draw. The Hub
client comes off a CDN because vendoring it would mean vendoring its WASM chunker too,
and an upload needs the network regardless.

## Notes for whoever edits this next

- `app.js` reads text inputs when it needs them rather than re-rendering on every
  keystroke; that is why the caret never jumps. Structural changes call `refresh()`.
- Project search filters the list already in memory (`renderProjects()`), so it costs
  no Hub calls, works offline once loaded, and cannot rate-limit. Every word in the
  query must match, against the repository path, its kind, and public/private.
- Hub list entries put the `owner/name` path in **`name`**; `id` is an internal hex
  string, and the modified date is **`updatedAt`** (`lastModified` is only on
  single-repo lookups). Both cost a bug already.
- The design source is `HubUpload PWA Redesign/` in the `open_data_cube` repo: a
  prototype for the design tool, needing React, Babel and a runtime from a CDN. This
  folder is the same design as a real app; the prototype is the reference, not a
  dependency.
- Icons come from Bootstrap Icons (MIT) as a 24-glyph sprite. Add one to the list in
  `build_icons.py` and re-run it.

## What this replaces

The Electron shell, `backend.py`, the PyInstaller step and the NSIS installer all exist
to do what a PWA does by itself — a window, an icon, and a token kept out of the client.
Nothing here needs them. Retire them once this is deployed and people have installed it;
until then they are untouched.
