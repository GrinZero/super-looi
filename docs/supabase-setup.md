# Supabase 数据库初始化指南

## 问题

Supabase 项目 `lqswbjdnqjflndcnbmjm` 的 PostgreSQL 直接连接 (IPv6) 从当前网络不可达，且 Pooler 尚未注册该 tenant。

## 解决方案

请在 Supabase Dashboard 的 **SQL Editor** 中手动执行以下 SQL：

1. 打开 https://supabase.com/dashboard/project/lqswbjdnqjflndcnbmjm/sql/new
2. 粘贴下面的 SQL 并执行

```sql
-- Enable the vector extension
create extension if not exists vector;

-- Create the memories table (mem0ai expects this)
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

-- Profiles table
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null default '主人',
  preferences jsonb default '{}',
  created_at timestamptz default now()
);

-- Conversations table
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id),
  messages jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Insert default profile
INSERT INTO profiles (name) VALUES ('主人');
```

3. 然后创建 Storage bucket：
   - 打开 Storage > New bucket
   - 名称: `evidence`
   - 设为 Public

## 验证

SQL 执行成功后，重启 server (`pnpm dev`)，memory 相关功能即可正常工作。
