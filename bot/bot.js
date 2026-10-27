// Halvia bot: an offline-first clinical assistant.
// The AI model (WebLLM) runs on the device's GPU in a web worker. Answers are grounded in a
// local library (BM25 search over passages), so the bot still helps, by search alone, when the
// model isn't downloaded or the device can't run it. Profiles, documents and chats live in
// IndexedDB, encrypted with AES-GCM using a key derived from the user's passcode.

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const MODELS = [
  { key: 'fast', name: 'Fast', model: 'Llama 3.2 1B', f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', size: 'about 0.9 GB', note: 'Works on most laptops and recent phones' },
  { key: 'better', name: 'Better', model: 'Llama 3.2 3B', f16: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC', size: 'about 2.3 GB', note: 'Clearer answers, needs a recent laptop' },
  { key: 'best', name: 'Most capable', model: 'Phi-3.5 mini', f16: 'Phi-3.5-mini-instruct-q4f16_1-MLC', f32: 'Phi-3.5-mini-instruct-q4f32_1-MLC', size: 'about 3.7 GB', note: 'Desktop or gaming laptop with a good GPU' },
];
const IDLE_LOCK_MS = 15 * 60 * 1000;

const S = {
  profile: null, key: null,
  starter: [], mine: [], chats: [], chatId: null,
  gpu: null, engine: null, worker: null, ai: 'checking', modelKey: LS.get('halvia-bot-model', 'fast'), have: LS.get('halvia-bot-have', {}),
  busy: false, stopReq: false, index: null, lastActive: Date.now(),
  strict: LS.get('halvia-bot-strict', true), useStarter: LS.get('halvia-bot-starter', true),
};

/* ---------- storage ---------- */
const DB = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('halvia-bot', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('profiles', { keyPath: 'id' });
      d.createObjectStore('vault', { keyPath: 'id' }).createIndex('owner', 'owner');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), q = fn(t.objectStore(store));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (st, v) => run(st, 'readwrite', s => s.put(v)),
    del: (st, k) => run(st, 'readwrite', s => s.delete(k)),
    all: st => run(st, 'readonly', s => s.getAll()),
    owned: owner => run('vault', 'readonly', s => s.index('owner').getAll(owner)),
  };
})();

const te = new TextEncoder(), td = new TextDecoder();
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.key, te.encode(JSON.stringify(obj))) };
}
async function unseal(rec, key = S.key) {
  return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data)));
}
async function saveDoc(doc) {
  if (!S.key) return;
  await DB.put('vault', { id: 'doc:' + doc.id, owner: S.profile.id, kind: 'doc', ...(await seal(doc)) });
}
async function saveChat(chat) {
  if (!S.key) return;
  await DB.put('vault', { id: 'chat:' + chat.id, owner: S.profile.id, kind: 'chat', ...(await seal(chat)) });
}

/* ---------- text and passages ---------- */
const STOP = new Set('a an and are as at be been by can could do does for from had has have how i if in into is it its me my of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your about any also but more most not no other some such only over under after before between give tell need needs patient patients next now get use used using like just much many very well know want please help best way ok'.split(' '));
const SYN = { septic: ['sepsis'], bp: ['blood', 'pressure', 'systolic'], hr: ['pulse', 'heart'], rr: ['respiration', 'respiratory'], sats: ['saturation', 'oxygen'], spo2: ['saturation', 'oxygen'], o2: ['oxygen'], temp: ['temperature'], gcs: ['glasgow', 'consciousness'], obs: ['observations'], handover: ['sbar', 'handover'], escalate: ['escalation', 'sbar'], ews: ['news2'], news: ['news2'], deteriorating: ['deterioration', 'news2'], bruise: ['bruising', 'black'], aki: ['acute', 'kidney'] };
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
const words = t => (t.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) || []);
const terms = t => words(t).filter(w => !STOP.has(w)).map(stem);
function queryTerms(q) {
  const out = [];
  for (const w of words(q)) { if (STOP.has(w)) continue; out.push(stem(w)); for (const s of SYN[w] || []) out.push(stem(s)); }
  return [...new Set(out)];
}

