// /api/transcribe — Vercel serverless function
// Server-side speech-to-text. The Speak drill calls this when the browser
// lacks the Web Speech API (iOS Safari, Firefox). Browser records audio with
// MediaRecorder, sends base64 here, we proxy to Groq Whisper (free tier) or
// OpenAI Whisper.
//
// Set GROQ_API_KEY (preferred, free at https://console.groq.com) OR
// OPENAI_API_KEY in Vercel env vars. Groq is used if both are present.
//
// Node 18+ on Vercel exposes global FormData/Blob/fetch — no deps needed.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const OPENAI_MODEL = 'whisper-1';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!groqKey && !openaiKey) {
    res.status(500).json({
      error: 'no_transcription_key',
      hint: 'Set GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY in Vercel project env vars.'
    });
    return;
  }

  const body = req.body || {};
  const { audio_b64, mime, language } = body;
  if (!audio_b64 || typeof audio_b64 !== 'string') {
    res.status(400).json({ error: 'missing_audio_b64' });
    return;
  }

  let buf;
  try {
    buf = Buffer.from(audio_b64, 'base64');
  } catch (e) {
    res.status(400).json({ error: 'bad_base64', message: String(e && e.message || e) });
    return;
  }
  if (buf.length < 100) {
    res.status(400).json({ error: 'audio_too_short', bytes: buf.length });
    return;
  }

  const useGroq = !!groqKey;
  const url = useGroq ? GROQ_URL : OPENAI_URL;
  const apiKey = useGroq ? groqKey : openaiKey;
  const model = useGroq ? GROQ_MODEL : OPENAI_MODEL;
  const audioMime = (typeof mime === 'string' && mime) ? mime : 'audio/webm';
  const ext = audioMime.includes('mp4') ? 'mp4'
            : audioMime.includes('mpeg') ? 'mp3'
            : audioMime.includes('ogg')  ? 'ogg'
            : audioMime.includes('wav')  ? 'wav'
            : 'webm';

  // `prompt` biases Whisper to output in the target script — without it the
  // model often returns Latin approximations like "Tello Cafe" for "Θέλω καφέ".
  // Filled with a primer of common Greek words so it locks onto the alphabet.
  // temperature=0 → deterministic, less hallucinated Latin output.
  const promptByLang = {
    el: 'Ελληνικά. Θέλω καφέ, νερό, παρακαλώ. Είμαι Αμερικάνος. Πάω στην Αθήνα. Πόσο κάνει αυτό; Καλημέρα, καλησπέρα, ευχαριστώ.',
  };
  const biasPrompt = (language && promptByLang[language]) || '';

  const form = new FormData();
  form.append('file', new Blob([buf], { type: audioMime }), `audio.${ext}`);
  form.append('model', model);
  if (language && typeof language === 'string') form.append('language', language);
  if (biasPrompt) form.append('prompt', biasPrompt);
  form.append('temperature', '0');
  form.append('response_format', 'json');

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    res.status(502).json({ error: 'fetch_failed', message: String(e && e.message || e) });
    return;
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    res.status(502).json({
      error: 'upstream_error',
      provider: useGroq ? 'groq' : 'openai',
      status: upstream.status,
      detail: raw.slice(0, 500)
    });
    return;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { text: raw }; }

  res.status(200).json({
    ok: true,
    text: (parsed && parsed.text) || '',
    provider: useGroq ? 'groq' : 'openai',
    model
  });
};
