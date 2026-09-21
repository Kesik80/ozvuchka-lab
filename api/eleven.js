// ОЗВУЧКА — прокси к ElevenLabs. Ключи никогда не уходят в браузер.
// ENV: ELEVENLABS_API_KEYS = "key1,key2,..."   (обязательно)
//      OZV_PASSWORD       = "..."              (необязательно: код доступа к функции)
const BASE = 'https://api.elevenlabs.io';

function keys() {
  return String(process.env.ELEVENLABS_API_KEYS || process.env.ELEVENLABS_API_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function tail(k) { return '…' + k.slice(-4); }

async function el(key, path, opt = {}) {
  const r = await fetch(BASE + path, {
    method: opt.method || 'GET',
    headers: Object.assign({ 'xi-api-key': key }, opt.body ? { 'Content-Type': 'application/json' } : {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  return r;
}
async function errOf(r) {
  let j = null; try { j = await r.json(); } catch (e) {}
  const d = j && j.detail;
  const msg = (d && (d.message || (typeof d === 'string' ? d : null))) || ('HTTP ' + r.status);
  const code = (d && (d.status || d.code)) || String(r.status);
  return { status: r.status, code, msg };
}
// ошибки, при которых имеет смысл попробовать следующий ключ
const ROTATE = /quota|limit|exceeded|invalid_api_key|unusual_activity|too_many|free_users|detected_unusual|401|402|429/i;

function send(res, status, obj) { res.status(status).json(obj); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Только POST', code: 'method' });
  const pass = process.env.OZV_PASSWORD;
  if (pass && req.headers['x-ozv-pass'] !== pass) return send(res, 401, { error: 'Нужен код доступа', code: 'need_pass' });
  const K = keys();
  if (!K.length) return send(res, 500, { error: 'В Vercel не задан ELEVENLABS_API_KEYS', code: 'no_keys' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const keyAt = i => (Number.isInteger(i) && K[i]) ? K[i] : null;

  try {
    switch (b.a) {
      case 'keys': {
        const out = await Promise.all(K.map(async (k, i) => {
          try {
            const r = await el(k, '/v1/user/subscription');
            if (!r.ok) { const e = await errOf(r); return { i, tail: tail(k), ok: false, error: e.msg }; }
            const s = await r.json();
            return { i, tail: tail(k), ok: true, tier: s.tier, used: s.character_count, limit: s.character_limit, reset: s.next_character_count_reset_unix || null };
          } catch (e) { return { i, tail: tail(k), ok: false, error: e.message }; }
        }));
        return send(res, 200, { keys: out });
      }

      case 'voices': {
        const seen = new Set(); const out = [];
        await Promise.all(K.map(async (k, i) => {
          try {
            const r = await el(k, '/v1/voices');
            if (!r.ok) return;
            const j = await r.json();
            (j.voices || []).forEach(v => {
              const premade = v.category === 'premade';
              const id = premade ? v.voice_id : v.voice_id + '@' + i;
              if (seen.has(id)) return; seen.add(id);
              out.push({ id: v.voice_id, name: v.name, cat: v.category, key: premade ? null : i,
                labels: v.labels || {}, preview: v.preview_url || null, desc: v.description || '' });
            });
          } catch (e) {}
        }));
        out.sort((a, b2) => (a.key === null) - (b2.key === null) || a.name.localeCompare(b2.name));
        return send(res, 200, { voices: out });
      }

      case 'tts': {
        const text = String(b.text || '').slice(0, 5000);
        if (!text.trim()) return send(res, 400, { error: 'Пустой текст', code: 'empty' });
        if (!/^[A-Za-z0-9]{8,40}$/.test(String(b.voice || ''))) return send(res, 400, { error: 'Неверный голос', code: 'voice' });
        const model = String(b.model || 'eleven_multilingual_v2');
        const body = { text, model_id: model, voice_settings: {
          stability: +b.stability >= 0 ? +b.stability : 0.5,
          similarity_boost: +b.similarity >= 0 ? +b.similarity : 0.75,
          style: +b.style >= 0 ? +b.style : 0,
          use_speaker_boost: true,
          speed: +b.speed > 0 ? +b.speed : 1,
        } };
        if (b.lang && /^(eleven_v3|eleven_flash_v2_5|eleven_turbo_v2_5)$/.test(model)) body.language_code = String(b.lang).slice(0, 5);
        // свой голос живёт только на своём аккаунте; стандартные — пробуем ключи по кругу
        let order;
        if (keyAt(b.key)) order = [b.key];
        else { const s = Math.floor(Math.random() * K.length); order = K.map((_, i) => (i + s) % K.length); }
        let last = null;
        for (const i of order) {
          const r = await el(K[i], '/v1/text-to-speech/' + b.voice + '?output_format=mp3_44100_128', { method: 'POST', body });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('X-Key', String(i));
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).send(buf);
          }
          last = await errOf(r);
          if (!ROTATE.test(last.code + ' ' + last.status)) break;
        }
        return send(res, 502, { error: last ? last.msg : 'Нет ответа', code: last ? last.code : 'fail' });
      }

      case 'design': {
        const k = keyAt(b.key) || K[0];
        const desc = String(b.description || '').slice(0, 1000);
        if (desc.length < 20) return send(res, 400, { error: 'Описание голоса — минимум 20 символов', code: 'short' });
        const text = String(b.text || '');
        const body = { voice_description: desc, model_id: b.model === 'eleven_ttv_v3' ? 'eleven_ttv_v3' : 'eleven_multilingual_ttv_v2' };
        if (text.length >= 100 && text.length <= 1000) body.text = text; else body.auto_generate_text = true;
        const r = await el(k, '/v1/text-to-voice/design', { method: 'POST', body });
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

      case 'library': {
        const q = new URLSearchParams({ page_size: '30', language: String(b.lang || 'de') });
        if (b.q) q.set('search', String(b.q).slice(0, 80));
        if (b.gender) q.set('gender', String(b.gender));
        if (Number.isInteger(b.page) && b.page > 0) q.set('page', String(b.page));
        const r = await el(keyAt(b.key) || K[0], '/v1/shared-voices?' + q.toString());
        if (!r.ok) { const e = await errOf(r); return send(res, 502, { error: e.msg, code: e.code }); }
        const j = await r.json();
        return send(res, 200, { more: !!j.has_more, voices: (j.voices || []).map(v => ({
          id: v.voice_id, owner: v.public_owner_id, name: v.name, gender: v.gender, age: v.age, accent: v.accent,
          use: v.use_case, desc: (v.description || '').slice(0, 200), preview: v.preview_url || null,
          free: v.free_users_allowed !== false,
        })) });
      }

      case 'add': {
        const k = keyAt(b.key) || K[0];
        if (!/^[A-Za-z0-9]+$/.test(String(b.owner || '')) || !/^[A-Za-z0-9]+$/.test(String(b.voice || '')))
          return send(res, 400, { error: 'Неверный голос', code: 'voice' });
        const r = await el(k, '/v1/voices/add/' + b.owner + '/' + b.voice, { method: 'POST', body: { new_name: String(b.name || 'Voice').slice(0, 60) } });
        if (!r.ok) { const e = await errOf(r); return send(res, 502, { error: e.msg, code: e.code }); }
        const j = await r.json();
        return send(res, 200, { voice: { id: j.voice_id, name: b.name, key: K.indexOf(k) } });
      }

      default:
        return send(res, 400, { error: 'Неизвестное действие', code: 'action' });
    }
  } catch (e) {
    return send(res, 500, { error: e.message, code: 'server' });
  }
};

