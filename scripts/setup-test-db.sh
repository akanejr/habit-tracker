#!/bin/bash
set -e

echo "Setting up bloom_test database..."

# Set up Supabase-compatible roles and schemas
sudo -u postgres psql -d bloom_test <<'EOF'
-- Create Supabase-compatible roles and schemas
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- Create auth schema (mock)
CREATE SCHEMA IF NOT EXISTS auth;

-- Create auth.users table (mock)
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- Create auth.uid() function
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM auth.users WHERE email = current_setting('app.current_user_email', true) LIMIT 1;
$$;

-- Grant permissions
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Grant schema permissions
GRANT ALL ON SCHEMA public TO bloom_tester;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Set default privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bloom_tester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bloom_tester;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO bloom_tester;

-- Create test users
DELETE FROM auth.users WHERE id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES 
  ('00000000-0000-0000-0000-000000000001', 'user1@test.com', '{"display_name": "User One"}'),
  ('00000000-0000-0000-0000-000000000002', 'user2@test.com', '{"display_name": "User Two"}');

-- Grant authenticated role to bloom_tester (required for RLS policies)
GRANT authenticated TO bloom_tester;

EOF

echo "Applying migrations..."

# Apply all migrations in order
for f in supabase/migrations/*.sql; do
  echo "Applying $(basename $f)..."
  sudo -u postgres psql -d bloom_test -f "$f" > /dev/null 2>&1 || {
    echo "Error applying $f"
    sudo -u postgres psql -d bloom_test -f "$f"
    exit 1
  }
done

echo "Database setup complete!"
