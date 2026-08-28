-- Per-(user, deal, channel) read watermark for message threads (#424).
--
-- `messages` has no read-state of its own, so nothing could tell an agent that
-- a client had written in. A watermark row per thread is enough: everything in
-- the thread newer than `last_read_at` (and not sent by the reader) is unread.
-- That is one row per thread a user has actually opened, not one row per
-- message, and it makes the count a single indexed range scan.
--
-- `channel` is part of the key on purpose: the client thread and the internal
-- agent+TC thread are separate conversations, so reading one must not silently
-- clear the other.

CREATE TABLE IF NOT EXISTS message_reads (
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deal_id      uuid        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    channel      varchar(20) NOT NULL DEFAULT 'client_thread',
    last_read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, deal_id, channel)
);

-- The unread count runs on every agent page load. Without this it falls back to
-- idx_messages_deal_id and re-filters channel/created_at in the heap; this
-- serves the whole predicate (see #393/#394 for the last two times an
-- unindexed lookup landed on a hot path).
CREATE INDEX IF NOT EXISTS idx_messages_deal_channel_created
    ON messages (deal_id, channel, created_at);
