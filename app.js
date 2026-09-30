(function applySavedTheme() {
  const saved = localStorage.getItem("codex-studys-theme");
  if (!saved || saved === "system") return;
  document.documentElement.setAttribute("data-theme", saved);
})();

const FALLBACK_THUMB = "assets/codex-telegram.png";
let allBatches = [];
let activeFilter = "all";
let searchQuery = "";
let sortMode = "relevance";
let langFilter = "all";
let visibleCount = 24;
const PAGE_SIZE = 24;

const $ = (selector) => document.querySelector(selector);
const THUMB_PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
window.__thumbFallback = (img) => { img.outerHTML = THUMB_PLACEHOLDER_SVG; };
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));
}

function categoryFor(batch) {
  const text = `${batch.name || ""} ${batch.byName || ""}`.toLowerCase();
  if (/railway|\brrb\b|\bntpc\b|\balp\b|\brpf\b|group[\s-]?d\b/.test(text)) return "railway";
  if (/bank|ibps|\bsbi\b|\brbi\b|\bpo\b|nabard/.test(text)) return "banking";
  if (/\bssc\b|\bcgl\b|\bchsl\b|\bmts\b|\bcpo\b|\bgd\b|stenographer/.test(text)) return "ssc";
  if (/police|constable|\bsi\b|defence|defense|army|agniveer|\bnda\b|\bcds\b|airforce|air force/.test(text)) return "police";
  if (/teach|\btet\b|ctet|reet|\bkvs\b|\bnvs\b|\btgt\b|\bpgt\b|\bprt\b|b\.?ed/.test(text)) return "teaching";
  if (/upsc|\bias\b|civil services|\bpcs\b|bpsc|uppsc|mppsc|rpsc/.test(text)) return "upsc";
  return "exam";
}

/* Robust date parsing for RWA fields (dd-mm-yyyy, yyyy-mm-dd, "01 Jul 2028", unix seconds/ms). */
function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  let date;
  if (/^\d{9,13}$/.test(raw)) {
    const n = Number(raw);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    const m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
    date = m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : new Date(raw);
  }
  return isNaN(date) ? null : date;
}

function deepSearchText(batch) {
  if (batch.__searchText) return batch.__searchText;
  const parts = [batch.name, batch.byName, batch.language, batch.type, (batch.slug || "").replace(/-/g, " ")];
  (batch.subBatches || []).forEach((sub) => parts.push(sub.name, sub.byName));
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  Object.defineProperty(batch, "__searchText", { value: text, enumerable: false, writable: true });
  return text;
}

function deepSearchScore(batch, queryWords, rawQuery) {
  const name = (batch.name || "").toLowerCase();
  const text = deepSearchText(batch);
  if (!queryWords.every((word) => text.includes(word))) return 0;
  if (name === rawQuery) return 100;
  if (name.startsWith(rawQuery)) return 80;
  if (name.includes(rawQuery)) return 60;
  if (queryWords.every((word) => name.includes(word))) return 40;
  return 20;
}

