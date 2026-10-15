-- pw_set: the user has chosen their own password. False (default) forces the dashboard's set-password card
-- after a code sign-in, so an admin-created placeholder password is never the credential that gets someone in.
alter table public.user_settings add column if not exists pw_set boolean not null default false;
