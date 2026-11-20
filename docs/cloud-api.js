(() => {
 const cfg=window.ACL_CONFIG; let session=null,revision=null,refreshing=null;
 try{session=JSON.parse(sessionStorage.getItem('acl-session')||'null')}catch{}
 const save=s=>{session=s;if(s)sessionStorage.setItem('acl-session',JSON.stringify(s));else sessionStorage.removeItem('acl-session')};
 async function auth(path,data){const r=await fetch(cfg.url+'/auth/v1/'+path,{method:'POST',headers:{apikey:cfg.key,'Content-Type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.msg||v.error_description||v.message||'Không thể đăng nhập.');v.expires_at=Date.now()/1000+(v.expires_in||3600);save(v);return v;}
 async function token(){if(!session)throw Error('Vui lòng đăng nhập.');if(session.expires_at<Date.now()/1000+60){refreshing??=auth('token?grant_type=refresh_token',{refresh_token:session.refresh_token}).finally(()=>refreshing=null);await refreshing;}return session.access_token;}
 window.aclAuth={login:(email,password)=>auth('token?grant_type=password',{email,password}),session:()=>session,logout:async()=>{const t=session?.access_token;save(null);if(t)await fetch(cfg.url+'/auth/v1/logout',{method:'POST',headers:{apikey:cfg.key,Authorization:'Bearer '+t}}).catch(()=>{});location.reload();}};
 window.cloudApi=async(path,data,raw=false)=>{
  if(!cfg?.key)throw Error('Đang hoàn tất kết nối Supabase.');
  if(raw)throw Error('Bản online nhận dữ liệu khởi tạo bằng bản sao JSON. Nhập Excel bằng bản trên máy rồi xuất bản sao.');
  const u=new URL(path,location.href),body={workspace_id:cfg.workspace,path:u.pathname,cutoff:u.searchParams.get('date')||'9999-12-31',data,expected_revision:revision,request_id:crypto.randomUUID()};
  const r=await fetch(cfg.url+'/functions/v1/acl-api',{method:'POST',headers:{apikey:cfg.key,Authorization:'Bearer '+await token(),'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await r.json();if(!r.ok){if(r.status===401){save(null);document.body.classList.add('signed-out');}throw Error(result.error||'Không thể kết nối dữ liệu.');}
  if(u.pathname==='/api/state'||u.pathname!=='/api/preview'&&u.pathname!=='/api/backup')revision=result.workspace_revision;
  return result;
 };
})();
