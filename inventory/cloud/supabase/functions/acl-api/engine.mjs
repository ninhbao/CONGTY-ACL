// Pure inventory domain logic; called only by the authenticated Edge Function.
const EPS=1e-6;
const txt=v=>String(v??'').normalize('NFC').trim();
const key=v=>txt(v).toLocaleLowerCase('vi');
const clone=v=>structuredClone(v);
function fail(s){throw new Error(s);}
function num(v,label,min=0,nullable=false){if(nullable&&(v==null||v===''))return null;if(v==null||v==='')fail(label+' không hợp lệ.');const n=Number(v);if(!Number.isFinite(n)||n<min||n>1e12)fail(label+' không hợp lệ.');return n;}
function dt(v){const s=txt(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail('Ngày không hợp lệ.');return s;}
const round=n=>Math.round(n*1e6)/1e6;
export function emptyState(){return {schema:1,products:[],movements:[],customers:[],suppliers:[],units:['Chai','Gói','Xô','Kg','Thùng','Bao'],conversions:[],shipments:[],reports:[],next_id:1};}
function addParty(s,type,name){if(name&&!s[type].some(p=>p.name===name))s[type].push({id:Math.max(0,...s[type].map(p=>p.id))+1,name,...(type==='customers'?{province:''}:{})});}
function unit(s,name){if(name&&!s.units.some(u=>key(u)===key(name)))s.units.push(name);}
export function fifo(ms){
 const result={},ids=new Set(ms.map(m=>m.product_id));
 for(const id of ids){
  const items=ms.filter(m=>m.product_id===id),mixed=new Set(items.map(m=>key(m.unit)).filter(Boolean)).size>1,lots=[];let debt=0;
  for(const m of items.sort((a,b)=>a.date.localeCompare(b.date)||(a.kind!=='in')-(b.kind!=='in')||a.id-b.id)){
   let q=m.qty;
   if(m.kind==='in'){const paid=Math.min(debt,q);debt-=paid;q-=paid;if(q>EPS)lots.push({receipt_id:m.id,received:m.date,manufactured:m.manufactured||'',qty:q,unit:m.unit});continue;}
   const used=[];while(q>EPS&&lots.length){const l=lots[0],take=Math.min(q,l.qty);used.push({...l,qty:round(take)});q-=take;l.qty-=take;if(l.qty<=EPS)lots.shift();}
   debt+=Math.max(0,q);result[m.id]={lots:mixed?[]:used,shortage:round(Math.max(0,q)),review:mixed};
  }
 }return result;
}
export function snapshot(s,cutoff='9999-12-31'){
 dt(cutoff);const alloc=fifo(s.movements);
 const products=s.products.map(p=>{const ms=s.movements.filter(m=>m.product_id===p.id&&m.date<=cutoff),stock=round(ms.reduce((n,m)=>n+(m.kind==='in'?m.qty:-m.qty),0)),review=new Set(ms.map(m=>key(m.unit)).filter(Boolean)).size>1;return {...p,stock,review,value:p.price==null||review?null:Math.round(stock*p.price)};}).sort((a,b)=>a.name.localeCompare(b.name,'vi'));
 const movements=s.movements.map(m=>({...m,name:s.products.find(p=>p.id===m.product_id)?.name||'',shipment:s.shipments.find(x=>x.document_id===m.document_id)||null,fifo:alloc[m.id]||null,...(m.kind!=='in'?{source_manufactured:m.manufactured,manufactured:[...new Set((alloc[m.id]?.lots||[]).map(l=>l.manufactured).filter(Boolean))].join(', ')}:{})})).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
 return {products,movements,customers:s.customers,suppliers:s.suppliers,units:s.units,conversions:s.conversions,reports:s.reports};
}
function checkRev(m,d){if(String(m.revision)!==String(d.revision))fail('Phiếu đã thay đổi. Tải lại dữ liệu trước khi sửa/xóa.');}
function checkOrder(ms,d){const v=d.revisions||{};if(Object.keys(v).sort().join(',')!==ms.map(m=>String(m.id)).sort().join(','))fail('Đơn hàng đã thay đổi. Tải lại dữ liệu.');ms.forEach(m=>checkRev(m,{revision:v[m.id]}));}
function validateBalances(before,after,ids){for(const pid of ids){const old={},next={};for(const [ms,target]of[[before,old],[after,next]])for(const m of ms.filter(m=>m.product_id===pid))target[m.date]=(target[m.date]||0)+(m.kind==='in'?m.qty:-m.qty);let a=0,b=0;for(const date of [...new Set([...Object.keys(old),...Object.keys(next)])].sort()){a+=old[date]||0;b+=next[date]||0;if(b<Math.min(0,a)-EPS)fail(`Không đủ tồn ngày ${date}. Thay đổi làm thiếu ${round(-b)} đơn vị.`);}}}
function convert(s,p,d,old){
 const entered=num(d.qty,'Số lượng',EPS),u=txt(d.input_unit)||(d.mode==='pack'?p.package||'Kiện':p.unit),base=key(p.unit);if(!u||!base)fail('Cần khai báo đơn vị lẻ cho sản phẩm.');let factor;
 if(key(u)===base)factor=1;
 else if(old&&key(u)===key(old.entered_unit||old.unit))factor=d.factor!=null&&d.factor!==''?num(d.factor,'Hệ số',EPS):old.factor||1;
 else if(d.mode==='pack'||key(u)===key(p.package)){if(!p.pack)fail('Chưa khai báo quy cách.');factor=p.pack;}
 else factor=d.factor!=null&&d.factor!==''?num(d.factor,'Hệ số',EPS):s.conversions.find(x=>x.product_id===p.id&&key(x.name)===key(u))?.factor;
 if(!factor)fail(`Cần nhập số ${p.unit} tương ứng 1 ${u}.`);const qty=num(entered*factor,'Số lượng quy đổi',EPS);unit(s,u);
 if(key(u)!==base){s.conversions=s.conversions.filter(x=>!(x.product_id===p.id&&key(x.name)===key(u)));s.conversions.push({product_id:p.id,name:u,factor});}
 return {qty,entered_qty:entered,entered_unit:u,factor};
}
function saveRow(s,d,kind,date,party,doc='',old){
 const p=s.products.find(p=>p.id===Number(d.product_id));if(!p)fail('Không tìm thấy sản phẩm.');const q=convert(s,p,d,old);
 if(kind!=='in'&&new Set(s.movements.filter(m=>m.product_id===p.id).map(m=>key(m.unit)).filter(Boolean)).size>1){if(!(old&&old.product_id===p.id&&old.date===date&&old.kind!=='in'&&q.qty<=old.qty+EPS))fail('Hàng có đơn vị lịch sử không nhất quán. Sửa phiếu nguồn trước.');}
 const manufactured=kind==='in'&&txt(d.manufactured)?dt(d.manufactured):'';if(manufactured>date)fail('Ngày sản xuất không được sau ngày nhập.');
 const id=old?.id||s.next_id++,m={id,product_id:p.id,kind,date,party,...q,unit:p.unit,manufactured,note:txt(d.note),document_id:doc,revision:old?old.revision+1:1,source:old?.source||'online'};
 if(old)s.movements[s.movements.findIndex(x=>x.id===old.id)]=m;else s.movements.push(m);return id;
}
export function apply(input,path,d={}){
 const s=clone(input),before=clone(s.movements),affected=new Set(),saved=[];let result={ok:true};
 if(path==='/api/product'){
  const name=txt(d.name);if(!name)fail('Nhập tên sản phẩm.');const old=d.id?s.products.find(p=>p.id===Number(d.id)):null;if(d.id&&!old)fail('Không tìm thấy sản phẩm.');
  if(s.products.some(p=>p.id!==old?.id&&key(p.name)===key(name)))fail('Tên sản phẩm đã tồn tại.');
  const p={id:old?.id||Math.max(0,...s.products.map(p=>p.id))+1,name,category:txt(d.category),brand:txt(d.brand),pack:num(d.pack,'Quy cách',EPS,true),price:num(d.price,'Giá nhập',0,true),package:txt(d.package),unit:txt(d.unit),minimum:num(d.minimum??0,'Tồn tối thiểu')};
  if(old&&'expected_unit'in d&&txt(d.expected_unit)!==txt(old.unit))fail('Đơn vị sản phẩm đã thay đổi. Tải lại danh mục.');
  if(old&&p.unit!==old.unit){if(!p.unit)fail('Đơn vị lẻ không được để trống.');if(key(p.package)===key(p.unit)&&p.pack!=null&&p.pack!==1)fail('Đơn vị kiện trùng đơn vị lẻ mới. Sửa tên kiện hoặc đặt quy cách bằng 1.');
   for(const m of s.movements.filter(m=>m.product_id===p.id)){const u=m.entered_unit||m.unit,normalize=Math.abs((m.factor||1)-1)<EPS||[key(old.unit),key(p.unit)].includes(key(u));m.unit=p.unit;if(normalize){m.entered_unit=p.unit;m.entered_qty=m.qty;m.factor=1;}m.revision++;}
   s.conversions=s.conversions.filter(x=>x.product_id!==p.id||![key(old.unit),key(p.unit)].includes(key(x.name)));
  }
  unit(s,p.unit);if(old)s.products[s.products.findIndex(x=>x.id===p.id)]=p;else s.products.push(p);return {state:s,result};
 }
 if(path==='/api/supplier'){const name=txt(d.name);if(!name)fail('Nhập tên nhà cung cấp.');addParty(s,'suppliers',name);return {state:s,result};}
 if(path==='/api/order/dispatch'){
  const doc=txt(d.document_id),date=dt(d.date),ms=s.movements.filter(m=>m.kind==='order'&&m.document_id===doc);if(!ms.length)fail('Không tìm thấy đơn hàng.');if(s.shipments.some(x=>x.document_id===doc))fail('Đơn đã có phiếu xuất. Không xuất trùng.');checkOrder(ms,d);
  const alloc=fifo(s.movements);for(const m of ms){if(date<m.date)fail('Ngày xuất không được trước ngày lên đơn.');if(alloc[m.id].review||alloc[m.id].shortage>EPS)fail('Chưa xác định đủ lô FIFO cho đơn.');m.revision++;}
  const shipment={document_id:doc,number:'PX-'+doc,date,note:txt(d.note)};s.shipments.push(shipment);return {state:s,result:{ok:true,shipment}};
 }
 if(['/api/order','/api/order/delete'].includes(path)){
  let doc=txt(d.document_id);const previous=s.movements.filter(m=>doc&&m.document_id===doc&&m.kind==='order');if(doc&&!previous.length)fail('Không tìm thấy đơn hàng.');if(previous.length)checkOrder(previous,d);previous.forEach(m=>affected.add(m.product_id));
  if(path.endsWith('/delete')){if(!doc)fail('Thiếu mã đơn.');s.movements=s.movements.filter(m=>m.document_id!==doc);s.shipments=s.shipments.filter(x=>x.document_id!==doc);}
  else{
   doc=doc||'DH-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();const date=dt(d.date),party=txt(d.party),shipment=s.shipments.find(x=>x.document_id===doc);if(shipment&&date>shipment.date)fail('Ngày lên đơn không được sau ngày xuất.');if(!party)fail('Chọn khách hàng.');if(!Array.isArray(d.lines)||!d.lines.length||d.lines.length>100)fail('Đơn hàng cần từ 1 đến 100 dòng.');const kept=new Set();
   for(const line of d.lines){const old=line.id?previous.find(m=>m.id===Number(line.id)):null;if(line.id&&(!old||kept.has(old.id)))fail('Dòng đơn hàng không hợp lệ.');const id=saveRow(s,line,'order',date,party,doc,old);kept.add(id);saved.push(id);}
   s.movements=s.movements.filter(m=>!previous.some(x=>x.id===m.id)||kept.has(m.id));addParty(s,'customers',party);
  }
 }else if(['/api/movement','/api/movement/delete'].includes(path)){
  const old=d.id?s.movements.find(m=>m.id===Number(d.id)):null;if(d.id&&!old)fail('Phiếu không còn tồn tại.');if(old){if(old.kind==='order')fail('Sửa/xóa đơn tại Lên đơn.');checkRev(old,d);affected.add(old.product_id);}
  if(path.endsWith('/delete')){if(!old)fail('Thiếu mã phiếu.');s.movements=s.movements.filter(m=>m.id!==old.id);}
  else{const kind=d.kind,date=dt(d.date),party=txt(d.party);if(!['in','out'].includes(kind))fail('Loại phiếu không hợp lệ.');saved.push(saveRow(s,d,kind,date,party,'',old));addParty(s,kind==='in'?'suppliers':'customers',party);}
 }else fail('Chức năng không tồn tại.');
 s.movements.filter(m=>saved.includes(m.id)).forEach(m=>affected.add(m.product_id));validateBalances(before,s.movements,affected);const alloc=fifo(s.movements);
 result={ok:true,saved_ids:saved,fifo:Object.fromEntries(saved.map(id=>[String(id),alloc[id]||null]))};return {state:s,result};
}

// Validate and normalize an exported local snapshot; import only into an empty workspace.
export function importSnapshot(input,raw){
 if(input.movements.length||input.products.length)fail('Kho online phải trống trước khi nhập bản sao khởi tạo.');
 if(!raw||!Array.isArray(raw.products)||!Array.isArray(raw.movements)||raw.products.length>10000||raw.movements.length>50000)fail('Bản sao không đúng định dạng hoặc quá lớn.');
 const s=emptyState(),ids=new Set(),mids=new Set();
 for(const x of raw.products){const id=num(x.id,'Mã sản phẩm',1);if(!Number.isSafeInteger(id)||ids.has(id))fail('Trùng mã sản phẩm.');ids.add(id);s.products.push({id,name:txt(x.name),unit:txt(x.unit),category:txt(x.category),brand:txt(x.brand),pack:num(x.pack,'Quy cách',EPS,true),price:num(x.price,'Giá',0,true),package:txt(x.package),minimum:num(x.minimum??0,'Tồn tối thiểu')});unit(s,txt(x.unit));}
 for(const x of raw.movements){const id=num(x.id,'Mã phiếu',1),pid=Number(x.product_id);if(!Number.isSafeInteger(id)||mids.has(id)||!ids.has(pid)||!['in','out','order'].includes(x.kind))fail('Phiếu không hợp lệ hoặc trùng mã.');mids.add(id);const q=num(x.qty,'Số lượng',EPS),factor=num(x.factor??1,'Hệ số',EPS),entered=num(x.entered_qty??q,'Số lượng ghi',EPS);if(Math.abs(entered*factor-q)>EPS)fail('Quy đổi số lượng không khớp.');s.movements.push({id,product_id:pid,kind:x.kind,date:dt(x.date),party:txt(x.party),qty:q,unit:txt(x.unit),entered_qty:entered,entered_unit:txt(x.entered_unit||x.unit),factor,manufactured:x.kind==='in'&&x.manufactured?dt(x.manufactured):'',note:txt(x.note),source:txt(x.source),document_id:txt(x.document_id),revision:1});unit(s,txt(x.entered_unit||x.unit));
  if(x.shipment&&!s.shipments.some(y=>y.document_id===x.document_id))s.shipments.push({document_id:txt(x.document_id),number:txt(x.shipment.number),date:dt(x.shipment.date),note:txt(x.shipment.note)});
 }
 for(const type of ['customers','suppliers'])for(const p of raw[type]||[]){addParty(s,type,txt(p.name));if(type==='customers'){const entry=s[type].find(x=>x.name===txt(p.name));if(entry)entry.province=txt(p.province);}}
 for(const x of raw.conversions||[]){if(!ids.has(Number(x.product_id)))fail('Quy đổi có sản phẩm không tồn tại.');s.conversions.push({product_id:Number(x.product_id),name:txt(x.name),factor:num(x.factor,'Hệ số',EPS)});}
 s.reports=Array.isArray(raw.reports)?raw.reports:[];s.next_id=Math.max(0,...mids)+1;
 return {state:s,result:{ok:true,products:s.products.length,receipts:s.movements.filter(m=>m.kind==='in').length,issues:s.movements.filter(m=>m.kind==='out').length}};
}
