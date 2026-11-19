# ACL — Quản lý tồn kho

Ứng dụng tiếng Việt chạy trên một máy, dành cho luồng dữ liệu Excel ACL. Giao diện trong trình duyệt, dữ liệu lưu bền vững bằng SQLite.

## Chạy ứng dụng

Cần Python 3.10 trở lên. Mở terminal trong thư mục `inventory` (hoặc thư mục giải nén):

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

Trên Windows, kích hoạt bằng `.venv\Scripts\activate`. Sau đó mở http://127.0.0.1:8765.

Chọn **Nhập Excel** và chọn file kho ACL. File cần bốn sheet Hàng hoá, Khách Hàng, Nhập Kho, Xuất Kho theo cấu trúc nguồn. Chỉ nhập lịch sử một lần khi kho chưa có giao dịch; ứng dụng chặn nhập trùng. Xem **Đối chiếu dữ liệu** ngay sau khi nhập.

## Chức năng

- Tồn đến ngày chọn, tìm kiếm theo hàng/nhãn/loại, lọc tồn âm và cần bổ sung.
- Danh mục hàng hóa, giá nhập, quy cách, ngưỡng tồn tối thiểu.
- Phiếu nhập/xuất theo đơn vị lẻ hoặc số kiện, ngày sản xuất, đối tác và ghi chú.
- Lên đơn nhiều sản phẩm: lưu đơn trừ tồn ngay tại ngày ghi đơn; không tạo thêm phiếu xuất cho cùng đơn để tránh trừ hai lần.
- Sửa/xóa phiếu nhập, phiếu xuất và đơn hàng đã lưu. Tồn và phân bổ lô tự tính lại; thao tác làm thiếu tồn cho giao dịch phía sau bị chặn. Thay đổi được ghi nhật ký trong cơ sở dữ liệu.
- FIFO theo ngày nhập rồi số phiếu nhập. Cùng ngày, nhập được tính trước xuất/lên đơn. Nếu xuất nhiều lô, hiển thị số lượng, ngày sản xuất và phiếu nhập của từng lô. Ngày SX thiếu được giữ trống; không thay bằng ngày nhập.
- Chai, Gói, Xô, Kg, Thùng, Bao và thêm đơn vị riêng. Tồn luôn tính theo đơn vị gốc của sản phẩm; đơn vị khác cần quy cách/hệ số rõ ràng. Hệ số được lưu trên từng dòng để sửa quy cách không đổi lịch sử.
- Phiếu nhập chọn nhà cung cấp; phiếu xuất/lên đơn chọn khách hàng bằng danh sách. Có thể thêm tên mới ngay trong phiếu. File gốc không có danh mục nhà cung cấp riêng, không tự coi cột Diễn giải là danh sách nhà cung cấp.
- Chặn xuất vượt tồn và xuất làm âm tồn ở giao dịch tương lai.
- Danh sách khách hàng, sổ giao dịch có nguồn dòng Excel, xuất CSV, xuất bản sao JSON.
- Lưu dữ liệu trong `data/inventory.sqlite3`, không cần kết nối mạng khi dùng.

## Quy tắc chuyển dữ liệu

- Giá nhập lấy cột E của Hàng hoá. Không sử dụng công thức đơn giá sai cột trong Tồn Kho.
- Ngày trống lấy ngày gần nhất phía trên, đối tác trống lấy đối tác gần nhất phía trên; tương ứng cách ghi nhóm phiếu của file nguồn.
- Tên hàng chuẩn hóa Unicode, bỏ khoảng trắng đầu/cuối, khớp không phân biệt hoa thường. Không tự gộp tên gần giống.
- Số lượng công thức đọc giá trị đã lưu bởi Excel, không tự thực thi công thức. Dòng không có số lượng hợp lệ bị bỏ qua và ghi rõ trong lưu ý.
- Không cộng Sheet1, Sheet2 hay bảng Tồn Kho vào lịch sử để tránh nhân đôi tồn.
- Khi nhập Excel, giữ số lượng và đơn vị nguyên bản. Hàng có nhiều đơn vị được cảnh báo, không tính giá trị và chặn xuất mới. Số tồn của các hàng này chỉ là tổng số ghi trong nguồn, chưa phải lượng tồn đã quy đổi đáng tin cậy. Có thể sửa từng phiếu sau khi đối chiếu đơn vị và hệ số. Các lưu ý từ lần nhập vẫn được giữ làm tham chiếu; trạng thái hiện tại nằm ở Tổng quan.
- Giá trị tồn là tồn nhân giá danh mục, chưa có bình quân giá vốn/FIFO. Giá thiếu là chưa có, không phải 0.
- Tồn mặc định đến hôm nay. Giao dịch tương lai chỉ vào tồn khi chọn ngày tương ứng.

## Sao lưu và khôi phục

Nút Sao lưu xuất JSON để lưu giữ/đối chiếu. Để khôi phục đầy đủ: dừng server, sao chép file `data/inventory.sqlite3` sang nơi an toàn. Khi khôi phục, dừng server rồi thay file này bằng bản sao. Có thể dùng `ACL_DB` để chọn đường dẫn cơ sở dữ liệu khác. Không đưa file dữ liệu lên GitHub.

## Phạm vi sử dụng

Đây là bản cho một máy và một kho. Chưa có đăng nhập, phân quyền, đồng bộ nhiều máy hoặc quản lý hạn sử dụng. Đơn hàng là giao dịch trừ tồn, không phải trạng thái đặt giữ hàng/chờ xuất. FIFO chọn lô để xác định ngày sản xuất, chưa tính giá vốn FIFO. Server chỉ nghe `127.0.0.1`. Không công bố server này trực tiếp lên Internet; GitHub lưu mã nguồn, không lưu dữ liệu vận hành. GitHub Pages không chạy được phần Python/SQLite.

## Nâng cấp từ bản đầu

Dừng ứng dụng, sao lưu `data/inventory.sqlite3`, cập nhật mã rồi chạy lại. Ứng dụng tự thêm các bảng/cột mới, giữ nguyên dữ liệu cũ. Sau đó tải lại trang trình duyệt. Khi hai cửa sổ cùng sửa một phiếu, phiên bản cũ sẽ bị từ chối để tránh ghi đè thay đổi mới.

## Kiểm thử

```sh
python -m unittest -v
```
