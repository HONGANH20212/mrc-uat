#!/usr/bin/env python3
"""MORACHI: patch only admin/index.html and a new CSS override; no API/DB change."""
from pathlib import Path
from datetime import datetime
import argparse
import shutil
import sys

MARKER = 'MORACHI_ADMIN_MOBILE_SCROLL_FIX_20261029'
LINK = '<link rel="stylesheet" href="/admin/mobile-scroll-fix.css?v=20261029-1">'


def change(html):
    if LINK in html or 'mu4-table-scroll' in html:
        raise RuntimeError('Bản vá mobile đã có, không cài chồng.')
    if 'unified-v3.css' not in html or 'id="admin-order-list"' not in html or 'id="admin-product-list"' not in html:
        raise RuntimeError('Thiếu Admin v3 hoặc bảng đơn/sản phẩm. Dừng để tránh sửa sai.')

    pstart = html.index('<div id="section-products"')
    ostart = html.index('<div id="section-orders"', pstart)
    prod = html[pstart:ostart]
    orders = html[ostart:]

    oldp = '<div class="card">\n                <table>'
    newp = ('<div class="card">\n'
            '                <p class="mu4-scroll-note">⇆ Vuốt ngang bảng để xem đủ thông tin sản phẩm và nút thao tác</p>\n'
            '                <div class="mu4-table-scroll" role="region" tabindex="0" aria-label="Bảng sản phẩm, có thể vuốt ngang">\n'
            '                <table>')
    endp = '</table>\n                <div class="table-footer">'
    newendp = '</table>\n                </div>\n                <div class="table-footer">'
    oldo = '<div class="card" style="margin-bottom: 60px;">\n                <table>'
    newo = ('<div class="card" style="margin-bottom: 60px;">\n'
            '                <p class="mu4-scroll-note">⇆ Vuốt ngang bảng để xem tổng tiền, trạng thái và thao tác đơn hàng</p>\n'
            '                <div class="mu4-table-scroll" role="region" tabindex="0" aria-label="Bảng đơn hàng, có thể vuốt ngang">\n'
            '                <table>')
    endo = '</table>\n            </div>\n\n            <!-- Thanh Thao Tác Hàng Loạt -->'
    newendo = '</table>\n                </div>\n            </div>\n\n            <!-- Thanh Thao Tác Hàng Loạt -->'

    for fragment, old, name in [(prod, oldp, 'product table open'), (prod, endp, 'product table close'),
                                (orders, oldo, 'order table open'), (orders, endo, 'order table close')]:
        if fragment.count(old) != 1:
            raise RuntimeError('HTML khác phiên bản đã kiểm tra tại: ' + name)
    prod = prod.replace(oldp, newp, 1).replace(endp, newendp, 1)
    orders = orders.replace(oldo, newo, 1).replace(endo, newendo, 1)
    updated = html[:pstart] + prod + orders
    if updated.count('</head>') != 1:
        raise RuntimeError('HTML thiếu hoặc trùng thẻ </head>')
    updated = updated.replace('</head>', LINK + '\n</head>', 1)
    return updated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', nargs='?', type=Path, default=Path.home()/'MORACHI_SHOP')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    dest_html = root/'admin/index.html'
    dest_css = root/'admin/mobile-scroll-fix.css'
    css = Path(__file__).with_name('mobile-scroll-fix.css').read_text(encoding='utf-8')
    if MARKER not in css:
        raise RuntimeError('CSS không đúng bản vá')
    html = dest_html.read_text(encoding='utf-8')
    changed = change(html)
    if args.check:
        print('CHECK OK: admin/index.html tương thích. Chưa thay đổi file.')
        return
    if dest_css.exists():
        raise RuntimeError('Đã tồn tại admin/mobile-scroll-fix.css; không ghi đè')
    backup_dir = root/'_backup_mobile_scroll'/datetime.now().strftime('%Y%m%d-%H%M%S')
    backup_dir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(dest_html, backup_dir/'index.html')
    try:
        dest_css.write_text(css, encoding='utf-8')
        dest_html.write_text(changed, encoding='utf-8')
    except Exception:
        shutil.copy2(backup_dir/'index.html',dest_html)
        dest_css.unlink(missing_ok=True)
        raise
    print('UPDATED: admin/index.html')
    print('CREATED: admin/mobile-scroll-fix.css')
    print('BACKUP :', backup_dir/'index.html')
    print('KHÔNG sửa admin.js, API, đơn hàng, Cosmos DB.')

if __name__ == '__main__':
    try: main()
    except Exception as err:
        print('STOP:', err, file=sys.stderr)
        sys.exit(1)