function splitLong(text, max = 1100) {
  if (text.length <= max) return [text];
  const sents = text.split(/(?<=[.!?])\s+/).map(x => x + ' '), out = [];
  let cur = '';
  for (const s of sents) { if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = ''; } cur += s; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// Markdown-ish documents split on headings; anything else on paragraphs, packed to ~1000 characters.
function toPassages(text, pages) {
  const out = [];
  if (/^#{1,3} /m.test(text)) {
    let head = '';
    for (const block of text.split(/^(?=#{1,3} )/m)) {
      const m = block.match(/^#{1,3} (.+)\n?/);
      const h = m ? m[1].trim() : '';
      const body = (m ? block.slice(m[0].length) : block).trim();
      if (m && /^# /.test(block)) head = h;
      if (!body) continue;
      for (const part of splitLong(body)) out.push({ h: m && !/^# /.test(block) ? h : '', text: part });
    }
    return out.map(p => ({ ...p, h: p.h || head }));
  }
  const paras = (pages || [{ n: 0, text }]).flatMap(pg => pg.text.split(/\n\s*\n|\n(?=[A-Z0-9•\-–])/).map(t => ({ n: pg.n, t: t.replace(/\s+/g, ' ').trim() }))).filter(p => p.t);
  let cur = null;
  for (const p of paras) {
    if (cur && (cur.text.length + p.t.length > 1000 || (p.n && p.n !== cur.page))) { out.push(cur); cur = null; }
    if (!cur) cur = { h: '', text: '', page: p.n || undefined };
    cur.text += (cur.text ? '\n' : '') + p.t;
  }
  if (cur) out.push(cur);
  return out.flatMap(p => splitLong(p.text).map(t => ({ ...p, text: t })));
}

function buildIndex() {
  const docs = [...(S.useStarter ? S.starter : []), ...S.mine];
  const items = [];
  for (const d of docs) d.passages.forEach((p, i) => {
    const tf = new Map();
    for (const w of [...terms(p.text), ...terms(p.h + ' ' + p.h + ' ' + d.title)]) tf.set(w, (tf.get(w) || 0) + 1);
    let len = 0; for (const v of tf.values()) len += v;
    items.push({ doc: d, i, p, tf, len });
  });
  const df = new Map();
  for (const it of items) for (const w of it.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const avg = items.reduce((a, b) => a + b.len, 0) / (items.length || 1);
  S.index = { items, df, avg, N: items.length };
  $('#libCount').textContent = docs.length;
}
function search(q, k = 4) {
  const ix = S.index; if (!ix || !ix.N) return [];
  const qt = queryTerms(q); if (!qt.length) return [];
  const k1 = 1.4, b = 0.7;
  const scored = [];
  for (const it of ix.items) {
    let s = 0, hits = 0;
    for (const w of qt) {
      const f = it.tf.get(w); if (!f) continue;
      hits++;
      const n = ix.df.get(w), idf = Math.log(1 + (ix.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * it.len / ix.avg));
    }
    if (s > 0) scored.push({ ...it, score: s * (0.6 + 0.4 * hits / qt.length) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  return scored.filter(r => r.score >= top * 0.35).slice(0, k);
}

/* ---------- reading files ---------- */
async function readPdf(file) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    let t = '';
    for (const it of tc.items) t += it.str + (it.hasEOL ? '\n' : ' ');
    pages.push({ n, text: t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') });
    progressIngest(`Reading ${file.name}: page ${n} of ${pdf.numPages}`);
  }
  if (!pages.some(p => p.text.trim().length > 20)) throw new Error('This PDF has no selectable text (it may be a scan), so it cannot be read yet.');
  return { pages };
}
// .docx is a zip: find word/document.xml and inflate it with the browser's own DecompressionStream.
async function readDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), v = new DataView(buf.buffer);
  let e = buf.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This Word file could not be opened.');
  let p = v.getUint32(e + 16, true);
  const count = v.getUint16(e + 10, true);
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nl));
    if (name === 'word/document.xml') {
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      let raw = buf.subarray(start, start + size);
      if (method === 8) raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const xml = new DOMParser().parseFromString(td.decode(raw), 'application/xml');
      const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const paras = [...xml.getElementsByTagNameNS(W, 'p')].map(pe => [...pe.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('')).filter(Boolean);
      return { text: paras.join('\n\n') };
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('This Word file has no document text.');
}
async function readFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') return { kind: 'PDF', ...(await readPdf(file)) };
  if (ext === 'docx') return { kind: 'Word', ...(await readDocx(file)) };
  if (ext === 'html' || ext === 'htm') {
    const d = new DOMParser().parseFromString(await file.text(), 'text/html');
    d.querySelectorAll('script,style,nav,footer,noscript').forEach(n => n.remove());
    d.querySelectorAll('p,li,h1,h2,h3,h4,tr,div,br').forEach(n => n.append('\n\n'));
    return { kind: 'Web page', text: d.body.textContent };
  }
  if (['txt', 'md', 'markdown', 'csv'].includes(ext) || file.type.startsWith('text/')) return { kind: ext === 'md' || ext === 'markdown' ? 'Markdown' : ext === 'csv' ? 'CSV' : 'Text', text: await file.text() };
  throw new Error(`${file.name}: this file type isn't supported yet.`);
}
const PII = [
  [/\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/, 'an NHS number or phone number'],
  [/\b(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])[/.-](19|20)\d{2}\b/, 'a date of birth'],
  [/\b[A-Z]{1,2}\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2}\b/, 'a postcode'],
  [/\b(MRN|hospital number|NHS no\.?)\b/i, 'a patient identifier'],
];
const piiIn = t => PII.filter(([re]) => re.test(t)).map(([, w]) => w);

function progressIngest(t) { $('#ingest').textContent = t; }
async function addDocument(title, kind, content, size) {
  const passages = toPassages(content.text || '', content.pages);
  if (!passages.length) throw new Error(`${title}: no readable text was found.`);
  const doc = { id: uid(), title, kind, size, added: Date.now(), passages };
  S.mine.unshift(doc);
  await saveDoc(doc);
  buildIndex(); renderLibrary();
  const pii = piiIn(passages.map(p => p.text).join(' ').slice(0, 200000));
  return { doc, pii };
}
async function ingestFiles(files) {
  if (!S.key) { openSign(); return; }
  for (const f of files) {
    try {
      if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is larger than 25 MB.`);
      progressIngest(`Reading ${f.name}…`);
      const c = await readFile(f);
      const { doc, pii } = await addDocument(f.name.replace(/\.[a-z0-9]+$/i, ''), c.kind, c, f.size);
      progressIngest(`Added ${f.name}: ${doc.passages.length} passage${doc.passages.length === 1 ? '' : 's'} indexed.` + (pii.length ? ` It may contain ${pii[0]}; Halvia bot is not meant for patient data.` : ''));
    } catch (err) {
      progressIngest(err.message || String(err));
    }
  }
}

/* ---------- on-device AI ---------- */
let wl;
const webllm = async () => wl ||= await import('./vendor/web-llm.js');
const modelOf = key => MODELS.find(m => m.key === key) || MODELS[0];
const modelId = m => (S.gpu?.f16 ? m.f16 : m.f32);

async function detectGpu() {
  if (!('gpu' in navigator)) return { ok: false };
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false };
    return { ok: true, f16: a.features.has('shader-f16') };
  } catch { return { ok: false }; }
}
function setAi(state, text) {
  S.ai = state;
  const pill = $('#aiPill');
  pill.dataset.s = state;
  $('#aiPillText').textContent = text || ({ ready: `AI ready · ${modelOf(S.modelKey).model}`, none: 'AI: download to use offline', unsupported: 'Library search only', loading: 'Starting AI…', error: 'AI unavailable · library search' }[state]);
  $('#compMode').textContent = state === 'ready' ? `On-device AI · ${modelOf(S.modelKey).model}` : 'Library search';
  renderStatusCard(); renderModels();
}
async function loadModel() {
  if (!S.gpu?.ok || S.ai === 'loading') return;
  const m = modelOf(S.modelKey), id = modelId(m);
  setAi('loading');
  $('#prog').hidden = false;
  try {
    const lib = await webllm();
    if (S.engine) { try { await S.engine.unload(); } catch {} S.worker?.terminate(); S.engine = null; }
    S.worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    S.engine = await lib.CreateWebWorkerMLCEngine(S.worker, id, {
      initProgressCallback: r => {
        const pct = Math.round((r.progress || 0) * 100);
        $('#progBar').style.width = pct + '%';
        $('#progText').textContent = r.text || `${pct}%`;
        $('#aiPillText').textContent = `AI ${pct}%`;
      },
    });
    S.have[m.key] = true; LS.set('halvia-bot-have', S.have); LS.set('halvia-bot-model', m.key);
    try { await navigator.storage?.persist?.(); } catch {}
    warmOfflineFiles();
    $('#prog').hidden = true;
    setAi('ready');
    toast(`${m.model} is ready. Halvia bot now works offline.`);
    storageNote();
  } catch (err) {
    console.error(err);
    S.engine = null; S.worker?.terminate();
    const why = String((err && err.message) || err);
    $('#progText').textContent = /fetch|network/i.test(why) ? "Couldn't download the model. Check the internet connection and try again." : /shader-f16|WebGPU|adapter|device/i.test(why) ? "This device's graphics can't run this model. Try the Fast model, or keep using library search." : 'The AI could not start: ' + why;
    setAi('error', navigator.onLine ? 'AI unavailable · library search' : 'Go online once to download the AI');
  }
}
async function removeModel() {
  const m = modelOf(S.modelKey);
  try { if (S.engine) await S.engine.unload(); } catch {}
  S.worker?.terminate(); S.engine = null;
  try { await (await webllm()).deleteModelAllInfoInCache(modelId(m)); } catch (e) { console.warn(e); }
  delete S.have[m.key]; LS.set('halvia-bot-have', S.have);
  setAi('none'); storageNote(); toast(`${m.model} removed from this device.`);
}
// After the model is in, make sure the PDF reader is cached too, so adding PDFs works offline.
function warmOfflineFiles() { ['./vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs'].forEach(u => fetch(u).catch(() => {})); }

const SYSTEM = strict => `You are Halvia bot, an assistant for UK doctors, nurses and other clinicians. You run offline on the user's own device.
Answer the question using ONLY the numbered sources provided. Cite the source after each fact, like [1] or [2].
${strict ? 'If the sources do not contain the answer, say "I couldn\'t find that in your library" and suggest what kind of document to add. Do not guess and do not use outside knowledge.' : 'Prefer the sources. If you add general knowledge that is not in the sources, say so clearly and do not cite it.'}
Be concise and practical: a short answer first, then bullet points if useful. Use UK spelling and units.
Never make a diagnosis or give a dose for a specific patient. Where it matters, remind the user to check local guidance and use clinical judgement.
Do not ask for, or repeat, patient-identifiable information.`;

/* ---------- chat ---------- */
function currentChat() { return S.chats.find(c => c.id === S.chatId); }
function newChat(focus = true) {
  if (S.busy) stopGen();
  S.chatId = null; renderThread(); renderChats();
  closeSide(); if (focus) $('#composerIn').focus();
}
async function ask(text) {
  text = text.trim(); if (!text || S.busy) return;
  let chat = currentChat();
  if (!chat) { chat = { id: uid(), title: text.slice(0, 60), updated: Date.now(), messages: [] }; S.chats.unshift(chat); S.chatId = chat.id; }
  const prevUser = [...chat.messages].reverse().find(m => m.role === 'user');
  chat.messages.push({ role: 'user', content: text });
  // Search on the question itself; only lean on the previous question for short follow-ups that find nothing alone.
  let hits = search(text, S.ai === 'ready' ? 4 : 3);
  const followUp = /^(and|also|what about|how about|what if|why|in |for |does (it|that|this)|is (it|that|this))|\b(it|that|this|they|them|those|these)\b/i.test(text);
  if (!hits.length && prevUser && followUp) hits = search(prevUser.content + ' ' + text, S.ai === 'ready' ? 4 : 3);
  const sources = hits.map(h => ({ title: h.doc.title, h: h.p.h && h.p.h !== h.doc.title ? h.p.h : '', page: h.p.page, text: h.p.text, starter: !!h.doc.starter }));
  const msg = { role: 'assistant', content: '', sources, mode: S.ai === 'ready' ? `On-device AI · ${modelOf(S.modelKey).model}` : 'Library search', t: Date.now() };
  chat.messages.push(msg);
  renderThread(); renderChats();
  S.busy = true; S.stopReq = false; setSend();
  try {
    if (S.ai === 'ready' && S.engine) await answerWithAi(chat, msg, text);
    else msg.content = answerFromLibrary(text, hits);
  } catch (err) {
    console.error(err);
    msg.content = (msg.content ? msg.content + '\n\n' : '') + 'Something went wrong while answering. ' + (hits.length ? 'Here is what the library says instead:\n\n' + answerFromLibrary(text, hits) : '');
    msg.mode = 'Library search';
  }
  S.busy = false; setSend();
  chat.updated = Date.now();
  updateMsg(chat.messages.length - 1, msg, true);
  saveChat(chat).then(renderChats);
}
async function answerWithAi(chat, msg, text) {
  const ctx = msg.sources.map((s, i) => `[${i + 1}] ${s.title}${s.h ? ' — ' + s.h : ''}${s.page ? ` (p. ${s.page})` : ''}\n${s.text}`).join('\n\n');
  const history = chat.messages.slice(0, -2).slice(-4).map(m => ({ role: m.role, content: m.content.slice(0, 800) }));
  const messages = [
    { role: 'system', content: SYSTEM(S.strict) },
    ...history,
    { role: 'user', content: (ctx ? `Sources:\n${ctx}` : 'Sources: none found in the library.') + `\n\nQuestion: ${text}` },
  ];
  const stream = await S.engine.chat.completions.create({ messages, stream: true, temperature: 0.2, max_tokens: 700 });
  let raf = 0;
  for await (const part of stream) {
    msg.content += part.choices[0]?.delta?.content || '';
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateMsg(chat.messages.length - 1, msg, false); });
    if (S.stopReq) break;
  }
  cancelAnimationFrame(raf);
  if (!msg.content.trim()) msg.content = answerFromLibrary(text, msg.sources.map(s => ({ p: s, doc: s })));
}
// Without the model: show the most relevant sentences from the best passages, with citations.
function answerFromLibrary(q, hits) {
  if (!hits.length) return `I couldn't find anything about that in your library.\n\nTry different words, or open the **Library** and add a guideline or paper that covers it.${S.gpu?.ok && S.ai !== 'ready' ? ' For written answers, download the on-device AI in **Settings**.' : ''}`;
  const qt = queryTerms(q), ix = S.index;
  const idf = w => { const n = ix.df.get(w) || 0; return Math.log(1 + (ix.N - n + 0.5) / (n + 0.5)); };
  const lines = hits.map((h, i) => {
    const sents = h.p.text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    // Score sentences by the rarity of the query words they share; title-like lines count for less.
    const ranked = sents.map((s, j) => {
      const t = new Set(terms(s)), heading = !/[.!?:]$/.test(s) && s.split(/\s+/).length < 14;
      return { s, j, n: qt.reduce((a, w) => a + (t.has(w) ? idf(w) : 0), 0) * (heading ? 0.5 : 1) };
    }).sort((a, b) => b.n - a.n || a.j - b.j);
    const best = ranked[0]?.n || 0;
    const pick = ranked.filter(r => r.n > 0 && r.n >= best * 0.6).slice(0, 2).sort((a, b) => a.j - b.j).map(r => r.s);
    const head = h.p.h && h.p.h !== h.doc.title ? `${h.doc.title}: ${h.p.h}` : h.doc.title;
    return `**${head}** [${i + 1}]\n> ${(pick.length ? pick : sents.slice(0, 2)).join(' ')}`;
  });
  return `Here's what your library says:\n\n${lines.join('\n\n')}\n\n${S.gpu?.ok ? 'This is a search result, not a written answer. Download the on-device AI in **Settings** for written answers.' : 'This is a search result. This device can\'t run the on-device AI, so Halvia bot is showing the passages directly.'}`;
}
function stopGen() { S.stopReq = true; try { S.engine?.interruptGenerate(); } catch {} }

/* ---------- rendering ---------- */
function md(src, nSources, mid) {
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?:\s*,?\s*\[(\d{1,2})\])*/g, m => m.match(/\d{1,2}/g).map(n => +n >= 1 && +n <= nSources ? `<a class="cite" href="#src-${mid}-${n}" aria-label="Source ${n}">${n}</a>` : `[${n}]`).join(''));
  const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; } };
  for (const line of src.split('\n')) {
    let m;
    if (!line.trim()) { flushP(); flushL(); continue; }
    if ((m = line.match(/^\s*#{1,4}\s+(.*)/))) { flushP(); flushL(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = line.match(/^\s*>\s?(.*)/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/))) {
      flushP(); const t = m[1] ? 'ol' : 'ul';
      if (!list || list.t !== t) { flushL(); list = { t, items: [] }; }
      list.items.push(m[2]); continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();
  return out.join('');
}
function msgHtml(m, i) {
  if (m.role === 'user') return `<li class="msg user"><div class="body">${esc(m.content)}</div></li>`;
  return `<li class="msg bot" id="m-${i}"><span class="ava" aria-hidden="true"><svg><use href="#heart"/></svg></span><div><div class="body">${botBody(m, i, !S.busy)}</div></div></li>`;
}
function botBody(m, i, done) {
  if (!m.content) return '<span class="typing" aria-label="Halvia bot is writing"><i></i><i></i><i></i></span>';
  let h = md(m.content, m.sources.length, i);
  if (!done) return h;
  if (m.sources.length) h += `<ol class="srcs" aria-label="Sources">${m.sources.map((s, j) => `<li><details class="src" id="src-${i}-${j + 1}"><summary><span class="n">${j + 1}</span><span class="t"><b>${esc(s.title)}</b><span>${esc([s.h, s.page && 'page ' + s.page, s.starter ? 'Halvia starter library' : 'Your library'].filter(Boolean).join(' · '))}</span></span></summary><div class="full">${esc(s.text)}</div></details></li>`).join('')}</ol>`;
  h += `<div class="meta"><span class="tag">${esc(m.mode)}</span>${m.sources.length ? `<span>${m.sources.length} source${m.sources.length > 1 ? 's' : ''}</span>` : ''}<button type="button" data-copy="${i}"><svg aria-hidden="true"><use href="#i-copy"/></svg>Copy</button></div>`;
  return h;
}
function updateMsg(i, m, done) {
  const el = document.querySelector(`#m-${i} .body`);
  if (el) el.innerHTML = botBody(m, i, done);
  stickBottom();
}
function stickBottom() { const t = $('#thread'); if (t.scrollHeight - t.scrollTop - t.clientHeight < 240) t.scrollTop = t.scrollHeight; }
function renderThread() {
  const c = currentChat();
  $('#hello').hidden = !!c;
  $('#msgs').innerHTML = c ? c.messages.map(msgHtml).join('') : '';
  const t = $('#thread'); t.scrollTop = t.scrollHeight;
}
function renderChats() {
  const ul = $('#chatList');
  const list = [...S.chats].sort((a, b) => b.updated - a.updated);
  ul.innerHTML = list.map(c => `<li class="${c.id === S.chatId ? 'on' : ''}"><button type="button" data-chat="${c.id}"${c.id === S.chatId ? ' aria-current="true"' : ''}>${esc(c.title)}</button><button class="del" type="button" data-delchat="${c.id}" aria-label="Delete chat: ${esc(c.title)}"><svg aria-hidden="true"><use href="#i-trash"/></svg></button></li>`).join('');
  $('#histEmpty').hidden = list.length > 0;
  $('#histGuest').hidden = !!S.profile;
}
function renderStatusCard() {
  const el = $('#statusCard');
  let h = '';
  if (!window.isSecureContext) h = `<p><b>Open the secure version to use the AI, sign-in and offline mode.</b> They only work over https.</p><a class="btn go sm" href="https://${esc(location.host)}${esc(location.pathname)}">Open secure version</a>`;
  else if (S.ai === 'unsupported') h = `<p><b>This browser can't run the on-device AI</b>, so Halvia bot answers by searching the library and showing the passages. For written answers, use a recent version of Chrome, Edge or Safari on a laptop or phone that supports WebGPU.</p>`;
  else if (S.ai === 'none' || S.ai === 'error') h = `<p><b>Download the AI once and Halvia bot works with no internet.</b> The fast model is ${modelOf(S.modelKey).size} and stays on this device. Until then, I'll answer by searching the library.</p><button class="btn go sm" type="button" data-act="download">Download AI</button>`;
  else if (S.ai === 'loading') h = `<p><b>Starting the on-device AI…</b> The first download can take a few minutes on Wi-Fi. You can ask questions meanwhile: I'll search the library.</p>`;
  el.innerHTML = h; el.hidden = !h;
}
function renderModels() {
  const box = $('#models'); if (!box) return;
  box.innerHTML = '<legend class="sr">Choose a model</legend>' + MODELS.map(m => `<label class="model"><input type="radio" name="model" value="${m.key}"${m.key === S.modelKey ? ' checked' : ''}${S.gpu?.ok ? '' : ' disabled'}><span><b>${m.name}</b> · ${m.model}<small>${m.note}</small></span><span class="sz">${m.size}${S.have[m.key] ? '<br><span class="have">On this device</span>' : ''}</span></label>`).join('');
  const dl = $('#dlBtn'), rm = $('#rmBtn');
  const sel = modelOf(S.modelKey);
  dl.disabled = !S.gpu?.ok || S.ai === 'loading' || (S.ai === 'ready');
  dl.textContent = S.ai === 'ready' ? `${sel.model} is running` : S.have[sel.key] ? `Start ${sel.model}` : `Download ${sel.model} for offline use`;
  rm.hidden = !S.have[sel.key];
  $('#gpuNote').innerHTML = S.gpu == null ? 'Checking whether this device can run the AI…'
    : S.gpu.ok ? 'This device can run the AI. Download a model once over Wi-Fi; it stays on this device and works with no internet. Bigger models give better answers but need more memory.'
    : "This browser doesn't support WebGPU, so the AI can't run here. Halvia bot still works offline by searching your library. Try a recent Chrome, Edge or Safari for written answers.";
}
async function storageNote() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $('#storeNote').textContent = `Halvia bot is using ${(e.usage / 1e9).toFixed(2)} GB on this device.${persisted ? ' Storage is protected from automatic clean-up.' : ''}`;
  } catch {}
}
function renderLibrary() {
  const row = (d, starter) => `<li class="doc"><svg aria-hidden="true"><use href="#i-file"/></svg><span><b>${esc(d.title)}</b><small>${esc(starter ? d.source : `${d.kind} · ${d.passages.length} passage${d.passages.length === 1 ? '' : 's'} · added ${new Date(d.added).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`)}</small></span>${starter ? `<a href="library/${d.file}" target="_blank" rel="noopener">Read<span class="sr"> ${esc(d.title)}</span></a>` : `<button type="button" data-deldoc="${d.id}" aria-label="Remove ${esc(d.title)}"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>`}</li>`;
  $('#starterList').innerHTML = S.starter.map(d => row(d, true)).join('');
  $('#mineList').innerHTML = S.mine.map(d => row(d, false)).join('');
  $('#mineEmpty').hidden = S.mine.length > 0;
  $('#mineGuest').hidden = !!S.profile;
  $('#mineBox').hidden = !S.profile;
}
function renderMe() {
  const p = S.profile;
  const initials = p ? p.name.replace(/^(dr|mr|mrs|ms|miss|prof)\.?\s+/i, '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?';
  $('#meWho').innerHTML = `<span class="av" aria-hidden="true">${esc(initials)}</span><span><b>${esc(p ? p.name : 'Guest')}</b><small>${esc(p ? p.role + ' · on this device' : 'Not signed in')}</small></span>`;
  $('#signBtn').textContent = p ? 'Lock' : 'Sign in';
  $('#signBtn').setAttribute('aria-label', p ? 'Lock and sign out' : 'Sign in');
  $('#dataNote').textContent = p ? `Signed in as ${p.name}. ${S.mine.length} document${S.mine.length === 1 ? '' : 's'} and ${S.chats.length} chat${S.chats.length === 1 ? '' : 's'} are stored encrypted on this device.` : "You're using Halvia bot as a guest. Chats are not saved. Sign in to keep chats and add your own documents.";
  $('#dataActs').hidden = !p;
  const h = new Date().getHours(), part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#helloH').textContent = p ? `${part}, ${p.name.split(/\s+/).slice(0, 2).join(' ')}` : 'How can I help on shift?';
  renderChats();
}
function setSend() {
  const b = $('#send'), has = $('#composerIn').value.trim().length > 0;
  b.classList.toggle('stop', S.busy);
  b.disabled = !S.busy && !has;
  b.setAttribute('aria-label', S.busy ? 'Stop writing' : 'Send message');
  b.innerHTML = `<svg aria-hidden="true"><use href="#i-${S.busy ? 'stop' : 'up'}"/></svg>`;
}
let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 4200); }

/* ---------- profiles ---------- */
async function profiles() { try { return await DB.all('profiles'); } catch { return []; } }
async function openSign() {
  if (!window.isSecureContext || !crypto.subtle) { toast('Sign-in needs a secure (https) connection.'); return; }
  const list = await profiles();
  $('#profPick').innerHTML = '<legend>Profile on this device</legend>' + list.map((p, i) => `<label class="prof"><input type="radio" name="prof" value="${p.id}"${i === 0 ? ' checked' : ''}><span><b>${esc(p.name)}</b><small>${esc(p.role)}</small></span></label>`).join('');
  tab(list.length ? 'in' : 'new');
  $('#tabIn').disabled = !list.length;
  $('#inErr').textContent = $('#newErr').textContent = '';
  $('#signDlg').showModal();
}
function tab(which) {
  const isIn = which === 'in';
  $('#tabIn').setAttribute('aria-selected', isIn); $('#tabNew').setAttribute('aria-selected', !isIn);
  $('#tabIn').tabIndex = isIn ? 0 : -1; $('#tabNew').tabIndex = isIn ? -1 : 0;
  $('#panIn').hidden = !isIn; $('#panNew').hidden = isIn;
  $('#signH').textContent = isIn ? 'Sign in' : 'Create a profile';
}
async function unlock(p, key) {
  S.profile = { id: p.id, name: p.name, role: p.role }; S.key = key;
  S.mine = []; S.chats = [];
  for (const rec of await DB.owned(p.id)) {
    try { const v = await unseal(rec); (rec.kind === 'doc' ? S.mine : S.chats).push(v); } catch (e) { console.warn('Could not open', rec.id, e); }
  }
  S.mine.sort((a, b) => b.added - a.added);
  S.chatId = null; S.lastActive = Date.now();
  buildIndex(); renderLibrary(); renderMe(); renderThread();
}
function lock(msg) {
  S.profile = null; S.key = null; S.mine = []; S.chats = []; S.chatId = null;
  buildIndex(); renderLibrary(); renderMe(); renderThread();
  if (msg) toast(msg);
}

/* ---------- wiring ---------- */
function openSide() { $('#side').classList.add('open'); $('#side').inert = false; $('#scrim').hidden = false; $('#sideOpen').setAttribute('aria-expanded', 'true'); $('#newChat').focus(); }
function closeSide() { if (!mobile()) return; $('#side').classList.remove('open'); $('#side').inert = true; $('#scrim').hidden = true; $('#sideOpen').setAttribute('aria-expanded', 'false'); }
const mobile = () => matchMedia('(max-width:52rem)').matches;
function syncSide() { $('#side').inert = mobile() && !$('#side').classList.contains('open'); if (!mobile()) $('#scrim').hidden = true; }

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  LS.set('halvia-bot-theme-choice', t);
  try { if (t === 'system') localStorage.removeItem('halvia-bot-theme'); else localStorage.setItem('halvia-bot-theme', t); } catch {}
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#themeBtn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to night mode');
  document.querySelectorAll('input[name="theme"]').forEach(r => (r.checked = r.value === t));
}
function net() {
  const on = navigator.onLine, p = $('#netPill');
  p.classList.toggle('on', on); p.classList.toggle('off', !on);
  p.querySelector('span').textContent = on ? 'Online' : 'Offline · still working';
  p.setAttribute('aria-label', on ? 'Online' : 'Offline, Halvia bot is still working');
}

let pendingSend = null;
function trySend(text) {
  const found = piiIn(text);
  if (found.length) { pendingSend = text; $('#piiWhat').textContent = `(it looks like ${found[0]})`; $('#pii').hidden = false; $('#piiEdit').focus(); return; }
  send(text);
}
function send(text) {
  $('#pii').hidden = true; pendingSend = null;
  $('#composerIn').value = ''; grow(); setSend();
  ask(text);
}
function grow() { const t = $('#composerIn'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 192) + 'px'; }

async function init() {
  // Starter library
  try {
    const list = await (await fetch('library/index.json')).json();
    S.starter = await Promise.all(list.map(async d => ({ ...d, starter: true, passages: toPassages(await (await fetch('library/' + d.file)).text()) })));
  } catch (e) { console.warn('Starter library unavailable', e); }
  $('#useStarter').checked = S.useStarter; $('#strict').checked = S.strict;
  buildIndex(); renderLibrary(); renderMe(); renderThread(); renderModels(); net(); syncSide();
  applyTheme(LS.get('halvia-bot-theme-choice', 'system'));

  // Events
  const form = $('#composer'), input = $('#composerIn');
  input.addEventListener('input', () => { grow(); setSend(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.busy) form.requestSubmit(); } });
  form.addEventListener('submit', e => { e.preventDefault(); if (S.busy) { stopGen(); return; } trySend(input.value); });
  $('#piiEdit').onclick = () => { $('#pii').hidden = true; input.focus(); };
  $('#piiSend').onclick = () => pendingSend && send(pendingSend);
  $('#sugs').addEventListener('click', e => { const b = e.target.closest('.sug'); if (b) send(b.textContent); });
  $('#newChat').onclick = () => newChat();
  $('#brand').onclick = () => newChat();
  $('#chatList').addEventListener('click', async e => {
    const open = e.target.closest('[data-chat]'), del = e.target.closest('[data-delchat]');
    if (open) { S.chatId = open.dataset.chat; renderThread(); renderChats(); closeSide(); }
    if (del) {
      const id = del.dataset.delchat;
      S.chats = S.chats.filter(c => c.id !== id);
      if (S.profile) await DB.del('vault', 'chat:' + id);
      if (S.chatId === id) S.chatId = null;
      renderThread(); renderChats(); toast('Chat deleted.');
    }
  });
  $('#msgs').addEventListener('click', e => {
    const c = e.target.closest('[data-copy]');
    if (c) { const m = currentChat()?.messages[+c.dataset.copy]; if (m) navigator.clipboard?.writeText(m.content).then(() => toast('Copied.'), () => {}); }
    const cite = e.target.closest('.cite');
    if (cite) { const d = document.querySelector(cite.getAttribute('href')); if (d) { e.preventDefault(); d.open = true; d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); d.querySelector('summary').focus(); } }
  });
  document.addEventListener('click', e => {
    const close = e.target.closest('[data-close]'); if (close) close.closest('dialog').close();
    if (e.target.closest('[data-act="download"]')) loadModel();
  });
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  $('#openLib').onclick = () => { renderLibrary(); progressIngest(''); $('#libDlg').showModal(); closeSide(); };
  $('#attach').onclick = () => { renderLibrary(); progressIngest(''); $('#libDlg').showModal(); if (S.profile) $('#fileIn').click(); };
  $('#openSet').onclick = () => { renderModels(); renderMe(); storageNote(); $('#setDlg').showModal(); closeSide(); };
  $('#aiPill').onclick = () => { renderModels(); storageNote(); $('#setDlg').showModal(); };
  $('#libSign').onclick = () => { $('#libDlg').close(); openSign(); };
  $('#signBtn').onclick = () => (S.profile ? lock('Locked. Your documents and chats are encrypted on this device.') : openSign());
  $('#tabIn').onclick = () => tab('in'); $('#tabNew').onclick = () => tab('new');
  $('.tabs').addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const to = $('#panIn').hidden ? 'in' : 'new'; if (to === 'in' && $('#tabIn').disabled) return; tab(to); (to === 'in' ? $('#tabIn') : $('#tabNew')).focus(); } });
  $('#formNew').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#nName').value.trim(), role = $('#nRole').value, a = $('#nPass').value, b = $('#nPass2').value;
    if (a !== b) { $('#newErr').textContent = "The passcodes don't match."; return; }
    const salt = crypto.getRandomValues(new Uint8Array(16)), key = await deriveKey(a, salt), id = uid();
    S.key = key;
    const p = { id, name, role, salt, created: Date.now(), check: await seal({ ok: 'halvia' }) };
    await DB.put('profiles', p);
    // Bring any guest chat into the new profile.
    const guest = S.chats;
    await unlock(p, key);
    for (const c of guest) { S.chats.push(c); await saveChat(c); }
    renderChats(); renderMe();
    e.target.reset(); $('#signDlg').close(); toast(`Welcome, ${name}. You can now add your own documents.`);
  });
  $('#formIn').addEventListener('submit', async e => {
    e.preventDefault();
    const id = (document.querySelector('input[name="prof"]:checked') || {}).value;
    const p = (await profiles()).find(x => x.id === id); if (!p) return;
    try {
      const key = await deriveKey($('#inPass').value, p.salt);
      await unseal(p.check, key);
      await unlock(p, key);
      e.target.reset(); $('#signDlg').close(); toast(`Signed in as ${p.name}.`);
    } catch { $('#inErr').textContent = "That passcode isn't right."; $('#inPass').select(); }
  });
  $('#fileIn').addEventListener('change', e => { ingestFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); ingestFiles([...e.dataTransfer.files]); });
  $('#pasteForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { doc, pii } = await addDocument($('#pasteTitle').value.trim(), 'Pasted text', { text: $('#pasteText').value }, $('#pasteText').value.length);
      progressIngest(`Added ${doc.title}: ${doc.passages.length} passage${doc.passages.length === 1 ? "" : "s"} indexed.` + (pii.length ? ` It may contain ${pii[0]}; Halvia bot is not meant for patient data.` : ''));
      e.target.reset();
    } catch (err) { progressIngest(err.message); }
  });
  $('#mineList').addEventListener('click', async e => {
    const b = e.target.closest('[data-deldoc]'); if (!b) return;
    const d = S.mine.find(x => x.id === b.dataset.deldoc);
    if (!d || !confirm(`Remove "${d.title}" from your library?`)) return;
    S.mine = S.mine.filter(x => x !== d); await DB.del('vault', 'doc:' + d.id);
    buildIndex(); renderLibrary(); progressIngest(`Removed ${d.title}.`);
  });
  $('#useStarter').onchange = e => { S.useStarter = e.target.checked; LS.set('halvia-bot-starter', S.useStarter); buildIndex(); };
  $('#strict').onchange = e => { S.strict = e.target.checked; LS.set('halvia-bot-strict', S.strict); };
  $('#models').addEventListener('change', e => {
    if (e.target.name !== 'model') return;
    S.modelKey = e.target.value; LS.set('halvia-bot-model', S.modelKey);
    if (S.ai === 'ready') { S.engine?.unload?.(); S.worker?.terminate(); S.engine = null; setAi('none'); }
    renderModels(); renderStatusCard();
  });
  $('#dlBtn').onclick = () => loadModel();
  $('#rmBtn').onclick = () => { if (confirm(`Remove ${modelOf(S.modelKey).model} from this device? You'll need the internet to download it again.`)) removeModel(); };
  $('#themeSeg').addEventListener('change', e => applyTheme(e.target.value));
  $('#themeBtn').onclick = () => { const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches); applyTheme(dark ? 'light' : 'dark'); };
  $('#clearChats').onclick = async () => {
    if (!confirm('Delete all your chats on this device?')) return;
    for (const c of S.chats) await DB.del('vault', 'chat:' + c.id);
    S.chats = []; S.chatId = null; renderThread(); renderMe(); toast('All chats deleted.');
  };
  $('#delProfile').onclick = async () => {
    if (!confirm('Delete your profile, documents and chats from this device? This cannot be undone.')) return;
    for (const rec of await DB.owned(S.profile.id)) await DB.del('vault', rec.id);
    await DB.del('profiles', S.profile.id);
    $('#setDlg').close(); lock('Profile deleted.');
  };
  $('#sideOpen').onclick = openSide; $('#sideClose').onclick = closeSide; $('#scrim').onclick = closeSide;
  $('#side').addEventListener('keydown', e => { if (e.key === 'Escape') { closeSide(); $('#sideOpen').focus(); } });
  matchMedia('(max-width:52rem)').addEventListener('change', syncSide);
  addEventListener('online', net); addEventListener('offline', net);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.busy) stopGen(); });
  ['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => (S.lastActive = Date.now()), { passive: true }));
  setInterval(() => { if (S.profile && Date.now() - S.lastActive > IDLE_LOCK_MS) lock('Locked after 15 minutes without use.'); }, 30000);

  let deferred;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; };
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline cache unavailable', e));

  // AI: detect, then start the model straight away if it's already on this device.
  S.gpu = await detectGpu();
  if (!S.gpu.ok) { setAi('unsupported', window.isSecureContext ? undefined : 'Needs https for AI'); return; }
  setAi('none');
  if (S.have[S.modelKey]) {
    try { if (await (await webllm()).hasModelInCache(modelId(modelOf(S.modelKey)))) loadModel(); else { delete S.have[S.modelKey]; LS.set('halvia-bot-have', S.have); renderModels(); } } catch {}
  }
}
init();
