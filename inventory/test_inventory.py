import io, tempfile, unittest
from pathlib import Path
import openpyxl
import server
from importer import parse_excel

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); server.DB=Path(self.tmp.name)/'test.sqlite3'; self.c=server.connect()
        server.mutate(self.c,'/api/product',dict(name='Sản phẩm A',pack=12,price=5000,unit='Chai'))
    def tearDown(self): self.c.close(); self.tmp.cleanup()
    def move(self,kind,qty,**kw): server.mutate(self.c,'/api/movement',dict(product_id=1,kind=kind,qty=qty,date='2026-11-19',**kw))
    def test_stock_and_conversion(self):
        self.move('in',2,mode='pack');self.move('out',3)
        p=server.snapshot(self.c)['products'][0];self.assertEqual(p['stock'],21);self.assertEqual(p['value'],105000)
    def test_overdraw_atomic(self):
        self.move('in',5)
        with self.assertRaises(ValueError):self.move('out',6)
        self.assertEqual(len(server.snapshot(self.c)['movements']),1)
    def test_cutoff(self):
        self.move('in',5);self.assertEqual(server.snapshot(self.c,'2026-11-18')['products'][0]['stock'],0)
    def test_invalid_quantities(self):
        for q in [0,-1,'NaN','Infinity','abc']:
            with self.assertRaises(ValueError):self.move('in',q)
    def test_backdated_issue_preserves_future_balance(self):
        self.move('in',10);self.move('out',8)
        with self.assertRaises(ValueError):
            server.mutate(self.c,'/api/movement',dict(product_id=1,kind='out',qty=3,date='2026-11-18'))
    def test_missing_price_not_zero(self):
        server.mutate(self.c,'/api/product',dict(name='B'))
        self.assertIsNone(next(p for p in server.snapshot(self.c)['products'] if p['name']=='B')['value'])
    def workbook(self):
        w=openpyxl.Workbook();w.remove(w.active)
        p=w.create_sheet('Hàng hoá');p.append(['Tên','Loại','Brand','Quy cách','Giá','Kiện']);p.append(['Mẫu','Phân bón','ACL',10,2500,'Thùng'])
        c=w.create_sheet('Khách Hàng');c.append(['STT','Tỉnh','Tên']);c.append([1,'Tỉnh mẫu','Đại lý mẫu'])
        n=w.create_sheet('Nhập Kho');n.append([]);n.append([]);n.append(['Ngày','Diễn giải','Brand','Tên','SL','ĐVT','NSX']);
        from datetime import datetime
        n.append([datetime(2026,1,1),'','','Mẫu',20,'Chai']);n.append([None,'','','MẪU',10,'Chai'])
        x=w.create_sheet('Xuất Kho');x.append([]);x.append([]);x.append(['Ngày','Khách','Tên','SL','ĐVT']);x.append([datetime(2026,1,2),'Đại lý mẫu','Mẫu',3,'Chai']);x.append([None,None,'Mẫu',2,'Chai'])
        raw=io.BytesIO();w.save(raw);return raw.getvalue()
    def test_excel_case_and_fill_forward(self):
        d=parse_excel(self.workbook());self.assertEqual(len(d['products']),1);self.assertEqual(len(d['movements']),4);self.assertEqual(d['movements'][1]['date'],'2026-01-01');self.assertEqual(d['movements'][3]['party'],'Đại lý mẫu')
    def test_reimport_blocked(self):
        raw=self.workbook();server.import_data(self.c,raw)
        with self.assertRaises(ValueError):server.import_data(self.c,raw)
        self.assertEqual(len(server.snapshot(self.c)['movements']),4)
    def test_mixed_units_not_valued(self):
        self.move('in',5);self.c.execute("INSERT INTO movements(product_id,kind,date,qty,unit) VALUES(1,'in','2026-11-19',2,'Kg')");self.c.commit()
        p=server.snapshot(self.c)['products'][0];self.assertTrue(p['review']);self.assertIsNone(p['value'])
        with self.assertRaises(ValueError):self.move('out',1)

if __name__=='__main__':unittest.main()