function deepSearch(batches, query) {
  const rawQuery = query.trim().toLowerCase();
  if (!rawQuery) return batches;
  const queryWords = rawQuery.split(/\s+/).filter(Boolean);
  return batches
    .map((batch) => ({ batch, score: deepSearchScore(batch, queryWords, rawQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.batch);
}

function openBatch(batch) {
  const id = batch && (batch._id || batch.batch_id);
  if (!id) return showToast("This course is not available right now.");
  addRecentlyViewed(batch);
  try { window.CXProfile && window.CXProfile.trackBatch(batch); } catch (e) {}
  renderRecentlyWatched();
  updateStats();
  // Stay inside Codexyt: open the in-app course viewer (Subjects → Chapters → Lectures/Notes).
  openViewer(batch);
}

/* ---------- RWA in-app course viewer: Subjects → Chapters → Lectures / Notes ---------- */
const RWA_CONTENT_HOSTS = ["https://maxxapis-rwa.vercel.app", "https://maxxapis-rwa2.vercel.app"];
const HLS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js";
const viewer = { open: false, course: null, stack: [], token: 0, tab: "lectures", hls: null, current: null };
const viewerCache = new Map();

function safeUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(url) ? url : "";
}

function firstOf(item, keys) {
  for (const key of keys) {
    const value = item && item[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

/* The API wraps its rows differently per endpoint, so collect every array of objects in the payload. */
function collectRows(payload, depth = 0, out = []) {
  if (!payload || depth > 3) return out;
  if (Array.isArray(payload)) {
    if (payload.some((row) => row && typeof row === "object" && !Array.isArray(row))) {
      payload.forEach((row) => { if (row && typeof row === "object" && !Array.isArray(row)) out.push(row); });
    }
    return out;
  }
  if (typeof payload === "object") Object.values(payload).forEach((value) => collectRows(value, depth + 1, out));
  return out;
}

async function fetchContent(path, params) {
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const urls = RWA_CONTENT_HOSTS.map((host) => `${host}/api/${path}?${query}`);
  const cacheKey = urls[0];
  if (viewerCache.has(cacheKey)) return viewerCache.get(cacheKey);
  let lastError = null;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Server ${response.status}`);
      const json = await response.json();
      const rows = collectRows(json);
      if (!rows.length && json && json.success === false) throw new Error("Server returned no data");
      viewerCache.set(cacheKey, rows);
      return rows;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Could not load content");
}

function normSubject(row) {
  return { id: String(firstOf(row, ["subjectid", "subject_id", "id"])), name: String(firstOf(row, ["subject_name", "subjectname", "name", "title"]) || "Subject") };
}
function normTopic(row) {
  return { id: String(firstOf(row, ["topicid", "topic_id", "id"])), name: String(firstOf(row, ["topic_name", "topicname", "name", "title"]) || "Chapter") };
}
/* RWA links can arrive AES-encrypted (same scheme the original RWA app used); plain http(s) links pass straight through. */
const RWA_AES_KEY = "638udh3829162018";
const RWA_AES_IV = "fedcba9876543210";
const urlCache = new Map();

async function aesDecryptLink(value) {
  if (!(window.crypto && window.crypto.subtle)) return "";
  let cipher = value;
  let ivText = RWA_AES_IV;
  if (value.includes(":")) {
    const parts = value.split(":");
    cipher = parts[0];
    try { const decoded = atob(parts[1]); if (decoded.length === 16) ivText = decoded; } catch (e) {}
  }
  const raw = atob(cipher.replace(/\s+/g, ""));
  const data = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 255);
  const iv = Uint8Array.from(ivText, (c) => c.charCodeAt(0) & 255);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RWA_AES_KEY), { name: "AES-CBC" }, false, ["decrypt"]);
  const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data);
  return new TextDecoder().decode(out).trim();
}

async function resolveUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (urlCache.has(text)) return urlCache.get(text);
  let result = "";
  try { result = safeUrl(await aesDecryptLink(text)); } catch (e) { result = ""; }
  urlCache.set(text, result);
  return result;
}

const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|txt)(\?|#|$)/i;

function qualityRank(label) {
  const n = parseInt(String(label), 10);
  return Number.isFinite(n) ? n : 9999;
}

/* Turns one API row into { lecture sources, note links }. No key / paywall checks anywhere. */
async function normRow(row) {
  const title = String(firstOf(row, ["title", "name", "video_title", "Title"]) || "Untitled");
  const sources = [];
  const seen = new Set();
  const addSource = (quality, url) => { if (url && !seen.has(url)) { seen.add(url); sources.push({ quality, url }); } };

  // 1) the player URL the API gives us, 2) every download_links quality, 3) other video-ish fields.
  addSource("Auto", await resolveUrl(firstOf(row, ["video_player_url"])));
  if (Array.isArray(row.download_links)) {
    const links = row.download_links
      .map((entry) => (typeof entry === "string" ? { quality: "", path: entry } : entry))
      .filter((entry) => entry && typeof entry === "object");
    const resolved = await Promise.all(links.map(async (entry, i) => ({ quality: String(entry.quality || `Link ${i + 1}`), url: await resolveUrl(entry.path || entry.link || entry.url || "") })));
    resolved.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality)).forEach((entry) => addSource(entry.quality, entry.url));
  }
  const extras = ["recording_hls", "video_url", "stream_url", "hls_url", "download_link", "download_link2"];
  for (const key of extras) addSource("Auto", await resolveUrl(firstOf(row, [key])));
  if (Array.isArray(row.livestream_links)) {
    for (const entry of row.livestream_links) {
      addSource("Live", await resolveUrl(typeof entry === "string" ? entry : (entry && (entry.path || entry.link || entry.url)) || ""));
    }
  }

  const fileLink = await resolveUrl(firstOf(row, ["file_link"]));
  const notes = [];
  const noteSeen = new Set();
  const addNote = (label, url) => { if (url && !noteSeen.has(url)) { noteSeen.add(url); notes.push({ title: label, url }); } };
  addNote(title, await resolveUrl(firstOf(row, ["pdf_link"])));
  addNote(`${title} (2)`, await resolveUrl(firstOf(row, ["pdf_link2"])));
  if (fileLink) {
    if (DOC_EXT.test(fileLink) || !sources.length) { if (DOC_EXT.test(fileLink)) addNote(title, fileLink); else addSource("Auto", fileLink); }
    else addSource("Auto", fileLink);
  }
  return { title, sources, notes };
}

async function normContent(rows) {
  const parsed = await Promise.all(rows.map(normRow));
  const lectures = [];
  const notes = [];
  parsed.forEach((item) => {
    if (item.sources.length) {
      // Default quality: 360p/240p style low-data option if present, otherwise the first source.
      lectures.push({ title: item.title, sources: item.sources, url: item.sources[0].url });
    }
    item.notes.forEach((note) => notes.push(note));
  });
  return { lectures, notes };
}

function viewerEls() {
  return { modal: document.getElementById("courseViewer"), body: document.getElementById("vwBody"), title: document.getElementById("vwTitle"), crumb: document.getElementById("vwCrumb"), back: document.getElementById("vwBack"), backLabel: document.getElementById("vwBackLabel") };
}

function stopPlayer() {
  if (viewer.hls) { try { viewer.hls.destroy(); } catch (e) {} viewer.hls = null; }
  const holder = document.getElementById("vwPlayer");
  if (holder) { holder.querySelector("video")?.pause?.(); holder.innerHTML = ""; holder.style.display = "none"; }
}

function openViewer(course) {
  const id = String(course._id || course.batch_id || "");
  if (!id) return showToast("This course is not available right now.");
  viewer.course = { id, name: course.name || "Course" };
  viewer.stack = [{ level: "subjects" }];
  viewer.token += 1;
  viewer.open = true;
  try { history.pushState({ cxv: 1 }, ""); } catch (e) {}
  openModal("courseViewer");
  renderViewer();
}

function closeViewer() {
  if (!viewer.open) return;
  const depth = viewer.stack.length;
  viewer.open = false;
  viewer.token += 1;
  stopPlayer();
  document.getElementById("courseViewer")?.classList.remove("visible");
  if (!$$(".overlay.visible").length) document.body.classList.remove("modal-open");
  try { history.go(-depth); } catch (e) {}
}

function viewerPush(step) {
  viewer.stack.push(step);
  try { history.pushState({ cxv: viewer.stack.length }, ""); } catch (e) {}
  renderViewer();
}

function viewerBack() {
  if (!viewer.open) return;
  try { history.back(); } catch (e) { closeViewer(); }
}

window.addEventListener("popstate", (event) => {
  if (!viewer.open) return;
  const depth = (event.state && event.state.cxv) || 0;
  if (depth < 1) {
    viewer.open = false;
    viewer.token += 1;
    stopPlayer();
    document.getElementById("courseViewer")?.classList.remove("visible");
    if (!$$(".overlay.visible").length) document.body.classList.remove("modal-open");
    return;
  }
  viewer.stack.length = Math.min(depth, viewer.stack.length);
  renderViewer();
});

function viewerState(html) {
  return `<div class="vw-state">${html}</div>`;
}

function renderViewer() {
  const { body, title, crumb, backLabel } = viewerEls();
  if (!body) return;
  const step = viewer.stack[viewer.stack.length - 1];
  const token = ++viewer.token;
  stopPlayer();
  title.textContent = viewer.course.name;
  const crumbs = viewer.stack.slice(1).map((s) => s.name);
  crumb.textContent = crumbs.join(" › ");
  backLabel.textContent = step.level === "subjects" ? "Course Library" : step.level === "topics" ? "Back to Subjects" : "Back to Chapters";
  body.scrollTop = 0;
  if (step.level === "subjects") loadLevel(token, "subjects", { courseid: viewer.course.id }, (rows) => rows.map(normSubject).filter((s) => s.id), renderSubjects);
  else if (step.level === "topics") loadLevel(token, "topics", { courseid: viewer.course.id, subjectid: step.subject.id }, (rows) => rows.map(normTopic).filter((t) => t.id), renderTopics);
  else loadLevel(token, "videos", { courseid: viewer.course.id, subjectid: step.subject.id, topicid: step.topic.id }, normContent, renderContent);
}

async function loadLevel(token, path, params, normalize, render) {
  const { body } = viewerEls();
  body.innerHTML = viewerState('<div class="vw-spinner"></div><div>Loading…</div>');
  try {
    const rows = await fetchContent(path, params);
    if (token !== viewer.token) return;
    render(await normalize(rows));
  } catch (error) {
    if (token !== viewer.token) return;
    console.error(error);
    body.innerHTML = viewerState('<div>Could not load this section. Please check your connection.</div><button class="btn btn-primary" type="button" data-vw="retry">Try again</button>');
  }
}

function renderSubjects(subjects) {
  const { body } = viewerEls();
  if (!subjects.length) { body.innerHTML = viewerState("No subjects found for this course yet."); return; }
  body.innerHTML = `<div class="vw-list">${subjects.map((s, i) => `<button class="vw-item" type="button" data-vw="subject" data-i="${i}"><span class="vw-item-ico">📘</span><span class="vw-item-name">${escapeHtml(s.name)}</span><span class="vw-chev">›</span></button>`).join("")}</div>`;
  body._items = subjects;
}

function renderTopics(topics) {
  const { body } = viewerEls();
  if (!topics.length) { body.innerHTML = viewerState("No chapters found in this subject yet."); return; }
  body.innerHTML = `<div class="vw-list">${topics.map((t, i) => `<button class="vw-item" type="button" data-vw="topic" data-i="${i}"><span class="vw-item-ico">📂</span><span class="vw-item-name">${escapeHtml(t.name)}</span><span class="vw-chev">›</span></button>`).join("")}</div>`;
  body._items = topics;
}

function renderContent(content) {
  const { body } = viewerEls();
  body._items = content;
  if (!content.lectures.length && content.notes.length) viewer.tab = "notes";
  else if (!content.notes.length && content.lectures.length) viewer.tab = "lectures";
  drawContentTabs();
}

function drawContentTabs() {
  const { body } = viewerEls();
  const content = body._items || { lectures: [], notes: [] };
  const isLec = viewer.tab === "lectures";
  const list = isLec
    ? content.lectures.map((l, i) => `<button class="vw-item" type="button" data-vw="play" data-i="${i}"><span class="vw-item-ico">▶</span><span class="vw-item-name">${escapeHtml(l.title)}</span><span class="vw-chev">›</span></button>`).join("")
    : content.notes.map((n) => `<div class="vw-item vw-note"><span class="vw-item-ico">📄</span><span class="vw-item-name">${escapeHtml(n.title)}</span><span class="vw-note-actions"><a class="vw-mini" href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">View</a><a class="vw-mini" href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer" download>Download</a></span></div>`).join("");
  const empty = isLec ? "No lectures in this chapter." : "No notes in this chapter.";
  body.innerHTML = `<div class="vw-player" id="vwPlayer" style="display:none"></div>
    <div class="vw-tabs" role="tablist">
      <button class="vw-tab${isLec ? " active" : ""}" type="button" role="tab" aria-selected="${isLec}" data-vw="tab" data-tab="lectures">Lectures (${content.lectures.length})</button>
      <button class="vw-tab${!isLec ? " active" : ""}" type="button" role="tab" aria-selected="${!isLec}" data-vw="tab" data-tab="notes">Notes (${content.notes.length})</button>
    </div>
    <div class="vw-list">${list || viewerState(empty)}</div>`;
  body._items = content;
}

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HLS_SRC;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error("Player library failed to load"));
    document.head.appendChild(script);
  });
}

async function playLecture(lecture, sourceIndex = 0) {
  const holder = document.getElementById("vwPlayer");
  if (!holder) return;
  stopPlayer();
  viewer.current = lecture;
  holder.style.display = "block";
  const sources = lecture.sources && lecture.sources.length ? lecture.sources : [{ quality: "Auto", url: lecture.url }];
  const active = Math.min(Math.max(sourceIndex, 0), sources.length - 1);
  const url = sources[active].url;
  const quality = sources.length > 1
    ? `<div class="vw-quality">${sources.map((src, i) => `<button class="vw-mini${i === active ? " vw-on" : ""}" type="button" data-vw="quality" data-q="${i}">${escapeHtml(src.quality)}</button>`).join("")}</div>`
    : "";
  const head = `<div class="vw-player-head"><span class="vw-player-title">${escapeHtml(lecture.title)}</span><span class="vw-player-actions"><a class="vw-mini" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in new tab</a><button class="vw-mini vw-done" type="button" data-vw="done">Done</button></span></div>${quality}`;
  const isHls = /\.m3u8(\?|#|$)/i.test(url);
  const isFile = /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
  if (isHls || isFile) {
    holder.innerHTML = `${head}<div class="vw-frame"><video controls playsinline autoplay></video></div>`;
    const video = holder.querySelector("video");
    if (isFile || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      try {
        const Hls = await loadHls();
        if (!Hls || !Hls.isSupported()) throw new Error("HLS unsupported");
        viewer.hls = new Hls();
        viewer.hls.loadSource(url);
        viewer.hls.attachMedia(video);
      } catch (error) {
        holder.querySelector(".vw-frame").innerHTML = viewerState("This stream can't play here. Use “Open in new tab”.");
      }
    }
  } else {
    holder.innerHTML = `${head}<div class="vw-frame"><iframe src="${escapeHtml(url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe></div>`;
  }
  holder.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setupViewer() {
  const { body, back, modal } = viewerEls();
  if (!body || !modal) return;
  back.addEventListener("click", viewerBack);
  body.addEventListener("click", (event) => {
    const target = event.target.closest("[data-vw]");
    if (!target) return;
    const action = target.dataset.vw;
    const step = viewer.stack[viewer.stack.length - 1];
    const index = Number(target.dataset.i);
    if (action === "retry") renderViewer();
    else if (action === "subject" && body._items[index]) viewerPush({ level: "topics", subject: body._items[index], name: body._items[index].name });
    else if (action === "topic" && body._items[index]) viewerPush({ level: "content", subject: step.subject, topic: body._items[index], name: body._items[index].name, });
    else if (action === "tab") { stopPlayer(); viewer.tab = target.dataset.tab; drawContentTabs(); }
    else if (action === "play" && body._items.lectures[index]) playLecture(body._items.lectures[index]);
    else if (action === "done") { stopPlayer(); viewer.current = null; }
    else if (action === "quality" && viewer.current) playLecture(viewer.current, Number(target.dataset.q));
  });
}

function getRecentlyViewed() {
  try { return JSON.parse(localStorage.getItem("codex-studys-recent") || "[]"); }
  catch { return []; }
}

function addRecentlyViewed(batch) {
  const id = batch._id || batch.batch_id;
  if (!id) return;
  const entry = { _id: id, name: batch.name || "Untitled course", byName: batch.byName || "", language: batch.language || "", previewImage: batch.previewImage || "", startDate: batch.startDate || "", endDate: batch.endDate || "", type: batch.type || "", slug: batch.slug || "" };
  const recent = getRecentlyViewed().filter((item) => item._id !== id);
  recent.unshift(entry);
  localStorage.setItem("codex-studys-recent", JSON.stringify(recent.slice(0, 8)));
}

function renderRecentlyWatched() {
  const statRecent = document.getElementById("statRecent");
  if (statRecent) statRecent.textContent = String(getRecentlyViewed().length);
  const section = document.getElementById("recentSection");
  const row = document.getElementById("recentRow");
  if (!section || !row) return;
  const items = getRecentlyViewed();
  if (!items.length) { section.style.display = "none"; row.innerHTML = ""; return; }
  section.style.display = "block";
  row.innerHTML = items.map((item) => `
    <button class="recent-item" type="button" data-recent-id="${escapeHtml(item._id)}">
      <img class="recent-thumb" src="${escapeHtml(item.previewImage || FALLBACK_THUMB)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK_THUMB}'">
      <span class="recent-info">
        <span class="recent-name">${escapeHtml(item.name || "Course")}</span>
        <span class="recent-sub">${escapeHtml(item.byName || item.language || "Continue watching")}</span>
      </span>
    </button>`).join("");
  row.querySelectorAll("[data-recent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.recentId;
      const full = allBatches.find((batch) => (batch._id || batch.batch_id) === id);
      openBatch(full || items.find((item) => item._id === id));
    });
  });
}

function setupRecentlyWatched() {
  renderRecentlyWatched();
  document.getElementById("recentClearBtn")?.addEventListener("click", () => {
    localStorage.removeItem("codex-studys-recent");
    renderRecentlyWatched();
    showToast("Recently watched cleared.");
  });
}

function setupQuickInstall() {
  const button = document.getElementById("installQuickBtn");
  if (!button) return;
  button.addEventListener("click", () => openModal("installModal"));
}

function getFavorites() {
  try { return JSON.parse(localStorage.getItem("codex-studys-favorites") || "[]"); }
  catch { return []; }
}

function isFavorite(id) {
  return getFavorites().includes(id);
}

function toggleFavorite(id) {
  const favorites = getFavorites();
  const index = favorites.indexOf(id);
  if (index === -1) favorites.push(id); else favorites.splice(index, 1);
  localStorage.setItem("codex-studys-favorites", JSON.stringify(favorites));
  return favorites.includes(id);
}

function updateFavoritesCount() {
  const count = getFavorites().length;
  const button = $('.filter-row .filter[data-filter="favorites"]');
  if (button) button.textContent = count ? `❤ Favorite Batches (${count})` : "❤ Favorite Batches";
  const navBadge = $("#favNavBadge");
  if (navBadge) {
    navBadge.textContent = String(count);
    navBadge.style.display = count ? "grid" : "none";
  }
  const statFav = $("#statFav");
  if (statFav) statFav.textContent = count.toLocaleString();
}

function filteredBatches() {
  let batches;
  if (activeFilter === "favorites") {
    const favorites = getFavorites();
    batches = allBatches.filter((batch) => favorites.includes(batch._id || batch.batch_id || ""));
  } else {
    batches = allBatches.filter((batch) => activeFilter === "all" || categoryFor(batch) === activeFilter);
  }
  if (langFilter !== "all") {
    batches = batches.filter((batch) => (batch.language || "").toLowerCase().includes(langFilter));
  }
  if (searchQuery.trim()) {
    batches = deepSearch(batches, searchQuery);
  }
  if (sortMode === "az") {
    batches = [...batches].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } else if (sortMode === "za") {
    batches = [...batches].sort((a, b) => (b.name || "").localeCompare(a.name || ""));
  } else if (sortMode === "newest") {
    batches = [...batches].sort((a, b) => ((parseDate(b.startDate) || 0) - (parseDate(a.startDate) || 0)));
  }
  return batches;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function isRecent(value) {
  const date = parseDate(value);
  if (!date) return false;
  const days = (Date.now() - date.getTime()) / 86400000;
  return days >= 0 && days <= 21;
}

function courseCard(batch) {
  const title = escapeHtml(batch.name || "Untitled course");
  const description = escapeHtml(batch.byName || "Structured learning for your next milestone");
  const language = escapeHtml(batch.language || "Self-paced");
  const category = categoryFor(batch);
  const image = escapeHtml(batch.previewImage || FALLBACK_THUMB);
  const id = escapeHtml(batch._id || batch.batch_id || "");
  const favActive = isFavorite(id);
  const startDate = formatDate(batch.startDate);
  const fresh = isRecent(batch.startDate);
  return `
    <article class="course-card" data-id="${id}" tabindex="0" role="button" aria-label="Open ${title}">
      <div class="course-thumb">
        <div class="thumb-fallback thumb-shimmer"></div>
        <img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('loaded');this.previousElementSibling.style.display='none'" onerror="this.style.display='none'">
        <span class="course-tag">${escapeHtml(category)}</span>
        ${fresh ? '<span class="course-tag course-tag-new">NEW</span>' : ""}
        <button class="fav-btn${favActive ? " active" : ""}" type="button" data-fav-id="${id}" aria-label="${favActive ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${favActive}">
          <svg viewBox="0 0 24 24" fill="${favActive ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 21s-7.2-4.5-9.6-9C.6 8.1 2.4 4.5 6 4.2c2.1-.15 3.6 1.05 6 3.3 2.4-2.25 3.9-3.45 6-3.3 3.6.3 5.4 3.9 3.6 7.8-2.4 4.5-9.6 9-9.6 9Z"/></svg>
        </button>
        <button class="info-btn" type="button" data-info-id="${id}" aria-label="Quick view details">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.6"/></svg>
        </button>
        ${getNote(id) ? '<span class="note-badge">📝 Note</span>' : ""}
      </div>
      <div class="course-chips"><span class="chip">${language}</span><span class="chip chip-accent">${escapeHtml(category)}</span></div>
      <div class="course-body">
        <h3 class="course-title">${title}</h3>
        <p class="course-description">${description}</p>
        <div class="course-meta"><span>${startDate ? `📅 ${startDate}` : language}</span><button class="course-cta" type="button">Let's Study <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>
      </div>
    </article>`;
}

function syncUrlParams() {
  const params = new URLSearchParams();
  if (activeFilter !== "all") params.set("filter", activeFilter);
  if (searchQuery.trim()) params.set("q", searchQuery.trim());
  if (sortMode !== "relevance") params.set("sort", sortMode);
  if (langFilter !== "all") params.set("lang", langFilter);
  const query = params.toString();
  const newUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, "", newUrl);
}

function renderBatches() {
  const grid = $("#batchGrid");
  const loadMoreBtn = $("#loadMoreBtn");
  const batches = filteredBatches();
  const visible = batches.slice(0, visibleCount);
  const filterLabel = activeFilter === "all" ? "courses" : activeFilter === "favorites" ? "favorite courses" : `${activeFilter.toUpperCase()} courses`;
  const noteText = batches.length
    ? `Showing ${visible.length} of ${batches.length.toLocaleString()} ${filterLabel}.`
    : activeFilter === "favorites" ? "No favorites yet. Tap the heart on any course to save it here." : "No courses matched that filter yet.";
  $("#resultsNote").textContent = noteText;
  const announcer = $("#filterAnnouncer");
  if (announcer) announcer.textContent = noteText;
  grid.innerHTML = visible.length ? visible.map(courseCard).join("") : '<div class="empty">Try another category or search the full library.</div>';
  $$(".course-card").forEach((card, index) => {
    card.addEventListener("click", () => openBatch(visible[index]));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openBatch(visible[index]);
      }
    });
  });
  $$(".fav-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const nowActive = toggleFavorite(button.dataset.favId);
      button.classList.toggle("active", nowActive);
      button.setAttribute("aria-pressed", String(nowActive));
      button.querySelector("svg").setAttribute("fill", nowActive ? "currentColor" : "none");
      if (nowActive) {
        button.classList.remove("pop");
        void button.offsetWidth;
        button.classList.add("pop");
      }
      if (activeFilter === "favorites" && !nowActive) renderBatches();
      updateFavoritesCount();
    });
  });
  $$(".info-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const batch = visible.find((item) => (item._id || item.batch_id || "") === button.dataset.infoId);
      if (batch) openDetail(batch);
    });
  });
  if (loadMoreBtn) {
    const remaining = batches.length - visible.length;
    loadMoreBtn.style.display = remaining > 0 ? "inline-flex" : "none";
    loadMoreBtn.textContent = remaining > 0 ? "Loading more courses…" : "";
  }
  const clearBtn = $("#clearFiltersBtn");
  if (clearBtn) clearBtn.style.display = (activeFilter !== "all" || searchQuery.trim()) ? "inline-flex" : "none";
  syncUrlParams();
}

