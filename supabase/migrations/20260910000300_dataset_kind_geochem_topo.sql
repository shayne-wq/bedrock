-- Two upload slots the console has always offered and the database has always
-- refused.
--
-- `dataset_kind` was created with four values and gained 'geophysics' in its
-- own migration. 'geochem' and 'topography' were added to the console's upload
-- wizard without one, so both parse the file, build the artifact, upload it to
-- storage, and then fail on the INSERT with
--   invalid input value for enum dataset_kind: "geochem"
-- — after the slow part, which is the worst place to fail. Found while
-- importing a real client's soil and rock geochemistry.
--
-- No policy or function references these, so both values can go in one file;
-- the "unsafe use of new value" rule only bites when a migration USES a label
-- it just added.
alter type dataset_kind add value if not exists 'geochem';
alter type dataset_kind add value if not exists 'topography';
