-- G Class Crew database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Safe to run once on a new project.

-- ---------- Tables ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'pending' check (role in ('owner','driver','pending')),
  created_at timestamptz not null default now()
);

create table public.cars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null default '',
  rego text not null default '',
  active boolean not null default true,
  sort int not null default 0
);

create table public.availability (
  worker_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  status text not null check (status in ('yes','no')),
  primary key (worker_id, day)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  client text not null default '',
  date date not null,
  data jsonb not null default '{}'::jsonb,   -- groom, bride, ceremony, photos, reception, getaway, note
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.job_lines (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  sort int not null default 0,
  car_id uuid references public.cars(id) on delete set null,
  worker_id uuid references public.profiles(id) on delete set null,
  hours numeric,
  task text not null default '',
  note text not null default '',
  start text not null default '',
  car_text text not null default '',
  driver_text text not null default ''
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  text text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  worker_id uuid references public.profiles(id) on delete set null,
  text text not null default '',
  photo_path text,
  sys boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.chat_reads (
  worker_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (worker_id, job_id)
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  day date not null default current_date,
  out_at timestamptz not null default now(),
  out_odo int not null,
  out_fuel text not null,
  out_checks text[] not null default '{}',
  out_notes text not null default '',
  out_photos text[] not null default '{}',
  in_at timestamptz,
  in_odo int,
  in_fuel text,
  in_checks text[] not null default '{}',
  in_notes text not null default '',
  in_photos text[] not null default '{}'
);
create unique index one_open_trip_per_car on public.trips(car_id) where in_at is null;

-- ---------- Helpers ----------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role in ('owner','driver') from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role = 'owner' from public.profiles where id = auth.uid()), false) $$;

create or replace function public.on_job(j uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_owner() or exists (select 1 from public.job_lines where job_id = j and worker_id = auth.uid()) $$;

-- New sign-ups get a profile. The very first person to sign up becomes the owner; everyone after waits for approval.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as
$$
begin
  insert into public.profiles (id, name, role)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1)),
          case when exists (select 1 from public.profiles where role = 'owner') then 'pending' else 'owner' end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row level security ----------
alter table public.profiles enable row level security;
alter table public.cars enable row level security;
alter table public.availability enable row level security;
alter table public.jobs enable row level security;
alter table public.job_lines enable row level security;
alter table public.notifications enable row level security;
alter table public.messages enable row level security;
alter table public.chat_reads enable row level security;
alter table public.trips enable row level security;

create policy "see self and team" on public.profiles for select using (id = auth.uid() or public.is_staff());
create policy "owner manages staff" on public.profiles for update using (public.is_owner());
create policy "owner removes staff" on public.profiles for delete using (public.is_owner() and id <> auth.uid());

create policy "staff see cars" on public.cars for select using (public.is_staff());
create policy "owner manages cars" on public.cars for all using (public.is_owner()) with check (public.is_owner());

create policy "staff see availability" on public.availability for select using (public.is_staff());
create policy "own availability" on public.availability for all
  using (public.is_staff() and (worker_id = auth.uid() or public.is_owner()))
  with check (public.is_staff() and (worker_id = auth.uid() or public.is_owner()));

create policy "see my jobs" on public.jobs for select using (public.on_job(id));
create policy "owner manages jobs" on public.jobs for all using (public.is_owner()) with check (public.is_owner());
create policy "see my job lines" on public.job_lines for select using (public.on_job(job_id));
create policy "owner manages job lines" on public.job_lines for all using (public.is_owner()) with check (public.is_owner());

create policy "my notifications" on public.notifications for select using (worker_id = auth.uid());
create policy "mark mine read" on public.notifications for update using (worker_id = auth.uid());
create policy "owner sends notifications" on public.notifications for insert with check (public.is_owner());

create policy "job chat read" on public.messages for select using (public.is_staff() and public.on_job(job_id));
create policy "job chat write" on public.messages for insert with check (
  public.is_staff() and public.on_job(job_id) and
  ((worker_id = auth.uid() and sys = false) or (sys = true and public.is_owner())));

create policy "my chat reads" on public.chat_reads for all using (worker_id = auth.uid()) with check (worker_id = auth.uid());

create policy "staff see trips" on public.trips for select using (public.is_staff());
create policy "sign out a car" on public.trips for insert with check (public.is_staff() and worker_id = auth.uid());
create policy "return my car" on public.trips for update using (worker_id = auth.uid() or public.is_owner());

-- ---------- Photos ----------
insert into storage.buckets (id, name, public) values ('photos','photos', false) on conflict do nothing;
create policy "staff view photos" on storage.objects for select using (bucket_id = 'photos' and public.is_staff());
create policy "staff upload photos" on storage.objects for insert with check (bucket_id = 'photos' and public.is_staff());

-- ---------- Live updates ----------
alter publication supabase_realtime add table public.messages, public.notifications, public.jobs, public.job_lines, public.trips;

-- ---------- Starting fleet ----------
insert into public.cars (name, code, sort) values
  ('RR Cullinan','RR',1), ('Chrysler Limo S2','LM',2), ('Urus','UR',3), ('RR Ghost','GH',4), ('G Wagon','G',5);
