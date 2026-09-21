BEGIN;
-- Durable HTTPS collaboration. Browser accounts and native device bindings remain
-- in 001; only the server service role may invoke this narrowly scoped authority.
CREATE TABLE public.coord_sync_agents (
 project_id uuid NOT NULL, peer_id text NOT NULL, session_id text NOT NULL,
 session_hash text NOT NULL REFERENCES public.coord_device_sessions(hash) ON DELETE CASCADE,
 agent text NOT NULL, summary text NOT NULL DEFAULT '', seen_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,peer_id,session_id),
 FOREIGN KEY(project_id,peer_id) REFERENCES public.coord_project_devices(project_id,peer_id) ON DELETE CASCADE
);
CREATE TABLE public.coord_sync_files (
 project_id uuid NOT NULL REFERENCES public.coord_projects(id) ON DELETE CASCADE,
 path_key text NOT NULL, path text NOT NULL, hash text NOT NULL, content bytea NOT NULL,
 PRIMARY KEY(project_id,path_key), CHECK(octet_length(content)<=1048576)
);
CREATE TABLE public.coord_sync_locks (
 project_id uuid NOT NULL, path_key text NOT NULL, path text NOT NULL,
 peer_id text NOT NULL, session_id text NOT NULL, session_hash text NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(project_id,path_key),
 FOREIGN KEY(project_id,peer_id,session_id) REFERENCES public.coord_sync_agents ON DELETE CASCADE
);
CREATE TABLE public.coord_sync_batches (
 id uuid PRIMARY KEY, project_id uuid NOT NULL, peer_id text NOT NULL,
 session_id text NOT NULL, session_hash text NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(project_id,peer_id,session_id) REFERENCES public.coord_sync_agents ON DELETE CASCADE
);
CREATE TABLE public.coord_sync_staging (
 batch_id uuid NOT NULL REFERENCES public.coord_sync_batches ON DELETE CASCADE,
 path_key text NOT NULL, path text NOT NULL, base_hash text, hash text, content bytea,
 PRIMARY KEY(batch_id,path_key), CHECK(octet_length(content)<=1048576)
);
CREATE INDEX coord_sync_batches_project ON public.coord_sync_batches(project_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['coord_sync_agents','coord_sync_files','coord_sync_locks','coord_sync_batches','coord_sync_staging'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
END $$;

-- Use locale-independent Unicode case conversion even when PostgreSQL was
-- initialized with locale C. This matches native NFC/toLowerCase path keys.
CREATE COLLATION public.coord_sync_unicode(provider=icu,locale='und',deterministic=true);
CREATE FUNCTION public.coord_sync_path_key(p_path text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT lower(normalize(p_path,NFC) COLLATE public.coord_sync_unicode);
$$;
REVOKE ALL ON FUNCTION public.coord_sync_path_key(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.coord_sync_safe_path(p_path text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE segment text;
BEGIN
 IF p_path IS NULL OR length(p_path) NOT BETWEEN 1 AND 1024 OR octet_length(p_path)>2048 OR p_path ~ '[[:cntrl:]]' OR strpos(p_path,chr(92))>0 OR p_path ~* '%2e|%2f|%5c' OR strpos(p_path,':')>0 THEN RETURN false; END IF;
 FOREACH segment IN ARRAY string_to_array(public.coord_sync_path_key(p_path),'/') LOOP
  IF segment IN ('','.','..','.git','.coord','.codex','.claude','.mcp.json','.ssh','.aws','.gnupg','.npmrc','.netrc','.pypirc','.env','node_modules','dist','build','builds','out','target','coverage','.next','.nuxt','.output','.turbo','.cache','.venv','venv','__pycache__','.ds_store')
   OR octet_length(segment)>255 OR segment LIKE '.env.%' OR segment LIKE '.coord-%'
   OR segment ~ '\.(pem|key|p12|pfx|keystore)$|^id_(rsa|ed25519|ecdsa|dsa)(\.|$)|^(credentials?|secrets?)|^(auth[-_ ]?tokens?|access[-_ ]?tokens?)(\.|$)'
   OR right(segment,1) IN (' ','.') OR segment ~ '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)'
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.coord_sync_safe_path(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.coord_sync_api(p_project_id uuid,p_peer_id text,p_session_id text,p_device_token text,p_operation text,p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $$
DECLARE
 token_hash text; uid uuid; actor text; now_at timestamptz; until_at timestamptz;
 op text := p_operation; path_name text; path_key_name text; base text; encoded text;
 bytes bytea; content_hash text; batch_id_value uuid; batch public.coord_sync_batches%ROWTYPE;
 previous public.coord_sync_staging%ROWTYPE; current_file public.coord_sync_files%ROWTYPE;
 conflict public.coord_sync_locks%ROWTYPE; item record; value jsonb;
 paths text[]; keys text[]; label text; summary_text text; agent_name text;
 n bigint; old_bytes bigint; total_bytes bigint; result jsonb; files_result jsonb;
BEGIN
 -- Shared with account changes: revoke and publish cannot pass each other between
 -- authorization and commit, even when separate Vercel instances serve requests.
 PERFORM pg_advisory_xact_lock(208718,1);
 now_at:=clock_timestamp(); until_at:=now_at+interval '120 seconds';
 IF p_project_id IS NULL OR p_peer_id IS NULL OR p_peer_id !~ '^[a-f0-9]{64}$' OR p_session_id IS NULL OR p_session_id !~ '^[A-Za-z0-9_-]{1,100}$'
  OR p_device_token IS NULL OR p_device_token !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','Paired device required','status',401); END IF;
 IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>1402000 OR op IS NULL OR op NOT IN ('manifest','read','heartbeat','reserve','release','stage','commit','abort') THEN RETURN jsonb_build_object('error','Invalid sync request','status',400); END IF;
 token_hash:=encode(extensions.digest(p_device_token,'sha256'),'hex');
 SELECT s.user_id INTO uid FROM public.coord_device_sessions s WHERE s.hash=token_hash AND s.expires_at>now_at;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','Device session expired','status',401); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.coord_project_devices d JOIN public.coord_members m ON m.project_id=d.project_id AND m.user_id=d.user_id WHERE d.project_id=p_project_id AND d.peer_id=p_peer_id AND d.user_id=uid AND d.session_hash=token_hash) THEN RETURN jsonb_build_object('error','Project access denied','status',403); END IF;
 actor:=p_peer_id||':'||p_session_id;
 -- Expiry/rebinding cleanup is bounded by the early-access installation quotas.
 DELETE FROM public.coord_sync_agents a WHERE a.seen_at<=now_at-interval '120 seconds' OR NOT EXISTS(
  SELECT 1 FROM public.coord_project_devices d JOIN public.coord_device_sessions s ON s.hash=d.session_hash JOIN public.coord_members m ON m.project_id=d.project_id AND m.user_id=d.user_id
  WHERE d.project_id=a.project_id AND d.peer_id=a.peer_id AND d.session_hash=a.session_hash AND s.user_id=d.user_id AND s.expires_at>now_at);
 DELETE FROM public.coord_sync_locks WHERE expires_at<=now_at;
 DELETE FROM public.coord_sync_batches WHERE expires_at<=now_at;
 DELETE FROM public.coord_rate_limits WHERE started_at<now_at-interval '1 minute';
 INSERT INTO public.coord_rate_limits VALUES('sync:global',now_at,1) ON CONFLICT(key) DO UPDATE SET requests=coord_rate_limits.requests+1 RETURNING requests INTO n;
 IF n>6000 THEN RETURN jsonb_build_object('error','Sync is busy; retry shortly','status',429); END IF;
 INSERT INTO public.coord_rate_limits VALUES('sync:device:'||token_hash,now_at,1) ON CONFLICT(key) DO UPDATE SET requests=coord_rate_limits.requests+1 RETURNING requests INTO n;
 IF n>1800 THEN RETURN jsonb_build_object('error','Too many sync requests; retry shortly','status',429); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.coord_sync_agents WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id) AND (SELECT count(*) FROM public.coord_sync_agents WHERE project_id=p_project_id)>=100 THEN RETURN jsonb_build_object('error','Project agent limit reached','status',409); END IF;
 INSERT INTO public.coord_sync_agents VALUES(p_project_id,p_peer_id,p_session_id,token_hash,'COORD','',now_at)
 ON CONFLICT(project_id,peer_id,session_id) DO UPDATE SET seen_at=excluded.seen_at;
 IF op='heartbeat' THEN
  agent_name:=p_input->>'agent'; label:=p_input->>'label';
  IF jsonb_typeof(p_input->'agent') IS DISTINCT FROM 'string' OR length(agent_name) NOT BETWEEN 1 AND 80 OR agent_name ~ '[[:cntrl:]]'
   OR (p_input ? 'label' AND (jsonb_typeof(p_input->'label') IS DISTINCT FROM 'string' OR length(label)>200 OR label ~ '[[:cntrl:]]')) THEN RETURN jsonb_build_object('error','Invalid agent label','status',400); END IF;
  UPDATE public.coord_sync_agents SET agent=agent_name WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id;
  UPDATE public.coord_sync_locks SET expires_at=until_at WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id AND session_hash=token_hash;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF op='manifest' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'hash',hash) ORDER BY path),'[]') INTO files_result FROM public.coord_sync_files WHERE project_id=p_project_id;
  SELECT jsonb_build_object(
   'agents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.peer_id||':'||a.session_id,'agent',a.agent,'summary',a.summary,'paths',(SELECT coalesce(jsonb_agg(l.path ORDER BY l.path),'[]') FROM public.coord_sync_locks l WHERE l.project_id=a.project_id AND l.peer_id=a.peer_id AND l.session_id=a.session_id),'seen',floor(extract(epoch FROM a.seen_at)*1000)) ORDER BY a.peer_id,a.session_id),'[]') FROM public.coord_sync_agents a WHERE a.project_id=p_project_id),
   'locks',(SELECT coalesce(jsonb_agg(jsonb_build_object('path',l.path,'owner',l.peer_id||':'||l.session_id,'expiresAt',floor(extract(epoch FROM l.expires_at)*1000)) ORDER BY l.path),'[]') FROM public.coord_sync_locks l WHERE l.project_id=p_project_id),
   'peers',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.peer_id,'name',d.name,'online',EXISTS(SELECT 1 FROM public.coord_sync_agents a WHERE a.project_id=d.project_id AND a.peer_id=d.peer_id)) ORDER BY d.peer_id),'[]') FROM public.coord_project_devices d JOIN public.coord_device_sessions s ON s.hash=d.session_hash JOIN public.coord_members m ON m.project_id=d.project_id AND m.user_id=d.user_id WHERE d.project_id=p_project_id AND s.expires_at>now_at AND s.user_id=d.user_id)
  ) INTO result;
  RETURN jsonb_build_object('files',files_result,'context',result);
 END IF;
 IF op IN ('read','stage') THEN
  path_name:=p_input->>'path';
  IF jsonb_typeof(p_input->'path') IS DISTINCT FROM 'string' OR NOT public.coord_sync_safe_path(path_name) THEN RETURN jsonb_build_object('error','Protected or invalid file path','status',400); END IF;
  path_key_name:=public.coord_sync_path_key(path_name);
 END IF;
 IF op='read' THEN
  IF p_input ? 'hash' AND (jsonb_typeof(p_input->'hash') IS DISTINCT FROM 'string' OR (p_input->>'hash') !~ '^[a-f0-9]{64}$') THEN RETURN jsonb_build_object('error','Invalid file hash','status',400); END IF;
  SELECT * INTO current_file FROM public.coord_sync_files WHERE project_id=p_project_id AND path_key=path_key_name;
  IF NOT FOUND OR current_file.path<>path_name THEN RETURN jsonb_build_object('error','File not found','status',404); END IF;
  IF p_input ? 'hash' AND p_input->>'hash'<>current_file.hash THEN RETURN jsonb_build_object('error','File changed; refresh the project','status',409,'path',path_name); END IF;
  RETURN jsonb_build_object('path',current_file.path,'hash',current_file.hash,'contentBase64',replace(encode(current_file.content,'base64'),chr(10),''));
 END IF;
 IF op IN ('reserve','release') THEN
  IF op='release' AND NOT (p_input ? 'paths') THEN
   DELETE FROM public.coord_sync_locks WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id AND session_hash=token_hash;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF jsonb_typeof(p_input->'paths') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'paths') NOT BETWEEN 1 AND 50 THEN RETURN jsonb_build_object('error','Choose between 1 and 50 paths','status',400); END IF;
  paths:=ARRAY[]::text[]; keys:=ARRAY[]::text[];
  FOR value IN SELECT jsonb_array_elements(p_input->'paths') LOOP
   path_name:=value#>>'{}'; path_key_name:=public.coord_sync_path_key(path_name);
   IF jsonb_typeof(value)<>'string' OR NOT public.coord_sync_safe_path(path_name) THEN RETURN jsonb_build_object('error','Protected or invalid file path','status',400); END IF;
   IF EXISTS(SELECT 1 FROM unnest(keys) k WHERE k=path_key_name OR starts_with(k,path_key_name||'/') OR starts_with(path_key_name,k||'/')) THEN RETURN jsonb_build_object('error','Duplicate or overlapping paths','status',400); END IF;
   paths:=array_append(paths,path_name); keys:=array_append(keys,path_key_name);
  END LOOP;
  IF op='release' THEN
   DELETE FROM public.coord_sync_locks WHERE project_id=p_project_id AND path_key=ANY(keys) AND peer_id=p_peer_id AND session_id=p_session_id AND session_hash=token_hash;
   RETURN jsonb_build_object('ok',true);
  END IF;
  summary_text:=coalesce(p_input->>'summary','');
  IF (p_input ? 'summary' AND jsonb_typeof(p_input->'summary') IS DISTINCT FROM 'string') OR length(summary_text)>500 OR summary_text ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('error','Invalid task summary','status',400); END IF;
  SELECT l.* INTO conflict FROM public.coord_sync_locks l WHERE l.project_id=p_project_id AND (l.peer_id<>p_peer_id OR l.session_id<>p_session_id OR l.session_hash<>token_hash) AND EXISTS(SELECT 1 FROM unnest(keys) k WHERE l.path_key=k OR starts_with(l.path_key,k||'/') OR starts_with(k,l.path_key||'/')) LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('error','Another agent reserved this path','status',409,'path',conflict.path,'owner',conflict.peer_id||':'||conflict.session_id); END IF;
  IF (SELECT count(*) FROM public.coord_sync_locks WHERE project_id=p_project_id AND NOT(path_key=ANY(keys)))+cardinality(keys)>500 THEN RETURN jsonb_build_object('error','Project reservation limit reached','status',409); END IF;
  FOR n IN 1..cardinality(paths) LOOP
   INSERT INTO public.coord_sync_locks VALUES(p_project_id,keys[n],paths[n],p_peer_id,p_session_id,token_hash,until_at)
   ON CONFLICT(project_id,path_key) DO UPDATE SET expires_at=excluded.expires_at;
  END LOOP;
  UPDATE public.coord_sync_agents SET summary=summary_text WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF jsonb_typeof(p_input->'batchId') IS DISTINCT FROM 'string' OR (p_input->>'batchId') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN RETURN jsonb_build_object('error','Invalid publication batch','status',400); END IF;
 batch_id_value:=(p_input->>'batchId')::uuid;
 SELECT * INTO batch FROM public.coord_sync_batches WHERE id=batch_id_value;
 IF FOUND AND (batch.project_id<>p_project_id OR batch.peer_id<>p_peer_id OR batch.session_id<>p_session_id OR batch.session_hash<>token_hash) THEN RETURN jsonb_build_object('error','Publication belongs to another agent','status',403); END IF;
 IF op='abort' THEN DELETE FROM public.coord_sync_batches WHERE id=batch_id_value; RETURN jsonb_build_object('ok',true); END IF;
 IF op='stage' THEN
  IF NOT (p_input ? 'baseHash') OR jsonb_typeof(p_input->'baseHash') NOT IN ('string','null') OR (jsonb_typeof(p_input->'baseHash')='string' AND (p_input->>'baseHash') !~ '^[a-f0-9]{64}$') OR NOT(p_input ? 'contentBase64') OR jsonb_typeof(p_input->'contentBase64') NOT IN ('string','null') THEN RETURN jsonb_build_object('error','Invalid file change','status',400); END IF;
  base:=p_input->>'baseHash'; encoded:=p_input->>'contentBase64';
  IF encoded IS NOT NULL THEN
   IF length(encoded)>1398104 OR encoded !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN RETURN jsonb_build_object('error','Invalid or oversized file encoding','status',400); END IF;
   BEGIN bytes:=decode(encoded,'base64'); EXCEPTION WHEN invalid_parameter_value THEN RETURN jsonb_build_object('error','Invalid file encoding','status',400); END;
   IF octet_length(bytes)>1048576 OR replace(encode(bytes,'base64'),chr(10),'')<>encoded THEN RETURN jsonb_build_object('error','Invalid or oversized file','status',400); END IF;
   -- Native workspaces are text-only. UTF-8 conversion also rejects embedded NUL.
   BEGIN PERFORM convert_from(bytes,'UTF8'); EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN RETURN jsonb_build_object('error','Only UTF-8 text files are supported','status',400); END;
   content_hash:=encode(extensions.digest(bytes,'sha256'),'hex');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.coord_sync_locks WHERE project_id=p_project_id AND path_key=path_key_name AND peer_id=p_peer_id AND session_id=p_session_id AND session_hash=token_hash AND expires_at>now_at) THEN RETURN jsonb_build_object('error','Reserve this file before publishing','status',409,'path',path_name); END IF;
  SELECT * INTO previous FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND path_key=path_key_name;
  IF FOUND AND previous.path<>path_name THEN RETURN jsonb_build_object('error','Case or Unicode path collision','status',409,'path',path_name); END IF;
  IF EXISTS(SELECT 1 FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND path_key<>path_key_name AND (starts_with(path_key,path_key_name||'/') OR starts_with(path_key_name,path_key||'/'))) THEN RETURN jsonb_build_object('error','Overlapping publication paths','status',409,'path',path_name); END IF;
  IF batch.id IS NULL AND ((SELECT count(*) FROM public.coord_sync_batches WHERE project_id=p_project_id)>=100 OR (SELECT count(*) FROM public.coord_sync_batches)>=200 OR (SELECT count(*) FROM public.coord_sync_batches WHERE project_id=p_project_id AND peer_id=p_peer_id AND session_id=p_session_id)>=4) THEN RETURN jsonb_build_object('error','Too many pending publications','status',409); END IF;
  old_bytes:=coalesce(octet_length(previous.content),0);
  IF (SELECT count(*) FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND path_key<>path_key_name)>=50 OR (SELECT coalesce(sum(octet_length(content)),0) FROM public.coord_sync_staging WHERE batch_id=batch_id_value)-old_bytes+coalesce(octet_length(bytes),0)>16777216 THEN RETURN jsonb_build_object('error','Publication exceeds 50 files or 16 MiB','status',409); END IF;
  IF (SELECT coalesce(sum(octet_length(s.content)),0) FROM public.coord_sync_staging s JOIN public.coord_sync_batches b ON b.id=s.batch_id WHERE b.project_id=p_project_id)-old_bytes+coalesce(octet_length(bytes),0)>33554432 THEN RETURN jsonb_build_object('error','Pending project changes exceed 32 MiB','status',409); END IF;
  IF (SELECT coalesce(sum(octet_length(content)),0) FROM public.coord_sync_files)+(SELECT coalesce(sum(octet_length(content)),0) FROM public.coord_sync_staging)-old_bytes+coalesce(octet_length(bytes),0)>268435456 THEN RETURN jsonb_build_object('error','Beta storage capacity reached','status',409); END IF;
  IF batch.id IS NULL THEN INSERT INTO public.coord_sync_batches VALUES(batch_id_value,p_project_id,p_peer_id,p_session_id,token_hash,now_at+interval '10 minutes'); END IF;
  INSERT INTO public.coord_sync_staging VALUES(batch_id_value,path_key_name,path_name,base,content_hash,bytes)
  ON CONFLICT(batch_id,path_key) DO UPDATE SET base_hash=excluded.base_hash,hash=excluded.hash,content=excluded.content;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF batch.id IS NULL THEN RETURN jsonb_build_object('error','Publication expired or already consumed','status',409); END IF;
 -- Validate the entire batch before any canonical mutation. A conflict must never
 -- partially publish a multi-file change or discard the still-reviewable batch.
 FOR item IN SELECT * FROM public.coord_sync_staging WHERE batch_id=batch_id_value ORDER BY path_key LOOP
  IF NOT EXISTS(SELECT 1 FROM public.coord_sync_locks WHERE project_id=p_project_id AND path_key=item.path_key AND peer_id=p_peer_id AND session_id=p_session_id AND session_hash=token_hash AND expires_at>now_at) THEN RETURN jsonb_build_object('error','File reservation expired','status',409,'path',item.path); END IF;
  SELECT * INTO current_file FROM public.coord_sync_files WHERE project_id=p_project_id AND path_key=item.path_key;
  IF FOUND AND current_file.path<>item.path THEN RETURN jsonb_build_object('error','Case or Unicode path collision','status',409,'path',item.path); END IF;
  IF current_file.hash IS DISTINCT FROM item.base_hash THEN RETURN jsonb_build_object('error','File changed; refresh before publishing','status',409,'path',item.path); END IF;
 END LOOP;
 WITH final_files AS (
  SELECT f.path_key,octet_length(f.content) size FROM public.coord_sync_files f WHERE f.project_id=p_project_id AND NOT EXISTS(SELECT 1 FROM public.coord_sync_staging s WHERE s.batch_id=batch_id_value AND s.path_key=f.path_key)
  UNION ALL SELECT path_key,octet_length(content) FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND content IS NOT NULL
 ) SELECT count(*),coalesce(sum(size),0) INTO n,total_bytes FROM final_files;
 IF n>500 OR total_bytes>16777216 THEN RETURN jsonb_build_object('error','Project exceeds 500 files or 16 MiB','status',409); END IF;
 IF EXISTS(
  WITH final_files AS (
   SELECT f.path_key FROM public.coord_sync_files f WHERE f.project_id=p_project_id AND NOT EXISTS(SELECT 1 FROM public.coord_sync_staging s WHERE s.batch_id=batch_id_value AND s.path_key=f.path_key)
   UNION ALL SELECT path_key FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND content IS NOT NULL
  ) SELECT 1 FROM final_files a JOIN final_files b ON a.path_key<>b.path_key AND starts_with(a.path_key,b.path_key||'/')
 ) THEN RETURN jsonb_build_object('error','File path overlaps an existing file','status',409); END IF;
 -- Replacing staged bytes with canonical bytes cannot increase the combined
 -- storage cap, checked at stage time while holding this same global lock.
 SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'hash',hash) ORDER BY path),'[]') INTO files_result FROM public.coord_sync_staging WHERE batch_id=batch_id_value;
 DELETE FROM public.coord_sync_files f USING public.coord_sync_staging s WHERE s.batch_id=batch_id_value AND f.project_id=p_project_id AND f.path_key=s.path_key;
 INSERT INTO public.coord_sync_files SELECT p_project_id,path_key,path,hash,content FROM public.coord_sync_staging WHERE batch_id=batch_id_value AND content IS NOT NULL;
 DELETE FROM public.coord_sync_batches WHERE id=batch_id_value;
 RETURN jsonb_build_object('ok',true,'files',files_result);
END $$;
REVOKE ALL ON FUNCTION public.coord_sync_api(uuid,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.coord_sync_api(uuid,text,text,text,text,jsonb) TO service_role;
COMMIT;