function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem("codex-studys-search-history") || "[]"); }
  catch { return []; }
}

function addSearchHistory(term) {
  const trimmed = term.trim();
  if (!trimmed) return;
  const history = getSearchHistory().filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
  history.unshift(trimmed);
  localStorage.setItem("codex-studys-search-history", JSON.stringify(history.slice(0, 6)));
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text || "");
  if (!query) return safe;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map((w) => escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return safe;
  return safe.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>");
}

function renderSearchResults(query = "") {
  const results = $("#searchResults");
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    const history = getSearchHistory();
    const recent = getRecentlyViewed();
    if (!history.length && !recent.length) {
      results.innerHTML = '<div class="search-hint">Start typing to find your next course.</div>';
      return;
    }
    let html = "";
    if (history.length) {
      html += `<div class="search-hint" style="text-align:left;margin-bottom:2px;">Recent searches</div>
        <div class="search-history-row">${history.map((term) => `<button type="button" class="search-history-chip">${escapeHtml(term)}</button>`).join("")}</div>`;
    }
    if (recent.length) {
      html += `<div class="search-hint" style="text-align:left;margin-bottom:2px;">Recently viewed</div>` + recent.map((batch) => `
        <div class="search-result" data-id="${escapeHtml(batch._id)}">
          <div class="search-result-thumb">${batch.previewImage ? `<img src="${escapeHtml(batch.previewImage)}" alt="" referrerpolicy="no-referrer" onerror="window.__thumbFallback(this)">` : THUMB_PLACEHOLDER_SVG}</div>
          <div><strong>${escapeHtml(batch.name)}</strong><small>${escapeHtml(batch.byName || batch.language || "Course")}</small></div>
        </div>`).join("");
    }
    results.innerHTML = html;
    $$(".search-history-chip").forEach((chip, index) => chip.addEventListener("click", () => {
      const input = $("#searchInput");
      if (input) { input.value = history[index]; renderSearchResults(history[index]); }
    }));
    $$(".search-result").forEach((result, index) => result.addEventListener("click", () => {
      openBatch(recent[index]);
      closeModal("searchModal");
    }));
    return;
  }
  const matches = deepSearch(allBatches, normalized).slice(0, 40);
  if (!matches.length) {
    results.innerHTML = '<div class="search-hint">No matches yet. Try a subject, exam or class.</div>';
    return;
  }
  results.innerHTML = `<div class="search-hint" style="text-align:left;margin-bottom:2px;">${matches.length} result${matches.length === 1 ? "" : "s"}</div>` + matches.map((batch) => `
    <div class="search-result" data-id="${escapeHtml(batch._id || batch.batch_id || "")}">
      <div class="search-result-thumb">${batch.previewImage ? `<img src="${escapeHtml(batch.previewImage)}" alt="" referrerpolicy="no-referrer" onerror="window.__thumbFallback(this)">` : THUMB_PLACEHOLDER_SVG}</div>
      <div><strong>${highlightMatch(batch.name || "Untitled course", normalized)}</strong><small>${escapeHtml(batch.byName || batch.language || "Course")}</small></div>
      ${isRecent(batch.startDate) ? '<span class="search-new-badge">new</span>' : ""}
    </div>`).join("");
  $$(".search-result").forEach((result, index) => result.addEventListener("click", () => {
    openBatch(matches[index]);
    closeModal("searchModal");
  }));
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  $$(".overlay.visible").forEach((other) => { if (other.id !== id) other.classList.remove("visible"); });
  modal.classList.add("visible");
  document.body.classList.add("modal-open");
  modal.querySelector("input")?.focus();
}

