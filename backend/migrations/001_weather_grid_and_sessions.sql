-- Run this in your Supabase SQL editor before starting the backend.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS weather_grid (
  id          SERIAL PRIMARY KEY,
  geom        GEOMETRY(Point, 4326) NOT NULL,
  wind_mph    FLOAT    NOT NULL DEFAULT 0,
  precip      FLOAT    NOT NULL DEFAULT 0,
  visibility  FLOAT    NOT NULL DEFAULT 9999,
  restricted  BOOLEAN  GENERATED ALWAYS AS (wind_mph > 25 OR precip > 2 OR visibility < 1000) STORED,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS weather_grid_geom_idx ON weather_grid USING GIST (geom);
CREATE UNIQUE INDEX IF NOT EXISTS weather_grid_geom_unique ON weather_grid USING GIST (geom);

CREATE TABLE IF NOT EXISTS weather_monitor_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bbox          JSONB       NOT NULL,
  thresholds    JSONB       NOT NULL,
  last_snapshot JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '12 hours'
);
CREATE INDEX IF NOT EXISTS weather_monitor_sessions_expires_idx ON weather_monitor_sessions (expires_at);