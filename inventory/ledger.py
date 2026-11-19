"""Transactional inventory documents, explicit unit conversion and FIFO lots."""
import json
import math
import uuid
from collections import defaultdict, deque
from datetime import date
from importer import clean

EPS = 0.000001
DEFAULT_UNITS = ('Chai', 'Gói', 'Xô', 'Kg', 'Thùng', 'Bao')

def migrate(c):
    columns = {r['name'] for r in c.execute('PRAGMA table_info(movements)')}
    for name, declaration in {
        'document_id': "TEXT DEFAULT ''", 'entered_qty': 'REAL',
        'entered_unit': 'TEXT', 'factor': 'REAL DEFAULT 1',
        'revision': 'INTEGER DEFAULT 1',
    }.items():
        if name not in columns:
            c.execute(f'ALTER TABLE movements ADD COLUMN {name} {declaration}')
    c.executescript('''
        CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS units(name TEXT PRIMARY KEY COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS product_units(product_id INTEGER, name TEXT COLLATE NOCASE, factor REAL, PRIMARY KEY(product_id,name));
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, action TEXT, before_json TEXT, after_json TEXT);
        CREATE TABLE IF NOT EXISTS movement_sequence(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    ''')
    c.execute('INSERT OR IGNORE INTO movement_sequence VALUES(1,0)')
    c.execute('UPDATE movement_sequence SET value=MAX(value,(SELECT COALESCE(MAX(id),0) FROM movements)) WHERE id=1')
    c.executemany('INSERT OR IGNORE INTO units(name) VALUES(?)', [(u,) for u in DEFAULT_UNITS])
    c.commit()

def rows(c, product_id=None):
    sql = 'SELECT * FROM movements'
    return [dict(r) for r in c.execute(sql + (' WHERE product_id=?' if product_id is not None else ''), (product_id,) if product_id is not None else ())]

def fifo(movements):
    """Receipts first within a date, then immutable row ID; never borrow future lots."""
    groups = defaultdict(list)
    for m in movements: groups[m['product_id']].append(m)
    result = {}
    for entries in groups.values():
        lots, debt = deque(), 0.0
        mixed = len({clean(m['unit']).casefold() for m in entries if clean(m['unit'])}) > 1
        for m in sorted(entries, key=lambda r: (r['date'], r['kind'] != 'in', r['id'])):
            qty = m['qty']
            if m['kind'] == 'in':
                paid = min(debt, qty); debt -= paid; qty -= paid
                if qty > EPS: lots.append(dict(receipt_id=m['id'], received=m['date'], manufactured=m['manufactured'] or '', qty=qty, unit=m['unit']))
                continue
            allocations = []
            while qty > EPS and lots:
                lot = lots[0]; take = min(qty, lot['qty'])
                allocations.append(dict(lot, qty=round(take, 6)))
                qty -= take; lot['qty'] -= take
                if lot['qty'] <= EPS: lots.popleft()
            debt += max(0, qty)
            result[m['id']] = dict(lots=[] if mixed else allocations, shortage=round(max(0, qty), 6), review=mixed)
    return result

def balance_by_day(entries):
    totals = defaultdict(float)
    for m in entries: totals[m['date']] += m['qty'] * (1 if m['kind'] == 'in' else -1)
    return totals

def validate_change(before, after, ids):
    """Reject newly created or worsened deficits, allowing unrelated legacy errors."""
    for pid in ids:
        old = balance_by_day([r for r in before if r['product_id'] == pid])
        new = balance_by_day([r for r in after if r['product_id'] == pid])
        a = b = 0.0
        for dt in sorted(set(old) | set(new)):
            a += old.get(dt, 0); b += new.get(dt, 0)
            if b < min(0, a) - EPS:
                raise ValueError(f'Không đủ tồn ngày {dt}: thay đổi làm thiếu {abs(b):g} đơn vị. Hãy sửa phiếu xuất/đơn hàng liên quan trước.')

def positive(value, label):
    try: n = float(value)
    except (ValueError, TypeError): raise ValueError(label + ' không hợp lệ.')
    if not math.isfinite(n) or n <= 0: raise ValueError(label + ' phải lớn hơn 0.')
    return n

