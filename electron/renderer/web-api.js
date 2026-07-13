// Browser fallback for the Electron preload bridge.
// When the app is opened in a normal browser (served by backend.py) there is no
// window.api, so we provide a same-origin implementation. Browsers can't hand us
// local file paths, so file selection uploads the bytes to /api/stage, which
// writes them to a temp dir and returns the same {path, rel, size} descriptors
// the Electron flow uses — the rest of the app is then identical.
(function () {
  if (window.api) return; // Electron already injected the bridge — do nothing.

  async function stage(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return [];
    const fd = new FormData();
    const rels = [];
    for (const f of files) {
      fd.append("files", f, f.name);
      rels.push(f.webkitRelativePath || f.name); // folder uploads keep structure
    }
    fd.append("rels", JSON.stringify(rels));
    const res = await fetch("/api/stage", { method: "POST", body: fd });
    const data = await res.json();
    return data.files || [];
  }

  function pick(attrs) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      Object.assign(input, attrs);
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const staged = await stage(input.files);
        input.remove();
        resolve(staged);
      });
      input.click();
    });
  }

  window.api = {
    isElectron: false,
    backendBase: "", // same origin
    openFiles: () => pick({ multiple: true }),
    openFolder: () => pick({ multiple: true, webkitdirectory: true }),
    stageDropped: (fileList) => stage(fileList),
    openExternal: (url) => window.open(url, "_blank", "noopener"),
    minimize: () => {},
    maximize: () => {},
    close: () => {},
  };
})();
