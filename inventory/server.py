"""Single-computer inventory app. Bind loopback only; no cloud authentication."""
import hashlib, io, json, math, os, secrets, sqlite3, zipfile
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from importer import parse_excel, clean

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('ACL_DB', ROOT / 'data' / 'inventory.sqlite3'))
TOKEN = secrets.token_urlsafe(32)

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    c.executescript('''CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, category TEXT, brand TEXT, pack REAL, price REAL, package TEXT, unit TEXT, minimum REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT UNIQUE,province TEXT);
    CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY,product_id INTEGER,kind TEXT,date TEXT,party TEXT,qty REAL,unit TEXT,manufactured TEXT,note TEXT,source TEXT);
    CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY,summary TEXT,warnings TEXT);
    ''')
    return c

def snapshot(c, cutoff='9999-12-31'):
    products=[dict(r) for r in c.execute('SELECT * FROM products ORDER BY name')]
    movements=[dict(r) for r in c.execute('SELECT m.*,p.name FROM movements m JOIN products p ON p.id=m.product_id ORDER BY date DESC,m.id DESC')]
    for p in products:
        ms=[m for m in movements if m['product_id']==p['id'] and m['date']<=cutoff]
        p['stock']=round(sum(m['qty']*(1 if m['kind']=='in' else -1) for m in ms),6)
        p['review']=len({m['unit'].casefold() for m in ms if m['unit']})>1
        p['value']=None if p['price'] is None or p['review'] else round(p['stock']*p['price'])
    reports=[dict(r) for r in c.execute('SELECT summary,warnings FROM imports')]
    return dict(products=products,movements=movements,customers=[dict(r) for r in c.execute('SELECT * FROM customers ORDER BY name')],reports=[dict(summary=json.loads(r['summary']),warnings=json.loads(r['warnings'])) for r in reports])

def import_data(c, raw):
    digest=hashlib.sha256(raw).hexdigest()
    if c.execute('SELECT 1 FROM imports WHERE hash=?',(digest,)).fetchone(): raise ValueError('File này đã được nhập, không nhập trùng.')
    if c.execute('SELECT COUNT(*) FROM movements').fetchone()[0]: raise ValueError('Chỉ nhập Excel khởi tạo vào kho chưa có giao dịch để tránh cộng trùng lịch sử. Hãy sao lưu trước và dùng kho dữ liệu mới cho file khác.')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if sum(i.file_size for i in z.infolist()) > 50_000_000: raise ValueError('File giải nén quá lớn.')
    data=parse_excel(raw)
    with c:
        for p in data['products']:
            c.execute('INSERT INTO products(name,category,brand,pack,price,package,unit,minimum) VALUES(:name,:category,:brand,:pack,:price,:package,:unit,:minimum)',p)
        for p in data['customers']: c.execute('INSERT OR IGNORE INTO customers(name,province) VALUES(:name,:province)',p)
        ids={r['name']:r['id'] for r in c.execute('SELECT id,name FROM products')}
        for m in data['movements']:
            c.execute('INSERT INTO movements(product_id,kind,date,party,qty,unit,manufactured,note,source) VALUES(?,?,?,?,?,?,?,?,?)',(ids[m['name']],m['kind'],m['date'],m['party'],m['qty'],m['unit'],m['manufactured'],m['note'],m['source']))
        c.execute('INSERT INTO imports VALUES(?,?,?)',(digest,json.dumps(data['summary']),json.dumps(data['warnings'],ensure_ascii=False)))
    return data['summary']

def numeric(v, label, minimum=0, nullable=False):
    if nullable and (v is None or v==''): return None
    try: n=float(v)
    except (ValueError,TypeError): raise ValueError(label+' không hợp lệ.')
    if not math.isfinite(n) or n<minimum: raise ValueError(label+' không hợp lệ.')
    return n

