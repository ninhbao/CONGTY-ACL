-- Shared warehouse state is private. All mutations pass through the Edge Function.
create table if not exists public.acl_workspaces (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 revision bigint not null default 0,
 state jsonb not null default '{"schema":1,"products":[],"movements":[],"customers":[],"suppliers":[],"units":["Chai","Gói","Xô","Kg","Thùng","Bao"],"conversions":[],"shipments":[],"reports":[],"next_id":1}'::jsonb,
 updated_at timestamptz not null default now(),
 check(jsonb_typeof(state)='object')
);
create table if not exists public.acl_members (
 workspace_id uuid references public.acl_workspaces on delete cascade,
 user_id uuid references auth.users on delete cascade,
 role text not null check(role in ('owner','editor','viewer')),
 primary key(workspace_id,user_id)
);
create table if not exists public.acl_events (
 id bigint generated always as identity primary key,
 workspace_id uuid not null references public.acl_workspaces on delete cascade,
 user_id uuid not null,
 request_id uuid not null,
 request_hash text not null,
 action text not null,
 before_state jsonb not null,
 result jsonb not null,
 revision bigint not null,
 created_at timestamptz not null default now(),
 unique(workspace_id,request_id)
);
alter table public.acl_workspaces enable row level security;
alter table public.acl_members enable row level security;
alter table public.acl_events enable row level security;
revoke all on public.acl_workspaces,public.acl_members,public.acl_events from anon,authenticated;
grant select on public.acl_members,public.acl_workspaces to authenticated;
grant all on public.acl_workspaces,public.acl_members,public.acl_events to service_role;
grant usage,select on sequence public.acl_events_id_seq to service_role;
drop policy if exists acl_own_membership on public.acl_members;
create policy acl_own_membership on public.acl_members for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists acl_member_read on public.acl_workspaces;
create policy acl_member_read on public.acl_workspaces for select to authenticated using(exists(select 1 from public.acl_members m where m.workspace_id=id and m.user_id=(select auth.uid())));

create or replace function public.acl_commit(
 p_workspace uuid,p_user uuid,p_expected bigint,p_state jsonb,p_action text,
 p_request uuid,p_hash text,p_result jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare w public.acl_workspaces; e public.acl_events;
begin
 if not exists(select 1 from public.acl_members where workspace_id=p_workspace and user_id=p_user and role in ('owner','editor')) then
  raise exception 'Không có quyền ghi dữ liệu.' using errcode='42501';
 end if;
 select * into w from public.acl_workspaces where id=p_workspace for update;
 if not found then raise exception 'Không tìm thấy kho.'; end if;
 select * into e from public.acl_events where workspace_id=p_workspace and request_id=p_request;
 if found then
  if e.request_hash<>p_hash or e.user_id<>p_user then raise exception 'Mã yêu cầu đã được sử dụng.'; end if;
  return jsonb_build_object('result',e.result,'revision',e.revision);
 end if;
 if w.revision<>p_expected then raise exception 'Kho đã thay đổi ở thiết bị khác. Tải lại dữ liệu.' using errcode='40001'; end if;
 if jsonb_typeof(p_state)<>'object' or length(p_state::text)>12000000 or jsonb_typeof(p_state->'products')<>'array' or jsonb_typeof(p_state->'movements')<>'array' then raise exception 'Dữ liệu kho không hợp lệ.'; end if;
 update public.acl_workspaces set state=p_state,revision=w.revision+1,updated_at=now() where id=p_workspace;
 insert into public.acl_events(workspace_id,user_id,request_id,request_hash,action,before_state,result,revision)
 values(p_workspace,p_user,p_request,p_hash,p_action,w.state,p_result,w.revision+1);
 return jsonb_build_object('result',p_result,'revision',w.revision+1);
end $$;
revoke all on function public.acl_commit(uuid,uuid,bigint,jsonb,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.acl_commit(uuid,uuid,bigint,jsonb,text,uuid,text,jsonb) to service_role;

insert into public.acl_workspaces(id,name) values('a6b1a140-6582-4e25-a455-202611200001','CONGTY-ACL') on conflict(id) do nothing;
-- After the owner signs in, add their auth.users ID to acl_members as owner.
-- Never grant anon access or place a service_role/secret key in the website.
