CREATE SCHEMA IF NOT EXISTS "mod_billing";
--> statement-breakpoint
CREATE TABLE "mod_billing"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"stripe_invoice_id" text,
	"number" text,
	"status" text NOT NULL,
	"total_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"hosted_url" text,
	"pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_billing"."overrides" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_billing"."plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"per_seat" boolean DEFAULT true NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_price_id" text,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 100 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_billing"."subscriptions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid,
	"status" text DEFAULT 'trialing' NOT NULL,
	"seats_purchased" integer DEFAULT 0 NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"grace_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_billing"."webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_billing"."workspace_usage" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"seats" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "invoices_ws_idx" ON "mod_billing"."invoices" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_stripe_idx" ON "mod_billing"."invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_slug_idx" ON "mod_billing"."plans" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "plans_published_idx" ON "mod_billing"."plans" USING btree ("published","order");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "mod_billing"."subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_sub_idx" ON "mod_billing"."subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "mod_billing"."webhook_events" USING btree ("received_at");