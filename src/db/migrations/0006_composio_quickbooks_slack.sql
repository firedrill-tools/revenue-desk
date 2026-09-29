-- QuickBooks and Slack moved from their REST APIs to Composio: a stored check of the old API connection (its token, its missing variables) says nothing about the Composio one, so it is dropped and the next check writes the row again.
DELETE FROM `connections` WHERE `integration` IN ('quickbooks', 'slack') AND `kind` = 'api';
