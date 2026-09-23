// ОЗВУЧКА — перевод строк через Gemini (бесплатный тариф).
// ENV: GEMINI_API_KEY (или GOOGLE_API_KEY, или GEMINI_API_KEYS через запятую)
//      GEMINI_MODEL   — необязательно, по умолчанию gemini-2.5-flash
//      OZV_PASSWORD   — тот же код доступа, что у озвучки (если задан)
const LANGS = { ru: 'Russian', uk: 'Ukrainian' };

function keys() {
  const out = [];
  const add = v => { const k = String(v || '').trim(); if (k && !out.includes(k)) out.push(k); };
  add(process.env.GEMINI_API_KEY); add(process.env.GOOGLE_API_KEY);
  String(process.env.GEMINI_API_KEYS || '').split(',').forEach(add);
  return out;
}

async function ask(key, model, prompt) {
  const cfg = { temperature: 0.2, responseMimeType: 'application/json',
    responseSchema: { type: 'ARRAY', items: { type: 'STRING' } } };
  if (/2\.5-flash/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = 'Gemini ' + r.status;
    try { msg = JSON.parse(txt).error.message || msg; } catch (e) {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const j = JSON.parse(txt);
  const out = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return JSON.parse(out.map(p => p.text || '').join('') || '[]');
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
  const to = LANGS[b.to] ? b.to : 'ru';
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 80).map(x => String(x || '').slice(0, 1000)) : [];
  if (!lines.length) return res.status(400).json({ error: 'Нет строк' });
  const context = Array.isArray(b.context) ? b.context.slice(0, 40).map(x => String(x || '').slice(0, 300)) : [];

  const prompt =
    'You translate German study texts and dialogues for a language learner.\n' +
    'Translate EACH line of the JSON array below from German into natural, simple ' + LANGS[to] + '.\n' +
    'Rules: keep the same number of items and the same order; one translation per item; ' +
    'do not merge or split lines; keep names as they are; keep audio tags like [laughs] out of the translation; ' +
    'if an item is already not German, still render it in ' + LANGS[to] + '. Return only a JSON array of strings.\n' +
    (context.length ? 'Earlier lines of the same text, for context only (do not translate): ' + JSON.stringify(context) + '\n' : '') +
    'Lines: ' + JSON.stringify(lines);

  const models = [process.env.GEMINI_MODEL || 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let last = null;
  for (const key of K) {
    let keyDead = false;
    for (const model of models) {
      for (let att = 0; att < 3 && !keyDead; att++) {
        try {
          const out = await ask(key, model, prompt);
          if (!Array.isArray(out) || out.length !== lines.length) {
            last = new Error('Gemini вернул ' + (Array.isArray(out) ? out.length : 0) + ' строк вместо ' + lines.length);
            break;                                   // формат не тот — пробуем другую модель
          }
          return res.status(200).json({ tr: out.map(x => String(x || '').trim()), model });
        } catch (e) {
          last = e;
          if (e.status === 404) break;               // такой модели нет
          if (e.status === 429 || e.status >= 500) { await sleep(700 * (att + 1)); continue; }  // перегруз — ещё попытка
          keyDead = true;                            // ключ не работает — следующий ключ
        }
      }
      if (keyDead) break;
    }
  }
  const raw = last ? last.message : 'Нет ответа';
  const msg = /high demand|overloaded|unavailable/i.test(raw) ? 'Gemini сейчас перегружен — попробуй ещё раз через минуту'
    : /quota|rate limit|resource_exhausted/i.test(raw) ? 'Дневной лимит Gemini исчерпан'
    : /api key|permission|unauthenticated/i.test(raw) ? 'Ключ Gemini не работает: ' + raw : raw;
  return res.status(502).json({ error: msg, raw });
};
