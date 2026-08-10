-- Bedrock — storage buckets and the analytics rollups the dashboard reads.

-- --------------------------------------------------------------- storage ---
-- Private. Customer block models are commercially sensitive pre-announcement,
-- so nothing is world-readable; the viewer gets short-lived signed URLs minted
-- by an edge function after it has validated the share token.
insert into storage.buckets (id, name, public, file_size_limit)
values ('artifacts', 'artifacts', false, 2147483648)
on conflict (id) do nothing;

-- Path convention: <org_id>/<project_id>/<dataset_id>/<file>
-- The first segment is the tenant boundary, so every policy checks it.
create policy artifacts_read on storage.objects for select
  using (bucket_id = 'artifacts'
         and is_org_member(((storage.foldername(name))[1])::uuid));

create policy artifacts_write on storage.objects for insert
  with check (bucket_id = 'artifacts'
              and is_org_member(((storage.foldername(name))[1])::uuid));

create policy artifacts_update on storage.objects for update
  using (bucket_id = 'artifacts'
         and is_org_member(((storage.foldername(name))[1])::uuid));

create policy artifacts_delete on storage.objects for delete
  using (bucket_id = 'artifacts'
         and is_org_member(((storage.foldername(name))[1])::uuid));

-- --------------------------------------------------------------- rollups ---
-- SECURITY INVOKER (the default) on purpose: these read view_sessions and
-- view_events through the caller's RLS, so an org can only ever aggregate its
-- own decks. Making them definer would have quietly turned every rollup into a
-- cross-tenant data leak.

create function deck_summary(p_deck uuid, p_since timestamptz default now() - interval '30 days')
returns table (
  sessions        bigint,
  embed_sessions  bigint,
  completions     bigint,
  median_watch_ms integer,
  total_watch_ms  bigint,
  avg_chapters    numeric
) language sql stable as $$
  select count(*)::bigint,
         count(*) filter (where is_embed)::bigint,
         count(*) filter (where completed)::bigint,
         coalesce(percentile_cont(0.5) within group (order by watch_ms), 0)::integer,
         coalesce(sum(watch_ms), 0)::bigint,
         coalesce(round(avg(chapters_seen), 1), 0)
    from view_sessions
   where deck_id = p_deck and started_at >= p_since;
$$;

-- Per-chapter engagement. `reached` is how many sessions ever opened the
-- chapter; `median_dwell_ms` is how long they stayed. Together they give the
-- two things an IR team actually asks: where do people leave, and what did
-- they linger on.
create function deck_chapter_funnel(p_deck uuid, p_since timestamptz default now() - interval '30 days')
returns table (
  chapter_ord     integer,
  reached         bigint,
  median_dwell_ms integer,
  total_dwell_ms  bigint
) language sql stable as $$
  select e.chapter_ord,
         count(distinct e.session_id)::bigint,
         coalesce(percentile_cont(0.5) within group (order by e.dwell_ms), 0)::integer,
         coalesce(sum(e.dwell_ms), 0)::bigint
    from view_events e
    join view_sessions s on s.id = e.session_id
   where e.deck_id = p_deck
     and e.kind = 'chapter'
     and e.chapter_ord is not null
     and s.started_at >= p_since
   group by e.chapter_ord
   order by e.chapter_ord;
$$;

-- Which websites the deck is being watched from. This is the number that
-- justifies the embed feature existing.
create function deck_referrers(p_deck uuid, p_since timestamptz default now() - interval '30 days')
returns table (
  referrer_host text,
  sessions      bigint,
  watch_ms      bigint
) language sql stable as $$
  select coalesce(referrer_host, 'direct'),
         count(*)::bigint,
         coalesce(sum(watch_ms), 0)::bigint
    from view_sessions
   where deck_id = p_deck and started_at >= p_since
   group by 1
   order by 2 desc;
$$;

create function deck_daily(p_deck uuid, p_since timestamptz default now() - interval '30 days')
returns table (day date, sessions bigint, watch_ms bigint)
language sql stable as $$
  select started_at::date, count(*)::bigint, coalesce(sum(watch_ms), 0)::bigint
    from view_sessions
   where deck_id = p_deck and started_at >= p_since
   group by 1 order by 1;
$$;