def rename_base_unit(c, product, new_unit):
    """Correct the base-unit label, preserving canonical quantities and lot history."""
    before = rows(c, product['id'])
    old_unit = clean(product['unit']).casefold()
    for m in before:
        entered_unit = clean(m['entered_unit'] or m['unit'])
        factor = m['factor'] or 1
        # Keep genuine package conversions; normalize conflicting/legacy labels.
        normalize = abs(factor-1) < EPS or entered_unit.casefold() in (old_unit, new_unit.casefold())
        c.execute('UPDATE movements SET unit=?,entered_unit=?,entered_qty=?,factor=?,revision=revision+1 WHERE id=?',
                  (new_unit, new_unit if normalize else entered_unit,
                   m['qty'] if normalize else m['entered_qty'], 1 if normalize else factor, m['id']))
    for mapping in c.execute('SELECT name FROM product_units WHERE product_id=?', (product['id'],)).fetchall():
        if clean(mapping['name']).casefold() in (old_unit, new_unit.casefold()):
            c.execute('DELETE FROM product_units WHERE product_id=? AND name=?', (product['id'], mapping['name']))
    c.execute('INSERT OR IGNORE INTO units(name) VALUES(?)', (new_unit,))
    c.execute('INSERT INTO audit(action,before_json,after_json) VALUES(?,?,?)',
              ('/api/product/unit', json.dumps({'product':dict(product),'movements':before},ensure_ascii=False),
               json.dumps({'product_id':product['id'],'unit':new_unit,'movements':rows(c,product['id'])},ensure_ascii=False)))

def conversion(c, p, d, existing=None):
    quantity = positive(d.get('qty'), 'Số lượng')
    # Legacy clients may still submit mode=pack; new clients always specify a unit.
    unit = clean(d.get('input_unit')) or (p['package'] or 'Kiện' if d.get('mode') == 'pack' else p['unit'])
    if not unit: raise ValueError('Chọn đơn vị cho sản phẩm trước khi ghi phiếu.')
    base = clean(p['unit'])
    if not base: raise ValueError('Sản phẩm chưa có đơn vị lẻ. Hãy sửa danh mục hàng hóa.')
    if unit.casefold() == base.casefold(): factor = 1.0
    elif existing and unit.casefold() == clean(existing['entered_unit'] or existing['unit']).casefold():
        # Preserve the original conversion when editing a historical document.
        factor = existing['factor'] or 1.0
        if d.get('factor') not in (None, ''): factor = positive(d['factor'], 'Hệ số quy đổi')
    elif d.get('mode') == 'pack' or unit.casefold() == clean(p['package']).casefold():
        if not p['pack']: raise ValueError('Chưa khai báo quy cách cho đơn vị này.')
        factor = p['pack']
    else:
        known = c.execute('SELECT factor FROM product_units WHERE product_id=? AND name=?', (p['id'], unit)).fetchone()
        factor = positive(d.get('factor'), 'Hệ số quy đổi') if d.get('factor') not in (None, '') else known['factor'] if known else None
        if factor is None: raise ValueError(f'Cần nhập số {base} tương ứng 1 {unit}. Không tự quy đổi các đơn vị khác nhau.')
    total = quantity * factor
    if not math.isfinite(total) or total < EPS or total > 1e12: raise ValueError('Số lượng quy đổi ngoài phạm vi cho phép.')
    c.execute('INSERT OR IGNORE INTO units VALUES(?)', (unit,))
    if unit.casefold() != base.casefold():
        c.execute('INSERT INTO product_units VALUES(?,?,?) ON CONFLICT(product_id,name) DO UPDATE SET factor=excluded.factor', (p['id'], unit, factor))
    return quantity, unit, factor, total

def save_row(c, d, kind, dt, party, document_id='', existing=None):
    p = c.execute('SELECT * FROM products WHERE id=?', (d.get('product_id'),)).fetchone()
    if not p: raise ValueError('Không tìm thấy sản phẩm.')
    entered, unit, factor, qty = conversion(c, p, d, existing)
    if kind != 'in':
        units = {clean(r['unit']).casefold() for r in rows(c, p['id']) if clean(r['unit'])}
        if len(units) > 1:
            reducing = existing and existing['product_id'] == p['id'] and existing['date'] == dt and existing['kind'] != 'in' and qty <= existing['qty'] + EPS
            if not reducing: raise ValueError('Hàng có đơn vị lịch sử không nhất quán. Sửa phiếu nguồn trước khi xuất/lên đơn thêm.')
    manufactured = clean(d.get('manufactured')) if kind == 'in' else ''
    if manufactured:
        date.fromisoformat(manufactured)
        if manufactured > dt: raise ValueError('Ngày sản xuất không được sau ngày nhập.')
    values = (p['id'], kind, dt, party, qty, p['unit'], manufactured, clean(d.get('note')), document_id, entered, unit, factor)
    if existing:
        c.execute('UPDATE movements SET product_id=?,kind=?,date=?,party=?,qty=?,unit=?,manufactured=?,note=?,document_id=?,entered_qty=?,entered_unit=?,factor=?,revision=revision+1 WHERE id=?', values + (existing['id'],))
        return existing['id']
    identifier = max(c.execute('SELECT value FROM movement_sequence WHERE id=1').fetchone()[0], c.execute('SELECT COALESCE(MAX(id),0) FROM movements').fetchone()[0]) + 1
    c.execute('UPDATE movement_sequence SET value=? WHERE id=1', (identifier,))
    cur = c.execute("INSERT INTO movements(id,product_id,kind,date,party,qty,unit,manufactured,note,document_id,entered_qty,entered_unit,factor,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')", (identifier,) + values)
    return cur.lastrowid

