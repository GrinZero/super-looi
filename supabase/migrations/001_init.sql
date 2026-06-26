-- Mem0ai required schema for Supabase vector store
-- Run this in Supabase SQL Editor

-- Enable the vector extension
create extension if not exists vector;

-- Create the memories table (mem0ai expects this exact structure)
create table if not exists memories (
  id text primary key,
  embedding vector(1536),
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc', now()),
  updated_at timestamp with time zone default timezone('utc', now())
);

-- Create the memory migrations table
create table if not exists memory_migrations (
  user_id text primary key,
  created_at timestamp with time zone default timezone('utc', now())
);

-- Create the vector similarity search function
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

-- Additional LOOI tables
-- Owner profile (Phase 1: single owner)
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null default '主人',
  preferences jsonb default '{}',
  created_at timestamptz default now()
);

-- Insert default owner profile
insert into profiles (name) values ('主人') on conflict do nothing;

-- Conversation history
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id),
  messages jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