function closeModal(id) {
  if (id === "courseViewer" && viewer.open) { closeViewer(); return; }
  document.getElementById(id)?.classList.remove("visible");
  if (!$$(".overlay.visible").length) document.body.classList.remove("modal-open");
}

function showToast(message) {
  const oldToast = $(".toast");
  oldToast?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2800);
}

const BATCH_CACHE_KEY = "cx-batches-cache-v2";

/* ---------- Rozgar With Ankit (RWA) live course list ---------- */
const RWA_API = "https://rozgarapinew.teachx.in/get/courselistnewv2?exam_name=&start=";
const RWA_HEADERS = { "client-service": "Appx", "auth-key": "appxapi", "device_type": "ANDROID" };
const RWA_STEP = 10;
const RWA_MAX_PAGES = 100;

function mapRwaCourse(course) {
  return {
    _id: String(course.id),
    name: course.course_name,
    byName: course.exam_name || course.exam_category || "Rozgar With Ankit",
    previewImage: course.course_thumbnail,
    startDate: course.start_date,
    endDate: course.expiryDate || course.end_date,
    language: course.language || "Hindi",
    feeTotal: 0,
    type: "RWA_BATCH",
    slug: course.course_slug || ""
  };
}

async function fetchRwaPage(start) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(RWA_API + start, { headers: RWA_HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`RWA API ${response.status}`);
    const json = await response.json();
    return Array.isArray(json && json.data) ? json.data : [];
  } finally {
    clearTimeout(timer);
  }
}

