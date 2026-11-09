(() => {
  "use strict";
  const svg = document.querySelector("#revoy-map");
  const stage = document.querySelector(".stage");
  const status = document.querySelector("#status");
  const nodes = [...svg.querySelectorAll(".node")];
  const relations = [...svg.querySelectorAll(".relation")];
  const nodeById = new Map(nodes.map((node) => [node.dataset.id, node]));
  const relationById = new Map(relations.map((relation) => [relation.dataset.id, relation]));
  const presets = ["classic", "signal-flow", "blueprint", "editorial"];
  const originalViewBox = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  let viewBox = originalViewBox.slice();
  let selected = null;
  let drag = null;

  function setStatus(message) {
    status.textContent = message;
  }

  function clearFocus() {
    nodes.concat(relations).forEach((element) => element.classList.remove("dim", "active"));
  }

  function focus(ids, edgeIds) {
    clearFocus();
    if (!ids || !ids.length) return;
    const keep = new Set(ids);
    const edgeKeep = new Set(edgeIds || []);
    nodes.forEach((node) => node.classList.toggle("dim", !keep.has(node.dataset.id)));
    relations.forEach((relation) => relation.classList.toggle("dim", !edgeKeep.has(relation.dataset.id)));
    ids.forEach((id) => nodeById.get(id)?.classList.add("active"));
    (edgeIds || []).forEach((id) => relationById.get(id)?.classList.add("active"));
  }

  function writeHash(params) {
    const value = new URLSearchParams(params);
    history.replaceState(null, "", value.toString() ? "#" + value.toString() : location.pathname + location.search);
  }

  function selectNode(id, update = true) {
    if (!nodeById.has(id)) return;
    selected = id;
    focus([id]);
    setStatus("Focused authored node: " + id);
    if (update) writeHash({ focus: id });
  }

  function authoredReach(direction, update = true) {
    if (!selected) {
      setStatus("Select a node before tracing reach.");
      return;
    }
    const seen = new Set([selected]);
    const used = [];
    let frontier = [selected];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const edge of MODEL.edges) {
          const match = direction === "upstream" ? edge.to === id : edge.from === id;
          if (!match) continue;
          const other = direction === "upstream" ? edge.from : edge.to;
          used.push(edge.id);
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    focus([...seen], used);
    setStatus(direction + " authored reach: " + [...seen].join(" → "));
    if (update) writeHash({ focus: selected, reach: direction });
  }

  function directedRoute(source, target, update = true) {
    if (!nodeById.has(source) || !nodeById.has(target)) {
      setStatus("Route endpoints must be authored node IDs.");
      return false;
    }
    const queue = [[source, []]];
    const seen = new Set([source]);
    while (queue.length) {
      const [id, path] = queue.shift();
      if (id === target) {
        const ids = [source];
        const edgeIds = [];
        for (const edge of path) {
          edgeIds.push(edge.id);
          ids.push(edge.to);
        }
        selected = source;
        focus(ids, edgeIds);
        setStatus("Authored route: " + ids.join(" → "));
        if (update) writeHash({ route: source + "~" + target });
        return true;
      }
      for (const edge of MODEL.edges.filter((candidate) => candidate.from === id)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push([edge.to, path.concat(edge)]);
      }
    }
    setStatus("No authored directed route from " + source + " to " + target + ".");
    return false;
  }

  function applyView(id, update = true) {
    const view = MODEL.views.find((candidate) => candidate.id === id);
    if (!view) return;
    focus(view.focus);
    setStatus(view.note || view.label);
    if (update) writeHash({ view: id });
  }

  function applyLens(kind, update = true) {
    const ids = MODEL.nodes.filter((node) => node.kind === kind).map((node) => node.id);
    const edges = MODEL.edges.filter((edge) => ids.includes(edge.from) || ids.includes(edge.to)).map((edge) => edge.id);
    focus(ids, edges);
    setStatus("Semantic role lens: " + kind + " (" + ids.length + " authored nodes)");
    if (update) writeHash({ lens: kind });
  }

  function applyHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("route")) {
      const [source, target] = params.get("route").split("~");
      directedRoute(source, target, false);
    } else if (params.has("view")) {
      applyView(params.get("view"), false);
    } else if (params.has("lens")) {
      applyLens(params.get("lens"), false);
    } else if (params.has("focus")) {
      selectNode(params.get("focus"), false);
      if (params.has("reach")) authoredReach(params.get("reach"), false);
    }
  }

  nodes.forEach((node) => {
    node.addEventListener("click", () => selectNode(node.dataset.id));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectNode(node.dataset.id);
    });
  });
  document.querySelector("#up").addEventListener("click", () => authoredReach("upstream"));
  document.querySelector("#down").addEventListener("click", () => authoredReach("downstream"));
  document.querySelector("#route").addEventListener("click", () => {
    const source = selected || prompt("Route source ID", "");
    const target = prompt("Route target ID", "");
    if (source && target) directedRoute(source, target);
  });
  document.querySelector("#source").addEventListener("click", () => {
    const node = MODEL.nodes.find((candidate) => candidate.id === selected);
    const source = node?.sources?.[0];
    if (!source?.url) {
      setStatus(selected ? "No revision-verified source is authored for " + selected + "." : "Select a source-backed node first.");
      return;
    }
    window.open(source.url, "_blank", "noopener,noreferrer");
  });

  const viewSelect = document.querySelector("#views");
  for (const view of MODEL.views) {
    const option = document.createElement("option");
    option.value = view.id;
    option.textContent = view.label;
    viewSelect.append(option);
  }
  viewSelect.addEventListener("change", () => applyView(viewSelect.value));

  const lensSelect = document.querySelector("#lens");
  for (const kind of [...new Set(MODEL.nodes.map((node) => node.kind))].sort()) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    lensSelect.append(option);
  }
  lensSelect.addEventListener("change", () => applyLens(lensSelect.value));

  document.querySelector("#search").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) {
      clearFocus();
      return;
    }
    const ids = MODEL.nodes.filter((node) => node.id.toLowerCase().includes(query) || node.label.toLowerCase().includes(query)).map((node) => node.id);
    focus(ids);
    setStatus(ids.length + " authored node match(es).");
  });

  document.querySelector("#theme").addEventListener("click", () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  });
  document.querySelector("#preset").addEventListener("click", () => {
    const index = presets.indexOf(document.documentElement.dataset.preset);
    document.documentElement.dataset.preset = presets[(index + 1) % presets.length];
  });
  document.querySelector("#present").addEventListener("click", () => document.body.classList.toggle("presentation"));

  function setViewBox(next) {
    viewBox = next;
    svg.setAttribute("viewBox", next.join(" "));
  }

  function zoom(factor, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const px = clientX === undefined ? .5 : Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const py = clientY === undefined ? .5 : Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const nextWidth = Math.max(originalViewBox[2] / 4, Math.min(originalViewBox[2] * 2, viewBox[2] / factor));
    const nextHeight = Math.max(originalViewBox[3] / 4, Math.min(originalViewBox[3] * 2, viewBox[3] / factor));
    setViewBox([viewBox[0] + (viewBox[2] - nextWidth) * px, viewBox[1] + (viewBox[3] - nextHeight) * py, nextWidth, nextHeight]);
  }
  document.querySelector("#zoomIn").addEventListener("click", () => zoom(1.22));
  document.querySelector("#zoomOut").addEventListener("click", () => zoom(1 / 1.22));
  document.querySelector("#reset").addEventListener("click", () => {
    setViewBox(originalViewBox.slice());
    clearFocus();
    writeHash({});
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, viewBox: viewBox.slice() };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const dx = (event.clientX - drag.x) * drag.viewBox[2] / rect.width;
    const dy = (event.clientY - drag.y) * drag.viewBox[3] / rect.height;
    setViewBox([drag.viewBox[0] - dx, drag.viewBox[1] - dy, drag.viewBox[2], drag.viewBox[3]]);
  });
  stage.addEventListener("pointerup", () => { drag = null; });

  document.querySelector("#overview").addEventListener("click", () => {
    const current = document.querySelector(".overview");
    if (current) {
      current.remove();
      return;
    }
    const clone = svg.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("overview");
    clone.setAttribute("viewBox", originalViewBox.join(" "));
    document.body.append(clone);
  });

  function canonicalSvg() {
    const clone = svg.cloneNode(true);
    clone.querySelectorAll(".dim,.active").forEach((element) => element.classList.remove("dim", "active"));
    clone.setAttribute("viewBox", originalViewBox.join(" "));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    const computed = getComputedStyle(document.body);
    style.textContent = ".node rect{fill:" + computed.getPropertyValue("--node") + ";stroke:" + computed.getPropertyValue("--line") + ";stroke-width:2}.node text{fill:" + computed.getPropertyValue("--ink") + "}.node-detail,.edge-label,.boundary text{fill:" + computed.getPropertyValue("--muted") + "}.relation path,.lifeline{fill:none;stroke:" + computed.getPropertyValue("--line") + ";stroke-width:2}.boundary rect{fill:none;stroke:" + computed.getPropertyValue("--line") + ";stroke-dasharray:8 7}.edge-label{font-size:10px;text-anchor:middle}.node-label{font-size:15px;font-weight:700}";
    clone.prepend(style);
    return new XMLSerializer().serializeToString(clone);
  }

  function download(blob, filename) {
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  function svgImage() {
    return new Promise((resolveImage, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(new Blob([canonicalSvg()], { type: "image/svg+xml" }));
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolveImage(image);
      };
      image.onerror = reject;
      image.src = url;
    });
  }

  async function rasterCanvas(width, height, shareCard) {
    const image = await svgImage();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const computed = getComputedStyle(document.body);
    context.fillStyle = computed.getPropertyValue("--bg");
    context.fillRect(0, 0, width, height);
    const titleHeight = shareCard ? 72 : 0;
    if (shareCard) {
      context.fillStyle = computed.getPropertyValue("--ink");
      context.font = "700 30px system-ui";
      context.fillText(MODEL.title, 36, 45);
    }
    const scale = Math.min((width - 40) / image.width, (height - titleHeight - 30) / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    context.drawImage(image, (width - drawWidth) / 2, titleHeight + (height - titleHeight - drawHeight) / 2, drawWidth, drawHeight);
    return canvas;
  }

  async function exportWebm() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      setStatus("WebM export is unsupported in this browser.");
      return;
    }
    const canvas = await rasterCanvas(1200, 675, false);
    const context = canvas.getContext("2d");
    const background = context.getImageData(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolveFinished) => { recorder.onstop = resolveFinished; });
    recorder.start();
    const path = svg.querySelector(".relation path");
    const length = path ? path.getTotalLength() : 1;
    const transform = svg.getScreenCTM();
    const start = performance.now();
    await new Promise((resolveAnimation) => {
      function frame(now) {
        context.putImageData(background, 0, 0);
        const progress = Math.min(1, (now - start) / 1800);
        if (path && transform) {
          const point = path.getPointAtLength(length * progress);
          const screen = new DOMPoint(point.x, point.y).matrixTransform(transform);
          const rect = svg.getBoundingClientRect();
          const x = (screen.x - rect.left) / rect.width * canvas.width;
          const y = (screen.y - rect.top) / rect.height * canvas.height;
          context.beginPath();
          context.fillStyle = getComputedStyle(document.body).getPropertyValue("--accent");
          context.arc(x, y, 8, 0, Math.PI * 2);
          context.fill();
        }
        if (progress < 1) requestAnimationFrame(frame);
        else resolveAnimation();
      }
      requestAnimationFrame(frame);
    });
    recorder.stop();
    await finished;
    stream.getTracks().forEach((track) => track.stop());
    download(new Blob(chunks, { type: mimeType }), "revoy-map.webm");
    setStatus("Exported finite WebM trace.");
  }

  async function exportArtifact(format) {
    if (format === "svg") {
      download(new Blob([canonicalSvg()], { type: "image/svg+xml" }), "revoy-map.svg");
      return;
    }
    if (format === "webm") {
      await exportWebm();
      return;
    }
    const share = format === "share";
    const canvas = await rasterCanvas(share ? 1200 : originalViewBox[2] * 2, share ? 630 : originalViewBox[3] * 2, share);
    const mime = share || format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
    const extension = share ? "share-card.png" : format === "jpeg" ? "jpeg" : format;
    canvas.toBlob((blob) => download(blob, "revoy-map." + extension), mime, .94);
  }

  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportArtifact(button.dataset.export)));

  function containment() {
    const contained = document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight;
    document.documentElement.dataset.contained = String(contained);
    document.documentElement.dataset.scrollWidth = String(document.documentElement.scrollWidth);
    document.documentElement.dataset.scrollHeight = String(document.documentElement.scrollHeight);
  }
  window.RevoyMap = Object.freeze({ selectNode, authoredReach, directedRoute, applyView, applyLens, applyHash, exportArtifact, canonicalSvg, containment });
  document.documentElement.dataset.runtimeReady = "true";
  document.documentElement.dataset.mediaRecorder = String(Boolean(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream));
  addEventListener("resize", containment);
  addEventListener("hashchange", applyHash);
  addEventListener("load", () => {
    applyHash();
    containment();
  });
  addEventListener("keydown", (event) => {
    if (event.key === "/") {
      event.preventDefault();
      document.querySelector("#search").focus();
    } else if (event.key.toLowerCase() === "t") {
      document.querySelector("#theme").click();
    } else if (event.key.toLowerCase() === "f") {
      document.querySelector("#present").click();
    } else if (event.key === "+") {
      document.querySelector("#zoomIn").click();
    } else if (event.key === "-") {
      document.querySelector("#zoomOut").click();
    } else if (event.key === "0") {
      document.querySelector("#reset").click();
    }
  });
})();
