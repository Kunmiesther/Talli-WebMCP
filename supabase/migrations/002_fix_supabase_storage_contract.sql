alter table link_tokens
  add column if not exists created_at timestamptz;

update link_tokens
  set created_at = coalesce(created_at, now())
  where created_at is null;

alter table link_tokens
  alter column created_at set default now();

alter table link_tokens
  alter column created_at set not null;
