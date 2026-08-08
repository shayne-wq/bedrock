-- Orebody — add 'geophysics' as a dataset kind.
--
-- Its own migration, deliberately. Postgres will not let a newly added enum
-- value be USED in the same transaction it was added in, so this is kept apart
-- from the zones migration that follows — that one only references the type in
-- column definitions, never the new value, and runs cleanly after this commits.
--
-- IF NOT EXISTS so re-running the migration set is a no-op.
alter type dataset_kind add value if not exists 'geophysics';
