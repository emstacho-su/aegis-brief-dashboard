-- Feedback review view: feedback rows with the submitter's email, for the project owner.
-- Safe to re-run. Not exposed to anon or authenticated (grants revoked), so it is readable only from the
-- dashboard SQL/Table editor (postgres) or with the service key.

create or replace view public.feedback_review
with (security_invoker = true)
as
select f.id,
       f.created_at,
       u.email,
       f.user_id,
       f.page,
       f.bug,
       f.change,
       f.screenshot_path
from public.feedback f
left join auth.users u on u.id = f.user_id
order by f.created_at desc;

revoke all on public.feedback_review from anon, authenticated;
grant select on public.feedback_review to service_role;