def mutate(c,path,d):
    if path=='/api/product':
        name=clean(d.get('name'))
        if not name: raise ValueError('Nhập tên sản phẩm.')
        values=(name,clean(d.get('category')),clean(d.get('brand')),numeric(d.get('pack'),'Quy cách',0.000001,True),numeric(d.get('price'),'Giá nhập',0,True),clean(d.get('package')),clean(d.get('unit')),numeric(d.get('minimum',0),'Tồn tối thiểu'))
        with c:
            if d.get('id'):
                if not c.execute('SELECT 1 FROM products WHERE id=?',(d['id'],)).fetchone(): raise ValueError('Không tìm thấy sản phẩm.')
                c.execute('UPDATE products SET name=?,category=?,brand=?,pack=?,price=?,package=?,unit=?,minimum=? WHERE id=?',values+(d['id'],))
            else: c.execute('INSERT INTO products(name,category,brand,pack,price,package,unit,minimum) VALUES(?,?,?,?,?,?,?,?)',values)
    elif path=='/api/movement':
        kind=d.get('kind'); dt=d.get('date',''); date.fromisoformat(dt)
        if kind not in ('in','out'): raise ValueError('Loại giao dịch không hợp lệ.')
        qty=numeric(d.get('qty'),'Số lượng',0.000001)
        c.execute('BEGIN IMMEDIATE')
        try:
            p=c.execute('SELECT * FROM products WHERE id=?',(d.get('product_id'),)).fetchone()
            if not p: raise ValueError('Không tìm thấy sản phẩm.')
            if d.get('mode')=='pack':
                if not p['pack']: raise ValueError('Chưa khai báo quy cách.')
                qty*=p['pack']
            if kind=='out':
                stock=next(p2 for p2 in snapshot(c,dt)['products'] if p2['id']==p['id'])
                if stock['review']: raise ValueError('Sản phẩm có đơn vị không nhất quán trong Excel. Cần đối chiếu trước khi xuất thêm.')
                future=c.execute('SELECT date,SUM(CASE kind WHEN \'in\' THEN qty ELSE -qty END) change FROM movements WHERE product_id=? AND date>? GROUP BY date ORDER BY date',(p['id'],dt)).fetchall()
                balance=stock['stock']-qty
                if balance < -0.000001: raise ValueError('Không đủ tồn tại ngày xuất.')
                for row in future:
                    balance+=row['change']
                    if balance < -0.000001: raise ValueError('Phiếu này làm âm tồn ở giao dịch sau ngày xuất.')
            manufactured=d.get('manufactured','')
            if manufactured: date.fromisoformat(manufactured)
            c.execute('INSERT INTO movements(product_id,kind,date,party,qty,unit,manufactured,note,source) VALUES(?,?,?,?,?,?,?,?,?)',(p['id'],kind,dt,clean(d.get('party')),qty,p['unit'],manufactured,clean(d.get('note')),'manual'))
            c.commit()
        except Exception:
            c.rollback(); raise
    else: raise ValueError('Chức năng không tồn tại.')

class Handler(BaseHTTPRequestHandler):
    def send(self,data,status=200,ctype='application/json; charset=utf-8'):
        raw=json.dumps(data,ensure_ascii=False,allow_nan=False).encode() if ctype.startswith('application/json') else data
        self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(raw))); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.end_headers(); self.wfile.write(raw)
    def allowed(self):
        return self.headers.get('Host') in ('127.0.0.1:'+str(self.server.server_port),'localhost:'+str(self.server.server_port))
    def do_GET(self):
        if not self.allowed(): return self.send({'error':'Host không hợp lệ'},403)
        path=urlparse(self.path).path
        if path=='/api/state':
            with connect() as c: data=snapshot(c,parse_qs(urlparse(self.path).query).get('date',['9999-12-31'])[0])
            return self.send(dict(data,token=TOKEN))
        if path=='/api/backup':
            with connect() as c:
                data=snapshot(c)
            return self.send(data)
        files={'/':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript; charset=utf-8'),'/style.css':('style.css','text/css; charset=utf-8')}
        if path not in files: return self.send({'error':'Không tìm thấy'},404)
        name,mime=files[path]; self.send((ROOT/'static'/name).read_bytes(),ctype=mime)
    def do_POST(self):
        if not self.allowed() or self.headers.get('X-ACL-Token') != TOKEN: return self.send({'error':'Vui lòng tải lại trang.'},403)
        try:
            size=int(self.headers.get('Content-Length',0))
            if not 0<size<=10_000_000: raise ValueError('Dung lượng tối đa 10 MB.')
            raw=self.rfile.read(size)
            with connect() as c:
                if self.path=='/api/import': result=import_data(c,raw)
                else: mutate(c,self.path,json.loads(raw)); result={'ok':True}
            self.send(result)
        except (ValueError,KeyError,sqlite3.IntegrityError,zipfile.BadZipFile) as e: self.send({'error':str(e)},400)
        except Exception: self.send({'error':'Không thể xử lý dữ liệu. Kiểm tra định dạng file và thử lại.'},400)

if __name__=='__main__':
    port=int(os.environ.get('PORT','8765'))
    print(f'ACL Tồn kho: http://127.0.0.1:{port}',flush=True)
    HTTPServer(('127.0.0.1',port),Handler).serve_forever()
