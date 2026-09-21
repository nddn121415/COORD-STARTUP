BEGIN;
-- Early testing account metadata only; source files remain on the persistent hub.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.coord_projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.coord_members(project_id uuid REFERENCES public.coord_projects ON DELETE CASCADE, user_id uuid REFERENCES auth.users ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(project_id,user_id));
CREATE TABLE public.coord_invites(hash text PRIMARY KEY, project_id uuid NOT NULL REFERENCES public.coord_projects ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE public.coord_device_sessions(hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE, name text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE public.coord_pairs(hash text PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, expires_at timestamptz NOT NULL, user_id uuid REFERENCES auth.users ON DELETE CASCADE);
CREATE TABLE public.coord_project_devices(project_id uuid REFERENCES public.coord_projects ON DELETE CASCADE, peer_id text CHECK(peer_id ~ '^[a-f0-9]{64}$'), user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE, session_hash text NOT NULL REFERENCES public.coord_device_sessions(hash) ON DELETE CASCADE, name text NOT NULL, PRIMARY KEY(project_id,peer_id));
CREATE TABLE public.coord_rate_limits(key text PRIMARY KEY, started_at timestamptz NOT NULL, requests integer NOT NULL);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['coord_projects','coord_members','coord_invites','coord_device_sessions','coord_pairs','coord_project_devices','coord_rate_limits'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
END $$;

CREATE FUNCTION public.coord_account_api(p_action text,p_user_id uuid DEFAULT NULL,p_device_token text DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, extensions AS $$
DECLARE
 a text := p_action; uid uuid := p_user_id; pid uuid; target uuid; role_name text;
 sess public.coord_device_sessions%ROWTYPE; pair public.coord_pairs%ROWTYPE;
 inv public.coord_invites%ROWTYPE; dev public.coord_project_devices%ROWTYPE;
 proj public.coord_projects%ROWTYPE; raw text; h text; label text; peer text; token text; v_code text;
 result jsonb; profile jsonb; n integer; rate_key text;
BEGIN
 -- A small early-access installation uses one transaction lock: quotas, redemption,
 -- revocation, and authorization have a single total order across serverless workers.
 PERFORM pg_advisory_xact_lock(208718,1);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>4096 THEN RETURN jsonb_build_object('error','Invalid request','status',400); END IF;
 a := CASE a WHEN 'projects_create' THEN 'project_create' WHEN 'project_detail' THEN 'project_get' WHEN 'members_remove' THEN 'member_remove' WHEN 'invite_create' THEN 'invitation_create' WHEN 'invite_accept' THEN 'invitation_accept' ELSE a END;
 DELETE FROM public.coord_rate_limits WHERE started_at < now()-interval '1 minute';
 INSERT INTO public.coord_rate_limits VALUES('global',now(),1) ON CONFLICT(key) DO UPDATE SET requests=coord_rate_limits.requests+1 RETURNING requests INTO n;
 IF n>600 THEN RETURN jsonb_build_object('error','Too many requests','status',429); END IF;
 IF a IN ('device_start','device_poll','device_approve') THEN
  rate_key:=CASE a WHEN 'device_start' THEN 'pair-start' WHEN 'device_poll' THEN 'poll:'||encode(extensions.digest(coalesce(p_payload->>'deviceCode',''),'sha256'),'hex') ELSE 'approve:'||coalesce(uid::text,'anonymous') END;
  INSERT INTO public.coord_rate_limits VALUES(rate_key,now(),1) ON CONFLICT(key) DO UPDATE SET requests=coord_rate_limits.requests+1 RETURNING requests INTO n;
  IF n>(CASE WHEN a='device_approve' THEN 10 ELSE 30 END) THEN RETURN jsonb_build_object('error','Too many requests','status',429); END IF;
 END IF;
 DELETE FROM public.coord_pairs WHERE expires_at<=now();
 DELETE FROM public.coord_invites WHERE expires_at<=now();
 DELETE FROM public.coord_device_sessions WHERE expires_at<=now();
 IF a='device_start' THEN
  label:=btrim(p_payload->>'name');
  IF label IS NULL OR length(label) NOT BETWEEN 1 AND 80 OR label ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('error','Invalid device name','status',400); END IF;
  IF (SELECT count(*) FROM public.coord_pairs)>=200 THEN RETURN jsonb_build_object('error','Pairing is busy','status',429); END IF;
  token:=encode(extensions.gen_random_bytes(32),'hex'); v_code:=upper(encode(extensions.gen_random_bytes(5),'hex'));
  INSERT INTO public.coord_pairs VALUES(encode(extensions.digest(token,'sha256'),'hex'),v_code,label,now()+interval '10 minutes',NULL);
  RETURN jsonb_build_object('deviceCode',token,'userCode',v_code,'expiresAt',floor(extract(epoch FROM now()+interval '10 minutes')*1000));
 END IF;
 IF a='device_poll' THEN
  raw:=p_payload->>'deviceCode';
  IF raw IS NULL OR raw !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','Invalid request','status',400); END IF;
  SELECT * INTO pair FROM public.coord_pairs WHERE hash=encode(extensions.digest(raw,'sha256'),'hex') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Pairing expired or already consumed','status',409); END IF;
  IF pair.user_id IS NULL THEN RETURN jsonb_build_object('status','pending'); END IF;
  IF (SELECT count(*) FROM public.coord_device_sessions WHERE user_id=pair.user_id)>=30 THEN RETURN jsonb_build_object('error','Session limit reached','status',409); END IF;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  INSERT INTO public.coord_device_sessions VALUES(encode(extensions.digest(token,'sha256'),'hex'),pair.user_id,pair.name,now()+interval '30 days');
  DELETE FROM public.coord_pairs WHERE hash=pair.hash;
  SELECT jsonb_build_object('id',id,'username',coalesce(email,id::text)) INTO profile FROM auth.users WHERE id=pair.user_id;
  RETURN jsonb_build_object('status','approved','token',token,'user',profile);
 END IF;
 IF uid IS NOT NULL AND p_device_token IS NOT NULL THEN RETURN jsonb_build_object('error','Invalid authentication','status',401); END IF;
 IF p_device_token IS NOT NULL THEN
  IF p_device_token !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','Sign in required','status',401); END IF;
  SELECT * INTO sess FROM public.coord_device_sessions WHERE hash=encode(extensions.digest(p_device_token,'sha256'),'hex') AND expires_at>now();
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Session expired','status',401); END IF;
  uid:=sess.user_id;
 END IF;
 SELECT jsonb_build_object('id',id,'username',coalesce(email,id::text)) INTO profile FROM auth.users WHERE id=uid;
 IF profile IS NULL THEN RETURN jsonb_build_object('error','Sign in required','status',401); END IF;
 rate_key:='user:'||uid::text;
 INSERT INTO public.coord_rate_limits VALUES(rate_key,now(),1) ON CONFLICT(key) DO UPDATE SET requests=coord_rate_limits.requests+1 RETURNING requests INTO n;
 IF n>120 THEN RETURN jsonb_build_object('error','Too many requests','status',429); END IF;
 IF a='logout' THEN DELETE FROM public.coord_device_sessions WHERE hash=sess.hash; RETURN jsonb_build_object('ok',true); END IF;
 IF a='workspace' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'role',m.role) ORDER BY p.created_at),'[]') INTO result FROM public.coord_projects p JOIN public.coord_members m ON m.project_id=p.id WHERE m.user_id=uid;
  RETURN jsonb_build_object('user',profile,'projects',result);
 END IF;
 IF a NOT IN ('connect','project_get') AND p_device_token IS NOT NULL THEN RETURN jsonb_build_object('error','Use the website for this action','status',403); END IF;
 IF a='device_approve' THEN
  v_code:=upper(p_payload->>'userCode');
  IF v_code IS NULL OR v_code !~ '^[A-F0-9]{10}$' THEN RETURN jsonb_build_object('error','Invalid request','status',400); END IF;
  UPDATE public.coord_pairs SET user_id=uid WHERE coord_pairs.code=v_code AND user_id IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Pairing code unavailable','status',409); END IF;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF a='project_create' THEN
  label:=btrim(p_payload->>'name');
  IF label IS NULL OR length(label) NOT BETWEEN 1 AND 100 OR label ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('error','Invalid project name','status',400); END IF;
  IF (SELECT count(*) FROM public.coord_projects WHERE owner_id=uid)>=5 OR (SELECT count(*) FROM public.coord_projects)>=20 THEN RETURN jsonb_build_object('error','Project limit reached','status',409); END IF;
  INSERT INTO public.coord_projects(name,owner_id) VALUES(label,uid) RETURNING * INTO proj;
  INSERT INTO public.coord_members VALUES(proj.id,uid,'owner');
  RETURN jsonb_build_object('id',proj.id,'name',proj.name,'role','owner','createdAt',floor(extract(epoch FROM proj.created_at)*1000));
 END IF;
 IF a='invitation_accept' THEN
  raw:=p_payload->>'key';
  IF raw IS NULL OR raw !~ '^coord-member\.[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','Invalid invitation','status',400); END IF;
  SELECT * INTO inv FROM public.coord_invites WHERE hash=encode(extensions.digest(raw,'sha256'),'hex') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Invitation expired or used','status',409); END IF;
  IF (SELECT count(*) FROM public.coord_members WHERE project_id=inv.project_id)>=30 THEN RETURN jsonb_build_object('error','Member limit reached','status',409); END IF;
  INSERT INTO public.coord_members VALUES(inv.project_id,uid,'member') ON CONFLICT DO NOTHING;
  DELETE FROM public.coord_invites WHERE hash=inv.hash;
  RETURN jsonb_build_object('ok',true,'projectId',inv.project_id);
 END IF;
 IF coalesce(p_payload->>'projectId','') !~ '^[a-fA-F0-9-]{36}$' THEN RETURN jsonb_build_object('error','Invalid project','status',400); END IF;
 BEGIN pid:=(p_payload->>'projectId')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('error','Invalid project','status',400); END;
 SELECT role INTO role_name FROM public.coord_members WHERE project_id=pid AND user_id=uid;
 IF role_name IS NULL THEN RETURN jsonb_build_object('error','Project access denied','status',403); END IF;
 SELECT * INTO proj FROM public.coord_projects WHERE id=pid;
 IF a='project_get' THEN
  RETURN jsonb_build_object('id',pid,'name',proj.name,'role',role_name,'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'username',coalesce(u.email,u.id::text),'role',m.role)),'[]') FROM public.coord_members m JOIN auth.users u ON u.id=m.user_id WHERE m.project_id=pid),'devices',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.peer_id,'userId',d.user_id,'name',d.name)),'[]') FROM public.coord_project_devices d WHERE d.project_id=pid));
 END IF;
 IF a='connect' THEN
  IF sess.hash IS NULL THEN RETURN jsonb_build_object('error','Connect from the paired desktop app','status',403); END IF;
  peer:=p_payload->>'peerId';
  IF peer IS NULL OR peer !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','Invalid device','status',400); END IF;
  SELECT * INTO dev FROM public.coord_project_devices WHERE project_id=pid AND peer_id=peer;
  IF FOUND AND dev.user_id<>uid THEN RETURN jsonb_build_object('error','Device belongs to another member','status',409); END IF;
  IF dev.peer_id IS NULL AND (SELECT count(*) FROM public.coord_project_devices WHERE user_id=uid)>=20 THEN RETURN jsonb_build_object('error','Device limit reached','status',409); END IF;
  INSERT INTO public.coord_project_devices VALUES(pid,peer,uid,sess.hash,sess.name) ON CONFLICT(project_id,peer_id) DO UPDATE SET session_hash=excluded.session_hash,name=excluded.name;
  RETURN jsonb_build_object('ok',true,'project',jsonb_build_object('id',pid,'name',proj.name));
 END IF;
 IF a='device_revoke' THEN
  peer:=p_payload->>'peerId';
  SELECT * INTO dev FROM public.coord_project_devices WHERE project_id=pid AND peer_id=peer;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Device not found','status',404); END IF;
  IF role_name<>'owner' AND dev.user_id<>uid THEN RETURN jsonb_build_object('error','Device access denied','status',403); END IF;
  DELETE FROM public.coord_device_sessions WHERE hash=dev.session_hash;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF role_name<>'owner' THEN RETURN jsonb_build_object('error','Project access denied','status',403); END IF;
 IF a='invitation_create' THEN
  IF (SELECT count(*) FROM public.coord_invites WHERE project_id=pid)>=30 THEN RETURN jsonb_build_object('error','Invitation limit reached','status',409); END IF;
  raw:='coord-member.'||encode(extensions.gen_random_bytes(32),'hex');
  INSERT INTO public.coord_invites VALUES(encode(extensions.digest(raw,'sha256'),'hex'),pid,now()+interval '1 day');
  RETURN jsonb_build_object('key',raw);
 END IF;
 IF a='member_remove' THEN
  BEGIN target:=(p_payload->>'userId')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('error','Invalid member','status',400); END;
  IF target IS NULL OR target=uid THEN RETURN jsonb_build_object('error','Owner cannot remove themselves','status',409); END IF;
  DELETE FROM public.coord_project_devices WHERE project_id=pid AND user_id=target;
  DELETE FROM public.coord_members WHERE project_id=pid AND user_id=target;
  DELETE FROM public.coord_invites WHERE project_id=pid;
  RETURN jsonb_build_object('ok',true);
 END IF;
 RETURN jsonb_build_object('error','Not found','status',404);
END $$;
REVOKE ALL ON FUNCTION public.coord_account_api(text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.coord_account_api(text,uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.coord_peer_authorized(p_project_id uuid,p_peer_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.coord_project_devices d JOIN public.coord_device_sessions s ON s.hash=d.session_hash JOIN public.coord_members m ON m.project_id=d.project_id AND m.user_id=d.user_id WHERE d.project_id=p_project_id AND d.peer_id=p_peer_id AND s.user_id=d.user_id AND s.expires_at>now());
$$;
CREATE FUNCTION public.coord_cloud_project(p_project_id uuid,p_peer_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'name',p.name,'allowed',true) FROM public.coord_projects p WHERE p.id=p_project_id AND public.coord_peer_authorized(p_project_id,p_peer_id);
$$;
REVOKE ALL ON FUNCTION public.coord_peer_authorized(uuid,text),public.coord_cloud_project(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.coord_peer_authorized(uuid,text),public.coord_cloud_project(uuid,text) TO service_role;

COMMIT;
