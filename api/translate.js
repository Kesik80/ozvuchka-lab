// ОЗВУЧКА — перевод строк через Gemini (бесплатный тариф).
// ENV: GEMINI_API_KEY (или GOOGLE_API_KEY, или GEMINI_API_KEYS через запятую)
//      MODEL_TEXT     — модель перевода, по умолчанию gemini-3.5-flash-lite (как в tlumach)
//      OZV_PASSWORD   — тот же код доступа, что у озвучки (если задан)
const LANGS = { ru: 'Russian', uk: 'Ukrainian', de: 'German', en: 'English' };

function keys() {
  const out = [];
  const add = v => { const k = String(v || '').trim(); if (k && !out.includes(k)) out.push(k); };
  add(process.env.GEMINI_API_KEY); add(process.env.GOOGLE_API_KEY);
  String(process.env.GEMINI_API_KEYS || '').split(',').forEach(add);
  return out;
}

async function ask(key, model, prompt, simple, glossMode) {
  const cfg = { temperature: 0.2, responseMimeType: 'application/json' };
  if (!simple) {
    cfg.responseSchema = glossMode
      ? { type: 'ARRAY', items: { type: 'OBJECT', properties: { base: { type: 'STRING' }, tr: { type: 'STRING' } }, required: ['base', 'tr'] } }
      : { type: 'ARRAY', items: { type: 'STRING' } };
    if (/2\.5-flash/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
  }
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
  let body = out.map(p => p.text || '').join('').trim();
  if (body[0] !== '[') { const a2 = body.indexOf('['), b2 = body.lastIndexOf(']'); if (a2 >= 0 && b2 > a2) body = body.slice(a2, b2 + 1); }
  return JSON.parse(body || '[]');
}

// какие модели вообще доступны этому ключу
async function listModels(key) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(n => /flash|pro/.test(n) && !/vision|image|audio|tts|embedding|live|thinking/.test(n));
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
  const from = LANGS[b.from] ? b.from : 'de';
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 80).map(x => String(x || '').slice(0, 1000)) : [];
  if (!lines.length && b.mode !== 'gloss') return res.status(400).json({ error: 'Нет строк' });
  const context = Array.isArray(b.context) ? b.context.slice(0, 40).map(x => String(x || '').slice(0, 300)) : [];

  // словарь: каждое слово приходит со своим предложением — значение подбирается по нему
  const items = Array.isArray(b.items) ? b.items.slice(0, 120)
    .map(x => ({ word: String((x && x.word) || '').slice(0, 40), sentence: String((x && x.sentence) || '').slice(0, 400) }))
    .filter(x => x.word) : [];
  const glossMode = b.mode === 'gloss' && items.length;

  const prompt = glossMode ?
    'You build a reading aid for a learner of ' + LANGS[from] + '.\n' +
    'Each item below is one word together with the sentence it occurs in.\n' +
    'For EACH item give the dictionary form and a short ' + LANGS[to] + ' translation OF THAT WORD AS IT IS USED IN THAT SENTENCE.\n' +
    'Rules: keep the same number of items and the same order; ' +
    '"base" is the dictionary form (German nouns with their article: "das Jahr"; verbs in the infinitive; ' +
    'a separated prefix belongs to its verb: in "ich stehe auf" both "stehe" and "auf" get base "aufstehen"); ' +
    '"tr" is one to three words in ' + LANGS[to] + ' that fit THIS sentence — the one sense used here, not a list of meanings, ' +
    'no explanations, no brackets. For names of people and places keep the name as "base" and its usual ' + LANGS[to] + ' form as "tr".\n' +
    'Return only a JSON array of objects {"base": string, "tr": string}. Items: ' + JSON.stringify(items)
    :
    'You translate study texts and dialogues for a language learner.\n' +
    'Translate EACH line of the JSON array below from ' + LANGS[from] + ' into natural, simple ' + LANGS[to] + '.\n' +
    'Rules: keep the same number of items and the same order; one translation per item; ' +
    'do not merge or split lines; keep names as they are; leave audio tags like [laughs] out of the translation; ' +
    'if an item is not in ' + LANGS[from] + ', still render it in ' + LANGS[to] + '. Return only a JSON array of strings.\n' +
    (context.length ? 'Earlier lines of the same text, for context only (do not translate): ' + JSON.stringify(context) + '\n' : '') +
    'Lines: ' + JSON.stringify(lines);

  const first = [process.env.MODEL_TEXT || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest']
    .filter((m, i, a2) => m && a2.indexOf(m) === i);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = [];
  let last = null;
  for (const key of K) {
    const models = first.slice();
    let discovered = false, keyDead = false;
    for (let mi = 0; mi < models.length && !keyDead; mi++) {
      const model = models[mi];
      let simple = false;
      for (let att = 0; att < 3; att++) {
        try {
          const out = await ask(key, model, prompt, simple, glossMode);
          if (glossMode) {
            if (!Array.isArray(out) || out.length !== items.length) {
              last = new Error('Gemini вернул ' + (Array.isArray(out) ? out.length : 0) + ' слов вместо ' + items.length);
              tried.push(model + ' → формат');
              break;
            }
            const gloss = out.map(x => ({ base: String((x && x.base) || '').slice(0, 60), tr: String((x && x.tr) || '').slice(0, 80) }));
            return res.status(200).json({ gloss, model, tried });
          }
          if (!Array.isArray(out) || out.length !== lines.length) {
            last = new Error('Gemini вернул ' + (Array.isArray(out) ? out.length : 0) + ' строк вместо ' + lines.length);
            tried.push(model + ' → формат');
            break;
          }
          return res.status(200).json({ tr: out.map(x => String(x || '').trim()), model, tried });
        } catch (e) {
          last = e;
          tried.push(model + ' → ' + (e.status || '?') + ' ' + String(e.message).slice(0, 70));
          if (e.status === 400 && !simple) { simple = true; continue; }        // не понимает схему/бюджет мыслей
          if (e.status === 404) break;                                          // такой модели нет
          if (e.status === 429 || e.status >= 500) { await sleep(700 * (att + 1)); continue; }
          if (e.status === 401 || e.status === 403) keyDead = true;             // ключ не работает
          break;
        }
      }
      // первые три не сработали — спрашиваем у Gemini, что вообще доступно этому ключу
      if (!keyDead && !discovered && mi === models.length - 1) {
        discovered = true;
        try { (await listModels(key)).forEach(n => { if (!models.includes(n) && models.length < first.length + 4) models.push(n); }); }
        catch (e) {}
      }
    }
  }
  const raw = last ? last.message : 'Нет ответа';
  const msg = /high demand|overloaded|unavailable/i.test(raw) ? 'Gemini сейчас перегружен — попробуй ещё раз через минуту'
    : /quota|rate limit|resource_exhausted/i.test(raw) ? 'Дневной лимит Gemini исчерпан'
    : /api key|permission|unauthenticated/i.test(raw) ? 'Ключ Gemini не работает: ' + raw : raw;
  return res.status(502).json({ error: msg, raw, tried });
};
