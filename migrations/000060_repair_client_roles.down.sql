-- No-op. The up migration is a one-off data repair that restores the role each
-- user was actually invited as; re-corrupting those rows back to `agent` would
-- reintroduce the bug, not undo a schema change. Nothing to roll back.
SELECT 1;