/* Loads every RWA page (no arbitrary cap). onProgress(list) fires as pages arrive. */
async function fetchAllRwaCourses(onProgress) {
  const byId = new Map();
  for (let page = 0; page < RWA_MAX_PAGES; page += 1) {
    let rows;
    try { rows = await fetchRwaPage(page * RWA_STEP); }
    catch (error) { if (!byId.size) throw error; break; }
    if (!rows.length) break;
    let added = 0;
    rows.forEach((course) => {
      if (!course || course.id === undefined || course.id === null || !course.course_name) return;
      const id = String(course.id);
      if (!byId.has(id)) { byId.set(id, mapRwaCourse(course)); added += 1; }
    });
    if (!added) break; // API ignored "start" or we hit the end
    if (onProgress && (page === 0 || page % 5 === 4)) onProgress([...byId.values()]);
  }
  return [...byId.values()];
}

function mergeBatches(...lists) {
  const byId = new Map();
  lists.forEach((list) => (list || []).forEach((batch) => {
    const id = batch && (batch._id || batch.batch_id);
    if (id) byId.set(String(id), batch);
  }));
  return [...byId.values()];
}

/* One-time cleanup of leftovers from the removed PW batch (Arjuna JEE 2027). */
function purgeLegacyPwData() {
  const PW_ID = "698ad3519549b300a5e1cc6a";
  try {
    if (localStorage.getItem("codex-studys-rwa-migrated")) return;
    localStorage.setItem("codex-studys-recent", JSON.stringify(getRecentlyViewed().filter((item) => item._id !== PW_ID)));
    localStorage.setItem("codex-studys-favorites", JSON.stringify(getFavorites().filter((id) => id !== PW_ID)));
    localStorage.setItem("codex-studys-rwa-migrated", "1");
  } catch (e) {}
}


function readBatchCache() {
  try {
    const raw = sessionStorage.getItem(BATCH_CACHE_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) && list.length ? list : null;
  } catch (e) { return null; }
}

function restoreScroll() {
  try {
    const y = Number(sessionStorage.getItem("cx-scroll") || 0);
    sessionStorage.removeItem("cx-scroll");
    if (y > 0) window.requestAnimationFrame(() => window.scrollTo(0, y));
  } catch (e) {}
}

let batchesLoading = false;

async function loadBatches() {
  if (batchesLoading) return;
  batchesLoading = true;
  const cached = readBatchCache();
  let usedCache = false;
  try {
    const grid = $("#batchGrid");
    if (cached) {
      allBatches = cached;
      usedCache = true;
      updateStats();
      renderBatches();
      $("#globalPreloader").classList.add("hidden");
      restoreScroll();
    } else if (grid && !allBatches.length) {
      grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-body"><div class="skeleton-line" style="width:88%"></div><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div></div>').join("");
    }

    // Seed list from batches.json (if it has courses), then load the live RWA list on top of it.
    let seed = [];
    try {
      const response = await fetch("batches.json", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        seed = Array.isArray(data.batches) ? data.batches : [];
      }
    } catch (e) { /* live API below may still work */ }

    const applyList = (list) => {
      const fresh = mergeBatches(seed, list);
      const changed = JSON.stringify(fresh) !== JSON.stringify(allBatches);
      allBatches = fresh;
      if (changed || !usedCache) { updateStats(); renderBatches(); }
      usedCache = true;
      return fresh;
    };

    if (seed.length && !cached) applyList([]);

    let live = [];
    let liveError = null;
    try {
      live = await fetchAllRwaCourses((partial) => applyList(partial));
    } catch (error) {
      liveError = error;
      console.error(error);
    }

    const finalList = applyList(live);
    if (!finalList.length) throw liveError || new Error("Course library unavailable");
    try { sessionStorage.setItem(BATCH_CACHE_KEY, JSON.stringify(finalList)); sessionStorage.setItem("cx-loaded", "1"); } catch (e) {}
    const updatedNote = $("#dataUpdatedNote");
    if (updatedNote) updatedNote.textContent = `· library refreshed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    console.error(error);
    if (!usedCache) {
      $("#resultsNote").textContent = "The course library could not be loaded.";
      $("#batchGrid").innerHTML = '<div class="empty">Please refresh to reconnect to the course library.</div>';
      showToast("Course library unavailable");
    }
  } finally {
    batchesLoading = false;
    $("#globalPreloader").classList.add("hidden");
  }
}

function setupNavigation() {
  const menu = $("#navLinks");
  const menuButton = $("#menuBtn");
  menuButton.addEventListener("click", () => {
    const open = menu.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(open));
  });
  $$(".nav-link").forEach((link) => link.addEventListener("click", () => {
    menu.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
  }));
  const sections = $$("main section[id]");
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      $$(".nav-link").forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`));
    }
  }), { rootMargin: "-35% 0px -55% 0px" });
  sections.forEach((section) => observer.observe(section));
}

function setupHeaderActions() {
  const refreshBtn = $("#refreshBtn");
  refreshBtn?.addEventListener("click", async () => {
    if (refreshBtn.classList.contains("spinning")) return;
    refreshBtn.classList.add("spinning");
    await loadBatches();
    showToast("Course library refreshed.");
    refreshBtn.classList.remove("spinning");
  });
  $("#favNavBtn")?.addEventListener("click", () => {
    activeFilter = "favorites";
    localStorage.setItem("codex-studys-last-filter", "favorites");
    visibleCount = PAGE_SIZE;
    $$(".filter-row .filter").forEach((item) => item.classList.toggle("active", item.dataset.filter === "favorites"));
    renderBatches();
    $("#courses")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function setupModals() {
  $("#searchBtn").addEventListener("click", () => {
    openModal("searchModal");
    renderSearchResults($("#searchInput").value);
  });
  let modalSearchDebounce;
  $("#searchInput").addEventListener("input", (event) => {
    const value = event.target.value;
    clearTimeout(modalSearchDebounce);
    modalSearchDebounce = setTimeout(() => renderSearchResults(value), 120);
  });
  $("#searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.value.trim()) addSearchHistory(event.target.value);
  });
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  $$(".overlay").forEach((overlay) => overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(overlay.id);
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $$(".overlay.visible").forEach((modal) => closeModal(modal.id));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openModal("searchModal");
      renderSearchResults($("#searchInput").value);
    }
  });
}

function setupFilters() {
  updateFavoritesCount();
  const filterKey = "codex-studys-last-filter";
  const urlParams = new URLSearchParams(window.location.search);
  const urlFilter = urlParams.get("filter");
  const urlQuery = urlParams.get("q");
  const urlSort = urlParams.get("sort");
  const savedFilter = urlFilter || localStorage.getItem(filterKey);
  const savedButton = savedFilter && $(`.filter-row .filter[data-filter="${savedFilter}"]`);
  if (savedButton) {
    activeFilter = savedFilter;
    $$(".filter-row .filter").forEach((item) => item.classList.toggle("active", item === savedButton));
  }
  if (urlQuery) {
    searchQuery = urlQuery;
    const inlineSearchEl = $("#inlineSearchInput");
    if (inlineSearchEl) inlineSearchEl.value = urlQuery;
  }
  if (urlSort && ["relevance", "newest", "az", "za"].includes(urlSort)) {
    sortMode = urlSort;
    const sortSelectEl = $("#sortSelect");
    if (sortSelectEl) sortSelectEl.value = urlSort;
  }
  const urlLang = urlParams.get("lang");
  if (urlLang && ["hindi", "english", "hinglish"].includes(urlLang)) {
    langFilter = urlLang;
    const langSelectEl = $("#langSelect");
    if (langSelectEl) langSelectEl.value = urlLang;
  }
  $$(".filter-row .filter").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    localStorage.setItem(filterKey, activeFilter);
    visibleCount = PAGE_SIZE;
    $$(".filter-row .filter").forEach((item) => item.classList.toggle("active", item === button));
    renderBatches();
  }));
  const inlineSearch = $("#inlineSearchInput");
  let searchDebounce;
  inlineSearch?.addEventListener("input", (event) => {
    const value = event.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = value;
      visibleCount = PAGE_SIZE;
      renderBatches();
    }, 150);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (typing) return;
    event.preventDefault();
    inlineSearch?.focus();
  });
  $("#sortSelect")?.addEventListener("change", (event) => {
    sortMode = event.target.value;
    visibleCount = PAGE_SIZE;
    renderBatches();
  });
  $("#langSelect")?.addEventListener("change", (event) => {
    langFilter = event.target.value;
    visibleCount = PAGE_SIZE;
    renderBatches();
  });
  $("#copyLinkBtn")?.addEventListener("click", () => {
    syncUrlParams();
    const url = window.location.href;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => showToast("Link copied!")).catch(() => showToast("Could not copy link"));
    } else {
      showToast("Copy not supported on this browser");
    }
  });
  $("#clearFiltersBtn")?.addEventListener("click", () => {
    activeFilter = "all";
    searchQuery = "";
    sortMode = "relevance";
    langFilter = "all";
    const langSelectEl = $("#langSelect");
    if (langSelectEl) langSelectEl.value = "all";
    visibleCount = PAGE_SIZE;
    localStorage.setItem(filterKey, "all");
    if (inlineSearch) inlineSearch.value = "";
    const sortSelectEl = $("#sortSelect");
    if (sortSelectEl) sortSelectEl.value = "relevance";
    $$(".filter-row .filter").forEach((item) => item.classList.toggle("active", item.dataset.filter === "all"));
    renderBatches();
  });
}

