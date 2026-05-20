// Generates the seed SQL for public.verb_conjugations (240 rows).
// Source of truth: GROUPS array in conjugation-drill.html. Run:
//   node scripts/seed-verb-conjugations.js > /tmp/seed.sql
// Then pipe the SQL into Supabase. One-shot script — re-run only when
// the verb list changes.

const PRONOUNS = [
  { key: 'eg',  pron: 'εγώ',          en: 'I' },
  { key: 'es',  pron: 'εσύ',          en: 'you (sing.)' },
  { key: 'af',  pron: 'αυτός / αυτή', en: 'he / she' },
  { key: 'em',  pron: 'εμείς',        en: 'we' },
  { key: 'eis', pron: 'εσείς',        en: 'you (pl./formal)' },
  { key: 'af3', pron: 'αυτοί / αυτές',en: 'they' },
];

const GROUPS = [
  { group: '-αω', verbs: [
    { inf: 'μιλάω', en: 'to speak / to talk', note: "Gives English 'homily' (a sermon) via ὁμιλέω. Noun: η ομιλία (speech).", forms: ['μιλάω','μιλάς','μιλάει','μιλάμε','μιλάτε','μιλάνε'] },
    { inf: 'αγαπάω', en: 'to love', note: "Source of English 'agape' (selfless love). Noun: η αγάπη.", forms: ['αγαπάω','αγαπάς','αγαπάει','αγαπάμε','αγαπάτε','αγαπάνε'] },
    { inf: 'ρωτάω', en: 'to ask', note: "Noun: η ερώτηση (question). Mnemonic: 'ro-TA-o' — every ASK has an A.", forms: ['ρωτάω','ρωτάς','ρωτάει','ρωτάμε','ρωτάτε','ρωτάνε'] },
    { inf: 'περπατάω', en: 'to walk', note: "Gives English 'peripatetic' (Aristotle's walking philosophers).", forms: ['περπατάω','περπατάς','περπατάει','περπατάμε','περπατάτε','περπατάνε'] },
    { inf: 'πεινάω', en: 'to be hungry', note: "Noun: η πείνα (hunger). Mnemonic: 'I'm PINE-aw for food.'", forms: ['πεινάω','πεινάς','πεινάει','πεινάμε','πεινάτε','πεινάνε'] },
    { inf: 'διψάω', en: 'to be thirsty', note: "Noun: η δίψα (thirst). Paired opposite of πεινάω.", forms: ['διψάω','διψάς','διψάει','διψάμε','διψάτε','διψάνε'] },
    { inf: 'γελάω', en: 'to laugh', note: "Gives medical English 'gelastic' (relating to laughter). Noun: το γέλιο.", forms: ['γελάω','γελάς','γελάει','γελάμε','γελάτε','γελάνε'] },
    { inf: 'ξυπνάω', en: 'to wake up', note: "ξ- (out of) + ύπνος (sleep) = 'out of sleep'. Noun: ο ύπνος.", forms: ['ξυπνάω','ξυπνάς','ξυπνάει','ξυπνάμε','ξυπνάτε','ξυπνάνε'] },
    { inf: 'σταματάω', en: 'to stop', note: "Same root as 'stamp' (foot down = stop). 'Σταμάτα!' = 'Stop!'", forms: ['σταματάω','σταματάς','σταματάει','σταματάμε','σταματάτε','σταματάνε'] },
    { inf: 'βοηθάω', en: 'to help', note: "Noun: η βοήθεια (help / Boithia). 'Βοήθεια!' = 'Help!'", forms: ['βοηθάω','βοηθάς','βοηθάει','βοηθάμε','βοηθάτε','βοηθάνε'] },
  ]},
  { group: '-εω', verbs: [
    { inf: 'λέω', en: 'to say / to tell / to call', note: "Source of 'lexicon', 'lexical' via λέξις (word). 3pl: λένε.", forms: ['λέω','λες','λέει','λέμε','λέτε','λένε'] },
    { inf: 'τρώω', en: 'to eat', note: "Stress on the ώ. Imperative: φάε (eat!) — irregular imperative.", forms: ['τρώω','τρως','τρώει','τρώμε','τρώτε','τρώνε'] },
    { inf: 'ακούω', en: 'to hear / to listen', note: "Source of 'acoustic', 'acoustics'. 3pl: ακούν (no final -ε).", forms: ['ακούω','ακούς','ακούει','ακούμε','ακούτε','ακούν'] },
    { inf: 'πάω', en: 'to go', note: "Irregular but follows the λέω skeleton. 'Πάμε!' = 'Let's go!'", forms: ['πάω','πας','πάει','πάμε','πάτε','πάνε'] },
    { inf: 'κλαίω', en: 'to cry', note: "Stress on the αί diphthong. εσύ form drops the vowel: κλαις.", forms: ['κλαίω','κλαις','κλαίει','κλαίμε','κλαίτε','κλαίνε'] },
    { inf: 'φταίω', en: "to be at fault / to be to blame", note: "'Εγώ φταίω' = 'It's my fault.' Same skeleton as κλαίω.", forms: ['φταίω','φταις','φταίει','φταίμε','φταίτε','φταίνε'] },
  ]},
  { group: '-ω', verbs: [
    { inf: 'αγοράζω', en: 'to buy', note: "From η αγορά (marketplace). Perfective: να αγοράσω.", forms: ['αγοράζω','αγοράζεις','αγοράζει','αγοράζουμε','αγοράζετε','αγοράζουν'] },
    { inf: 'γράφω', en: 'to write', note: "Source of 'graph', 'graphic', 'paragraph', 'autograph'.", forms: ['γράφω','γράφεις','γράφει','γράφουμε','γράφετε','γράφουν'] },
    { inf: 'διαβάζω', en: 'to read / to study', note: "διά (through) + βάζω (put). 'Put it through' — read/study.", forms: ['διαβάζω','διαβάζεις','διαβάζει','διαβάζουμε','διαβάζετε','διαβάζουν'] },
    { inf: 'θέλω', en: 'to want', note: "One of the 13 high-frequency irregulars. Aorist: θέλησα.", forms: ['θέλω','θέλεις','θέλει','θέλουμε','θέλετε','θέλουν'] },
    { inf: 'ξέρω', en: 'to know', note: "Mnemonic: 'X-ray vision = I see, I know'. No real aorist — use ήξερα.", forms: ['ξέρω','ξέρεις','ξέρει','ξέρουμε','ξέρετε','ξέρουν'] },
    { inf: 'πίνω', en: 'to drink', note: "Cognate with Latin 'potare' → English 'potion', 'potable'.", forms: ['πίνω','πίνεις','πίνει','πίνουμε','πίνετε','πίνουν'] },
    { inf: 'βλέπω', en: 'to see / to look', note: "Gives medical 'blepharitis' (eyelid inflammation).", forms: ['βλέπω','βλέπεις','βλέπει','βλέπουμε','βλέπετε','βλέπουν'] },
    { inf: 'κάνω', en: 'to do / to make', note: "After είμαι/έχω, the most-used verb in Greek. 'Τι κάνεις;' = 'How are you?'", forms: ['κάνω','κάνεις','κάνει','κάνουμε','κάνετε','κάνουν'] },
    { inf: 'παίρνω', en: 'to take / to get', note: "Mnemonic: 'I take a PEAR-no'. Aorist: πήρα (irregular).", forms: ['παίρνω','παίρνεις','παίρνει','παίρνουμε','παίρνετε','παίρνουν'] },
    { inf: 'δίνω', en: 'to give', note: "PIE root *deh₃- → also Latin 'do, donare' → English 'donate'.", forms: ['δίνω','δίνεις','δίνει','δίνουμε','δίνετε','δίνουν'] },
    { inf: 'έχω', en: 'to have', note: "Source of English 'epoch' (ἐπέχω, 'to hold'). The auxiliary verb in Greek.", forms: ['έχω','έχεις','έχει','έχουμε','έχετε','έχουν'] },
    { inf: 'ανοίγω', en: 'to open', note: "Mnemonic: 'a-NEE-go and the door opens'. Imperative: άνοιξε.", forms: ['ανοίγω','ανοίγεις','ανοίγει','ανοίγουμε','ανοίγετε','ανοίγουν'] },
    { inf: 'κλείνω', en: 'to close / to shut', note: "Imperative: κλείσε. Opposite of ανοίγω.", forms: ['κλείνω','κλείνεις','κλείνει','κλείνουμε','κλείνετε','κλείνουν'] },
    { inf: 'μένω', en: 'to stay / to live (somewhere)', note: "Cognate of Latin 'manere' → English 'remain', 'permanent'.", forms: ['μένω','μένεις','μένει','μένουμε','μένετε','μένουν'] },
  ]},
  { group: '-ώ', verbs: [
    { inf: 'μπορώ', en: 'can / to be able', note: "Stress lives on the ending. 'Μπορείς;' = 'Can you?' Aorist: μπόρεσα.", forms: ['μπορώ','μπορείς','μπορεί','μπορούμε','μπορείτε','μπορούν'] },
    { inf: 'οδηγώ', en: 'to drive', note: "From η οδός (road) — same root as 'odyssey'. 'Road-do' = drive.", forms: ['οδηγώ','οδηγείς','οδηγεί','οδηγούμε','οδηγείτε','οδηγούν'] },
    { inf: 'τηλεφωνώ', en: 'to telephone / to call', note: "Direct cognate: tele- (far) + phone (voice). Easy win.", forms: ['τηλεφωνώ','τηλεφωνείς','τηλεφωνεί','τηλεφωνούμε','τηλεφωνείτε','τηλεφωνούν'] },
    { inf: 'ευχαριστώ', en: 'to thank', note: "Source of 'Eucharist' (Christian thanksgiving). Lit: 'good favor'.", forms: ['ευχαριστώ','ευχαριστείς','ευχαριστεί','ευχαριστούμε','ευχαριστείτε','ευχαριστούν'] },
    { inf: 'χρησιμοποιώ', en: 'to use', note: "χρήσιμο (useful) + ποιώ (make) → 'make useful' = use.", forms: ['χρησιμοποιώ','χρησιμοποιείς','χρησιμοποιεί','χρησιμοποιούμε','χρησιμοποιείτε','χρησιμοποιούν'] },
    { inf: 'ακολουθώ', en: 'to follow', note: "Source of English 'acolyte' (one who follows / assists).", forms: ['ακολουθώ','ακολουθείς','ακολουθεί','ακολουθούμε','ακολουθείτε','ακολουθούν'] },
    { inf: 'ζω', en: 'to live', note: "Source of 'zoology', 'zodiac'. Short stem ζ-, standard -ώ endings.", forms: ['ζω','ζεις','ζει','ζούμε','ζείτε','ζουν'] },
    { inf: 'αργώ', en: 'to be late / to be slow', note: "From αργός (slow, lazy). Gives 'argon' (the slow, inert gas).", forms: ['αργώ','αργείς','αργεί','αργούμε','αργείτε','αργούν'] },
    { inf: 'τραγουδώ', en: 'to sing', note: "Noun: το τραγούδι (song). 'Tra-goo-DO' has a song in it.", forms: ['τραγουδώ','τραγουδείς','τραγουδεί','τραγουδούμε','τραγουδείτε','τραγουδούν'] },
    { inf: 'προσπαθώ', en: 'to try / to attempt', note: "προς + πάθος (toward + passion) — 'push toward'. Aorist: προσπάθησα.", forms: ['προσπαθώ','προσπαθείς','προσπαθεί','προσπαθούμε','προσπαθείτε','προσπαθούν'] },
  ]},
];

const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const rows = [];
for (const g of GROUPS) {
  for (const v of g.verbs) {
    for (let i = 0; i < PRONOUNS.length; i++) {
      const p = PRONOUNS[i];
      rows.push(`(${sq(v.inf)}, ${sq(v.en)}, ${sq(g.group)}, ${sq(p.pron)}, ${sq(p.key)}, ${sq(p.en)}, ${sq(v.forms[i])}, ${sq(v.note || '')})`);
    }
  }
}

process.stdout.write(
  `INSERT INTO public.verb_conjugations (verb_word, verb_en, verb_group, pronoun, pronoun_key, pronoun_en, form, note) VALUES\n` +
  rows.join(',\n') +
  `\nON CONFLICT (verb_word, pronoun_key) DO NOTHING;\n`
);

process.stderr.write(`Generated ${rows.length} rows from ${GROUPS.reduce((n,g)=>n+g.verbs.length,0)} verbs across ${GROUPS.length} groups.\n`);
