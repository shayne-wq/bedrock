-- Sessions bucketed by hour, for the 1-day view.
--
-- deck_daily answers "which days", which is the right shape for a month and the
-- wrong one for a day: a single bar labelled "today" says nothing about when
-- anybody actually watched. Same body, same security posture as its siblings —
-- plain SQL, invoker rights, so RLS on view_sessions decides who sees what.
--
-- Both functions return only the buckets that have sessions. Filling the
-- calendar is the caller's job and is done in the console, because a chart that
-- silently omits the quiet days misreports the cadence rather than the volume.
create function deck_hourly(p_deck uuid, p_since timestamptz default now() - interval '24 hours')
returns table (hour timestamptz, sessions bigint, watch_ms bigint)
language sql stable as $$
  select date_trunc('hour', started_at), count(*)::bigint, coalesce(sum(watch_ms), 0)::bigint
    from view_sessions
   where deck_id = p_deck and started_at >= p_since
   group by 1 order by 1;
$$;
