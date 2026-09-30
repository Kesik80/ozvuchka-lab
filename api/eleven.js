// ОЗВУЧКА — прокси к ElevenLabs. Ключи никогда не уходят в браузер.
// ENV: ELEVENLABS_API_KEYS = "key1,key2,..."   (обязательно)
//      OZV_PASSWORD       = "..."              (обязательно: без него функция выключена)
const BASE = 'https://api.elevenlabs.io';

// запрос с таймаутом: без него зависший провайдер съедает все 60 секунд функции
async function fetchT(url, opt, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 25000);
  try { return await fetch(url, Object.assign({}, opt, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}


function keys() {
  // как в Uhrzeit: ELEVENLABS_API_KEY, _2 … _5 и/или ELEVENLABS_API_KEYS через запятую
  const out = [];
  const add = v => { const k = String(v || '').trim(); if (k && !out.includes(k)) out.push(k); };
  add(process.env.ELEVENLABS_API_KEY);
  for (let i = 2; i <= 5; i++) add(process.env['ELEVENLABS_API_KEY_' + i]);
  String(process.env.ELEVENLABS_API_KEYS || '').split(',').forEach(add);
  return out;
}
// кончились символы: 401/402 с quota_exceeded. 429 («слишком часто») аккаунт не меняет.
function outOfCredits(status, text) {
  const t = String(text || '').toLowerCase();
  return (status === 401 || status === 402) && (t.includes('quota_exceeded') || t.includes('quota exceeded') || t.includes('credits'));
}
function tail(k) { return '…' + k.slice(-4); }

async function el(key, path, opt = {}, ms) {
  const r = await fetchT(BASE + path, {
    method: opt.method || 'GET',
    headers: Object.assign({ 'xi-api-key': key }, opt.body ? { 'Content-Type': 'application/json' } : {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  }, ms || 20000);
  return r;
}
async function errOf(r) {
  let j = null; try { j = await r.json(); } catch (e) {}
  const d = j && j.detail;
  const msg = (d && (d.message || (typeof d === 'string' ? d : null))) || ('HTTP ' + r.status);
  const code = (d && (d.status || d.code)) || String(r.status);
  return { status: r.status, code, msg };
}

function send(res, status, obj) { res.status(status).json(obj); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return send(res, 405, { error: 'Только POST', code: 'method' });
  // код доступа обязателен: без него функция — открытый прокси к платным ключам
  const pass = String(process.env.OZV_PASSWORD || '').trim();
  if (!pass) return send(res, 503, { error: 'В Vercel не задан OZV_PASSWORD — функция выключена', code: 'no_pass' });
  if (String(req.headers['x-ozv-pass'] || '').trim() !== pass) return send(res, 401, { error: 'Нужен код доступа', code: 'need_pass' });
  const K = keys();
  if (!K.length) return send(res, 500, { error: 'В Vercel не задан ELEVENLABS_API_KEY (или ELEVENLABS_API_KEYS)', code: 'no_keys' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const keyAt = i => (Number.isInteger(i) && K[i]) ? K[i] : null;

  try {
    switch (b.a) {
      case 'keys': {
        const acc = await Promise.all(K.map(async (k, i) => {
          try {
            const r = await el(k, '/v1/user/subscription');
            if (!r.ok) {
              const e = await errOf(r);
              return { i, tail: tail(k), ok: false, error: e.msg, noPermission: e.code === 'missing_permissions' };
            }
            const d = await r.json();
            const used = d.character_count || 0, limit = d.character_limit || 0;
            return { i, tail: tail(k), ok: true, tier: d.tier || '—', used, limit, left: Math.max(0, limit - used),
              percent: limit ? Math.round(used / limit * 100) : 0, reset: d.next_character_count_reset_unix || null };
          } catch (e) { return { i, tail: tail(k), ok: false, error: e.message }; }
        }));
        const good = acc.filter(a => a.ok);
        const left = good.reduce((n, a) => n + a.left, 0), limit = good.reduce((n, a) => n + a.limit, 0);
        const best = good.slice().sort((a, b2) => b2.left - a.left)[0];
        return send(res, 200, { keys: acc, left, limit, percent: limit ? Math.round((limit - left) / limit * 100) : 0, best: best ? best.i : null });
      }

      case 'voices': {
        // голоса одного аккаунта: стандартные + свои. У каждого аккаунта свой набор своих голосов.
        const i = Number.isInteger(b.key) && K[b.key] ? b.key : 0;
        const r = await el(K[i], '/v1/voices');
        if (!r.ok) { const e = await errOf(r); return send(res, 502, { error: e.msg + ' (нужно право Voices → Read у ключа)', code: e.code }); }
        const j = await r.json();
        const voices = (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, cat: v.category || 'premade',
          labels: v.labels || {}, preview: v.preview_url || null, desc: v.description || '' }));
        return send(res, 200, { voices, key: i });
      }

      case 'tts':
      case 'ttsts': {   // ttsts — весь текст одним файлом + тайминги символов
        const ts = b.a === 'ttsts';
        const raw = typeof b.text === 'string' ? b.text : '';
        const MAX = ts ? 2600 : 5000;   // ответ с таймингами — это base64 внутри JSON, у Vercel предел 4,5 МБ
        if (raw.length > MAX) return send(res, 400, { error: 'Кусок длиннее ' + MAX + ' символов — раздели его', code: 'too_long' });
        const text = raw;
        if (!text.trim()) return send(res, 400, { error: 'Пустой текст', code: 'empty' });
        if (!/^[A-Za-z0-9]{15,40}$/.test(String(b.voice || ''))) return send(res, 400, { error: 'Неверный голос', code: 'voice' });
        const MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];
        const model = MODELS.includes(b.model) ? b.model : 'eleven_multilingual_v2';
        const v3 = model === 'eleven_v3';
        const v4 = model.indexOf('eleven_v4') === 0;
        const num = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
        let stability = num(b.stability, 0, 1, 0.5);
        if (v3) stability = stability < 0.25 ? 0 : stability > 0.75 ? 1 : 0.5;   // v3: только 0 / 0.5 / 1
        // v4 понимает лишь стабильность и похожесть: стиль, скорость и speaker boost ему не шлём
        const vs = v4 ? { stability, similarity_boost: num(b.similarity, 0, 1, 0.75) }
                      : { stability, similarity_boost: num(b.similarity, 0, 1, 0.75), style: num(b.style, 0, 1, 0), use_speaker_boost: true };
        const speed = num(b.speed, 0.7, 1.2, 1);
        if (speed !== 1 && !v4) vs.speed = speed;
        const body = { text, model_id: model, voice_settings: vs };
        if (b.lang && (v3 || model === 'eleven_flash_v2_5')) body.language_code = String(b.lang).slice(0, 5);
        const seed = parseInt(b.seed, 10);
        if (Number.isFinite(seed) && seed >= 0) body.seed = Math.min(4294967295, seed);
        if (!v3 && !v4) {   // невидимый контекст интонации — у v3 и v4 не поддерживается
          if (b.prev) body.previous_text = String(b.prev).slice(0, 400);
          if (b.next) body.next_text = String(b.next).slice(0, 400);
        }
        // начинаем с выбранного аккаунта; свой голос живёт только на своём — его не перекидываем
        const start = keyAt(b.key) ? b.key : 0;
        const order = b.pin ? [start] : K.map((_, n) => (start + n) % K.length);
        let last = null;
        const t0 = Date.now();   // у функции 60 с: на много аккаунтов подряд по 45 с не хватит
        for (const i of order) {
          const left = 56000 - (Date.now() - t0);
          if (left < 6000) { last = 'Не хватило времени на перебор аккаунтов'; break; }
          const r = await el(K[i], '/v1/text-to-speech/' + b.voice + (ts ? '/with-timestamps' : '') + '?output_format=mp3_44100_64', { method: 'POST', body }, Math.min(45000, left));
          if (r.ok && ts) {
            const j = await r.json();
            const al = j.alignment || j.normalized_alignment || {};
            return send(res, 200, { audio: j.audio_base_64 || j.audio_base64,
              starts: al.character_start_times_seconds || [],
              ends: al.character_end_times_seconds || [],
              chars: (al.characters || []).length, key: i });
          }
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('X-Key', String(i));
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).send(buf);
          }
          const full = await r.text();
          const txt = full.slice(0, 400);
          if (outOfCredits(r.status, full) && order.length > 1) { last = 'У аккаунта ' + (i + 1) + ' кончились символы'; continue; }
          if (r.status === 429 && order.length > 1) { last = 'Аккаунт ' + (i + 1) + ' занят'; continue; }
          if (r.status === 402 || /paid_plan_required/.test(full))
            return send(res, 402, { error: 'Этот голос доступен только на платном плане ElevenLabs', code: 'paid_voice', key: i });
          let msg = 'ElevenLabs ' + r.status, code = String(r.status);
          try { const d = JSON.parse(full).detail; if (d) { msg = d.message || msg; code = d.status || d.code || code; } } catch (e) { if (txt) msg += ': ' + txt; }
          return send(res, 502, { error: msg, code, key: i });
        }
        return send(res, 502, { error: order.length > 1 ? 'Все аккаунты заняты или без символов' : (last || 'Озвучка не удалась'), code: 'quota_exceeded', last: last || null });
      }

      case 'design': {
        const k = keyAt(b.key) || K[0];
        const desc = String(b.description || '').slice(0, 1000);
        if (desc.length < 20) return send(res, 400, { error: 'Описание голоса — минимум 20 символов', code: 'short' });
        const text = String(b.text || '');
        const body = { voice_description: desc, model_id: b.model === 'eleven_ttv_v3' ? 'eleven_ttv_v3' : 'eleven_multilingual_ttv_v2' };
        if (text.length >= 100 && text.length <= 1000) body.text = text; else body.auto_generate_text = true;
        const r = await el(k, '/v1/text-to-voice/design', { method: 'POST', body }, 45000);
        if (!r.ok) { const e = await errOf(r); return send(res, 502, { error: e.msg, code: e.code }); }
        const j = await r.json();
        return send(res, 200, { previews: (j.previews || []).map(p => ({ gid: p.generated_voice_id, audio: p.audio_base_64, dur: p.duration_secs || null })), text: j.text || null });
      }

      case 'create': {
        const k = keyAt(b.key) || K[0];
        const r = await el(k, '/v1/text-to-voice', { method: 'POST', body: {
          voice_name: String(b.name || 'Ozvuchka').slice(0, 60),
          voice_description: String(b.description || '').slice(0, 1000),
          generated_voice_id: String(b.gid || ''),
        } });
        if (!r.ok) { const e = await errOf(r); return send(res, 502, { error: e.msg, code: e.code }); }
        const v = await r.json();
        return send(res, 200, { voice: { id: v.voice_id, name: v.name, key: K.indexOf(k) } });
      }

      default:
        return send(res, 400, { error: 'Неизвестное действие', code: 'action' });
    }
  } catch (e) {
    return send(res, 500, { error: e.message, code: 'server' });
  }
};

module.exports.config = { maxDuration: 60 };