function setupLoadMore() {
  const loadMoreBtn = $("#loadMoreBtn");
  if (!loadMoreBtn) return;
  const loadNext = () => {
    visibleCount += PAGE_SIZE;
    renderBatches();
  };
  loadMoreBtn.addEventListener("click", loadNext);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && loadMoreBtn.style.display !== "none") loadNext();
    });
  }, { rootMargin: "600px" });
  observer.observe(loadMoreBtn);
}

function setupAnnouncements() {
  const key = "codex-studys-announce-seen";
  const badge = document.querySelector("#announceBtn .icon-badge");
  if (localStorage.getItem(key) === "true") badge?.remove();
  $("#announceBtn")?.addEventListener("click", () => {
    openModal("announceModal");
    localStorage.setItem(key, "true");
    badge?.remove();
  });
  $("#announceCopyLink")?.addEventListener("click", () => {
    const url = window.location.origin + window.location.pathname;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => showToast("Link copied!")).catch(() => showToast("Could not copy link"));
    } else {
      showToast("Copy not supported on this browser");
    }
  });
}

const THEME_COLORS = {
  light: "#f4f5f9", dark: "#090b10", sandalwood: "#1c130c", "forest-emerald": "#06140f",
  "ocean-deep": "#050e17", "sakura-blossom": "#fff3f6", "dracula-midnight": "#14121f",
  "lavender-mist": "#f5f2fc", "cyberpunk-neon": "#05020a"
};

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const current = document.documentElement.getAttribute("data-theme");
  meta.setAttribute("content", THEME_COLORS[current] || THEME_COLORS.dark);
}

function setupThemePicker() {
  syncThemeColor();
  const key = "codex-studys-theme";
  const markActive = () => {
    const current = localStorage.getItem(key) || "system";
    $$(".theme-option").forEach((option) => option.classList.toggle("active", option.dataset.theme === current));
  };
  $("#themeBtn")?.addEventListener("click", () => {
    markActive();
    openModal("themeModal");
  });
  $$(".theme-option").forEach((option) => option.addEventListener("click", () => {
    const theme = option.dataset.theme;
    localStorage.setItem(key, theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
      const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
      if (prefersLight) document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    syncThemeColor();
    markActive();
  }));
}

/* ================= Animation Effects ================= */
function setupFxEngine() {
  const ENABLED_KEY = "codex-studys-fx-enabled";
  const EFFECT_KEY = "codex-studys-fx-effect";
  const INTENSITY_KEY = "codex-studys-fx-intensity";
  const SCALE = [0.55, 1, 1.85];

  const enableToggle = $("#fxEnableToggle");
  const grid = $("#effectsGrid");
  const intensityInput = $("#fxIntensity");
  const fxBtn = $("#fxBtn");
  if (!grid) return;

  let canvas = null, ctx = null, rafId = null, dpr = 1, running = false, last = 0;
  let particles = [], bolts = [], flash = 0, burstTimer = 0, boltTimer = 0;
  let effect = localStorage.getItem(EFFECT_KEY) || "rain";
  let intensity = Number(localStorage.getItem(INTENSITY_KEY));
  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 2) intensity = 1;
  let enabled = localStorage.getItem(ENABLED_KEY) === "true";

  const reducedMotion = () =>
    document.documentElement.getAttribute("data-reduced-motion") === "true" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.id = "fxCanvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function density(base) {
    const w = window.innerWidth;
    const dscale = w < 480 ? 0.5 : w < 900 ? 0.75 : 1;
    return Math.max(6, Math.round(base * dscale * SCALE[intensity]));
  }

  function seed() {
    const w = window.innerWidth, h = window.innerHeight;
    particles = []; bolts = []; flash = 0; burstTimer = 0; boltTimer = 0;
    if (effect === "rain" || effect === "storm") {
      const n = density(effect === "storm" ? 100 : 75);
      for (let i = 0; i < n; i++) particles.push({
        x: Math.random() * w, y: Math.random() * h - h,
        len: 14 + Math.random() * 16, speed: 7 + Math.random() * 7,
        drift: effect === "storm" ? 2.6 : 0.7
      });
    } else if (effect === "snow") {
      const n = density(70);
      for (let i = 0; i < n; i++) particles.push({
        x: Math.random() * w, y: Math.random() * h,
        r: 1.5 + Math.random() * 2.6, speed: 0.6 + Math.random() * 1.3,
        phase: Math.random() * Math.PI * 2, amp: 10 + Math.random() * 20
      });
    } else if (effect === "hail") {
      const n = density(55);
      for (let i = 0; i < n; i++) particles.push({
        x: Math.random() * w, y: Math.random() * h - h,
        r: 2 + Math.random() * 2, speed: 10 + Math.random() * 6, drift: 1.4
      });
    } else if (effect === "fireball") {
      const n = density(40);
      for (let i = 0; i < n; i++) particles.push({
        x: Math.random() * w, y: h + Math.random() * 100,
        r: 2 + Math.random() * 3.2, speed: 0.7 + Math.random() * 1.3,
        drift: Math.random() * 1.2 - 0.6, flick: Math.random() * Math.PI * 2
      });
    }
  }

  function spawnBurst(w, h) {
    const cx = 40 + Math.random() * (w - 80);
    const cy = 60 + Math.random() * (h * 0.45);
    const hue = Math.floor(Math.random() * 360);
    const count = density(26);
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.3;
      const sp = 1.6 + Math.random() * 2.2;
      particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue });
    }
  }

  function spawnBolt(w, h) {
    const points = [];
    let x = 60 + Math.random() * Math.max(w - 120, 20), y = 0;
    points.push({ x, y });
    while (y < h * 0.7) {
      y += 18 + Math.random() * 22;
      x += (Math.random() - 0.5) * 40;
      points.push({ x, y });
    }
    bolts.push({ points, life: 1 });
    flash = 0.35;
  }

  function step(dt, w, h) {
    ctx.clearRect(0, 0, w, h);
    if (effect === "rain" || effect === "storm") {
      ctx.strokeStyle = "rgba(160,200,255,.55)";
      ctx.lineWidth = 1.3;
      particles.forEach((p) => {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.drift * 3, p.y + p.len);
        ctx.stroke();
        p.y += p.speed * dt * 60; p.x += p.drift * dt * 60;
        if (p.y > h) { p.y = -p.len; p.x = Math.random() * w; }
      });
      if (effect === "storm") {
        boltTimer -= dt;
        if (boltTimer <= 0) { spawnBolt(w, h); boltTimer = 2.5 + Math.random() * 4; }
      }
    } else if (effect === "snow") {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      particles.forEach((p) => {
        p.phase += dt;
        const x = p.x + Math.sin(p.phase) * p.amp * 0.02;
        ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        p.y += p.speed * dt * 60;
        if (p.y > h) { p.y = -4; p.x = Math.random() * w; }
      });
    } else if (effect === "hail") {
      ctx.fillStyle = "rgba(220,235,255,.9)";
      particles.forEach((p) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        p.y += p.speed * dt * 60; p.x += p.drift * dt * 60;
        if (p.y > h) { p.y = -6; p.x = Math.random() * w; }
      });
    } else if (effect === "fireball") {
      particles.forEach((p) => {
        p.flick += dt * 6;
        const alpha = 0.5 + Math.sin(p.flick) * 0.3;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        grad.addColorStop(0, `rgba(255,180,80,${alpha})`);
        grad.addColorStop(1, "rgba(255,80,20,0)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2); ctx.fill();
        p.y -= p.speed * dt * 60; p.x += p.drift * dt * 30;
        if (p.y < -10) { p.y = h + Math.random() * 40; p.x = Math.random() * w; }
      });
    } else if (effect === "firecracker") {
      burstTimer -= dt;
      if (burstTimer <= 0) { spawnBurst(w, h); burstTimer = 1.1 + Math.random() * (2.6 - intensity * 0.7); }
      particles = particles.filter((p) => p.life > 0);
      particles.forEach((p) => {
        p.vy += dt * 1.6; p.x += p.vx * dt * 60; p.y += p.vy * dt * 60; p.life -= dt * 0.9;
        ctx.fillStyle = `hsla(${p.hue},95%,65%,${Math.max(p.life, 0)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
      });
    } else if (effect === "lightning") {
      boltTimer -= dt;
      if (boltTimer <= 0) { spawnBolt(w, h); boltTimer = 2.6 + Math.random() * (5 - intensity); }
    }

    if (effect === "storm" || effect === "lightning") {
      bolts = bolts.filter((b) => b.life > 0);
      bolts.forEach((b) => {
        ctx.strokeStyle = `rgba(220,235,255,${b.life})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        b.points.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
        ctx.stroke();
        b.life -= dt * 1.8;
      });
      if (flash > 0) {
        ctx.fillStyle = `rgba(210,225,255,${flash})`;
        ctx.fillRect(0, 0, w, h);
        flash -= dt * 0.9;
      }
    }
  }

  function loop(ts) {
    if (!running) return;
    const dt = Math.min((ts - last) / 1000 || 0, 0.05);
    last = ts;
    step(dt, window.innerWidth, window.innerHeight);
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    ensureCanvas();
    seed();
    running = true;
    last = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function apply() {
    if (enabled && !reducedMotion() && !document.hidden) start(); else stop();
  }

  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else apply(); });
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", apply);
  window.__codexFxApply = apply;

  function markActive() {
    $$(".effect-option").forEach((btn) => btn.classList.toggle("active", btn.dataset.effect === effect));
  }
  enableToggle?.setAttribute("aria-checked", String(enabled));
  if (intensityInput) intensityInput.value = String(intensity);
  markActive();

  enableToggle?.addEventListener("click", () => {
    enabled = enableToggle.getAttribute("aria-checked") !== "true";
    enableToggle.setAttribute("aria-checked", String(enabled));
    localStorage.setItem(ENABLED_KEY, String(enabled));
    apply();
  });

  grid.addEventListener("click", (event) => {
    const btn = event.target.closest(".effect-option");
    if (!btn) return;
    effect = btn.dataset.effect;
    localStorage.setItem(EFFECT_KEY, effect);
    markActive();
    if (running) { stop(); apply(); }
  });

  intensityInput?.addEventListener("input", () => {
    intensity = Number(intensityInput.value);
    localStorage.setItem(INTENSITY_KEY, String(intensity));
    if (running) seed();
  });

  fxBtn?.addEventListener("click", () => openModal("effectsModal"));

  if (enabled) apply();
}

