import {apply,snapshot,importSnapshot} from './engine.mjs';
const url=Deno.env.get('SUPABASE_URL')!;
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const allowed=(Deno.env.get('ALLOWED_ORIGINS')||'https://ninhbao.github.io').split(',').map(x=>x.trim());
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function db(path:string,options:RequestInit={}){
 const r=await fetch(url+'/rest/v1/'+path,{...options,headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json',...options.headers}});
 const data=await r.json();if(!r.ok)throw new Error(data.message||'Lỗi lưu dữ liệu.');return data;
}
Deno.serve(async req=>{
 const origin=req.headers.get('Origin')||'',cors={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:allowed[0],'Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
 const send=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
 if(origin&&!allowed.includes(origin))return send({error:'Nguồn truy cập không hợp lệ.'},403);
 if(req.method==='OPTIONS')return new Response('',{headers:cors});
 if(req.method!=='POST')return send({error:'Phương thức không hợp lệ.'},405);
 try{
  const auth=req.headers.get('Authorization')||'';if(!auth.startsWith('Bearer '))return send({error:'Vui lòng đăng nhập.'},401);
  const r=await fetch(url+'/auth/v1/user',{headers:{apikey:secret,Authorization:auth}});if(!r.ok)return send({error:'Phiên đăng nhập hết hạn.'},401);const user=await r.json();if(!uuid.test(user.id))return send({error:'Tài khoản không hợp lệ.'},401);
  const text=await req.text();if(text.length>10000000)return send({error:'Dữ liệu quá lớn, tối đa 10 MB.'},413);
  const body=JSON.parse(text),wid=body.workspace_id;if(!uuid.test(wid||''))return send({error:'Chưa cấu hình kho.'},400);
  const memberships=await db(`acl_members?workspace_id=eq.${wid}&user_id=eq.${user.id}&select=role`);if(!memberships.length)return send({error:'Tài khoản chưa được cấp quyền vào kho ACL.'},403);
  const [warehouse]=await db(`acl_workspaces?id=eq.${wid}&select=state,revision`);if(!warehouse)return send({error:'Không tìm thấy kho.'},404);
  const path=String(body.path||'');const read=path==='/api/state'||path==='/api/backup';
  if(read)return send({...snapshot(warehouse.state,body.cutoff||'9999-12-31'),workspace_revision:warehouse.revision});
  if(memberships[0].role==='viewer')return send({error:'Tài khoản chỉ có quyền xem.'},403);
  if(!uuid.test(body.request_id||''))return send({error:'Thiếu mã yêu cầu.'},400);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({path,data:body.data}))))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const prior=await db(`acl_events?workspace_id=eq.${wid}&request_id=eq.${body.request_id}&select=user_id,request_hash,result,revision`);
  if(prior.length){if(prior[0].user_id!==user.id||prior[0].request_hash!==hash)return send({error:'Mã yêu cầu đã được sử dụng.'},409);return send({...prior[0].result,workspace_revision:prior[0].revision});}
  if(Number(body.expected_revision)!==warehouse.revision)return send({error:'Kho đã thay đổi ở thiết bị khác. Tải lại trang trước khi lưu.'},409);
  const preview=path==='/api/preview';
  const changed=path==='/api/import-snapshot'?importSnapshot(warehouse.state,body.data):apply(warehouse.state,preview?(body.data?.lines?'/api/order':'/api/movement'):path,body.data||{});
  if(preview)return send({...changed.result,workspace_revision:warehouse.revision});
  const committed=await db('rpc/acl_commit',{method:'POST',body:JSON.stringify({p_workspace:wid,p_user:user.id,p_expected:warehouse.revision,p_state:changed.state,p_action:path,p_request:body.request_id,p_hash:hash,p_result:changed.result})});
  return send({...committed.result,workspace_revision:committed.revision});
 }catch(e){return send({error:e instanceof Error?e.message:'Không thể xử lý yêu cầu.'},400);}
});
