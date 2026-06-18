#!/usr/bin/env node
// scripts/audit-phonetics.js — deterministic quality gate for vocab phonetics.
//
// The phonetic/transliteration field was AI-generated and never verified, so
// some entries have the WRONG stressed syllable (e.g. παράδοση → "pah-rah-DOH-mee"
// when the accent ά is on the 2nd syllable: pa-RA-tho-si).
//
// We can catch this deterministically: Greek orthography MARKS the stress with
// an accent (ά έ ή ί ό ύ ώ). So for every word we know exactly which syllable
// should be stressed. We then check the phonetic marks (UPPERCASE) the matching
// syllable. No AI, no guessing — pure rules. Report-only (never writes).
//
// Run:  node scripts/audit-phonetics.js            (summary + flags)
//       node scripts/audit-phonetics.js --manual   (also list synizesis/misaligned/missing)

const { httpJson } = require('../analyst/http');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bdfjddzwvudqictvuvtr.supabase.co';
const KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

const TONOS = { ά:'α', έ:'ε', ή:'η', ί:'ι', ό:'ο', ύ:'υ', ώ:'ω', ΐ:'ι', ΰ:'υ' };
const VOWELS = new Set(['α','ε','η','ι','ο','υ','ω','ϊ','ϋ']);
const DIPHTHONGS = new Set(['αι','ει','οι','υι','ου','αυ','ευ','ηυ']);
const isVowel = (c) => VOWELS.has(c) || (c in TONOS);
const baseOf = (c) => TONOS[c] || c;

// Unstressed leading articles. Phonetics often omit them (το μάτι → "MA-tee"),
// so we strip them to align the noun with its phonetic before checking stress.
const ARTICLES = new Set(['ο','η','το','οι','τα','τον','την','τη','του','της','των',
  'στο','στη','στον','στην','στις','στους','στα','ένα','μια','μία','έναν','ενός','μιας']);

// Split a Greek word into syllable nuclei and find which carries the accent.
// Position is counted FROM THE START (1 = first syllable) — robust to the optional
// synizesis that collapses syllables after the stress.
function greekStress(word) {
  const chars = [...word.toLowerCase()];
  const nuclei = [];
  for (let i = 0; i < chars.length; ) {
    const c = chars[i];
    if (!isVowel(c)) { i++; continue; }
    let hasTonos = c in TONOS;
    let step = 1;
    const next = chars[i + 1];
    if (next && isVowel(next)) {
      const pair = baseOf(c) + baseOf(next);
      const diaeresis = next === 'ϊ' || next === 'ϋ';
      if (DIPHTHONGS.has(pair) && !(c in TONOS) && !diaeresis) {
        if (next in TONOS) hasTonos = true;
        step = 2;
      }
    }
    nuclei.push(hasTonos);
    i += step;
  }
  const idx = nuclei.findIndex(Boolean);
  return { syllables: nuclei.length, fromStart: idx < 0 ? null : idx + 1 };
}

// Synizesis glide (unstressed ι/υ next to another vowel, not a diphthong) makes the
// syllable count ambiguous → we can't place stress reliably, so we skip & report.
function hasSynizesis(word) {
  const cs = [...word.toLowerCase()];
  for (let i = 0; i < cs.length - 1; i++) {
    if (!isVowel(cs[i]) || !isVowel(cs[i + 1])) continue;
    if (DIPHTHONGS.has(baseOf(cs[i]) + baseOf(cs[i + 1]))) continue;
    const a = cs[i], b = cs[i + 1];
    if (((baseOf(a) === 'ι' || baseOf(a) === 'υ') && !(a in TONOS)) ||
        ((baseOf(b) === 'ι' || baseOf(b) === 'υ') && !(b in TONOS))) return true;
  }
  return false;
}

