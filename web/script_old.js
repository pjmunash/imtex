/*
Browser OCR implementation using Tesseract.js and optional OCR.Space.
Features: multi-threshold variants, multi-config OCR passes, consensus filtering,
dominant prefix filtering, per-image isolation, drag/drop, multi-file selection.
*/

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const extractBtn = document.getElementById('extract-btn');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('status');
const idsOutput = document.getElementById('ids-output');
const copyIdsBtn = document.getElementById('copy-ids');
const cardsEl = document.getElementById('cards');
const strictModeInput = document.getElementById('strict-mode');
const apiStatus = document.getElementById('api-status');

// Built-in OCR.Space API key
const OCR_SPACE_API_KEY = 'K82313421388957';

let imageFiles = [];

function splitIntoStrips(canvas, stripHeightCm = 0.5) {
  // Assume 300 DPI for conversion
  const dpi = 300;
  const stripHeightPx = Math.floor(stripHeightCm * dpi / 2.54); // cm to pixels
  
  const strips = [];
  const height = canvas.height;
  const width = canvas.width;
  
  let y = 0;
  while (y < height) {
    const yEnd = Math.min(y + stripHeightPx, height);
    const stripHeight = yEnd - y;
    
    // Create new canvas for this strip
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width = width;
    stripCanvas.height = stripHeight;
    const stripCtx = stripCanvas.getContext('2d');
    
    // Copy strip from original canvas
    const imageData = canvas.getContext('2d').getImageData(0, y, width, stripHeight);
    stripCtx.putImageData(imageData, 0, 0);
    
    strips.push(stripCanvas);
    y = yEnd;
  }
  
  return strips;
}

let lastValidatedIds = [];

// --- Utils ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function setStatus(text) {
  statusEl.textContent = text;
}

function setApiStatus(state, msg) {
  if (!apiStatus) return;
  if (state === 'ok') {
    apiStatus.textContent = msg || 'OCR.Space OK';
    apiStatus.classList.remove('error');
  } else if (state === 'error') {
    apiStatus.textContent = msg || 'OCR.Space error';
    apiStatus.classList.add('error');
  } else if (state === 'pending') {
    apiStatus.textContent = msg || 'Calling OCR.Space...';
    apiStatus.classList.remove('error');
  } else {
    apiStatus.textContent = msg || 'API not used';
    apiStatus.classList.remove('error');
  }
}

function addFiles(files) {
  const valid = [];
  const exts = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif'];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (exts.some((ext) => lower.endsWith(ext))) valid.push(f);
  }
  if (valid.length === 0) return;
  // append unique by name+size
  const existingKeys = new Set(imageFiles.map((f) => `${f.name}-${f.size}`));
  for (const f of valid) {
    const key = `${f.name}-${f.size}`;
    if (!existingKeys.has(key)) imageFiles.push(f);
  }
  extractBtn.disabled = imageFiles.length === 0;
  setStatus(`Loaded ${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'}`);
}

// Drag & drop
['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
  });
});
dropzone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  addFiles(files);
});

fileInput.addEventListener('change', (e) => {
  addFiles(Array.from(e.target.files || []));
});

clearBtn.addEventListener('click', () => {
  imageFiles = [];
  lastValidatedIds = [];
  idsOutput.textContent = '';
  cardsEl.innerHTML = '';
  extractBtn.disabled = true;
  copyIdsBtn.disabled = true;
  setStatus('Ready');
});

copyIdsBtn.addEventListener('click', () => {
  if (!lastValidatedIds.length) return;
  navigator.clipboard.writeText(lastValidatedIds.join('\n'));
  setStatus('IDs copied to clipboard');
});

// --- Image preprocessing ---
async function loadImageToCanvas(file, minSize = 1000) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const scale = Math.max(minSize / img.width, minSize / img.height, 1);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);
  return canvas;
}

