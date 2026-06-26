/**
 * Run database migration against Supabase
 * Usage: npx tsx scripts/migrate.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "public" } }
);

const migrations = [
  // Enable vector extension
  `create extension if not exists vector;`,

  // Memories table (mem0ai expects this)
  `create table if not exists memories (
    id text primary key,
    embedding vector(1536),
    metadata jsonb,
    created_at timestamp with time zone default timezone('utc', now()),
    updated_at timestamp with time zone default timezone('utc', now())
  );`,

  // Memory migrations table (mem0ai internal)
  `create table if not exists memory_migrations (
    user_id text primary key,
    created_at timestamp with time zone default timezone('utc', now())
  );`,

  // Vector similarity search function
  `create or replace function match_vectors(
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
  $$;`,

  // Profiles table
  `create table if not exists profiles (
    id uuid primary key default gen_random_uuid(),
    name text not null default '主人',
    preferences jsonb default '{}',
    created_at timestamptz default now()
  );`,

  // Conversations table
  `create table if not exists conversations (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid references profiles(id),
    messages jsonb not null default '[]',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );`,
];

async function main() {
  console.log("Running migrations against Supabase...\n");

  for (let i = 0; i < migrations.length; i++) {
    const sql = migrations[i];
    const preview = sql.trim().split("\n")[0].slice(0, 60);
    process.stdout.write(`[${i + 1}/${migrations.length}] ${preview}... `);

    const { error } = await supabase.rpc("exec_sql", { query: sql });

    if (error) {
      // If exec_sql doesn't exist, try raw query approach
      // Supabase doesn't support raw SQL via REST by default
      // We'll need to use the management API or SQL editor
      console.log(`\n⚠️  Cannot run via RPC: ${error.message}`);
      console.log("Please run the following SQL manually in Supabase SQL Editor:\n");
      console.log(migrations.join("\n\n"));
      process.exit(1);
    } else {
      console.log("✅");
    }
  }

  // Insert default profile
  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({ name: "主人" }, { onConflict: "id" });

  if (profileError && !profileError.message.includes("already exists")) {
    console.log(`⚠️  Profile insert note: ${profileError.message}`);
  }

  console.log("\n✅ All migrations complete!");
}

main().catch(console.error);