def check_revision(existing, submitted):
    if str(existing['revision']) != str(submitted.get('revision')):
        raise ValueError('Phiếu đã thay đổi ở cửa sổ khác. Tải lại dữ liệu trước khi sửa/xóa.')

def change(c, path, d, preview=False):
    c.execute('BEGIN IMMEDIATE')
    try:
        before = rows(c); affected = set(); saved = []
        if path in ('/api/order', '/api/order/delete'):
            doc = clean(d.get('document_id'))
            previous = [r for r in before if doc and r['document_id'] == doc and r['kind'] == 'order']
            if doc and not previous: raise ValueError('Không tìm thấy đơn hàng.')
            if previous:
                versions = d.get('revisions', {})
                if set(versions) != {str(r['id']) for r in previous}: raise ValueError('Đơn hàng đã thay đổi. Tải lại dữ liệu.')
                for r in previous: check_revision(r, {'revision': versions[str(r['id'])]})
            affected.update(r['product_id'] for r in previous)
            if path.endswith('/delete'):
                if not doc: raise ValueError('Thiếu mã đơn hàng.')
                c.execute("DELETE FROM movements WHERE document_id=? AND kind='order'", (doc,))
            else:
                doc = doc or 'DH-' + uuid.uuid4().hex[:12].upper()
                dt = clean(d.get('date')); date.fromisoformat(dt)
                party = clean(d.get('party'))
                if not party: raise ValueError('Chọn khách hàng cho đơn hàng.')
                lines = d.get('lines')
                if not isinstance(lines, list) or not 1 <= len(lines) <= 100: raise ValueError('Đơn hàng cần từ 1 đến 100 dòng sản phẩm.')
                old = {r['id']: r for r in previous}
                kept = set()
                for line in lines:
                    identifier = int(line['id']) if line.get('id') else None
                    if identifier and (identifier not in old or identifier in kept): raise ValueError('Dòng đơn hàng không hợp lệ.')
                    mid = save_row(c, line, 'order', dt, party, doc, old.get(identifier))
                    saved.append(mid); kept.add(mid)
                for mid in old.keys() - kept: c.execute('DELETE FROM movements WHERE id=?', (mid,))
                c.execute('INSERT OR IGNORE INTO customers(name,province) VALUES(?,?)', (party, ''))
        elif path in ('/api/movement', '/api/movement/delete'):
            existing = next((r for r in before if str(r['id']) == str(d.get('id'))), None)
            if d.get('id') and not existing: raise ValueError('Phiếu không còn tồn tại.')
            if existing:
                if existing['kind'] == 'order': raise ValueError('Sửa/xóa đơn tại mục Lên đơn.')
                check_revision(existing, d); affected.add(existing['product_id'])
            if path.endswith('/delete'):
                if not existing: raise ValueError('Thiếu mã phiếu.')
                c.execute('DELETE FROM movements WHERE id=?', (existing['id'],))
            else:
                kind = d.get('kind'); dt = clean(d.get('date')); date.fromisoformat(dt)
                if kind not in ('in', 'out'): raise ValueError('Loại phiếu không hợp lệ.')
                party = clean(d.get('party'))
                saved.append(save_row(c, d, kind, dt, party, existing=existing))
                if party:
                    if kind == 'in': c.execute('INSERT OR IGNORE INTO suppliers(name) VALUES(?)', (party,))
                    else: c.execute('INSERT OR IGNORE INTO customers(name,province) VALUES(?,?)', (party, ''))
        else: raise ValueError('Chức năng không tồn tại.')
        after = rows(c)
        affected.update(r['product_id'] for r in after if r['id'] in saved)
        validate_change(before, after, affected)
        allocations = fifo([r for r in after if r['product_id'] in affected])
        result = {'ok': True, 'fifo': {str(mid): allocations.get(mid) for mid in saved}, 'saved_ids': saved}
        if preview: c.rollback()
        else:
            c.execute('INSERT INTO audit(action,before_json,after_json) VALUES(?,?,?)', (path, json.dumps([r for r in before if r['product_id'] in affected], ensure_ascii=False), json.dumps([r for r in after if r['product_id'] in affected], ensure_ascii=False)))
            c.commit()
        return result
    except Exception:
        c.rollback(); raise
