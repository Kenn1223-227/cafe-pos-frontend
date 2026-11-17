import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useSocketEvents } from '../../socket/useSocketEvents'
import { orderService } from '../../services/orderService'
import { khoService } from '../../services/khoService'
import { useAuthStore } from '../../store/authStore'

// Hàng đợi cũ từng lưu ở localStorage (sai nguồn sự thật) - dọn đi một lần
const KHOA_QUEUE_CU = 'barista_kds_queue'
// Lưới an toàn: kể cả khi socket "chết im lặng", màn hình vẫn tự đồng bộ lại với server
const CHU_KY_DONG_BO_MS = 20000

const NHAN_TRANG_THAI = {
  ChoPhaChe: { text: 'Chờ pha', cls: 'bg-amber-500/20 text-amber-300' },
  DangLam: { text: 'Đang làm', cls: 'bg-sky-500/20 text-sky-300' },
}

const gioHienThi = (v) => {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN')
}

export default function BaristaPage() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  // Hàng đợi = BẢN SAO của server (GET /api/order/dangcho), không tự "nhặt" từ sự kiện socket
  const [queue, setQueue] = useState([])
  const [daTai, setDaTai] = useState(false)
  const [loiDongBo, setLoiDongBo] = useState(false)
  const [lanDongBoCuoi, setLanDongBoCuoi] = useState(null)
  const [hoan, setHoan] = useState(() => new Set()) // món "Hoãn": đẩy xuống cuối, KHÔNG xóa
  const [dangXuLy, setDangXuLy] = useState(() => new Set())
  const [lowStock, setLowStock] = useState([])

  const yeuCauRef = useRef(0) // số thứ tự request gần nhất đã gửi
  const daApDungRef = useRef(0) // số thứ tự request mới nhất đã được áp dụng (bỏ qua phản hồi cũ đến muộn)
  const daThayRef = useRef(null) // tập maCTHD đã thấy; null = chưa tải lần nào (không báo "đơn mới" cho lần đầu)

  const dongBo = useCallback(async () => {
    const stt = ++yeuCauRef.current
    try {
      const ds = await orderService.getDangCho({ silent: true })
      if (stt < daApDungRef.current) return
      daApDungRef.current = stt

      const ids = new Set(ds.map((m) => m.maCTHD))
      if (daThayRef.current) {
        const moi = ds.filter((m) => !daThayRef.current.has(m.maCTHD))
        if (moi.length > 0) {
          const nhanBan = [...new Set(moi.map((m) => m.tenBan || 'Mang đi'))].join(', ')
          toast.success(`🔔 ${moi.length} món mới (${nhanBan})`)
        }
      }
      daThayRef.current = ids

      setQueue(ds)
      setHoan((prev) => new Set([...prev].filter((id) => ids.has(id))))
      setDaTai(true)
      setLoiDongBo(false)
      setLanDongBoCuoi(new Date())
    } catch (err) {
      const status = err.response?.status
      if (status === 401 || (status === 403 && /^Token/i.test(err.response?.data?.message || ''))) {
        toast.error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
        logout()
        navigate('/login', { replace: true })
        return
      }
      setLoiDongBo(true) // giữ nguyên danh sách đang hiển thị, báo mất đồng bộ trên header
    }
  }, [logout, navigate])

  // Mở trang + định kỳ + khi tab/máy tính bảng sáng lại
  useEffect(() => {
    localStorage.removeItem(KHOA_QUEUE_CU)
    const lanDau = setTimeout(dongBo, 0)
    const timer = setInterval(dongBo, CHU_KY_DONG_BO_MS)
    const khiHienLai = () => {
      if (document.visibilityState === 'visible') dongBo()
    }
    document.addEventListener('visibilitychange', khiHienLai)
    return () => {
      clearTimeout(lanDau)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', khiHienLai)
    }
  }, [dongBo])

  useEffect(() => {
    khoService.canhBao().then(setLowStock).catch(() => {})
  }, [])

  // Sự kiện socket chỉ để làm mới SỚM. Dữ liệu luôn lấy lại từ server nên không thể trùng hay sót.
  // 'connect' chạy cả lần đầu lẫn mỗi lần kết nối lại => đơn bị lỡ trong lúc rớt mạng sẽ được bù ngay.
  useSocketEvents({
    connect: dongBo,
    CO_DON_MOI: dongBo,
    MON_DANG_LAM: dongBo,
    MON_DA_XONG: dongBo,
  })

  const handleFinishDish = async (item) => {
    if (dangXuLy.has(item.maCTHD)) return
    setDangXuLy((prev) => new Set(prev).add(item.maCTHD))
    try {
      await orderService.traMon(item.maCTHD)
      toast.success(`Đã trả món: ${item.tenMon}`)
      setQueue((prev) => prev.filter((q) => q.maCTHD !== item.maCTHD))
    } catch {
      // Interceptor đã hiện lỗi (vd. món đã được trả ở máy khác); đồng bộ lại ngay bên dưới
    } finally {
      setDangXuLy((prev) => {
        const n = new Set(prev)
        n.delete(item.maCTHD)
        return n
      })
      dongBo()
    }
  }

  const toggleHoan = (maCTHD) =>
    setHoan((prev) => {
      const n = new Set(prev)
      if (n.has(maCTHD)) n.delete(maCTHD)
      else n.add(maCTHD)
      return n
    })

  // Món chưa hoãn lên trước, giữ nguyên thứ tự gọi (server đã sắp theo thời gian gọi)
  const hienThi = [...queue.filter((q) => !hoan.has(q.maCTHD)), ...queue.filter((q) => hoan.has(q.maCTHD))]

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 flex flex-col">
      <header className="bg-stone-950 px-6 py-4 flex items-center justify-between border-b border-stone-800">
        <div>
          <h1 className="text-xl font-bold text-amber-400">
            🍹 Màn hình KDS Pha Chế (Barista)
          </h1>
          <p className="text-xs text-stone-400">
            Nhân viên: {user?.tenNV} • {queue.length} món đang chờ •{' '}
            {loiDongBo ? (
              <span className="text-red-400 font-semibold">
                ⚠️ Mất đồng bộ với máy chủ, đang thử lại...
              </span>
            ) : (
              <span className="text-emerald-400">
                ● Đồng bộ {lanDongBoCuoi ? lanDongBoCuoi.toLocaleTimeString('vi-VN') : '...'}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={dongBo}
            className="px-4 py-2 bg-stone-800 hover:bg-stone-700 rounded-xl text-xs font-semibold cursor-pointer"
          >
            ↻ Tải lại
          </button>
          <button
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl text-xs font-semibold cursor-pointer"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      {/* Thanh cảnh báo nguyên liệu sắp hết */}
      {lowStock.length > 0 && (
        <div className="bg-red-950/80 border-b border-red-800 px-6 py-2.5 text-xs text-red-200 flex items-center gap-2 overflow-x-auto">
          <span className="font-bold shrink-0">⚠️ Cảnh báo tồn kho thấp:</span>
          {lowStock.map((nl) => (
            <span
              key={nl.maNL}
              className="px-2.5 py-0.5 rounded-full bg-red-900/90 border border-red-700 shrink-0"
            >
              {nl.tenNL}: còn {nl.tonKho} {nl.donViTinh}
            </span>
          ))}
        </div>
      )}

      <main className="flex-1 p-6">
        {!daTai ? (
          <div className="h-96 flex flex-col items-center justify-center text-stone-500">
            <p className="text-4xl mb-3">⏳</p>
            <p className="text-lg font-medium">
              {loiDongBo ? 'Chưa tải được danh sách đơn, đang thử lại...' : 'Đang tải danh sách đơn...'}
            </p>
          </div>
        ) : queue.length === 0 ? (
          <div className="h-96 flex flex-col items-center justify-center text-stone-500">
            <p className="text-4xl mb-3">☕</p>
            <p className="text-lg font-medium">Hiện không có món nào đang chờ pha chế</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {hienThi.map((item) => {
              const dangHoan = hoan.has(item.maCTHD)
              const nhan = NHAN_TRANG_THAI[item.trangThaiPhaChe]
              return (
                <div
                  key={item.maCTHD}
                  className={`bg-stone-800 border-2 rounded-2xl p-5 flex flex-col justify-between shadow-lg ${
                    dangHoan ? 'border-stone-600 opacity-60' : 'border-amber-500/80'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between text-xs text-stone-400 pb-2 border-b border-stone-700">
                      <span className="font-bold text-amber-400 text-sm">
                        {item.tenBan || 'Mang đi'}
                      </span>
                      <span>
                        {gioHienThi(item.thoiGianGoi)} • #{item.maHoaDon}
                      </span>
                    </div>

                    <div className="my-4">
                      <div className="flex items-baseline justify-between">
                        <h3 className="text-xl font-bold text-white">{item.tenMon}</h3>
                        <span className="ml-2 px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-bold text-sm">
                          Size {item.kichThuoc}
                        </span>
                      </div>
                      <p className="text-2xl font-extrabold text-emerald-400 mt-2">
                        Số lượng: x{item.soLuong}
                      </p>

                      {nhan && (
                        <span className={`inline-block mt-2 px-2 py-0.5 rounded text-[11px] font-bold ${nhan.cls}`}>
                          {nhan.text}
                        </span>
                      )}

                      {/* Topping khách đã trả tiền: BẮT BUỘC hiển thị để barista không bỏ sót */}
                      {item.toppings?.length > 0 && (
                        <div className="mt-2 p-2.5 rounded-xl bg-stone-900 border border-amber-700/50 text-sm text-amber-100 space-y-0.5">
                          {item.toppings.map((t) => (
                            <p key={t.maTopping} className="font-semibold">
                              + {t.tenTopping} ×{t.soLuong}
                            </p>
                          ))}
                        </div>
                      )}

                      {item.ghiChu && (
                        <p className="mt-2 p-2.5 rounded-xl bg-stone-900 text-amber-200 text-xs italic">
                          📝 Ghi chú: {item.ghiChu}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2 pt-3 border-t border-stone-700">
                    <button
                      onClick={() => handleFinishDish(item)}
                      disabled={dangXuLy.has(item.maCTHD)}
                      className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-stone-600 text-white font-bold rounded-xl text-sm transition cursor-pointer"
                    >
                      ✓ Hoàn thành / Trả món
                    </button>
                    <button
                      onClick={() => toggleHoan(item.maCTHD)}
                      className="px-3 py-3 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl text-xs cursor-pointer"
                      title="Đẩy xuống cuối danh sách (món vẫn còn trong hàng đợi)"
                    >
                      {dangHoan ? 'Bỏ hoãn' : 'Hoãn'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
