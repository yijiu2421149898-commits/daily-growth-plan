-- =============================================================
-- 每日成长计划 · Supabase 增量升级脚本（v2）
-- -------------------------------------------------------------
-- 作用：为新增功能补齐数据表、字段、行级权限与管理员函数
-- 使用：Supabase 控制台 → SQL Editor → 粘贴整段 → Run
-- 特性：幂等（可重复执行），不会删除或覆盖已有业务数据
-- -------------------------------------------------------------
-- 涉及内容：
--   1. is_admin()              管理员判断函数
--   2. diary_categories        日记分类表
--   3. diary.category_ids      日记的分类 id 数组
--   4. todos.sort_order        待办手动排序字段
--   5. habits / habit_logs     习惯与打卡记录
--   6. goals                   月度 / 季度目标
--   7. 管理员读取、删除权限     供「用户管理」查看与清理数据
--   8. admin_list_users()      管理员用户列表（含禁用状态）
--   9. admin_set_user_disabled() 禁用 / 恢复账号
-- =============================================================

-- ---------- 0. 通用：管理员判断函数 ----------
-- 依赖用户的 raw_user_meta_data.is_admin = 'true'
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and coalesce(u.raw_user_meta_data->>'is_admin', 'false') = 'true'
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- ---------- 1. 日记分类表 ----------
create table if not exists public.diary_categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color      text not null default '#a9744f',
  is_preset  boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists diary_categories_user_name_uidx
  on public.diary_categories (user_id, name);

alter table public.diary_categories enable row level security;

drop policy if exists diary_categories_self on public.diary_categories;
create policy diary_categories_self on public.diary_categories
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists diary_categories_admin_read on public.diary_categories;
create policy diary_categories_admin_read on public.diary_categories
  for select using (public.is_admin());

-- ---------- 2. 日记表：分类 id 数组 ----------
alter table public.diary
  add column if not exists category_ids uuid[] not null default '{}';

-- ---------- 3. 待办表：手动排序字段 ----------
alter table public.todos
  add column if not exists sort_order integer not null default 0;

-- 为旧数据按创建时间初始化一次排序值（仅处理仍为 0 的记录）
update public.todos t
set sort_order = sub.rn
from (
  select id,
         row_number() over (partition by user_id, record_date order by created_at) as rn
  from public.todos
) sub
where t.id = sub.id
  and t.sort_order = 0;

-- ---------- 4. 习惯与打卡 ----------
create table if not exists public.habits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  icon        text not null default '🌱',
  is_archived boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.habit_logs (
  id         uuid primary key default gen_random_uuid(),
  habit_id   uuid not null references public.habits(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  log_date   date not null,
  created_at timestamptz not null default now(),
  unique (habit_id, log_date)
);

create index if not exists habit_logs_user_date_idx
  on public.habit_logs (user_id, log_date);

alter table public.habits enable row level security;
alter table public.habit_logs enable row level security;

drop policy if exists habits_self on public.habits;
create policy habits_self on public.habits
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists habits_admin_read on public.habits;
create policy habits_admin_read on public.habits
  for select using (public.is_admin());

drop policy if exists habit_logs_self on public.habit_logs;
create policy habit_logs_self on public.habit_logs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists habit_logs_admin_read on public.habit_logs;
create policy habit_logs_admin_read on public.habit_logs
  for select using (public.is_admin());

-- ---------- 5. 目标管理 ----------
create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  type          text not null default 'month',       -- month 月度 / quarter 季度
  period        text not null,                       -- 2026-11 或 2026-Q4
  target_value  integer not null default 30,         -- 目标数值
  current_value integer not null default 0,          -- 手动记录时的当前值
  link_type     text not null default 'manual',      -- manual / todo / habit
  link_id       uuid,                                -- 绑定习惯时的习惯 id
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists goals_user_idx on public.goals (user_id, status);

alter table public.goals enable row level security;

drop policy if exists goals_self on public.goals;
create policy goals_self on public.goals
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists goals_admin_read on public.goals;
create policy goals_admin_read on public.goals
  for select using (public.is_admin());

-- ---------- 6. 管理员对原有三张表的读取 / 删除权限 ----------
-- 用于「用户管理」中查看任意用户记录、单独导出、清空数据
do $$
declare
  t text;
begin
  foreach t in array array['daily_status', 'todos', 'diary'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'admin_read_' || t
    ) then
      execute format(
        'create policy %I on public.%I for select using (public.is_admin())',
        'admin_read_' || t, t
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'admin_delete_' || t
    ) then
      execute format(
        'create policy %I on public.%I for delete using (public.is_admin())',
        'admin_delete_' || t, t
      );
    end if;
  end loop;
end $$;

-- ---------- 7. 管理员：用户列表（兼容旧版 list_users） ----------
create or replace function public.list_users()
returns table (id uuid, email text, raw_user_meta_data jsonb)
language sql
security definer
set search_path = public
as $$
  select u.id, u.email::text, u.raw_user_meta_data
  from auth.users u
  order by u.created_at asc;
$$;

grant execute on function public.list_users() to authenticated;

-- 新版列表：额外返回注册时间、最后登录与禁用状态
create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  is_admin boolean,
  disabled boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'permission denied';
  end if;

  return query
    select u.id,
           u.email::text,
           u.created_at,
           u.last_sign_in_at,
           coalesce(u.raw_user_meta_data->>'is_admin', 'false') = 'true',
           (u.banned_until is not null and u.banned_until > now())
    from auth.users u
    order by u.created_at asc;
end;
$$;

grant execute on function public.admin_list_users() to authenticated;

-- ---------- 8. 管理员：禁用 / 恢复账号 ----------
-- 说明：通过 auth.users.banned_until 实现禁用，禁用后无法再次登录。
--       已登录的会话可能仍然有效，直到其 token 过期或被管理员强制退出。
create or replace function public.admin_set_user_disabled(target_user uuid, disabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'permission denied';
  end if;

  if target_user = auth.uid() then
    raise exception '不能禁用当前登录的管理员账号';
  end if;

  update auth.users
  set banned_until = case when disabled then now() + interval '100 years' else null end
  where id = target_user;
end;
$$;

grant execute on function public.admin_set_user_disabled(uuid, boolean) to authenticated;

-- =============================================================
-- 执行完成后刷新浏览器即可使用全部新增功能。
-- 若分类表为空，前端会在首次进入时自动写入 7 个预设分类。
-- =============================================================
