-- הריצו את כל הקובץ ב-Supabase: SQL Editor -> New query -> Run
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, full_name text,
  role text not null default 'user' check (role in ('admin','user')),
  active boolean not null default true,
  can_download boolean not null default true,
  created_at timestamptz not null default now()
);

-- המשתמש הראשון שנוצר הופך אוטומטית למנהל
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id,email,role)
  values (new.id,new.email, case when exists(select 1 from public.profiles) then 'user' else 'admin' end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_active() returns boolean
language sql security definer stable set search_path = public as
$$ select exists(select 1 from profiles where id = auth.uid() and active) $$;
create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as
$$ select exists(select 1 from profiles where id = auth.uid() and active and role='admin') $$;

create table public.passports (
  id uuid primary key default gen_random_uuid(),
  first_name text not null, last_name text not null,
  passport_number text, notes text,
  file_path text not null, file_name text, file_type text,
  file_hash text not null,
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- מניעת כפילויות: אותו קובץ, או אותו מספר דרכון
create unique index passports_hash_uq on public.passports(file_hash);
create unique index passports_number_uq on public.passports(lower(trim(passport_number)))
  where passport_number is not null and trim(passport_number) <> '';
create index passports_name_idx on public.passports(lower(last_name), lower(first_name));

create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid, user_email text, action text not null,
  passport_id uuid, details jsonb, created_at timestamptz not null default now()
);

create or replace function public.write_audit(p_action text, p_passport uuid, p_details jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log(user_id,user_email,action,passport_id,details)
  values (auth.uid(), (select email from profiles where id=auth.uid()), p_action, p_passport, p_details);
end $$;

-- פעולות צפייה/הורדה נרשמות מהאפליקציה
create or replace function public.log_action(p_action text, p_passport uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active() or p_action not in ('view','download') then return; end if;
  perform write_audit(p_action, p_passport, null);
end $$;

create or replace function public.passports_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op='INSERT' then
    perform write_audit('upload', new.id, jsonb_build_object('name', new.first_name||' '||new.last_name));
    return new;
  elsif tg_op='UPDATE' then
    new.updated_at := now();
    perform write_audit('edit', new.id, jsonb_build_object('name', new.first_name||' '||new.last_name));
    return new;
  else
    perform write_audit('delete', old.id, jsonb_build_object('name', old.first_name||' '||old.last_name));
    return old;
  end if;
end $$;
create trigger passports_audit_ins after insert on public.passports for each row execute function public.passports_audit();
create trigger passports_audit_upd before update on public.passports for each row execute function public.passports_audit();
create trigger passports_audit_del after delete on public.passports for each row execute function public.passports_audit();

-- הרשאות ברמת שורה
alter table public.profiles enable row level security;
alter table public.passports enable row level security;
alter table public.audit_log enable row level security;

create policy "profile: own or admin" on public.profiles for select using (id = auth.uid() or is_admin());
create policy "profile: admin update" on public.profiles for update using (is_admin()) with check (is_admin());
create policy "passports: read" on public.passports for select using (is_active());
create policy "passports: insert" on public.passports for insert with check (is_active() and uploaded_by = auth.uid());
create policy "passports: update" on public.passports for update using (is_active()) with check (is_active());
create policy "passports: admin delete" on public.passports for delete using (is_admin());
create policy "audit: admin read" on public.audit_log for select using (is_admin());

-- אחסון פרטי
insert into storage.buckets(id,name,public) values ('passports','passports',false) on conflict do nothing;
create policy "files: read" on storage.objects for select using (bucket_id='passports' and is_active());
create policy "files: upload" on storage.objects for insert with check (bucket_id='passports' and is_active());
create policy "files: admin delete" on storage.objects for delete using (bucket_id='passports' and is_admin());

-- עדכונים בזמן אמת
alter publication supabase_realtime add table public.passports;
