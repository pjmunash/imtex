/*
Browser OCR implementation using Tesseract.js and optional OCR.Space.
Features: multi-threshold variants, multi-config OCR passes, consensus filtering,
dominant prefix filtering, per-image isolation, drag/drop, multi-file selection, strip scanning.
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
let lastValidatedIds = [];

// --- Strip Scanning Utility ---
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

function loadImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function generateVariants(canvas) {
  const variants = [];
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  function createThresholdCanvas(threshold, invert = false) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const context = c.getContext('2d');
    const newData = context.createImageData(imgData.width, imgData.height);
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const binary = invert ? (gray < threshold ? 255 : 0) : (gray > threshold ? 255 : 0);
      newData.data[i] = newData.data[i + 1] = newData.data[i + 2] = binary;
      newData.data[i + 3] = 255;
    }
    context.putImageData(newData, 0, 0);
    return c;
  }

  // Generate 8 threshold variants
  [100, 120, 140, 160, 180].forEach(t => variants.push(createThresholdCanvas(t)));
  [100, 140, 180].forEach(t => variants.push(createThresholdCanvas(t, true)));
  
  return variants;
}

// --- OCR functions ---
async function ocrWithTesseract(canvas) {
  const dataUrl = canvas.toDataURL();
  const result = await Tesseract.recognize(dataUrl, 'eng', {
    tessedit_char_whitelist: '0123456789NG',
  });
  return result.data.text.split('\n').filter(Boolean);
}

async function ocrWithOCRSpace(file, apiKey) {
  setApiStatus('pending', 'Calling OCR.Space...');
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('apikey', apiKey);
  formData.append('language', 'eng');
  formData.append('isOverlayRequired', 'false');

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    setApiStatus('error', 'OCR.Space network error');
    throw new Error('OCR.Space network error');
  }

  const payload = await response.json();
  if (payload.OCRExitCode !== 1) {
    const msg = payload.ErrorMessage || payload.ErrorDetails || 'OCR.Space returned an error';
    setApiStatus('error', msg);
    throw new Error(msg);
  }

  setApiStatus('ok', 'OCR.Space OK');
  
  const parsed = payload.ParsedResults || [];
  if (!parsed.length) return [];
  const text = parsed[0].ParsedText || '';
  return text.split('\n').filter(Boolean);
}

// --- ID extraction ---
function extractIds(lines, options = {}) {
  const { perImage = false, strict = false } = options;
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

  const counts = new Map();
  for (const id of idCandidates) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const minCount = strict ? 3 : 2;
  const fallbackCount = strict ? 5 : 4;

  let ids = [];
  const prefixMap = new Map();
  for (const id of counts.keys()) {
    const prefix = id.slice(0, 5);
    prefixMap.set(prefix, (prefixMap.get(prefix) || 0) + 1);
  }

  const totalIds = counts.size;
  let dominant = null;
  for (const [prefix, prefixCount] of prefixMap.entries()) {
    const ratio = prefixCount / totalIds;
    if (ratio >= (perImage ? 0.5 : 0.6)) {
      dominant = prefix;
      break;
    }
  }

  if (dominant) {
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
async function processImage(file, engine, apiKey, strict, useStrips = true, stripHeight = 0.5) {
  setStatus(`Processing ${file.name}...`);
  
  // Load base canvas
  const baseCanvas = await loadImageToCanvas(file);
  
  // Split into strips if enabled
  let canvasesToProcess = [baseCanvas];
  if (useStrips) {
    canvasesToProcess = splitIntoStrips(baseCanvas, stripHeight);
  }
  
  // Generate variants for all canvases (strips or single image)
  let variants = [];
  for (const canvas of canvasesToProcess) {
    const canvasVariants = generateVariants(canvas);
    variants = variants.concat(canvasVariants);
  }

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
      const res = await processImage(file, engine, apiKey, strict, useStrips, stripHeight);
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
      errEl.style.color = '#e94560';
      errEl.textContent = `Error: ${error}`;
      card.appendChild(errEl);
    } else {
      if (ids.length) {
        const idsEl = document.createElement('pre');
        idsEl.className = 'output-box';
        idsEl.textContent = ids.join('\n');
        card.appendChild(idsEl);

        lastValidatedIds.push(...ids);
      } else {
        const noIds = document.createElement('div');
        noIds.style.color = '#94a3b8';
        noIds.textContent = 'No IDs found';
        card.appendChild(noIds);
      }
    }

    cardsEl.appendChild(card);
  }

  // Aggregate validated IDs
  const uniqueIds = [...new Set(lastValidatedIds)].sort();
  if (uniqueIds.length) {
    idsOutput.textContent = uniqueIds.join('\n');
    copyIdsBtn.disabled = false;
  } else {
    idsOutput.textContent = 'No IDs extracted';
  }

  setStatus(`Extracted ${uniqueIds.length} unique IDs from ${imageFiles.length} images`);
  extractBtn.disabled = false;
}

function clearAll() {
  imageFiles = [];
  lastValidatedIds = [];
  cardsEl.innerHTML = '';
  idsOutput.textContent = '';
  setStatus('Ready');
  extractBtn.disabled = true;
  copyIdsBtn.disabled = true;
  fileInput.value = '';
}

function copyIds() {
  if (!idsOutput.textContent || idsOutput.textContent === 'No IDs extracted') return;
  navigator.clipboard.writeText(idsOutput.textContent).then(() => {
    alert('IDs copied to clipboard!');
  }).catch(err => {
    alert('Failed to copy: ' + err);
  });
}

// --- Event listeners ---
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#e94560';
});
dropzone.addEventListener('dragleave', () => {
  dropzone.style.borderColor = '#94a3b8';
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#94a3b8';
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (files.length) {
    imageFiles = files;
    setStatus(`${files.length} file(s) selected`);
    extractBtn.disabled = false;
  }
});

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length) {
    imageFiles = files;
    setStatus(`${files.length} file(s) selected`);
    extractBtn.disabled = false;
  }
});

extractBtn.addEventListener('click', extractAll);
clearBtn.addEventListener('click', clearAll);
copyIdsBtn.addEventListener('click', copyIds);

// Initial state
setStatus('Ready');
