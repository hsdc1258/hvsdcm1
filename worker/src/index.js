const enc = new TextEncoder();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8',...extra}});
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const hex = bytes => [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
const now = () => Date.now();
const normalize = s => String(s||'').normalize('NFKC').toLowerCase().replace(/[\s.,/#!$%^&*;:{}=\-_~()\[\]"'“”‘’?<>·]+/g,'').trim();
async function sha(s){return hex(await crypto.subtle.digest('SHA-256',enc.encode(s)))}
async function passwordHash(password,salt){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);return b64(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:180000},key,256))}
function token(){const a=new Uint8Array(32);crypto.getRandomValues(a);return b64(a).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
async function body(req){try{return await req.json()}catch{return {}}}
function cors(env,origin){return {'access-control-allow-origin':origin===env.ALLOWED_ORIGIN?origin:env.ALLOWED_ORIGIN,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','vary':'origin'}}
async function auth(req,env,role='user'){
  const raw=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,''); if(!raw)return null;
  const row=await env.DB.prepare('SELECT s.*,u.username,u.disabled FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?').bind(await sha(raw),now()).first();
  if(!row||row.disabled|| (role==='admin'&&row.role!=='admin'))return null;
  await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').bind(now(),row.token_hash).run(); return row;
}
async function log(env,user,event,app=null,detail=null){await env.DB.prepare('INSERT INTO activity(user_id,event,app,created_at,detail) VALUES(?,?,?,?,?)').bind(user||null,event,app,now(),detail).run()}
async function issue(env,userId,role,req){const raw=token(), t=now();await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,role,created_at,expires_at,last_seen_at,ip_hash,user_agent) VALUES(?,?,?,?,?,?,?,?)').bind(await sha(raw),userId||null,role,t,t+30*864e5,t,await sha(req.headers.get('cf-connecting-ip')||'local'),(req.headers.get('user-agent')||'').slice(0,240)).run();return raw}
async function route(req,env){
  const url=new URL(req.url), p=url.pathname, method=req.method;
  if(method==='POST'&&p==='/api/login'){const x=await body(req),u=await env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').bind(String(x.username||'').trim()).first();if(!u||u.disabled||await passwordHash(String(x.password||''),u.password_salt)!==u.password_hash)return json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'},401);const raw=await issue(env,u.id,'user',req);await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(),u.id).run();await log(env,u.id,'login');return json({token:raw,user:{id:u.id,username:u.username}})}
  if(method==='POST'&&p==='/api/admin/login'){const x=await body(req);if(!env.ADMIN_PASSWORD||String(x.password||'')!==env.ADMIN_PASSWORD)return json({error:'비밀번호가 올바르지 않습니다.'},401);return json({token:await issue(env,null,'admin',req)})}
  if(method==='GET'&&p==='/api/me'){const a=await auth(req,env);return a?json({user:{id:a.user_id,username:a.username}}):json({error:'로그인이 필요합니다.'},401)}
  if(method==='POST'&&p==='/api/logout'){const raw=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(raw)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(raw)).run();return json({ok:true})}
  const pm=p.match(/^\/api\/progress\/(wordmaster|smstudy)$/);
  if(pm){const a=await auth(req,env);if(!a)return json({error:'로그인이 필요합니다.'},401);const app=pm[1];if(method==='GET'){const r=await env.DB.prepare('SELECT data,updated_at FROM progress WHERE user_id=? AND app=?').bind(a.user_id,app).first();return json({data:r?JSON.parse(r.data):null,updatedAt:r?.updated_at||0})}if(method==='PUT'){const x=await body(req),raw=JSON.stringify(x.data??{});if(raw.length>800000)return json({error:'기록이 너무 큽니다.'},413);await env.DB.prepare('INSERT INTO progress(user_id,app,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,app) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').bind(a.user_id,app,raw,now()).run();await log(env,a.user_id,'progress_sync',app);return json({ok:true})}}
  const am=p.match(/^\/api\/answers\/(wordmaster|smstudy)$/);
  if(am&&method==='GET'){const a=await auth(req,env);if(!a)return json({error:'로그인이 필요합니다.'},401);const rows=await env.DB.prepare('SELECT question_id,display_answer FROM shared_answers WHERE app=? ORDER BY created_at').bind(am[1]).all();return json({answers:rows.results})}
  if(method==='POST'&&p==='/api/answers/accept'){const a=await auth(req,env);if(!a)return json({error:'로그인이 필요합니다.'},401);const x=await body(req),app=String(x.app),qid=String(x.questionId||''),answer=String(x.answer||'').trim();if(!['wordmaster','smstudy'].includes(app)||!qid||!answer||answer.length>200)return json({error:'잘못된 답안입니다.'},400);await env.DB.prepare('INSERT OR IGNORE INTO shared_answers(app,question_id,normalized_answer,display_answer,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(app,qid,normalize(answer),answer,a.user_id,now()).run();await log(env,a.user_id,'shared_answer',app,qid);return json({ok:true})}
  if(p.startsWith('/api/admin/')){const a=await auth(req,env,'admin');if(!a)return json({error:'관리자 로그인이 필요합니다.'},401);
    if(method==='GET'&&p==='/api/admin/users'){const rows=await env.DB.prepare(`SELECT u.id,u.username,u.created_at,u.last_login_at,u.disabled,COALESCE(SUM(CASE WHEN a.event='login' THEN 1 ELSE 0 END),0) logins,COUNT(DISTINCT CASE WHEN a.app='wordmaster' THEN a.id END) word_events,COUNT(DISTINCT CASE WHEN a.app='smstudy' THEN a.id END) sm_events FROM users u LEFT JOIN activity a ON a.user_id=u.id GROUP BY u.id ORDER BY u.id DESC`).all();return json({users:rows.results})}
    if(method==='POST'&&p==='/api/admin/users'){const x=await body(req),username=String(x.username||'').trim(),password=String(x.password||'');if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)||password.length<6)return json({error:'아이디 형식 또는 비밀번호 길이를 확인하세요.'},400);const salt=token();try{const r=await env.DB.prepare('INSERT INTO users(username,password_hash,password_salt,created_at) VALUES(?,?,?,?)').bind(username,await passwordHash(password,salt),salt,now()).run();return json({ok:true,id:r.meta.last_row_id})}catch{return json({error:'이미 존재하는 아이디입니다.'},409)}}
    const um=p.match(/^\/api\/admin\/users\/(\d+)$/);if(um&&method==='DELETE'){await env.DB.prepare('DELETE FROM users WHERE id=?').bind(Number(um[1])).run();return json({ok:true})}
    if(method==='GET'&&p==='/api/admin/stats'){const totals=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM sessions WHERE expires_at>${now()}) active_sessions,(SELECT COUNT(*) FROM activity WHERE created_at>${now()-864e5}) events_24h,(SELECT COUNT(*) FROM shared_answers) shared_answers`).first();const daily=await env.DB.prepare(`SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') day,COUNT(*) events,COUNT(DISTINCT user_id) users FROM activity WHERE created_at>? GROUP BY day ORDER BY day`).bind(now()-14*864e5).all();return json({totals,daily:daily.results})}
  }
  return json({error:'Not found'},404);
}
export default {async fetch(req,env){const origin=req.headers.get('origin')||env.ALLOWED_ORIGIN,h=cors(env,origin);if(req.method==='OPTIONS')return new Response(null,{status:204,headers:h});try{const res=await route(req,env),headers=new Headers(res.headers);Object.entries(h).forEach(([k,v])=>headers.set(k,v));return new Response(res.body,{status:res.status,headers})}catch(e){return json({error:'서버 오류',detail:String(e?.message||e)},500,h)}}};

