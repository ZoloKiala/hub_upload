# Hub uploader — the PWA

The redesigned app: upload models, datasets and Spaces to the **IWMIHQ** organization
on the Hugging Face Hub. Static files only — no Python, no Node, no server.

```
pwa/
  index.html   every screen, as markup
  app.css      IWMI's design system, light and dark (see below)
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

## How it looks

The palette, type and hairlines are Explorer's, value for value from
`services/explorer/static/iwmi-explorer.css` in the `open_data_cube` repo: navy
`#28537D`, the `#f2f3f4` page, white cards on `#e8e7e7`, white fields on `#dcdee1`
with a blue focus ring, the five-step ink ramp, DM Serif Text over Public Sans, and
the real IWMI wordmark. The uploader, Explorer and the two guides are one family.

The toggle beside Help switches between **Light** and **Dark**, and remembers. Both
options are visible with the one in force filled, so the choice is one click and no
guesswork. Until somebody chooses, it follows the machine — showing whichever look
the system asks for, and changing with it at dusk; clicking either half makes it
explicit. Dark is the same palette turned down — the same navy, lifted to `#7fb0e0` where it
carries text on a dark ground, and the same green/amber/orange for pass, warn and
fail. It is all tokens, so no component knows which look it is drawing in; four
things that cannot follow a token (the primary button's text, the upload bar's
translucency, the brand block and the log card) are handled explicitly.

The choice is applied by a small inline script in `<head>` before first paint, so a
dark app never flashes light on launch, and `<meta name="theme-color">` moves with
it so the browser's own chrome matches.

## At different sizes

The top bar never wraps. It drops the `IWMIHQ · Hugging Face Hub` line at 1080px and
the app's name at 880px, and at **700px the whole rail collapses into a menu** —
sections, Install, Help, Settings and the appearance toggle, each with its name back,
which three unlabelled icons could not give them. The menu marks the section you are
in, closes on Escape or a click outside, and keeps its appearance toggle in step with
the one in the bar.

Below 900px the two-column upload view stacks; below 620px *tall* the file, README
and log panels give up their fixed heights so a short window scrolls as one page.

## Whose repository is it

The Hub has no per-repository owner inside an organization: everything in IWMIHQ
belongs to IWMIHQ, and org write access reaches all of it. **This app cannot enforce
ownership** — the same token works from the CLI. What it does is make ownership
visible before an upload and put friction in front of the case that is almost always
a mistake.

- **Maintainers live in the repository**, as a `maintainers:` list in the README
  front matter this app writes. Creating lists you; adding to someone else's keeps
  their names and appends yours — uploading never takes a repository over.
- **Choosing an existing repository reads it first**: who maintains it, and whether
  your token can write to it at all (`checkRepoAccess`), so a 403 arrives at the
  picker rather than after a long upload.
- **If you are not listed**, the pre-flight check fails and the upload button stays
  disabled until you type the repository's name — the same friction the data cube
  uses for removals. Going ahead is then deliberate, and the commit says who did it.
- **The picker offers what you have uploaded to** first, marked "— yours", with a
  checkbox to show everything.

If this has to be *enforced* rather than made hard to do by accident, the options are
Hugging Face **resource groups** (Enterprise Hub — `createRepo` already accepts a
`resourceGroupId`), per-person **fine-grained tokens** scoped to their own
repositories, or a review gate holding the only write token, as the data cube does
for product changes.

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
- Icons come from Bootstrap Icons (MIT) as a subset sprite. Add one to the list in
  `build_icons.py` and re-run it.

## What this replaces

The Electron shell, `backend.py`, the PyInstaller step and the NSIS installer all exist
to do what a PWA does by itself — a window, an icon, and a token kept out of the client.
Nothing here needs them. Retire them once this is deployed and people have installed it;
until then they are untouched.