function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function thresholdVariant(srcCanvas, threshold = 128, invert = false) {
  const canvas = document.createElement('canvas');
  canvas.width = srcCanvas.width;
  canvas.height = srcCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    let val = v > threshold ? 255 : 0;
    if (invert) val = 255 - val;
    d[i] = d[i + 1] = d[i + 2] = val;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function generateVariants(baseCanvas) {
  const gray = toGrayscale(baseCanvas);
  return [
    thresholdVariant(gray, 100, false),
    thresholdVariant(gray, 120, false),
    thresholdVariant(gray, 140, false),
    thresholdVariant(gray, 160, false),
    thresholdVariant(gray, 180, false),
    thresholdVariant(gray, 140, true),
    thresholdVariant(gray, 170, true),
    gray,
  ];
}

// --- OCR helpers ---
const tessConfigs = [
  { lang: 'eng', tessedit_pageseg_mode: '6' },
  { lang: 'eng', tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'NG0123456789' },
  { lang: 'eng', tessedit_pageseg_mode: '4' },
];

async function ocrWithTesseract(canvas) {
  const results = [];
  for (const config of tessConfigs) {
    const { data } = await Tesseract.recognize(canvas, 'eng', { tessedit_pageseg_mode: config.tessedit_pageseg_mode, tessedit_char_whitelist: config.tessedit_char_whitelist });
    const lines = (data.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    results.push(...lines);
    await sleep(10);
  }
  return results;
}

async function ocrWithOCRSpace(file, apiKey) {
  setApiStatus('pending');
  const form = new FormData();
  form.append('file', file);
  form.append('language', 'eng');
  form.append('isOverlayRequired', 'false');
  form.append('apikey', apiKey);
  const resp = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
  if (!resp.ok) throw new Error('OCR.Space request failed');
  const payload = await resp.json();
  if (payload.OCRExitCode !== 1) throw new Error(payload.ErrorMessage || 'OCR.Space error');
  const parsed = payload.ParsedResults && payload.ParsedResults[0] ? payload.ParsedResults[0].ParsedText : '';
  setApiStatus('ok');
  return parsed.split('\n').map((l) => l.trim()).filter(Boolean);
}

// --- ID extraction logic ---
function extractIds(lines, { perImage = true, strict = false } = {}) {
  const idCandidates = [];
  const charMap = {
    O: '0', o: '0', Q: '0', D: '0',
    I: '1', i: '1', l: '1', L: '1', T: '1', '|': '1',
    Z: '2', z: '2',
    S: '5', s: '5',
    G: '6', b: '6',
    B: '8',
    '°': '0', 'º': '0',
  };

  for (const line of lines) {
    let cleaned = line.trim().toUpperCase().replace(/[ ,\-()]/g, '');

    // Fix common 013 patterns
    if (cleaned.startsWith('NGOIS') || cleaned.startsWith('NGO1S') || cleaned.startsWith('NGOLS')) cleaned = 'NG013' + cleaned.slice(5);
    else if (cleaned.startsWith('NGOI') || cleaned.startsWith('NGOL')) cleaned = 'NG013' + cleaned.slice(4);
    else if (cleaned.startsWith('NGO1') && cleaned[4] && !/\d/.test(cleaned[4])) cleaned = 'NG013' + cleaned.slice(4);
    else if (cleaned.startsWith('NEOS')) cleaned = 'NG013' + cleaned.slice(4);
    else if (cleaned.startsWith('NEO')) cleaned = 'NG013' + cleaned.slice(3);
    else if (cleaned.startsWith('WG') || cleaned.startsWith('W6')) cleaned = 'NG' + cleaned.slice(2);
    else if (cleaned.startsWith('MG') || cleaned.startsWith('M6')) cleaned = 'NG' + cleaned.slice(2);
    else if (cleaned.startsWith('N6')) cleaned = 'NG' + cleaned.slice(2);

    let filtered = '';
    for (const ch of cleaned) {
      if (/^[A-Z0-9]$/.test(ch)) filtered += ch;
      else if (charMap[ch]) filtered += charMap[ch];
    }

    if (!filtered.startsWith('NG')) {
      const idx = filtered.indexOf('NG');
      if (idx > 0 && idx < 5) filtered = filtered.slice(idx);
      else continue;
    }

    const core = filtered.slice(2);
    const digits = [];
    for (const ch of core) {
      if (/\d/.test(ch)) digits.push(ch);
      else if (charMap[ch]) digits.push(charMap[ch]);
    }
    if (digits.length >= 7) {
      const candidate = 'NG' + digits.slice(0, 7).join('');
      idCandidates.push(candidate);
    }
  }

  // Consensus + dominant prefix
  const counts = new Map();
  for (const id of idCandidates) counts.set(id, (counts.get(id) || 0) + 1);
  const prefixes = new Map();
  for (const id of counts.keys()) {
    const p = id.slice(0, 5);
    prefixes.set(p, (prefixes.get(p) || 0) + 1);
  }
  const sortedPrefixes = Array.from(prefixes.entries()).sort((a, b) => b[1] - a[1]);
  const dominant = sortedPrefixes[0] ? sortedPrefixes[0][0] : null;
  const threshold = perImage ? 0.5 : 0.6;

  let ids = [];
  const minCount = strict ? 3 : 2;
  const fallbackCount = strict ? 5 : 4;

  if (dominant && (sortedPrefixes.length === 1 || sortedPrefixes[0][1] >= sortedPrefixes.length * threshold)) {
    for (const [id, count] of counts.entries()) {
      if (id.startsWith(dominant) && count >= minCount) ids.push(id);
    }
  } else {
    for (const [id, count] of counts.entries()) {
      if (count >= fallbackCount) ids.push(id);
    }
  }

  return ids;
}

// --- Main extraction ---
async function processImage(file, engine, apiKey, strict) {
  setStatus(`Processing ${file.name}...`);
  const variants = await (async () => {
    const base = await loadImageToCanvas(file);
    return generateVariants(base);
  })();

  const allLines = [];

  // Tesseract passes
  if (engine === 'tesseract' || engine === 'dual') {
    for (const v of variants) {
      const lines = await ocrWithTesseract(v);
      allLines.push(...lines);
    }
  }

  // OCR.Space pass
  if ((engine === 'ocrspace' || engine === 'dual') && apiKey) {
    try {
      const lines = await ocrWithOCRSpace(file, apiKey);
      allLines.push(...lines);
    } catch (err) {
      console.warn('OCR.Space error', err);
      setApiStatus('error', 'OCR.Space error');
    }
  }
  if ((engine === 'ocrspace' || engine === 'dual') && !apiKey) {
    setApiStatus('idle', 'API not used');
  }

  const ids = extractIds(allLines, { perImage: true, strict });
  return { lines: allLines, ids };
}

async function extractAll() {
  if (!imageFiles.length) return;
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const apiKey = OCR_SPACE_API_KEY;
  const strict = !!strictModeInput?.checked;
  const useStrips = document.getElementById('strip-enabled')?.checked ?? true;
  const stripHeight = parseFloat(document.getElementById('strip-height')?.value || '0.5');
  extractBtn.disabled = true;
  copyIdsBtn.disabled = true;
  cardsEl.innerHTML = '';
  idsOutput.textContent = '';
  lastValidatedIds = [];

  const results = [];
  for (const file of imageFiles) {
    try {
      const res = await processImage(file, engine, apiKey);
      results.push({ file, ...res });
    } catch (err) {
      console.error(err);
      results.push({ file, lines: [], ids: [], error: err.message });
    }
  }

  // Render
  for (const { file, lines, ids, error } of results) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('h4');
    title.textContent = `${file.name}`;
    card.appendChild(title);

    if (error) {
      const errEl = document.createElement('div');
      errEl.textContent = `Error: ${error}`;
      card.appendChild(errEl);
    }

    const textPre = document.createElement('pre');
    textPre.textContent = lines.join('\n');
    card.appendChild(textPre);

    const idsPre = document.createElement('pre');
    idsPre.className = 'id-list';
    idsPre.textContent = ids.join('\n');
    card.appendChild(idsPre);

    cardsEl.appendChild(card);
    for (const id of ids) if (!lastValidatedIds.includes(id)) lastValidatedIds.push(id);
  }

  idsOutput.textContent = lastValidatedIds.join('\n');
  copyIdsBtn.disabled = lastValidatedIds.length === 0;
  extractBtn.disabled = false;
  setStatus(`Done. Processed ${results.length} image${results.length === 1 ? '' : 's'}`);
}

extractBtn.addEventListener('click', extractAll);

// Initial status
setStatus('Ready. Add images to begin.');
