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
// Run:  node scripts/audit-phonetics.js

const { httpJson } = require('../analyst/http');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bdfjddzwvudqictvuvtr.supabase.co';
const KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Xeos4qw6hQuiyb9GS6oPuQ_LnOK9SJj';

const TONOS = { ά:'α', έ:'ε', ή:'η', ί:'ι', ό:'ο', ύ:'υ', ώ:'ω', ΐ:'ι', ΰ:'υ' };
const VOWELS = new Set(['α','ε','η','ι','ο','υ','ω','ϊ','ϋ']);
const DIPHTHONGS = new Set(['αι','ει','οι','υι','ου','αυ','ευ','ηυ']);
const isVowel = (c) => VOWELS.has(c) || (c in TONOS);
const baseOf = (c) => TONOS[c] || c;

// Split a Greek word into syllable nuclei (vowel groups, diphthongs merged) and
// find which nucleus carries the accent. Returns stress position counted FROM
// THE END (1 = last syllable, 2 = penult, …) — robust to start-of-word noise.
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
        step = 2; // diphthong → one nucleus
      }
    }
    nuclei.push(hasTonos);
    i += step;
  }
  const idx = nuclei.findIndex(Boolean);
  // Position counted FROM THE START (1 = first syllable). We use from-start, not
  // from-end, because optional synizesis collapses syllables AFTER the stress
  // (αύριο → "AV-ri-o"/"AV-ryo"), which would shift a from-end count but never
  // the from-start index of the stressed vowel.
  return { syllables: nuclei.length, fromStart: idx < 0 ? null : idx + 1 };
}

// Does the word contain a SYNIZESIS glide — an unstressed ι/υ next to another
// vowel (not a true diphthong)? e.g. γιατί, παλιό, νιώθω, διάρκεια. In these the
// glide optionally collapses a syllable, so a syllable-count check can't reliably
// locate the stress. We skip them for manual review rather than false-flag.
function hasSynizesis(word) {
  const cs = [...word.toLowerCase()];
  for (let i = 0; i < cs.length - 1; i++) {
    if (!isVowel(cs[i]) || !isVowel(cs[i + 1])) continue;
    if (DIPHTHONGS.has(baseOf(cs[i]) + baseOf(cs[i + 1]))) continue; // real diphthong, fine
    const a = cs[i], b = cs[i + 1];
    const glide = ((baseOf(a) === 'ι' || baseOf(a) === 'υ') && !(a in TONOS)) ||
                  ((baseOf(b) === 'ι' || baseOf(b) === 'υ') && !(b in TONOS));
    if (glide) return true;
  }
  return false;
}

// Parse a phonetic like "pa-RA-tho-si": which syllable(s) are UPPERCASE-stressed.
function phoneticStress(ph) {
  const parts = ph.split(/[\s-]+/).filter(Boolean);
  const caps = [];
  parts.forEach((p, i) => {
    const up = (p.match(/[A-Z]/g) || []).length;
    const lo = (p.match(/[a-z]/g) || []).length;
    if (up >= 2 || (up > 0 && up >= lo)) caps.push(i);
  });
  return {
    parts: parts.length,
    capsCount: caps.length,
    fromStart: caps.length ? caps[0] + 1 : null,
  };
}

(async function main() {
  const r = await httpJson('GET',
    `${SUPABASE_URL}/rest/v1/vocab?select=id,word,phonetic,translation&limit=2000`,
    { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const rows = r.json || [];

  const flags = [];
  const manualReview = [];
  let checked = 0, skippedMulti = 0, skippedMono = 0, noAccent = 0, noPhon = 0, synizesis = 0;

  for (const row of rows) {
    const word = (row.word || '').trim();
    const ph = (row.phonetic || '').trim();
    if (!ph) { noPhon++; continue; }
    if (/\s/.test(word)) { skippedMulti++; continue; }      // phrases → manual pass
    const g = greekStress(word);
    if (g.syllables <= 1) { skippedMono++; continue; }       // monosyllable: no stress to check
    // No accent in a polysyllable is almost always a function word that's
    // monosyllabic in speech (για, ποιος). Report separately, don't error-flag.
    if (g.fromStart == null) { noAccent++; continue; }
    if (hasSynizesis(word)) { synizesis++; manualReview.push(`${word}  [${ph}]`); continue; } // ambiguous syllable count

    checked++;
    const p = phoneticStress(ph);
    if (p.capsCount !== 1) {
      flags.push({ word, ph, reason: `malformed: ${p.capsCount} stressed syllables (expected exactly 1)` });
    } else if (p.fromStart !== g.fromStart) {
      flags.push({ word, ph, reason: `STRESS WRONG: accent is on syllable ${g.fromStart} (from start), phonetic stresses syllable ${p.fromStart}` });
    }
  }

  console.log(`\n  vocab rows: ${rows.length}`);
  console.log(`  single-word checked: ${checked}`);
  console.log(`  skipped — multiword: ${skippedMulti}, monosyllable: ${skippedMono}, no phonetic: ${noPhon}, no-accent: ${noAccent}, synizesis (manual): ${synizesis}\n`);
  console.log(`  ⚠ FLAGGED: ${flags.length}\n`);
  for (const f of flags) console.log(`  • ${f.word.padEnd(20)} ${('[' + f.ph + ']').padEnd(26)} ${f.reason}`);
  console.log('');
  if (process.argv.includes('--manual')) {
    console.log(`  synizesis words (verify by ear — auto-check can't place stress): ${manualReview.length}\n`);
    for (const m of manualReview) console.log(`  · ${m}`);
    console.log('');
  }
})();
