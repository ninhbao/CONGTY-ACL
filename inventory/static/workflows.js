// Document workflows extend the existing dashboard and product editor.
const labels={in:'Nhập kho',out:'Xuất kho',order:'Lên đơn'};
const dateText=v=>v?v.split('-').reverse().join('/'):'Chưa có ngày SX';
const dnow=new Date(),localToday=new Date(dnow.getTime()-dnow.getTimezoneOffset()*60000).toISOString().slice(0,10);
let editingDocument=null,previewVersion=0,previewTimer;
const originalRender=render,originalNew=$('new').onclick,originalSubmit=$('form').onsubmit;
$('movement-kind').onchange=()=>render();
const normalizeSearch=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLocaleLowerCase('vi');
function filterProducts(el){
 const select=el.querySelector('.product'),selected=select.value,query=normalizeSearch(el.querySelector('.product-search').value.trim());
 const matches=state.products.filter(p=>normalizeSearch([p.name,p.brand,p.category].join(' ')).includes(query));
 const items=[...matches],current=state.products.find(p=>String(p.id)===selected);
 if(current&&!items.includes(current))items.unshift(current);
 select.innerHTML=option('','Chọn hàng hóa')+items.map(p=>option(p.id,p.name+' ('+(p.unit||'chưa có đơn vị')+')',String(p.id)===selected)).join('');
 select.value=selected;select.size=query?Math.min(5,Math.max(2,items.length+1)):1;
 el.querySelector('.product-results').textContent=query?`${matches.length} sản phẩm phù hợp${current&&!matches.includes(current)?' · giữ sản phẩm đang chọn':''}`:'';
}
function installProductSearch(el){
 const select=el.querySelector('.product'),holder=select.parentElement;
 const input=document.createElement('input');input.className='product-search';input.type='search';input.placeholder='Gõ tên hàng, thương hiệu… (có hoặc không dấu)';input.setAttribute('aria-label','Tìm sản phẩm');
 holder.insertBefore(input,select);input.oninput=()=>filterProducts(el);
 input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();select.focus();}};
 const results=document.createElement('small');results.className='product-results';results.setAttribute('aria-live','polite');holder.append(results);
 const button=document.createElement('button');button.type='button';button.className='quick-product-button';button.textContent='+ Tạo sản phẩm mới';button.onclick=()=>openQuickProduct(el);holder.append(button);
}
let quickProductLine=null;
const quickDialog=document.createElement('dialog');quickDialog.id='quick-product-dialog';
quickDialog.innerHTML=`<form id="quick-product-form"><div class="dialoghead"><h2>Thêm sản phẩm mới</h2><button type="button" id="quick-product-close" aria-label="Đóng thêm sản phẩm">✕</button></div><p>Sản phẩm sẽ được tạo và chọn ngay trong phiếu đang nhập.</p><div class="fields">${field('Tên sản phẩm','name','text','required maxlength="200"')}${field('Đơn vị gốc','unit','text','required list="quick-units" maxlength="60"')}${field('Phân loại','category')}${field('Thương hiệu','brand')}${field('Số đơn vị gốc / kiện','pack','number','min="0.000001" step="any"')}${field('Tên kiện (Thùng, Bao…)','package')}${field('Giá nhập / đơn vị gốc','price','number','min="0" step="any"')}${field('Tồn tối thiểu','minimum','number','min="0" step="any" required value="0"')}</div><datalist id="quick-units"></datalist><p id="quick-product-error" role="alert"></p><button type="submit" class="primary">Tạo và chọn sản phẩm</button></form>`;
document.body.append(quickDialog);
function openQuickProduct(el){
 quickProductLine=el;$('quick-product-form').reset();$('quick-product-error').textContent='';
 $('quick-product-form').elements.namedItem('name').value=el.querySelector('.product-search').value.trim();
 $('quick-units').innerHTML=(state.units||[]).map(u=>option(u,u)).join('');quickDialog.showModal();
}
$('quick-product-close').onclick=()=>quickDialog.close();
$('quick-product-form').onsubmit=async e=>{
 e.preventDefault();e.stopPropagation();const form=$('quick-product-form'),button=form.querySelector('[type=submit]');button.disabled=true;
 try{
  const data=Object.fromEntries(new FormData(form));await api('/api/product',data);
  state=await api('/api/state?date='+$('cutoff').value);
  const created=state.products.find(p=>p.name===data.name.normalize('NFC').trim());
  if(!created)throw Error('Đã tạo sản phẩm. Hãy tìm lại sản phẩm trong danh sách.');
  document.querySelectorAll('.document-line').forEach(el=>filterProducts(el));
  if(quickProductLine?.isConnected){
   quickProductLine.querySelector('.product-search').value='';filterProducts(quickProductLine);
   quickProductLine.querySelector('.product').value=String(created.id);updateUnits(quickProductLine);
   quickProductLine.querySelector('.product-results').textContent='Đã tạo và chọn '+created.name;
  }
  quickDialog.close();render();schedulePreview();
 }catch(e){$('quick-product-error').textContent=e.message;}finally{button.disabled=false;}
};
function fifoText(info){
 if(!info)return '';
 if(info.review)return 'Cần đối chiếu đơn vị trước khi xác định lô';
 const parts=info.lots.map(l=>`${fmt(l.qty)} ${l.unit||''} · NSX ${dateText(l.manufactured)} · nhập ${dateText(l.received)} (#${l.receipt_id})`);
 if(info.shortage)parts.push(`Thiếu ${fmt(info.shortage)} đơn vị trong lịch sử`);
 return parts.join('\n')||'Chưa có lô phù hợp';
}
function groups(){const map=new Map();for(const m of state.movements.filter(m=>m.kind==='order')){if(!map.has(m.document_id))map.set(m.document_id,[]);map.get(m.document_id).push(m);}return [...map.values()].map(ms=>ms.sort((a,b)=>a.id-b.id));}
function rowActions(kind,id){return `<div class="row-actions"><button data-edit="${kind}" data-id="${esc(id)}">Sửa</button><button class="danger" data-delete="${kind}" data-id="${esc(id)}">Xóa</button></div>`;}
render=function(){
 $('movement-kind').hidden=view!=='movements';
 const current=view,special=['in','out','orders','suppliers'].includes(view);
 if(special)view='stock';originalRender();view=current;
 if(!['in','out','movements','orders','suppliers'].includes(view))return;
 const titles={in:'Nhập kho',out:'Xuất kho',movements:'Nhập / Xuất kho',orders:'Lên đơn',suppliers:'Nhà cung cấp'};
 $('title').textContent=titles[view];$('tabletitle').textContent=titles[view];$('filter').hidden=true;$('csv').hidden=false;
 $('new').textContent=view==='orders'?'+ Lên đơn hàng':view==='movements'?'+ Tạo phiếu kho':view==='suppliers'?'+ Thêm nhà cung cấp':view==='out'?'+ Phiếu xuất':'+ Phiếu nhập';
 const q=$('search').value.toLocaleLowerCase('vi'),match=(...s)=>s.join(' ').toLocaleLowerCase('vi').includes(q);
 let heads=[],rows=[];exportRows=[];
 if(view==='suppliers'){
  heads=['Nhà cung cấp'];exportRows=(state.suppliers||[]).filter(p=>match(p.name)).map(p=>[p.name]);rows=exportRows.map(r=>r.map(esc));
 }else if(view==='orders'){
  heads=['Mã đơn','Ngày','Khách hàng','Sản phẩm / Số lượng','Ngày SX theo FIFO','Tình trạng'];
  const items=groups().filter(ms=>ms[0].date<=$('cutoff').value&&match(ms[0].document_id,ms[0].party,...ms.map(m=>m.name)));
  exportRows=items.map(ms=>[ms[0].document_id,ms[0].date,ms[0].party,ms.map(m=>`${m.name}: ${fmt(m.entered_qty??m.qty)} ${m.entered_unit||m.unit}`).join('\n'),ms.map(m=>m.name+'\n'+fifoText(m.fifo)).join('\n'),'Đã trừ tồn']);
  rows=exportRows.map((r,i)=>[...r.map(v=>`<span class="lot-text">${esc(v)}</span>`),rowActions('order',items[i][0].document_id)]);
 }else{
  heads=['Ngày','Loại phiếu','Sản phẩm','Số lượng ghi','Quy đổi tồn','Đối tác','Ngày SX / FIFO','Nguồn / Ghi chú'];
  const items=state.movements.filter(m=>m.date<=$('cutoff').value&&(view==='movements'?m.kind!=='order'&&($('movement-kind').value==='all'||m.kind===$('movement-kind').value):m.kind===view)&&match(m.name,m.party,m.note,m.document_id));
  exportRows=items.map(m=>[m.date,labels[m.kind],m.name,`${fmt(m.entered_qty??m.qty)} ${m.entered_unit||m.unit}`,`${fmt(m.qty)} ${m.unit}`,m.party,m.kind==='in'?dateText(m.manufactured):fifoText(m.fifo),m.note]);
  rows=exportRows.map((r,i)=>[...r.map((v,j)=>j===6?`<span class="lot-text">${esc(v)}</span>`:esc(v)),rowActions(items[i].kind==='order'?'order':'movement',items[i].kind==='order'?items[i].document_id:items[i].id)]);
 }
 $('content').innerHTML=table(view==='suppliers'?heads:[...heads,'Thao tác'],rows);$('count').textContent=rows.length+' dòng • đến '+dateText($('cutoff').value);exportRows=[heads,...exportRows];
};
function option(value,text,selected=false){return `<option value="${esc(value)}" ${selected?'selected':''}>${esc(text)}</option>`;}
function currentKind(){return $('form').dataset.mode==='order'?'order':$('form').elements.namedItem('kind')?.value;}
function lineElement(m={}){
 const el=document.createElement('section');el.className='document-line';el.dataset.id=m.id||'';el.dataset.revision=m.revision||'';
 el.innerHTML=`<div class="line-top"><b>Sản phẩm</b><button type="button" class="remove-line danger">Bỏ dòng</button></div><div class="line-grid"><label class="wide">Tên hàng<select class="product" required>${option('','Chọn hàng hóa')}${state.products.map(p=>option(p.id,p.name+' ('+(p.unit||'chưa có đơn vị')+')',p.id===m.product_id)).join('')}</select></label><label>Số lượng<input class="quantity" type="number" min="0.000001" max="1000000000000" step="any" required value="${esc(m.entered_qty??m.qty??'')}"></label><label>Nhập số lượng theo<select class="unit-select" required></select></label><label class="custom-label" hidden>Đơn vị mới<input class="custom-unit" maxlength="60" placeholder="Ví dụ: Hộp"></label><label class="factor-label" hidden><span class="factor-title">Hệ số quy đổi</span><input class="factor" type="number" min="0.000001" step="any"></label><label class="manufactured-label">Ngày sản xuất<input class="manufactured" type="date" value="${esc(m.kind==='in'?m.manufactured:'')}"></label><label>Ghi chú<input class="note" maxlength="1000" value="${esc(m.note||'')}"></label></div><p class="conversion-hint"></p><div class="fifo-preview lot-text"></div>`;
 el.querySelector('.remove-line').onclick=()=>{el.remove();schedulePreview();};
 installProductSearch(el);
 el.querySelector('.product').onchange=()=>{el.querySelector('.product-search').value='';filterProducts(el);updateUnits(el);schedulePreview();};
 el.querySelector('.unit-select').onchange=()=>{updateConversion(el);schedulePreview();};
 el.querySelector('.custom-unit').oninput=()=>{updateConversion(el);schedulePreview();};
 updateUnits(el,m.entered_unit||m.unit,m.factor||1);return el;
}
function updateUnits(el,selected,savedFactor){
 const p=state.products.find(p=>String(p.id)===el.querySelector('.product').value),units=[...new Set([...(state.units||[]),p?.unit,p?.package,selected].filter(Boolean))],chosen=selected||p?.unit||'';
 el.querySelector('.unit-select').innerHTML=option('','Chọn đơn vị')+units.map(u=>option(u,u,u===chosen)).join('')+option('__new','+ Thêm đơn vị…');
 el.dataset.savedUnit=selected||'';el.dataset.savedFactor=savedFactor||'';updateConversion(el);
}
function updateConversion(el){
 const p=state.products.find(p=>String(p.id)===el.querySelector('.product').value),custom=el.querySelector('.unit-select').value==='__new',unit=custom?el.querySelector('.custom-unit').value.trim():el.querySelector('.unit-select').value;
 el.querySelector('.custom-label').hidden=!custom;el.querySelector('.custom-unit').required=custom;
 const base=p?.unit||'',same=unit.toLocaleLowerCase()===base.toLocaleLowerCase(),known=state.conversions?.find(x=>x.product_id===p?.id&&x.name.toLocaleLowerCase()===unit.toLocaleLowerCase()),pack=unit&&p?.package&&unit.toLocaleLowerCase()===p.package.toLocaleLowerCase(),saved=unit===el.dataset.savedUnit?Number(el.dataset.savedFactor):null;
 const factor=same?1:saved||(pack?p.pack:known?.factor),input=el.querySelector('.factor');input.value=factor||'';input.required=!same;input.readOnly=same||Boolean(pack&&p.pack&&!saved);
 el.querySelector('.factor-label').hidden=same||!p;el.querySelector('.factor-title').textContent=`1 ${unit||'đơn vị'} = bao nhiêu ${base||'đơn vị gốc'}?`;
 el.querySelector('.conversion-hint').textContent=p?`Tồn kho tính theo ${base||'đơn vị gốc chưa khai báo'}. ${same?'Mỗi đơn vị ghi tương ứng 1 đơn vị tồn.':'Nhập đúng hệ số quy đổi trước khi lưu.'}`:'';refreshKindVisibility();
}
function refreshKindVisibility(){const kind=currentKind();document.querySelectorAll('.document-line').forEach(el=>{el.querySelector('.manufactured-label').hidden=kind!=='in';el.querySelector('.remove-line').hidden=kind!=='order';el.querySelector('.fifo-preview').hidden=kind==='in';});}
function updateParties(selected=''){
 const incoming=currentKind()==='in',parties=incoming?state.suppliers:state.customers;
 $('party-label').textContent=incoming?'Nhà cung cấp':'Khách hàng';
 const list=[...new Set([...(parties||[]).map(p=>p.name),selected].filter(Boolean))];
 $('party-select').innerHTML=option('','Chọn từ danh sách')+list.map(n=>option(n,n,n===selected)).join('')+option('__new',incoming?'+ Thêm nhà cung cấp…':'+ Thêm khách hàng…');
 $('party-select').required=currentKind()==='order';$('party-new-label').hidden=true;$('party-new').required=false;$('party-new').value='';
}
function readDocument(){
 const form=$('form'),kind=currentKind(),party=$('party-select').value==='__new'?$('party-new').value.trim():$('party-select').value,common={kind,date:form.elements.namedItem('date').value,party};
 const lines=[...document.querySelectorAll('.document-line')].map(el=>({id:el.dataset.id||undefined,revision:el.dataset.revision||undefined,product_id:el.querySelector('.product').value,qty:el.querySelector('.quantity').value,input_unit:el.querySelector('.unit-select').value==='__new'?el.querySelector('.custom-unit').value.trim():el.querySelector('.unit-select').value,factor:el.querySelector('.factor').value,manufactured:el.querySelector('.manufactured').value,note:el.querySelector('.note').value}));
 if(kind==='order')return {...common,document_id:editingDocument?.[0]?.document_id||'',revisions:Object.fromEntries((editingDocument||[]).map(m=>[String(m.id),m.revision])),lines};
 return {...common,...lines[0]};
}
function schedulePreview(){
 clearTimeout(previewTimer);const version=++previewVersion;
 if(!['movement-v2','order'].includes($('form').dataset.mode)||currentKind()==='in')return;
 previewTimer=setTimeout(async()=>{
  if(!$('dialog').open||!$('form').checkValidity())return;const data=readDocument();if(data.lines&&!data.lines.length)return;
  try{const r=await api('/api/preview',data);if(version!==previewVersion)return;document.querySelectorAll('.fifo-preview').forEach((el,i)=>el.textContent='FIFO dự kiến\n'+fifoText(r.fifo[String(r.saved_ids[i])])+'\nNgày SX được tự điền khi lưu.');}
  catch(e){if(version===previewVersion)document.querySelectorAll('.fifo-preview').forEach(el=>el.textContent=e.message);}
 },300);
}
function openDocument(kind='in',existing=null){
 editingDocument=existing;previewVersion++;const order=kind==='order',first=order?existing?.[0]:existing;
 $('form').dataset.mode=order?'order':'movement-v2';$('formerror').textContent='';$('dialogtitle').textContent=(first?'Sửa ':'')+(order?'Đơn hàng':labels[kind]);$('fields').classList.add('document-fields');
 $('fields').innerHTML=`<div class="fields">${order?'<p class="wide order-notice">Lưu đơn sẽ trừ tồn ngay. Không tạo thêm phiếu xuất cho cùng đơn để tránh trừ hai lần.</p>':`<label>Loại phiếu<select name="kind">${option('in','Nhập kho',kind==='in')}${option('out','Xuất kho',kind==='out')}</select></label>`}${field('Ngày phiếu','date','date',`required value="${esc(first?.date||localToday)}"`)}<label><span id="party-label"></span><select id="party-select"></select></label><label id="party-new-label" hidden>Tên mới<input id="party-new" maxlength="200"></label></div><div id="lines"></div>${order?'<button id="add-line" type="button">+ Thêm sản phẩm</button>':''}`;
 updateParties(first?.party||'');$('party-select').onchange=()=>{const add=$('party-select').value==='__new';$('party-new-label').hidden=!add;$('party-new').required=add;schedulePreview();};
 if(!order)$('form').elements.namedItem('kind').onchange=()=>{updateParties();refreshKindVisibility();schedulePreview();};
 for(const m of(order?existing||[{}]:[existing||{}]))$('lines').append(lineElement(m));
 if(order)$('add-line').onclick=()=>{$('lines').append(lineElement());refreshKindVisibility();};
 refreshKindVisibility();$('dialog').showModal();schedulePreview();
}
$('new').onclick=()=>{
 if(view==='products'){$('fields').classList.remove('document-fields');originalNew();return;}
 if(view==='suppliers'){$('form').dataset.mode='supplier';$('formerror').textContent='';$('dialogtitle').textContent='Thêm nhà cung cấp';$('fields').classList.remove('document-fields');$('fields').innerHTML=field('Tên nhà cung cấp','name','text','required maxlength="200"');$('dialog').showModal();return;}
 openDocument(view==='orders'?'order':view==='out'||view==='movements'&&$('movement-kind').value==='out'?'out':'in');
};
$('content').onclick=async e=>{
 const button=e.target.closest('button[data-id]');if(!button)return;const type=button.dataset.edit||button.dataset.delete,id=button.dataset.id;
 const item=type==='order'?groups().find(ms=>ms[0].document_id===id):state.movements.find(m=>String(m.id)===id);if(!item)return;
 if(button.dataset.edit){openDocument(type==='order'?'order':item.kind,item);return;}
 const description=type==='order'?`đơn ${id}`:`phiếu ${labels[item.kind]} #${id} (${item.name})`;
 if(!confirm(`Xóa ${description}? Tồn kho và các lô FIFO liên quan sẽ được tính lại.`))return;button.disabled=true;
 try{await api('/api/'+type+'/delete',type==='order'?{document_id:id,revisions:Object.fromEntries(item.map(m=>[String(m.id),m.revision]))}:{id:item.id,revision:item.revision});await load();message('Đã xóa. Tồn kho và FIFO đã được tính lại.');}
 catch(e){message(e.message);button.disabled=false;}
};
$('form').addEventListener('input',schedulePreview);$('form').addEventListener('change',schedulePreview);
$('form').onsubmit=async e=>{
 const mode=$('form').dataset.mode;if(!['movement-v2','order','supplier'].includes(mode))return originalSubmit(e);
 e.preventDefault();const button=$('form').querySelector('[type=submit]');button.disabled=true;previewVersion++;
 try{const data=mode==='supplier'?Object.fromEntries(new FormData($('form'))):readDocument();await api('/api/'+(mode==='movement-v2'?'movement':mode),data);$('dialog').close();await load();message(mode==='order'?'Đã lưu đơn và trừ tồn. Ngày SX được lấy từ các lô FIFO.':'Đã lưu. Tồn kho và FIFO đã được tính lại.');}
 catch(e){$('formerror').textContent=e.message;}finally{button.disabled=false;}
};
