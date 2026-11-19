"""Read ACL workbooks without modifying them or evaluating executable content."""
import io
import math
import unicodedata
from collections import Counter
from datetime import datetime, date
import openpyxl

def clean(value):
    return unicodedata.normalize('NFC', str(value or '')).strip()

def number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None

def day(value):
    return value.date().isoformat() if isinstance(value, datetime) else value.isoformat() if isinstance(value, date) else None

def parse_excel(raw):
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    required = ['Hàng hoá', 'Khách Hàng', 'Nhập Kho', 'Xuất Kho']
    if any(s not in wb.sheetnames for s in required):
        raise ValueError('File cần có các sheet: ' + ', '.join(required))
    products, customers, movements, warnings = {}, [], [], []
    for rowno, row in enumerate(wb['Hàng hoá'].iter_rows(min_row=2, values_only=True), 2):
        name = clean(row[0])
        if not name: continue
        if name in products:
            warnings.append(f'Hàng hoá dòng {rowno}: trùng tên {name}, giữ dòng đầu.'); continue
        pack, price = number(row[3]), number(row[4])
        products[name] = dict(name=name, category=clean(row[1]), brand=clean(row[2]), pack=pack if pack and pack > 0 else None, price=price if price is not None and price >= 0 else None, package=clean(row[5]), unit='', minimum=0)
    for row in wb['Khách Hàng'].iter_rows(min_row=2, values_only=True):
        if clean(row[2]): customers.append(dict(name=clean(row[2]), province=clean(row[1])))
    for sheet, kind, cols in [('Nhập Kho','in',(0,1,3,4,5,6)),('Xuất Kho','out',(0,1,2,3,4,5))]:
        current_day = current_party = None
        for rowno,row in enumerate(wb[sheet].iter_rows(min_row=4, values_only=True),4):
            row=tuple(row)+(None,)*max(0,7-len(row))
            d,p,n,q,u,m = cols
            if day(row[d]): current_day = day(row[d])
            if row[p] is not None: current_party = clean(row[p])
            name = clean(row[n]); qty = number(row[q])
            matched = next((key for key in products if key.casefold() == name.casefold()), None)
            if matched: name = matched
            if not name:
                if qty: warnings.append(f'{sheet} dòng {rowno}: có số lượng nhưng thiếu tên hàng, không nhập.')
                continue
            if qty is None or qty <= 0:
                warnings.append(f'{sheet} dòng {rowno}: số lượng trống/không hợp lệ, không nhập ({name}).'); continue
            if not current_day:
                warnings.append(f'{sheet} dòng {rowno}: thiếu ngày, không nhập ({name}).'); continue
            if name not in products:
                products[name] = dict(name=name, category='Chưa phân loại', brand='', pack=None, price=None, package='', unit='', minimum=0)
                warnings.append(f'{sheet} dòng {rowno}: {name} chưa có trong danh mục.')
            unit=clean(row[u])
            product=products[name]
            if product['unit'] and unit and product['unit'] != unit:
                warnings.append(f'{sheet} dòng {rowno}: đơn vị {unit} khác {product["unit"]} của {name}; cần đối chiếu.')
            if not product['unit']: product['unit']=unit
            movements.append(dict(kind=kind,date=current_day,party=current_party or '',name=name,qty=qty,unit=unit,manufactured=day(row[m]) or '',note=f'{sheet}!{rowno}',source=f'{sheet}:{rowno}'))
    balances=Counter()
    for m in movements: balances[m['name']]+=m['qty']*(1 if m['kind']=='in' else -1)
    for p in products.values():
        if p['price'] is None: warnings.append(f'Thiếu giá nhập: {p["name"]}.')
        if balances[p['name']] < 0: warnings.append(f'Tồn âm: {p["name"]}: {balances[p["name"]]:g}.')
    dates=[m['date'] for m in movements]
    return dict(products=list(products.values()), customers=customers, movements=movements, warnings=warnings,
                summary=dict(sheets=len(wb.sheetnames),products=len(products),customers=len(customers),receipts=sum(m['kind']=='in' for m in movements),issues=sum(m['kind']=='out' for m in movements),start=min(dates) if dates else None,end=max(dates) if dates else None,negative=sum(v<0 for v in balances.values()),missing_prices=sum(p['price'] is None for p in products.values())))
