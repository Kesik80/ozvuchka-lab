// ОЗВУЧКА — распознавание записи через Gemini: реплики, говорящие, времена.
// ENV: MODEL_AUDIO (по умолчанию gemini-3.5-flash), GEMINI_API_KEY | GOOGLE_API_KEY | GEMINI_API_KEYS
//      OZV_PASSWORD — тот же код доступа, что у озвучки
const NAMES = { de: 'German', ru: 'Russian', uk: 'Ukrainian', en: 'English' };

// запрос с таймаутом: без него зависший провайдер съедает все 60 секунд функции
async function fetchT(url, opt, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 25000);
  try { return await fetch(url, Object.assign({}, opt, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}


function keys() {
  const out = [];
  const add = v => { const k = String(v || '').trim(); if (k && !out.includes(k)) out.push(k); };
  add(process.env.GEMINI_API_KEY); add(process.env.GOOGLE_API_KEY);
  String(process.env.GEMINI_API_KEYS || '').split(',').forEach(add);
  return out;
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      speaker: { type: 'STRING' },
      text: { type: 'STRING' },
      start: { type: 'NUMBER' },
      end: { type: 'NUMBER' },
    },
    required: ['speaker', 'text', 'start'],
  },
};

async function ask(key, model, mime, audio, prompt) {
  const r = await fetchT('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: audio } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
  }, 45000);
  const txt = await r.text();
  if (!r.ok) {
    let m = 'Gemini ' + r.status;
    try { m = JSON.parse(txt).error.message || m; } catch (e) {}
    const e = new Error(m); e.status = r.status; throw e;
  }
  const parts = (((JSON.parse(txt).candidates || [])[0] || {}).content || {}).parts || [];
  let body = parts.map(p => p.text || '').join('').trim();
  if (body[0] !== '[') { const a = body.indexOf('['), b = body.lastIndexOf(']'); if (a >= 0 && b > a) body = body.slice(a, b + 1); }
  return JSON.parse(body || '[]');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Только POST' });
  // код доступа обязателен: без него функция — открытый прокси к платным ключам
  const pass = String(process.env.OZV_PASSWORD || '').trim();
  if (!pass) return res.status(503).json({ error: 'В Vercel не задан OZV_PASSWORD — функция выключена', code: 'no_pass' });
  if (String(req.headers['x-ozv-pass'] || '').trim() !== pass) return res.status(401).json({ error: 'Нужен код доступа', code: 'need_pass' });
  const K = keys();
  if (!K.length) return res.status(500).json({ error: 'В Vercel не задан GEMINI_API_KEY', code: 'no_keys' });

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const audio = typeof b.audio === 'string' ? b.audio : '';
  if (!audio) return res.status(400).json({ error: 'Нет аудио' });
  if (audio.length > 3500000) return res.status(413).json({ error: 'Кусок записи слишком большой', code: 'too_big' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return res.status(400).json({ error: 'Аудио пришло не в base64', code: 'bad_audio' });
  const mime = /^audio\/[\w.+-]+$/.test(String(b.mime || '')) ? b.mime : 'audio/mpeg';
  const lang = NAMES[String(b.lang || '').slice(0, 2)] || null;

  const prompt =
    'Transcribe this recording of a conversation.\n' +
    (lang ? 'The language is ' + lang + '.\n' : 'Keep the original language of the speech.\n') +
    'Return a JSON array, one item per utterance, in chronological order:\n' +
    '- "speaker": a stable label per voice, "A", "B", "C" … (same voice = same label through the whole recording)\n' +
    '- "text": what is said, with normal punctuation and capitalisation, no filler-only items\n' +
    '- "start" and "end": seconds from the beginning of THIS audio, as numbers (e.g. 12.4)\n' +
    'Split long turns into sentences. Skip music, noise and silence. If nothing is said, return [].';

  const models = [process.env.MODEL_AUDIO || 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = [];
  let last = null;
  for (const key of K) {
    let keyDead = false;
    for (const model of models) {
      for (let att = 0; att < 2 && !keyDead; att++) {
        try {
          const out = await ask(key, model, mime, audio, prompt);
          const lines = (Array.isArray(out) ? out : []).filter(x => x && typeof x === 'object').map(x => ({
            speaker: String(x.speaker || '').slice(0, 20),
            text: String(x.text || '').trim().slice(0, 1000),
            start: Number.isFinite(+x.start) ? Math.max(0, +x.start) : null,
            end: Number.isFinite(+x.end) ? +x.end : null,
          })).filter(x => x.text);
          return res.status(200).json({ lines, model, tried });
        } catch (e) {
          last = e; tried.push(model + ' → ' + (e.status || '?') + ' ' + String(e.message).slice(0, 70));
          const daily = e.status === 429 && /per ?day|daily|quota|exhaust/i.test(String(e.message));
          if (daily) { keyDead = true; break; }   // дневной лимит: повторы бессмысленны
          if (e.status === 404) break;
          if (e.status === 429 || e.status >= 500) { await sleep(800 * (att + 1)); continue; }
          if (e.status === 401 || e.status === 403) keyDead = true;
          break;
        }
      }
      if (keyDead) break;
    }
  }
  const raw = last ? last.message : 'Нет ответа';
  const msg = /high demand|overloaded|unavailable/i.test(raw) ? 'Gemini перегружен — попробуй ещё раз через минуту'
    : /quota|rate limit|resource_exhausted/i.test(raw) ? 'Дневной лимит Gemini исчерпан'
    : /too large|payload|request entity/i.test(raw) ? 'Кусок записи слишком большой'
    : raw;
  return res.status(502).json({ error: msg, raw, tried });
};

module.exports.config = { maxDuration: 60 };
