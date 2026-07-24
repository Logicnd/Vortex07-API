-- Shared profile likes for Vortex07
CREATE TABLE IF NOT EXISTS likes (
  actor_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_target ON likes (target_id);
CREATE INDEX IF NOT EXISTS idx_likes_actor ON likes (actor_id);
