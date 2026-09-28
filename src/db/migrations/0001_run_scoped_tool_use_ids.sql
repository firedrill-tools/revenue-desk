DROP INDEX `approvals_tool_use_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_run_tool_use_idx` ON `approvals` (`run_id`,`tool_use_id`);--> statement-breakpoint
DROP INDEX `tool_calls_tool_use_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_run_tool_use_idx` ON `tool_calls` (`run_id`,`tool_use_id`);