/* ================= Network Status ================= */
function setupNetworkStatus() {
  const netBtn = $("#netBtn");
  const typeEl = $("#netType");
  const pingEl = $("#netPing");
  const latencyEl = $("#netLatency");
  const bwEl = $("#netBandwidth");
  const statusEl = $("#netStatus");
  const refreshBtn = $("#netRefreshBtn");
  if (!netBtn || !typeEl) return;

  let pollTimer = null;
  const PING_ASSET = "assets/icon-192.png";

  function connInfo() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }
  function typeLabel() {
    const c = connInfo();
    if (c) {
      const t = c.type && c.type !== "unknown" ? c.type : c.effectiveType;
      if (t) return t === "wifi" ? "Wi-Fi" : t.toUpperCase();
    }
    return "Unknown";
  }
  function bandwidthLabel() {
    const c = connInfo();
    return c && typeof c.downlink === "number" ? `${c.downlink} Mbps` : "—";
  }
  function setStatus(online) {
    statusEl.innerHTML = `<span class="net-status-dot${online ? "" : " offline"}"></span>${online ? "Online" : "Offline"}`;
  }

  async function measure() {
    if (!navigator.onLine) {
      typeEl.textContent = "Offline"; pingEl.textContent = "—"; latencyEl.textContent = "—";
      bwEl.textContent = "—"; setStatus(false);
      return;
    }
    typeEl.textContent = typeLabel();
    bwEl.textContent = bandwidthLabel();
    setStatus(true);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        await fetch(`${PING_ASSET}?_=${Date.now()}_${i}`, { method: "HEAD", cache: "no-store" });
        samples.push(performance.now() - t0);
      } catch (error) { /* ignore a single dropped sample */ }
    }
    if (samples.length) {
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      pingEl.textContent = `${Math.round(avg)} ms`;
      const entries = performance.getEntriesByType("resource").filter((r) => r.name.includes(PING_ASSET));
      const lastEntry = entries[entries.length - 1];
      const ttfb = lastEntry ? Math.max(0, lastEntry.responseStart - lastEntry.requestStart) : avg * 0.4;
      latencyEl.textContent = `${Math.round(ttfb || avg * 0.4)} ms`;
    } else {
      pingEl.textContent = "Timeout"; latencyEl.textContent = "—"; setStatus(false);
    }
  }

  function startPolling() {
    measure();
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => {
      const modal = document.getElementById("networkModal");
      if (!modal || !modal.classList.contains("visible")) {
        window.clearInterval(pollTimer); pollTimer = null; return;
      }
      measure();
    }, 8000);
  }

  netBtn.addEventListener("click", () => { openModal("networkModal"); startPolling(); });
  refreshBtn?.addEventListener("click", measure);
}

const POPUP_SNOOZE_KEY = "codex-studys-popups-snooze";
const POPUP_SNOOZE_MS = 24 * 60 * 60 * 1000;

function popupsSnoozed() {
  try {
    const until = Number(localStorage.getItem(POPUP_SNOOZE_KEY) || 0);
    return until > Date.now();
  } catch (e) { return false; }
}

function setupTelegramPopup() {
  document.querySelectorAll("[data-snooze-popups]").forEach((btn) => {
    btn.addEventListener("click", () => {
      try { localStorage.setItem(POPUP_SNOOZE_KEY, String(Date.now() + POPUP_SNOOZE_MS)); } catch (e) {}
      closeModal("telegramModal");
      closeModal("installModal");
      showToast("Popups 24 ghante ke liye band");
    });
  });
  if (popupsSnoozed()) return;
  let seen = false;
  try { seen = sessionStorage.getItem("cx-popups-shown") === "1"; } catch (e) {}
  if (seen) return; // already shown this session (e.g. coming back from a batch)
  window.setTimeout(() => {
    try { sessionStorage.setItem("cx-popups-shown", "1"); } catch (e) {}
    if (viewer.open) return; // don't interrupt a course that is already open
    openModal("telegramModal");
    const modal = document.getElementById("telegramModal");
    if (!modal) return;
    const watcher = window.setInterval(() => {
      if (!modal.classList.contains("visible")) {
        window.clearInterval(watcher);
        window.setTimeout(() => { if (!isStandaloneApp() && !popupsSnoozed() && !viewer.open) openModal("installModal"); }, 200);
      }
    }, 150);
  }, 700);
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function setupInstallPrompt() {
  if (isStandaloneApp()) return;
  const installBtn = $("#installActionBtn");
  const iosSteps = $("#iosInstallSteps");
  const body = $("#installBody");

  const showForIOS = () => {
    if (installBtn) installBtn.style.display = "none";
    if (iosSteps) iosSteps.style.display = "grid";
    if (body) body.textContent = "Add CODEX STUDYS to your home screen for a faster, app-like experience.";
  };

  installBtn?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    closeModal("installModal");
    if (outcome === "accepted") showToast("Installing CODEX STUDYS…");
  });

  window.addEventListener("appinstalled", () => {
    closeModal("installModal");
    showToast("CODEX STUDYS installed!");
  });

  if (isIOSDevice()) showForIOS();
}

