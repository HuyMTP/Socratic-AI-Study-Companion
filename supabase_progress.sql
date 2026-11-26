-- ============================================================
-- GÓI C: BẢNG LƯU TIẾN ĐỘ HỌC (XP, chuỗi ngày, hàng đợi ôn tập)
-- Chạy trong Supabase: SQL Editor -> New query -> dán toàn bộ -> Run
-- Chạy thêm sau file supabase_setup.sql. Có thể chạy lại nhiều lần.
-- ============================================================

create table if not exists public.learning_progress (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.learning_progress enable row level security;

drop policy if exists "chi_chu_so_huu" on public.learning_progress;
create policy "chi_chu_so_huu" on public.learning_progress
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.learning_progress from anon;
grant select, insert, update, delete on public.learning_progress to authenticated;

-- Ghi (hoặc cập nhật) tiến độ của chính người đăng nhập; giới hạn kích thước ngay tại cơ sở dữ liệu
create or replace function public.save_my_progress(p_data jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập';
  end if;
  if octet_length(p_data::text) > 500000 then
    raise exception 'Dữ liệu tiến độ quá lớn';
  end if;
  insert into public.learning_progress (user_id, data, updated_at)
  values (auth.uid(), p_data, now())
  on conflict (user_id) do update set data = excluded.data, updated_at = now();
end;
$$;

revoke all on function public.save_my_progress(jsonb) from public, anon;
grant execute on function public.save_my_progress(jsonb) to authenticated;