// Which syllable of a phonetic chunk ("pa-RA-tho-si") is UPPERCASE-stressed.
function phoneticStress(chunk) {
  const parts = chunk.split('-').filter(Boolean);
  const caps = [];
  parts.forEach((p, i) => {
    const up = (p.match(/[A-Z]/g) || []).length;
    const lo = (p.match(/[a-z]/g) || []).length;
    if (up >= 2 || (up > 0 && up >= lo)) caps.push(i);
  });
  return { parts: parts.length, capsCount: caps.length, fromStart: caps.length ? caps[0] + 1 : null };
}

// Check one Greek word against one phonetic chunk. Returns a status object.
function checkWord(word, chunk) {
  const g = greekStress(word);
  if (g.syllables <= 1) return { skip: 'mono' };
  if (g.fromStart == null) return { skip: 'noaccent' };
  if (hasSynizesis(word)) return { skip: 'synizesis' };
  const p = phoneticStress(chunk);
  if (p.capsCount !== 1) return { flag: `malformed: ${p.capsCount} stressed syllables (expected 1)` };
  if (p.fromStart !== g.fromStart) return { flag: `STRESS WRONG: accent on syllable ${g.fromStart}, phonetic stresses ${p.fromStart}` };
  return { ok: true };
}

(async function main() {
  const r = await httpJson('GET',
    `${SUPABASE_URL}/rest/v1/vocab?select=id,word,phonetic,translation&limit=2000`,
    { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const rows = r.json || [];

  const flags = [], missing = [], synizesis = [], misaligned = [];
  let checkedWords = 0;

  for (const row of rows) {
    // Normalize to NFC: some rows store accents as decomposed combining marks
    // (α + U+0301) instead of precomposed ά, which would hide the stress.
    const word = (row.word || '').trim().normalize('NFC');
    const ph = (row.phonetic || '').trim();
    if (!ph) { missing.push(word); continue; }

    if (!/\s/.test(word)) {
      // genuine single word — whole phonetic is one chunk (spaces in it = malformed)
      const res = checkWord(word, ph);
      if (res.flag) flags.push({ word, ph, reason: res.flag });
      else if (res.skip === 'synizesis') synizesis.push(`${word}  [${ph}]`);
      else if (res.ok) checkedWords++;
      continue;
    }
    // phrase — drop leading article(s) the phonetic omits, then align word↔chunk
    let gw = word.split(/\s+/);
    const pc = ph.split(/\s+/);
    while (gw.length > pc.length && ARTICLES.has(gw[0].toLowerCase())) gw = gw.slice(1);

    if (gw.length === pc.length) {
      gw.forEach((w, i) => {
        const res = checkWord(w, pc[i]);
        if (res.flag) flags.push({ word: `${w}  (in "${word}")`, ph: pc[i], reason: res.flag });
        else if (res.skip === 'synizesis') synizesis.push(`${w}  [${pc[i]}]  (in "${word}")`);
        else if (res.ok) checkedWords++;
      });
    } else {
      misaligned.push(`${word}  →  [${ph}]  (${gw.length} words vs ${pc.length} phonetic chunks)`);
    }
  }

  console.log(`\n  vocab rows: ${rows.length}`);
  console.log(`  words auto-checked: ${checkedWords}`);
  console.log(`  synizesis (manual): ${synizesis.length}  ·  misaligned phrases (manual): ${misaligned.length}  ·  missing phonetic: ${missing.length}\n`);
  console.log(`  ⚠ FLAGGED: ${flags.length}\n`);
  for (const f of flags) console.log(`  • ${f.word.padEnd(28)} ${('[' + f.ph + ']').padEnd(22)} ${f.reason}`);
  console.log('');

  if (process.argv.includes('--manual')) {
    console.log(`  ── misaligned phrases (${misaligned.length}) ──`);
    for (const m of misaligned) console.log(`  · ${m}`);
    console.log(`\n  ── missing phonetic (${missing.length}) ──`);
    for (const m of missing) console.log(`  · ${m}`);
    console.log('');
  }
})();
