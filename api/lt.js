// ОЗВУЧКА — проверка текста: LanguageTool (точные позиции) + Gemini поверх него
// (объяснения по-русски и отсев ложных срабатываний), как в tlumach.
// ENV: LT_URL, LT_USER, LT_KEY — свой или премиальный LanguageTool (необязательно)
//      MODEL_TEXT / GEMINI_MODEL, GEMINI_API_KEY | GOOGLE_API_KEY | GEMINI_API_KEYS
//      OZV_PASSWORD — тот же код доступа, что у озвучки
const LT_DEFAULT = 'https://api.languagetool.org';
const LANG = { de: 'de-DE', ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };
const LANG_NAME = { de: 'German', ru: 'Russian', uk: 'Ukrainian', en: 'English' };
const MAX_MATCHES = 25;

function gKeys() {
  const out = [];
  const add = v => { const k = String(v || '').trim(); if (k && !out.includes(k)) out.push(k); };
  add(process.env.GEMINI_API_KEY); add(process.env.GOOGLE_API_KEY);
  String(process.env.GEMINI_API_KEYS || '').split(',').forEach(add);
  return out;
}

async function languageTool(text, lang) {
  const form = new URLSearchParams({ text, language: lang, level: 'picky' });
  if (process.env.LT_USER && process.env.LT_KEY) {
    form.set('username', process.env.LT_USER);
    form.set('apiKey', process.env.LT_KEY);
  }
  const base = String(process.env.LT_URL || LT_DEFAULT).replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(base + '/v2/check', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
    const txt = await r.text();
    if (!r.ok) {
      const e = new Error(r.status === 429 ? 'LanguageTool просит подождать — слишком много проверок подряд'
        : r.status === 413 ? 'Слишком длинный текст для одной проверки'
        : 'LanguageTool ' + r.status);
      e.status = r.status; throw e;
    }
    return (JSON.parse(txt).matches || []).slice(0, MAX_MATCHES).map(m => ({
      o: m.offset, l: m.length,
      msg: m.shortMessage || m.message || '',
      full: m.message || '',
      cat: ((m.rule || {}).category || {}).name || '',
      reps: (m.replacements || []).slice(0, 5).map(x => x.value),
      id: (m.rule || {}).id || '', type: (m.rule || {}).issueType || '',
    }));
  } finally { clearTimeout(timer); }
}

async function gemini(key, model, prompt) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let m = 'Gemini ' + r.status;
    try { m = JSON.parse(txt).error.message || m; } catch (e) {}
    const e = new Error(m); e.status = r.status; throw e;
  }
  const parts = (((JSON.parse(txt).candidates || [])[0] || {}).content || {}).parts || [];
  let body = parts.map(p => p.text || '').join('').trim();
  if (body[0] !== '{') { const a = body.indexOf('{'), b = body.lastIndexOf('}'); if (a >= 0 && b > a) body = body.slice(a, b + 1); }
  return JSON.parse(body || '{}');
}

async function explain(text, matches, langName) {
  const keys = gKeys();
  if (!keys.length) return { skipped: 'нет ключа Gemini' };
  const list = matches.map((m, i) => ({ i, fragment: text.substr(m.o, m.l), message: m.full, suggests: m.reps }));
  const prompt =
    'You proofread ' + langName + ' study texts. The rule-based checker LanguageTool already found the places below.\n' +
    'TEXT:\n' + JSON.stringify(text) + '\n' +
    'FINDINGS: ' + JSON.stringify(list) + '\n' +
    'Answer with JSON only: {"corrected": string, "explain": [{"i": number, "why": string}], ' +
    '"falsePositives": [number], "extra": [{"quote": string, "fix": string, "why": string}]}\n' +
    '- corrected: the whole text with real mistakes fixed and nothing else changed (keep the line breaks).\n' +
    '- explain: for every real finding, "why" is a SHORT explanation IN RUSSIAN: what is wrong and what is correct.\n' +
    '- falsePositives: indexes i of findings that are not mistakes (names, places, dialect, tags in square brackets, deliberate style).\n' +
    '- extra: real mistakes the checker missed; "quote" must be an exact substring of TEXT, "fix" the corrected form, "why" in Russian. Empty array if none.';
  const models = [process.env.MODEL_TEXT || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest'];
  let last = null;
  for (const key of keys) {
    for (const model of models) {
      try { return { j: await gemini(key, model, prompt), model }; }
      catch (e) { last = e; if (e.status === 401 || e.status === 403) break; }
    }
  }
  return { skipped: last ? last.message : 'нет ответа' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Только POST' });
  const pass = process.env.OZV_PASSWORD;
  if (pass && req.headers['x-ozv-pass'] !== pass) return res.status(401).json({ error: 'Нужен код доступа', code: 'need_pass' });

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const text = String(b.text || '').slice(0, 19000);
  if (!text.trim()) return res.status(400).json({ error: 'Пустой текст' });
  const short = String(b.lang || 'de').slice(0, 2);
  const lang = LANG[short] || 'de-DE';

  let matches = [], ltFailed = null;
  try { matches = await languageTool(text, lang); }
  catch (e) { ltFailed = e.name === 'AbortError' ? 'LanguageTool не ответил за 8 секунд' : e.message; }

  let why = {}, fp = [], extra = [], corrected = null, llmFailed = null, model = null;
  if (b.explain !== false) {
    const r = await explain(text, matches, LANG_NAME[short] || 'German');
    if (r.skipped) llmFailed = r.skipped;
    else {
      model = r.model;
      const j = r.j || {};
      (j.explain || []).forEach(x => { if (x && Number.isInteger(x.i)) why[x.i] = String(x.why || '').slice(0, 300); });
      fp = (j.falsePositives || []).filter(Number.isInteger);
      extra = (j.extra || []).filter(x => x && x.quote && text.includes(x.quote)).slice(0, 20)
        .map(x => ({ quote: String(x.quote).slice(0, 120), fix: String(x.fix || '').slice(0, 200), why: String(x.why || '').slice(0, 300) }));
      if (typeof j.corrected === 'string') corrected = j.corrected.slice(0, 20000);
    }
  }
  if (ltFailed && llmFailed) return res.status(502).json({ error: 'Проверка не сработала. ' + ltFailed + '; Gemini: ' + llmFailed });
  return res.status(200).json({ matches, why, fp, extra, corrected, ltFailed, llmFailed, model });
};
