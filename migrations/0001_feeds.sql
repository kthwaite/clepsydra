CREATE TABLE feed (
    id             INTEGER PRIMARY KEY,
    url            TEXT NOT NULL UNIQUE,
    site_url       TEXT,
    title          TEXT NOT NULL DEFAULT '',
    title_override TEXT,
    group_name     TEXT,
    tags           TEXT NOT NULL DEFAULT '[]',
    subscribed     INTEGER NOT NULL DEFAULT 1,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    added_at       TEXT NOT NULL,
    etag           TEXT,
    last_modified  TEXT,
    last_fetch_at  TEXT,
    next_fetch_at  TEXT NOT NULL,
    error_count    INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT
);

CREATE TABLE entry (
    id            INTEGER PRIMARY KEY,
    feed_id       INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
    guid          TEXT NOT NULL,
    url           TEXT,
    title         TEXT NOT NULL DEFAULT '',
    author        TEXT,
    content_html  TEXT,
    published_at  TEXT,
    fetched_at    TEXT NOT NULL,
    read_at       TEXT,
    bookmarked_at TEXT,
    annotation    TEXT,
    UNIQUE (feed_id, guid)
);

CREATE INDEX idx_entry_sort ON entry (coalesce(published_at, fetched_at) DESC, id DESC);
CREATE INDEX idx_entry_feed_unread ON entry (feed_id) WHERE read_at IS NULL;

CREATE TABLE entry_tag (
    entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
);
