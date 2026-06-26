import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const client = new Client({
  connectionString: `postgresql://postgres.lqswbjdnqjflndcnbmjm:${process.env.DB_PASSWORD}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
  ssl: { rejectUnauthorized: false },
});

const sql = `
create extension if not exists vector;

create table if not exists memories (
  id text primary key,
  embedding vector(1536),
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc', now()),
  updated_at timestamp with time zone default timezone('utc', now())
);

create table if not exists memory_migrations (
  user_id text primary key,
  created_at timestamp with time zone default timezone('utc', now())
);

create or replace function match_vectors(
  query_embedding vector(1536),
  match_count int,
  filter jsonb default '{}'::jsonb
)
returns table (
  id text,
  similarity float,
  metadata jsonb
)
language plpgsql
as $$
begin
  return query
  select
    t.id::text,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.metadata
  from memories t
  where case
    when filter::text = '{}'::text then true
    else t.metadata @> filter
  end
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null default '主人',
  preferences jsonb default '{}',
  created_at timestamptz default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id),
  messages jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
`;

async function run() {
  await client.connect();
  console.log("Connected to Supabase PostgreSQL");

  // Run the whole SQL as one block (PostgreSQL supports this)
  try {
    await client.query(sql);
    console.log("✅ All tables and functions created");
  } catch (err: any) {
    console.error("❌ Migration failed:", err.message);
    // Try individual statements
    const statements = sql
      .split(";")
      .filter((s) => s.trim() && !s.trim().startsWith("--"));
    for (const stmt of statements) {
      if (!stmt.trim()) continue;
      try {
        await client.query(stmt + ";");
        console.log("  ✅", stmt.trim().split("\n")[0].slice(0, 50));
      } catch (e: any) {
        console.log("  ⚠️", stmt.trim().split("\n")[0].slice(0, 50), "-", e.message);
      }
    }
  }

  // Insert default profile
  try {
    await client.query(
      "INSERT INTO profiles (name) VALUES ('主人') ON CONFLICT DO NOTHING;"
    );
    console.log("✅ Default profile created");
  } catch (err: any) {
    console.log("⚠️ Profile:", err.message);
  }

  await client.end();
  console.log("\n✅ Migration complete!");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
