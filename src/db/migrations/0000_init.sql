CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`integration` text NOT NULL,
	`action_class` text NOT NULL,
	`operation` text NOT NULL,
	`consequence` text NOT NULL,
	`descriptor_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`reason` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "approvals_integration" CHECK(integration IN ('gmail', 'google_calendar', 'hubspot', 'stripe', 'quickbooks', 'slack')),
	CONSTRAINT "approvals_action_class" CHECK(action_class IN ('read', 'internal_write', 'outbound', 'financial', 'destructive')),
	CONSTRAINT "approvals_status" CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
	CONSTRAINT "approvals_decided_by" CHECK("approvals"."decided_by" IS NULL OR decided_by IN ('user', 'timeout', 'stop', 'restart')),
	CONSTRAINT "approvals_decided" CHECK(("approvals"."status" = 'pending') = ("approvals"."decided_at" IS NULL AND "approvals"."decided_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_tool_use_idx` ON `approvals` (`tool_use_id`);--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`integration` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`profile` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`status_detail` text DEFAULT '' NOT NULL,
	`endpoint_label` text,
	`account_hint` text,
	`missing_vars` text DEFAULT '[]' NOT NULL,
	`last_checked_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "connections_integration" CHECK(integration IN ('gmail', 'google_calendar', 'hubspot', 'stripe', 'quickbooks', 'slack')),
	CONSTRAINT "connections_kind" CHECK(kind IN ('composio', 'mcp', 'api')),
	CONSTRAINT "connections_status" CHECK(status IN ('connected', 'needs_auth', 'expired', 'not_configured', 'invalid', 'error', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`sdk_session_id` text,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "conversations_source" CHECK(source IN ('ui', 'cli')),
	CONSTRAINT "conversations_status" CHECK(status IN ('idle', 'running', 'awaiting_approval', 'error'))
);
--> statement-breakpoint
CREATE INDEX `conversations_list_idx` ON `conversations` (`archived_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`role` text NOT NULL,
	`parts_json` text NOT NULL,
	`metadata_json` text,
	`text` text DEFAULT '' NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_role" CHECK(role IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_seq_idx` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_run_idx` ON `messages` (`run_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`action_class` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "policies_action_class" CHECK(action_class IN ('read', 'internal_write', 'outbound', 'financial', 'destructive')),
	CONSTRAINT "policies_mode" CHECK(mode IN ('auto', 'ask', 'deny'))
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`source` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`stop_reason` text,
	`terminal_reason` text,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text,
	`num_turns` integer,
	`model_requests` integer,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`duration_ms` integer,
	`duration_api_ms` integer,
	`error_code` text,
	`error_message` text,
	`policy_snapshot` text NOT NULL,
	`connections_snapshot` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runs_source" CHECK(source IN ('ui', 'cli')),
	CONSTRAINT "runs_mode" CHECK(mode IN ('interactive', 'headless')),
	CONSTRAINT "runs_status" CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'timed_out')),
	CONSTRAINT "runs_effort" CHECK(effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
	CONSTRAINT "runs_error_code" CHECK("runs"."error_code" IS NULL OR error_code IN ('config_missing', 'model_error', 'max_turns', 'budget_exceeded', 'timeout', 'cancelled', 'server_restart', 'internal')),
	CONSTRAINT "runs_finished" CHECK(("runs"."status" = 'running') = ("runs"."finished_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `runs_conversation_idx` ON `runs` (`conversation_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_started_idx` ON `runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`integration` text,
	`connection_kind` text,
	`tool_name` text NOT NULL,
	`upstream_tool` text,
	`operation` text,
	`action_class` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`truncated` integer DEFAULT false NOT NULL,
	`is_error` integer DEFAULT false NOT NULL,
	`error_code` text,
	`error_message` text,
	`http_status` integer,
	`idempotency_key` text,
	`approval_id` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tool_calls_integration" CHECK("tool_calls"."integration" IS NULL OR integration IN ('gmail', 'google_calendar', 'hubspot', 'stripe', 'quickbooks', 'slack')),
	CONSTRAINT "tool_calls_kind" CHECK("tool_calls"."connection_kind" IS NULL OR connection_kind IN ('composio', 'mcp', 'api')),
	CONSTRAINT "tool_calls_action_class" CHECK("tool_calls"."action_class" IS NULL OR action_class IN ('read', 'internal_write', 'outbound', 'financial', 'destructive')),
	CONSTRAINT "tool_calls_status" CHECK(status IN ('awaiting_approval', 'running', 'succeeded', 'failed', 'denied', 'interrupted')),
	CONSTRAINT "tool_calls_decision" CHECK(decision IN ('pending', 'auto', 'approved', 'denied', 'policy_denied', 'timed_out', 'stopped', 'rejected')),
	CONSTRAINT "tool_calls_known_tool" CHECK("tool_calls"."decision" = 'rejected' OR "tool_calls"."decision" = 'pending' OR "tool_calls"."integration" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_tool_use_id_unique` ON `tool_calls` (`tool_use_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_run_idx` ON `tool_calls` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_integration_idx` ON `tool_calls` (`integration`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`agent_name` text DEFAULT 'Revenue Desk' NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`email_signature` text DEFAULT '' NOT NULL,
	`internal_email_domains` text DEFAULT '[]' NOT NULL,
	`notify_slack_channel` text,
	`allowed_slack_channels` text DEFAULT '[]' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`default_model` text,
	`default_effort` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "workspace_settings_singleton" CHECK("workspace_settings"."id" = 1),
	CONSTRAINT "workspace_settings_effort" CHECK("workspace_settings"."default_effort" IS NULL OR default_effort IN ('low', 'medium', 'high', 'xhigh', 'max'))
);
