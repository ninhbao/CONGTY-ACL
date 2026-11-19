import sqlite3
import tempfile
import unittest
from pathlib import Path
import server
from ledger import fifo, rows

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();server.DB=Path(self.temp.name)/'test.sqlite3';self.c=server.connect()
        server.mutate(self.c,'/api/product',dict(name='Hàng A',unit='Chai',package='Thùng',pack=12,price=1000))
        server.mutate(self.c,'/api/product',dict(name='Hàng B',unit='Gói',package='Bao',pack=20,price=2000))
    def tearDown(self):self.c.close();self.temp.cleanup()
    def move(self,kind,qty,dt='2026-11-19',pid=1,**extra):
        r=server.mutate(self.c,'/api/movement',dict(kind=kind,qty=qty,date=dt,product_id=pid,**extra))
        return next(m for m in rows(self.c) if m['id']==r['saved_ids'][0])
    def stock(self,pid=1):return next(p['stock'] for p in server.snapshot(self.c)['products'] if p['id']==pid)
    def order(self,lines,**extra):
        return server.mutate(self.c,'/api/order',dict(date='2026-11-19',party='Khách mẫu',lines=lines,**extra))
    def document(self):
        ms=[m for m in rows(self.c) if m['kind']=='order']
        return dict(document_id=ms[0]['document_id'],revisions={str(m['id']):m['revision'] for m in ms})
    def test_fifo_receipt_date_not_manufacture_date(self):
        a=self.move('in',5,'2026-11-01',manufactured='2026-10-20')
        b=self.move('in',10,'2026-11-02',manufactured='2026-09-01')
        out=self.move('out',8)
        lots=fifo(rows(self.c))[out['id']]['lots']
        self.assertEqual([(l['receipt_id'],l['qty'],l['manufactured']) for l in lots],[(a['id'],5,'2026-10-20'),(b['id'],3,'2026-09-01')])
    def test_fifo_missing_manufacture_stays_blank(self):
        self.move('in',10);out=self.move('out',2,manufactured='2020-01-01')
        self.assertEqual(fifo(rows(self.c))[out['id']]['lots'][0]['manufactured'],'')
        self.assertEqual(out['manufactured'],'')
    def test_order_multiline_deduct_once(self):
        self.move('in',30);self.move('in',40,pid=2)
        self.order([dict(product_id=1,qty=1,input_unit='Thùng'),dict(product_id=2,qty=1,input_unit='Bao')])
        self.assertEqual((self.stock(),self.stock(2)),(18,20))
        self.assertEqual(len([m for m in rows(self.c) if m['kind']=='order']),2)
    def test_order_edit_delete_reverses_stock(self):
        self.move('in',10);self.order([dict(product_id=1,qty=4)])
        m=next(m for m in rows(self.c) if m['kind']=='order')
        self.order([dict(id=m['id'],product_id=1,qty=7)],**self.document());self.assertEqual(self.stock(),3)
        server.mutate(self.c,'/api/order/delete',self.document());self.assertEqual(self.stock(),10)
    def test_duplicate_order_lines_cannot_overdraw(self):
        self.move('in',10)
        with self.assertRaises(ValueError):self.order([dict(product_id=1,qty=6),dict(product_id=1,qty=6)])
        self.assertEqual(self.stock(),10);self.assertEqual(len(rows(self.c)),1)
    def test_order_atomic_when_one_product_short(self):
        self.move('in',10)
        with self.assertRaises(ValueError):self.order([dict(product_id=1,qty=3),dict(product_id=2,qty=1)])
        self.assertEqual(self.stock(),10)
    def test_update_issue_and_delete(self):
        self.move('in',10);out=self.move('out',5)
        out=self.move('out',2,id=out['id'],revision=out['revision']);self.assertEqual(self.stock(),8)
        server.mutate(self.c,'/api/movement/delete',dict(id=out['id'],revision=out['revision']));self.assertEqual(self.stock(),10)
    def test_receipt_delete_and_reduce_blocked_when_consumed(self):
        receipt=self.move('in',10);self.move('out',8)
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/movement/delete',receipt)
        with self.assertRaises(ValueError):self.move('in',5,id=receipt['id'],revision=receipt['revision'])
        self.assertEqual(self.stock(),2)
    def test_delete_unused_receipt(self):
        receipt=self.move('in',10);server.mutate(self.c,'/api/movement/delete',receipt);self.assertEqual(self.stock(),0)
    def test_receipt_edit_reallocates_dates(self):
        r=self.move('in',10,manufactured='2026-10-01');out=self.move('out',3)
        self.move('in',10,id=r['id'],revision=r['revision'],manufactured='2026-10-02')
        self.assertEqual(fifo(rows(self.c))[out['id']]['lots'][0]['manufactured'],'2026-10-02')
    def test_receipt_edit_cannot_move_after_consumption(self):
        r=self.move('in',10,'2026-11-01');self.move('out',3,'2026-11-02')
        with self.assertRaises(ValueError):self.move('in',10,'2026-11-03',id=r['id'],revision=r['revision'])
    def test_custom_unit_persists_with_conversion(self):
        self.move('in',2,input_unit='Hộp',factor=6)
        self.move('out',1,input_unit='Hộp')
        self.assertEqual(self.stock(),6)
        self.assertIn('Hộp',server.snapshot(self.c)['units'])
    def test_unknown_unit_requires_explicit_factor(self):
        with self.assertRaises(ValueError):self.move('in',2,input_unit='Kg')
        self.assertEqual(self.stock(),0)
    def test_base_unit_cannot_fake_factor(self):
        self.move('in',2,input_unit='Chai',factor=1000);self.assertEqual(self.stock(),2)
    def test_stale_edit_or_delete_rejected(self):
        r=self.move('in',10);self.move('in',11,id=r['id'],revision=r['revision'])
        with self.assertRaises(ValueError):self.move('in',20,id=r['id'],revision=r['revision'])
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/movement/delete',r)
        self.assertEqual(self.stock(),11)
    def test_preview_does_not_write(self):
        self.move('in',10)
        before=[dict(r) for r in self.c.execute('SELECT * FROM audit')]
        r=server.mutate(self.c,'/api/preview',dict(kind='out',date='2026-11-19',product_id=1,qty=2))
        self.assertEqual(r['fifo'][str(r['saved_ids'][0])]['lots'][0]['qty'],2)
        self.assertEqual(self.stock(),10);self.assertEqual(len(rows(self.c)),1)
        self.assertEqual(before,[dict(r) for r in self.c.execute('SELECT * FROM audit')])
    def test_supplier_and_customer_separate(self):
        self.move('in',10,party='Nhà cung cấp A');self.move('out',2,party='Khách B')
        s=server.snapshot(self.c)
        self.assertEqual([p['name'] for p in s['suppliers']],['Nhà cung cấp A'])
        self.assertEqual([p['name'] for p in s['customers']],['Khách B'])
    def test_order_cannot_edit_as_movement(self):
        self.move('in',10);self.order([dict(product_id=1,qty=2)]);m=next(r for r in rows(self.c) if r['kind']=='order')
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/movement/delete',m)
    def test_deleted_line_restores_product_stock(self):
        self.move('in',10);self.move('in',10,pid=2)
        self.order([dict(product_id=1,qty=3),dict(product_id=2,qty=4)])
        m=next(r for r in rows(self.c) if r['kind']=='order' and r['product_id']==1)
        self.order([dict(id=m['id'],product_id=1,qty=2)],**self.document())
        self.assertEqual((self.stock(),self.stock(2)),(8,10))
    def test_base_unit_rename_updates_all_history(self):
        self.move('in',30,manufactured='2026-10-01');self.move('out',3)
        self.order([dict(product_id=1,qty=2)])
        before=rows(self.c)
        server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Gói',expected_unit='Chai'))
        after=rows(self.c)
        self.assertEqual(self.stock(),25)
        for old,new in zip(before,after):
            self.assertEqual(new['unit'],'Gói');self.assertEqual(new['entered_unit'],'Gói')
            self.assertEqual(new['qty'],old['qty']);self.assertEqual(new['manufactured'],old['manufactured'])
            self.assertEqual(new['revision'],old['revision']+1)
        self.assertEqual(fifo(after)[after[-1]['id']]['lots'][0]['unit'],'Gói')
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/movement/delete',before[1])
    def test_rename_preserves_pack_conversion_and_other_products(self):
        self.move('in',2,input_unit='Thùng');self.move('in',5,pid=2)
        server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Kg',package='Thùng',pack=12))
        ms=rows(self.c);self.assertEqual((ms[0]['qty'],ms[0]['entered_qty'],ms[0]['entered_unit'],ms[0]['factor']),(24,2,'Thùng',12))
        self.assertEqual(ms[1]['unit'],'Gói')
    def test_rename_normalizes_mixed_legacy_units(self):
        self.move('in',10)
        self.c.execute("INSERT INTO movements(product_id,kind,date,qty,unit) VALUES(1,'out','2026-11-19',2,'Kg')");self.c.commit()
        server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Gói'))
        self.assertTrue(all(m['unit']=='Gói' and m['entered_unit']=='Gói' for m in rows(self.c)))
        self.assertEqual(self.stock(),8)
    def test_rename_collision_and_stale_product_are_rejected(self):
        self.move('in',2,input_unit='Thùng')
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Thùng',package='Thùng',pack=12))
        self.assertEqual(rows(self.c)[0]['unit'],'Chai')
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Kg',expected_unit='Gói'))
    def test_rename_to_former_conversion_unit_keeps_quantity(self):
        self.move('in',2,input_unit='Hộp',factor=6)
        server.mutate(self.c,'/api/product',dict(id=1,name='Hàng A',unit='Hộp'))
        m=rows(self.c)[0];self.assertEqual((m['qty'],m['entered_qty'],m['factor']),(12,12,1))
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM product_units WHERE product_id=1 AND name=?',('Hộp',)).fetchone()[0],0)
    def test_audit_records_changes(self):
        r=self.move('in',10);server.mutate(self.c,'/api/movement/delete',r)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM audit').fetchone()[0],2)
    def test_deleted_ids_not_reused(self):
        old=self.move('in',10);server.mutate(self.c,'/api/movement/delete',old)
        new=self.move('in',20);self.assertNotEqual(old['id'],new['id'])
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/movement/delete',old)
        self.assertEqual(self.stock(),20)
    def test_dispatch_order_does_not_deduct_twice(self):
        self.move('in',20,manufactured='2026-10-01');self.order([dict(product_id=1,qty=7)])
        self.assertEqual(self.stock(),13);before=len(rows(self.c))
        r=server.mutate(self.c,'/api/order/dispatch',dict(self.document(),date='2026-11-20',note='Giao hàng'))
        self.assertEqual(self.stock(),13);self.assertEqual(len(rows(self.c)),before)
        m=next(m for m in server.snapshot(self.c)['movements'] if m['kind']=='order')
        self.assertEqual(m['shipment']['number'],r['shipment']['number']);self.assertEqual(m['shipment']['date'],'2026-11-20')
        self.assertEqual(m['fifo']['lots'][0]['manufactured'],'2026-10-01')
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/order/dispatch',dict(self.document(),date='2026-11-20'))
        self.assertEqual(self.stock(),13)
    def test_dispatch_stale_and_early_dates_rejected(self):
        self.move('in',10);self.order([dict(product_id=1,qty=3)])
        old=self.document()
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/order/dispatch',dict(old,date='2026-11-18'))
        m=next(r for r in rows(self.c) if r['kind']=='order')
        self.order([dict(id=m['id'],product_id=1,qty=4)],**old)
        with self.assertRaises(ValueError):server.mutate(self.c,'/api/order/dispatch',dict(old,date='2026-11-19'))
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM order_shipments').fetchone()[0],0)
    def test_edit_and_delete_dispatched_order_are_linked(self):
        self.move('in',10);self.order([dict(product_id=1,qty=3)])
        server.mutate(self.c,'/api/order/dispatch',dict(self.document(),date='2026-11-20'))
        m=next(r for r in rows(self.c) if r['kind']=='order')
        self.order([dict(id=m['id'],product_id=1,qty=4)],**self.document());self.assertEqual(self.stock(),6)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM order_shipments').fetchone()[0],1)
        server.mutate(self.c,'/api/order/delete',self.document());self.assertEqual(self.stock(),10)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM order_shipments').fetchone()[0],0)

if __name__=='__main__':unittest.main()
