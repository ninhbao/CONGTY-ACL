// Parse cached cell values only: never execute workbook formulas or macros.
window.aclParseExcel=raw=>{
 const wb=XLSX.read(raw,{type:'array',cellDates:true}),required=['Hàng hoá','Khách Hàng','Nhập Kho','Xuất Kho'];
 if(required.some(n=>!wb.Sheets[n]))throw Error('File cần có các sheet: '+required.join(', '));
 const clean=v=>String(v??'').normalize('NFC').trim(),number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const day=v=>v instanceof Date&&!isNaN(v)?`${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`:'';
 const rows=n=>XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,range:0,raw:true,defval:null,blankrows:true});
 const products=[],customers=[],suppliers=[],movements=[],warnings=[];let pid=0,mid=0;
 for(const [i,r]of rows('Hàng hoá').entries()){if(i===0)continue;const name=clean(r[0]);if(!name)continue;if(products.some(p=>p.name===name)){warnings.push(`Hàng hoá dòng ${i+1}: trùng tên ${name}, giữ dòng đầu.`);continue;}const pack=number(r[3]),price=number(r[4]);products.push({id:++pid,name,category:clean(r[1]),brand:clean(r[2]),pack:pack>0?pack:null,price:price!==null&&price>=0?price:null,package:clean(r[5]),unit:'',minimum:0});}
 for(const [i,r]of rows('Khách Hàng').entries())if(i&&clean(r[2]))customers.push({name:clean(r[2]),province:clean(r[1])});
 for(const [sheet,kind,cols]of[['Nhập Kho','in',[0,1,3,4,5,6]],['Xuất Kho','out',[0,1,2,3,4,5]]]){
  let date='',party='';for(const [i,r]of rows(sheet).entries()){if(i<3)continue;const [d,p,n,q,u,m]=cols;if(day(r[d]))date=day(r[d]);if(r[p]!=null)party=clean(r[p]);const name=clean(r[n]),qty=number(r[q]);if(!name){if(qty)warnings.push(`${sheet} dòng ${i+1}: thiếu tên hàng, không nhập.`);continue;}
   if(!qty||qty<=0||!date){warnings.push(`${sheet} dòng ${i+1}: thiếu ngày hoặc số lượng hợp lệ, không nhập (${name}).`);continue;}
   let product=products.find(p=>p.name.toLocaleLowerCase('vi')===name.toLocaleLowerCase('vi'));if(!product){product={id:++pid,name,category:'Chưa phân loại',brand:'',pack:null,price:null,package:'',unit:'',minimum:0};products.push(product);warnings.push(`${sheet} dòng ${i+1}: ${name} chưa có trong danh mục.`);}
   const unit=clean(r[u]);if(product.unit&&unit&&product.unit!==unit)warnings.push(`${sheet} dòng ${i+1}: đơn vị ${unit} khác ${product.unit} của ${name}; cần đối chiếu.`);if(!product.unit)product.unit=unit;
   movements.push({id:++mid,product_id:product.id,kind,date,party,qty,unit,manufactured:kind==='in'?day(r[m]):'',note:`${sheet}!${i+1}`,source:`${sheet}:${i+1}`});if(kind==='in'&&party&&!suppliers.some(s=>s.name===party))suppliers.push({name:party});
  }
 }
 for(const p of products){if(p.price===null)warnings.push('Thiếu giá nhập: '+p.name);const stock=movements.filter(m=>m.product_id===p.id).reduce((n,m)=>n+(m.kind==='in'?m.qty:-m.qty),0);if(stock<0)warnings.push(`Tồn âm: ${p.name}: ${stock}`);}
 return {products,movements,customers,suppliers,conversions:[],reports:[{warnings,summary:{products:products.length,receipts:movements.filter(m=>m.kind==='in').length,issues:movements.filter(m=>m.kind==='out').length}}]};
};