function setupOfflineBanner() {
  const banner = $("#offlineBanner");
  if (!banner) return;
  const update = () => banner.classList.toggle("visible", !navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

function setupViewToggle() {
  const key = "codex-studys-view";
  const grid = $("#batchGrid");
  const gridBtn = $("#gridViewBtn");
  const listBtn = $("#listViewBtn");
  if (!grid || !gridBtn || !listBtn) return;
  const apply = (mode) => {
    grid.classList.toggle("list-view", mode === "list");
    gridBtn.classList.toggle("active", mode !== "list");
    gridBtn.setAttribute("aria-pressed", String(mode !== "list"));
    listBtn.classList.toggle("active", mode === "list");
    listBtn.setAttribute("aria-pressed", String(mode === "list"));
  };
  apply(localStorage.getItem(key) || "grid");
  gridBtn.addEventListener("click", () => { localStorage.setItem(key, "grid"); apply("grid"); });
  listBtn.addEventListener("click", () => { localStorage.setItem(key, "list"); apply("list"); });
}

function setupPreferences() {
  const contrastToggle = $("#contrastToggle");
  const motionToggle = $("#motionToggle");

  const applyContrast = (on) => {
    document.documentElement.setAttribute("data-contrast", on ? "high" : "normal");
    contrastToggle?.setAttribute("aria-checked", String(on));
  };
  const applyMotion = (on) => {
    document.documentElement.setAttribute("data-reduced-motion", String(on));
    motionToggle?.setAttribute("aria-checked", String(on));
  };
  applyContrast(localStorage.getItem("codex-studys-contrast") === "true");
  applyMotion(localStorage.getItem("codex-studys-reduced-motion") === "true");

  contrastToggle?.addEventListener("click", () => {
    const on = contrastToggle.getAttribute("aria-checked") !== "true";
    localStorage.setItem("codex-studys-contrast", String(on));
    applyContrast(on);
  });
  motionToggle?.addEventListener("click", () => {
    const on = motionToggle.getAttribute("aria-checked") !== "true";
    localStorage.setItem("codex-studys-reduced-motion", String(on));
    applyMotion(on);
    window.__codexFxApply?.();
  });

  $("#exportFavBtn")?.addEventListener("click", () => {
    const favorites = getFavorites();
    if (!favorites.length) return showToast("No favorites to export yet.");
    const details = allBatches.filter((batch) => favorites.includes(batch._id || batch.batch_id || ""));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), favorites: details }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "codex-studys-favorites.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Favorites exported.");
  });

  const importInput = $("#importFavFile");
  $("#importFavBtn")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const ids = (data.favorites || []).map((batch) => batch._id || batch.batch_id).filter(Boolean);
        const current = getFavorites();
        const merged = [...new Set([...current, ...ids])];
        localStorage.setItem("codex-studys-favorites", JSON.stringify(merged));
        updateFavoritesCount();
        renderBatches();
        showToast(`Imported ${ids.length} favorite${ids.length === 1 ? "" : "s"}.`);
      } catch {
        showToast("That file could not be read.");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  });

  $("#clearDataBtn")?.addEventListener("click", () => {
    if (!confirm("This clears favorites, theme, search history and all saved preferences on this device. Continue?")) return;
    Object.keys(localStorage).filter((key) => key.startsWith("codex-studys")).forEach((key) => localStorage.removeItem(key));
    showToast("App data cleared. Reloading…");
    setTimeout(() => window.location.reload(), 900);
  });
}

function animateCount(element, target) {
  if (!element) return;
  if (target <= 0) { element.textContent = "0"; return; }
  const duration = 700;
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = Math.round(target * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateStats() {
  const strip = $("#statsStrip");
  if (!strip) return;
  strip.style.display = "grid";
  const freshCount = allBatches.filter((batch) => isRecent(batch.startDate)).length;
  animateCount($("#statTotal"), allBatches.length);
  animateCount($("#statNew"), freshCount);
  const statFav = $("#statFav");
  if (statFav) statFav.textContent = getFavorites().length.toLocaleString();
  const statRecent = $("#statRecent");
  if (statRecent) statRecent.textContent = String(getRecentlyViewed().length);
}

function setupBackToTop() {
  const button = $("#backToTopBtn");
  if (!button) return;
  const onScroll = () => button.classList.toggle("visible", window.scrollY > 480);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}


/* ---------- Personal notes ---------- */
function getNotes() {
  try { return JSON.parse(localStorage.getItem("codex-studys-notes") || "{}"); }
  catch { return {}; }
}

function getNote(id) {
  return getNotes()[id] || "";
}

function setNote(id, text) {
  const notes = getNotes();
  if (text.trim()) notes[id] = text.trim(); else delete notes[id];
  localStorage.setItem("codex-studys-notes", JSON.stringify(notes));
}

/* ---------- Quick view ---------- */
let detailBatch = null;

function openDetail(batch) {
  detailBatch = batch;
  const id = batch._id || batch.batch_id || "";
  const hero = document.getElementById("detailHero");
  if (hero) {
    hero.src = batch.previewImage || FALLBACK_THUMB;
    hero.onerror = () => { hero.onerror = null; hero.src = FALLBACK_THUMB; };
  }
  const titleEl = document.getElementById("detailTitle");
  if (titleEl) titleEl.textContent = batch.name || "Untitled course";
  const subEl = document.getElementById("detailSub");
  if (subEl) subEl.textContent = batch.byName || "Structured learning for your next milestone";
  const isRwa = batch.type === "RWA_BATCH";
  const facts = [
    ["Category", categoryFor(batch).toUpperCase()],
    ["Language", batch.language || "Self-paced"],
    ["Starts", formatDate(batch.startDate) || "Anytime"]
  ];
  const endLabel = formatDate(batch.endDate);
  if (endLabel) facts.push(["Ends", endLabel]);
  if (isRwa) facts.push(["Provider", "Rozgar With Ankit"]);
  else if ((batch.subBatches || []).length) facts.push(["Subjects", String(batch.subBatches.length)]);
  const factsEl = document.getElementById("detailFacts");
  if (factsEl) factsEl.innerHTML = facts.map(([k, v]) => `<div class="detail-fact"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join("");
  const noteEl = document.getElementById("detailNote");
  if (noteEl) noteEl.value = getNote(id);
  syncDetailFavButton(id);
  openModal("detailModal");
}

function syncDetailFavButton(id) {
  const favBtn = document.getElementById("detailFavBtn");
  if (favBtn) favBtn.textContent = isFavorite(id) ? "❤ Saved" : "❤ Save";
}

function setupDetailModal() {
  document.getElementById("detailFavBtn")?.addEventListener("click", () => {
    if (!detailBatch) return;
    const id = detailBatch._id || detailBatch.batch_id || "";
    const active = toggleFavorite(id);
    syncDetailFavButton(id);
    updateFavoritesCount();
    renderBatches();
    showToast(active ? "Added to favorites." : "Removed from favorites.");
  });
  document.getElementById("detailOpenBtn")?.addEventListener("click", () => {
    if (!detailBatch) return;
    closeModal("detailModal");
    openBatch(detailBatch);
  });
  const noteEl = document.getElementById("detailNote");
  let noteTimer;
  noteEl?.addEventListener("input", () => {
    if (!detailBatch) return;
    const id = detailBatch._id || detailBatch.batch_id || "";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      setNote(id, noteEl.value);
      renderBatches();
    }, 400);
  });
}

/* ---------- Reading progress ---------- */
function setupScrollProgress() {
  const bar = document.getElementById("scrollProgress");
  if (!bar) return;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? Math.min((window.scrollY / max) * 100, 100) : 0}%`;
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

/* ---------- Shortcuts ---------- */
function setupShortcuts() {
  document.getElementById("shortcutsBtn")?.addEventListener("click", () => openModal("shortcutsModal"));
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    const key = event.key.toLowerCase();
    if (event.key === "?") { event.preventDefault(); openModal("shortcutsModal"); }
    else if (key === "f") { event.preventDefault(); document.getElementById("favNavBtn")?.click(); }
    else if (key === "t") { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  purgeLegacyPwData();
  setupViewer();
  setupDetailModal();
  setupScrollProgress();
  setupShortcuts();
  setupNavigation();
  setupModals();
  setupFilters();
  setupLoadMore();
  setupViewToggle();
  setupThemePicker();
  setupPreferences();
  setupFxEngine();
  setupNetworkStatus();
  setupAnnouncements();
  setupHeaderActions();
  setupTelegramPopup();
  setupInstallPrompt();
  setupQuickInstall();
  setupRecentlyWatched();
  setupBackToTop();
  setupOfflineBanner();
  registerServiceWorker();
  loadBatches();
});


/* Disable page zoom (pinch, double-tap, ctrl+wheel, ctrl +/-) */
(() => {
  ["gesturestart", "gesturechange", "gestureend"].forEach((t) =>
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTouch = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouch < 300) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
  document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) e.preventDefault();
  });
})();
