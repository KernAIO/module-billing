-- Row level security for this module's tenant tables.
--
-- Only `invoices` is one. An invoice is the customer's own record, read on their own billing screen
-- in their own workspace context, so it is isolated the way every other module's data is.
--
-- The rest of `mod_billing` — plans, subscriptions, workspace_usage, overrides, webhook_events — is
-- deliberately *not* row-level secured, and the reason is written where it will be read, at the top
-- of src/server/schema.ts: those rows are the instance operator's record *about* a workspace rather
-- than the workspace's own data, and the console that lists every workspace on the instance and the
-- jobs that enumerate them cannot work under a policy that returns nothing when `app.workspace_id`
-- is unset. Their isolation is enforced in the procedure layer instead.
alter table "mod_billing"."invoices" enable row level security;
--> statement-breakpoint
alter table "mod_billing"."invoices" force row level security;
--> statement-breakpoint
create policy "invoices_ws_isolation" on "mod_billing"."invoices"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
