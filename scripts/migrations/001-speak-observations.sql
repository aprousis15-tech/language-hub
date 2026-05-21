-- Migration 001 — speak_observations
-- Run once in Supabase: SQL Editor → New query → paste → Run.
--
-- WHY: The Speak drill grader is intentionally forgiving (passes "sound close
-- enough" attempts). Hard fails go to the existing `mistakes` table and drive
-- the Review tab. This new table captures EVERY speak attempt — fails AND
-- near-miss passes AND clean passes — with structured weakness data, so a
-- downstream learning agent can analyze patterns over time without polluting
-- the user-facing Review UI.
--
-- Safe to run multiple times: IF NOT EXISTS guards everything.

create table if not exists public.speak_observations (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  -- 'fail' = grader marked score=fix
  -- 'note' = grader marked score=pass but with observed weaknesses (near-miss)
  -- 'clean' = grader marked score=pass with no observed weaknesses
  severity        text not null check (severity in ('fail', 'note', 'clean')),
  drill_source    text not null default 'daily-five',
  english_prompt  text not null,
  model_answer    text not null,
  transcript      text not null,
  target_grammar  text,
  score           text check (score in ('pass', 'fix')),
  headline        text,
  correction      text,
  grammar_note    text,
  -- Structured per-issue array. Each entry:
  -- { type, description, expected, heard }
  -- type ∈ pronunciation | stress | vowel | consonant | case | tense | person
  --        | number | gender | vocab | word_order | article | preposition
  weaknesses_observed jsonb not null default '[]'::jsonb,
  stt_provider    text,    -- 'groq' | 'openai' | 'web-speech'
  audio_mime      text,
  -- Set when the user flags "mic miscaught" so the agent can discount it.
  miscaught_at    timestamptz,
  resolved_at     timestamptz
);

create index if not exists speak_observations_created_at_idx
  on public.speak_observations (created_at desc);

create index if not exists speak_observations_severity_idx
  on public.speak_observations (severity);

create index if not exists speak_observations_target_grammar_idx
  on public.speak_observations (target_grammar);

-- RLS: if your project has RLS enabled on other tables, mirror those policies
-- here. The simple permissive default below matches what the `mistakes` table
-- likely uses for a single-user personal app. Tighten for multi-user.
alter table public.speak_observations enable row level security;

drop policy if exists "speak_observations_all_access" on public.speak_observations;
create policy "speak_observations_all_access" on public.speak_observations
  for all using (true) with check (true);
