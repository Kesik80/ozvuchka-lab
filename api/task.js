// ОЗВУЧКА — упражнение «вставь слово»: Gemini выбирает слово для пропуска и варианты ответа.
// ENV: MODEL_TEXT / GEMINI_MODEL, GEMINI_API_KEY | GOOGLE_API_KEY | GEMINI_API_KEYS
//      OZV_PASSWORD — тот же код доступа, что у озвучки
const NAMES = { de: 'German', ru: 'Russian', uk: 'Ukrainian', en: 'English' };

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
      i: { type: 'NUMBER' },
      word: { type: 'STRING' },
      nth: { type: 'NUMBER' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      hint: { type: 'STRING' },
    },
    required: ['i', 'word', 'nth', 'options', 'hint'],
  },
};

async function ask(key, model, prompt) {
  const cfg = { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA };
  if (/2\.5-flash/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg }),
  });
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
  const pass = process.env.OZV_PASSWORD;
  if (pass && req.headers['x-ozv-pass'] !== pass) return res.status(401).json({ error: 'Нужен код доступа', code: 'need_pass' });
  const K = keys();
  if (!K.length) return res.status(500).json({ error: 'В Vercel не задан GEMINI_API_KEY', code: 'no_keys' });

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 40)
    .map(x => ({ i: Number(x && x.i), text: String((x && x.text) || '').slice(0, 500) }))
    .filter(x => Number.isFinite(x.i) && x.text.trim()) : [];
  if (!lines.length) return res.status(400).json({ error: 'Нет строк' });
  const from = NAMES[String(b.lang || 'de').slice(0, 2)] || 'German';
  const to = NAMES[String(b.to || 'ru').slice(0, 2)] || 'Russian';

  const prompt =
    'You build a gap-fill exercise from a ' + from + ' study text for a learner.\n' +
    'For EACH line below choose exactly ONE word worth practising — an article, a preposition, a verb form, ' +
    'a case ending or a key vocabulary word. Prefer words where a learner really has to choose.\n' +
    'Return a JSON array with one object per line:\n' +
    '- "i": the line number exactly as given\n' +
    '- "word": that word copied EXACTLY as it is written in the line, same capitalisation, no punctuation\n' +
    '- "nth": which occurrence of that word in the line it is (1 = the first one)\n' +
    '- "options": 4 strings — the correct word plus 3 wrong but plausible ones of the SAME kind ' +
    '(other articles for an article, other verb forms for a verb). All distinct, all plausible at first glance.\n' +
    '- "hint": a short hint IN ' + to.toUpperCase() + ' — what is being asked (e.g. "артикль, дательный падеж"), never the answer itself.\n' +
    'Skip a line only if it has no suitable word; then simply leave it out of the array.\n' +
    'Lines: ' + JSON.stringify(lines);

  const models = [process.env.MODEL_TEXT || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = [];
  let last = null;
  for (const key of K) {
    let keyDead = false;
    for (const model of models) {
      for (let att = 0; att < 2 && !keyDead; att++) {
        try {
          const out = await ask(key, model, prompt);
          const items = (Array.isArray(out) ? out : []).map(x => {
            const word = String((x && x.word) || '').trim();
            let options = (Array.isArray(x && x.options) ? x.options : []).map(o => String(o || '').trim()).filter(Boolean);
            options = options.filter((o, n) => options.indexOf(o) === n);
            if (!options.includes(word)) options.unshift(word);
            return {
              i: Number(x.i), word, nth: Math.max(1, Math.round(Number(x.nth) || 1)),
              options: options.slice(0, 4), hint: String((x && x.hint) || '').slice(0, 120),
            };
          }).filter(x => x.word && Number.isFinite(x.i) && x.options.length >= 2);
          return res.status(200).json({ items, model, tried });
        } catch (e) {
          last = e; tried.push(model + ' → ' + (e.status || '?') + ' ' + String(e.message).slice(0, 70));
          if (e.status === 404) break;
          if (e.status === 429 || e.status >= 500) { await sleep(700 * (att + 1)); continue; }
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
    : raw;
  return res.status(502).json({ error: msg, raw, tried });
};

module.exports.config = { maxDuration: 60 };
