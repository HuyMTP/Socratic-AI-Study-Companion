create table if not exists public.timetable_entries (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sort_order  int  not null default 0,
  subject     text not null check (char_length(subject)    <= 100),
  weekday     text not null default '' check (char_length(weekday)    <= 20),
  start_time  text not null default '' check (char_length(start_time) <= 10),
  end_time    text not null default '' check (char_length(end_time)   <= 10),
  room        text not null default '' check (char_length(room)       <= 50),
  created_at  timestamptz not null default now()
);

create table if not exists public.tasks (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sort_order  int  not null default 0,
  title       text not null check (char_length(title)   <= 200),
  subject     text not null default '' check (char_length(subject) <= 100),
  due         text not null default '' check (char_length(due)     <= 20),
  hours       text not null default '' check (char_length(hours)   <= 10),
  created_at  timestamptz not null default now()
);

create index if not exists timetable_entries_user_idx on public.timetable_entries (user_id);
create index if not exists tasks_user_idx on public.tasks (user_id);

-- 2. Row Level Security: mỗi người chỉ thấy và sửa được hàng của chính mình
alter table public.timetable_entries enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "chi_chu_so_huu" on public.timetable_entries;
create policy "chi_chu_so_huu" on public.timetable_entries
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "chi_chu_so_huu" on public.tasks;
create policy "chi_chu_so_huu" on public.tasks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Người chưa đăng nhập (anon) không được đụng vào hai bảng này
revoke all on public.timetable_entries, public.tasks from anon;
grant select, insert, update, delete on public.timetable_entries, public.tasks to authenticated;

-- 3. Hàm lưu dữ liệu: xóa cũ rồi ghi mới trong MỘT giao dịch (hoặc lưu hết, hoặc không lưu gì)
--    Đồng thời kiểm tra giới hạn số dòng ngay tại cơ sở dữ liệu.
create or replace function public.save_my_data(p_tt jsonb, p_tasks jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập';
  end if;
  if jsonb_typeof(p_tt) <> 'array' or jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'Dữ liệu không hợp lệ';
  end if;
  if jsonb_array_length(p_tt) > 30 or jsonb_array_length(p_tasks) > 50 then
    raise exception 'Vượt giới hạn: tối đa 30 dòng thời khóa biểu và 50 việc cần làm';
  end if;

  delete from public.timetable_entries where user_id = auth.uid();
  delete from public.tasks where user_id = auth.uid();

  insert into public.timetable_entries (user_id, sort_order, subject, weekday, start_time, end_time, room)
  select auth.uid(), t.n,
         coalesce(t.r->>'subject', ''), coalesce(t.r->>'weekday', ''),
         coalesce(t.r->>'start_time', ''), coalesce(t.r->>'end_time', ''),
         coalesce(t.r->>'room', '')
  from jsonb_array_elements(p_tt) with ordinality as t(r, n);

  insert into public.tasks (user_id, sort_order, title, subject, due, hours)
  select auth.uid(), t.n,
         coalesce(t.r->>'title', ''), coalesce(t.r->>'subject', ''),
         coalesce(t.r->>'due', ''), coalesce(t.r->>'hours', '')
  from jsonb_array_elements(p_tasks) with ordinality as t(r, n);
end;
$$;

revoke all on function public.save_my_data(jsonb, jsonb) from public, anon;
grant execute on function public.save_my_data(jsonb, jsonb) to authenticated;

-- 4. Hàm cho người dùng tự xóa tài khoản của mình (các bảng dữ liệu tự xóa theo nhờ "on delete cascade")
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
