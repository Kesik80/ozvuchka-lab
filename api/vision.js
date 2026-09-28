// ОЗВУЧКА — картинка из книжки: Gemini находит на фото предметы, называет их и обводит рамкой.
// ENV: MODEL_VISION (по умолчанию gemini-3.5-flash), GEMINI_API_KEY | GOOGLE_API_KEY | GEMINI_API_KEYS
//      OZV_PASSWORD — тот же код доступа, что у озвучки
const NAMES = { de: 'German', ru: 'Russian', uk: 'Ukrainian', en: 'English' };

// запрос с таймаутом: без него зависший провайдер съедает все 60 секунд функции
async function fetchT(url, opt, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 45000);
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

// box_2d — [ymin, xmin, ymax, xmax] в тысячных долях кадра, как отдаёт Gemini
const SCHEMA_ALL = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      word: { type: 'STRING' },
      tr: { type: 'STRING' },
      box_2d: { type: 'ARRAY', items: { type: 'NUMBER' } },
    },
    required: ['word', 'tr', 'box_2d'],
  },
};
const SCHEMA_ONE = {
  type: 'OBJECT',
  properties: { word: { type: 'STRING' }, tr: { type: 'STRING' } },
  required: ['word', 'tr'],
};

async function ask(key, model, mime, image, prompt, one) {
  const r = await fetchT('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: image } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: one ? SCHEMA_ONE : SCHEMA_ALL },
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
  const open = one ? '{' : '[', close = one ? '}' : ']';
  if (body[0] !== open) { const a = body.indexOf(open), b = body.lastIndexOf(close); if (a >= 0 && b > a) body = body.slice(a, b + 1); }
  return JSON.parse(body || (one ? '{}' : '[]'));
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
  const image = typeof b.image === 'string' ? b.image : '';
  if (!image) return res.status(400).json({ error: 'Нет картинки' });
  if (image.length > 3500000) return res.status(413).json({ error: 'Фото слишком большое', code: 'too_big' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return res.status(400).json({ error: 'Фото пришло не в base64', code: 'bad_image' });
  const mime = /^image\/(jpeg|png|webp)$/.test(String(b.mime || '')) ? b.mime : 'image/jpeg';
  const lang = NAMES[String(b.lang || 'de').slice(0, 2)] || 'German';
  const to = NAMES[String(b.to || 'ru').slice(0, 2)] || 'Russian';
  const one = b.mode === 'one';
  const max = Math.min(40, Math.max(1, Math.round(Number(b.max) || 20)));

  const prompt = one
    ? 'This is a close-up of ONE object cut out of a picture-dictionary page.\n' +
      'Name that object as a learner of ' + lang + ' would look it up:\n' +
      '- "word": the dictionary form in ' + lang + ' — a noun WITH its article ("der Hut"), a verb in the infinitive.\n' +
      '- "tr": a one- or two-word ' + to + ' translation.\n' +
      'If the crop shows several things, name the biggest one in the middle. Answer with JSON only.'
    : 'This photo is a page from a picture dictionary or a children\'s book.\n' +
      'Find up to ' + max + ' separate objects a learner would want to name — things, animals, people, food, vehicles. ' +
      'Skip the background, the page itself, decorative frames, text and page numbers.\n' +
      'For EACH object return:\n' +
      '- "word": the dictionary form in ' + lang + ' — a noun WITH its article ("die Katze"), a verb in the infinitive.\n' +
      '- "tr": a one- or two-word ' + to + ' translation.\n' +
      '- "box_2d": [ymin, xmin, ymax, xmax] of that object, each 0-1000 relative to the image.\n' +
      'One entry per object, no duplicates, boxes must fit the object tightly. Answer with JSON only.';

  const models = [process.env.MODEL_VISION || 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tried = [];
  let last = null;
  for (const key of K) {
    let keyDead = false;
    for (const model of models) {
      for (let att = 0; att < 2 && !keyDead; att++) {
        try {
          const out = await ask(key, model, mime, image, prompt, one);
          if (one) {
            const word = String((out && out.word) || '').trim().slice(0, 60);
            if (!word) throw new Error('Gemini не узнал предмет');
            return res.status(200).json({ word, tr: String((out && out.tr) || '').trim().slice(0, 60), model, tried });
          }
          const items = (Array.isArray(out) ? out : []).filter(x => x && typeof x === 'object').map(x => {
            const box = (Array.isArray(x.box_2d) ? x.box_2d : []).map(Number);
            if (box.length !== 4 || box.some(n => !Number.isFinite(n))) return null;
            let [y0, x0, y1, x1] = box;
            if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
            if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
            const cl = n => Math.min(1000, Math.max(0, n));
            [y0, x0, y1, x1] = [cl(y0), cl(x0), cl(y1), cl(x1)];
            if (y1 - y0 < 15 || x1 - x0 < 15) return null;             // слишком мелкая рамка — мимо
            if ((y1 - y0) * (x1 - x0) > 900000) return null;            // «вся страница» — не предмет
            const word = String(x.word || '').trim().slice(0, 60);
            if (!word) return null;
            return { word, tr: String(x.tr || '').trim().slice(0, 60), box: [x0, y0, x1, y1] };  // отдаём как x0,y0,x1,y1
          }).filter(Boolean).slice(0, max);
          return res.status(200).json({ items, model, tried });
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
    : /too large|payload|request entity/i.test(raw) ? 'Фото слишком большое'
    : raw;
  return res.status(502).json({ error: msg, raw, tried });
};

module.exports.config = { maxDuration: 60 };
