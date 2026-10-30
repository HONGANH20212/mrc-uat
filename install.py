#!/usr/bin/env python3
"""Install MORACHI auto-SKU and inline JPY without overwriting unrelated files.

Usage: python3 install.py ~/MORACHI_SHOP --check | --apply
"""
import argparse
import ast
import datetime
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'package'
MARK = 'MORACHI_AUTO_SKU_JPY_20261030'


def need_once(source, old, label):
    matches = source.count(old)
    if matches != 1:
        raise ValueError(f'{label}: cần đúng 1 vị trí, tìm thấy {matches}; source khác bản mẫu')


def build_function(source):
    if MARK in source:
        raise ValueError('api/function_app.py đã cài chức năng này')
    old = 'app.register_functions(jpy_import_bp)'
    need_once(source, old, 'register sku blueprint')
    source = source.replace(old, old + '''

# MORACHI_AUTO_SKU_JPY_20261030
from morachi_sku_api import sku_bp
from morachi_sku_core import add_skus_on_create, merge_and_assign_on_update
app.register_functions(sku_bp)
''', 1)
    old = 'product = normalize_product(body)'
    need_once(source, old, 'product POST')
    source = source.replace(old, old + '''
            # New variants receive unique SKU-MOR-xxxx on the backend.
            product['variants'] = add_skus_on_create(container, product.get('variants', []))''', 1)
    old = 'updated = normalize_product(body, existing)'
    need_once(source, old, 'product PUT')
    source = source.replace(old, old + '''
            # Preserve original SKU/JPY/cost fields; assign only for new variants.
            updated['variants'] = merge_and_assign_on_update(
                container, existing, updated.get('variants', []))''', 1)
    # Existing source used blind replace; ETag detects edits racing with JPY updates.
    old = 'container.replace_item(item=p_id, body=updated)'
    need_once(source, old, 'optimistic product save')
    source = source.replace(old, '''container.replace_item(
                    item=p_id, body=updated, etag=existing['_etag'],
                    match_condition=MatchConditions.IfNotModified)''', 1)
    ast.parse(source)
    return source


def build_admin_js(source):
    if MARK in source:
        raise ValueError('admin/admin.js đã cài chức năng này')
    old = '''    container.appendChild(row);
}

window.editProduct ='''
    need_once(source, old, 'variant edit field')
    new = '''    // MORACHI_AUTO_SKU_JPY_20261030: keep variant identity through edits/renames.
    row.dataset.morachiSku = String(data.sku || '');
    container.appendChild(row);
}

window.editProduct ='''
    source = source.replace(old, new, 1)
    old = '''                    image: vImageUrl
                });'''
    need_once(source, old, 'serialize variant sku')
    source = source.replace(old, '''                    image: vImageUrl,
                    sku: row.dataset.morachiSku || ''
                });''', 1)
    return source


def build_sku_html(source):
    if 'sku-price-inline.js' in source:
        raise ValueError('admin/sku-mobile.html đã cài chức năng này')
    for literal in ('id="sheet"', 'id="variantRow"', 'id="infoGrid"', 'id="grid"'):
        if literal not in source:
            raise ValueError('admin/sku-mobile.html không có thành phần ' + literal)
    need_once(source, '</body>', 'sku mobile inject')
    # Admin-only source includes SKU, purchase_price_jpy and _etag.
    if "const API = '/api/products';" in source:
        source = source.replace("const API = '/api/products';",
                                "const API = '/api/manage/products';", 1)
    source = source.replace('MORACHI · SKU & Tồn kho – UAT', 'MORACHI · SKU & Tồn kho')
    source = source.replace('Đang tải dữ liệu sản phẩm từ UAT...', 'Đang tải dữ liệu từ Cosmos DB...')
    source = source.replace(
        'Bản này chỉ đọc dữ liệu. Muốn sửa tồn kho/giá nhập cần bổ sung API và quyền ghi UAT trong bước tiếp theo.',
        'Admin có thể cấp SKU thiếu và nhập giá JPY ngay phía trên. Giá vốn tự tính JPY × 170; tồn kho và giá bán không thay đổi.')
    return source.replace('</body>',
        '<!-- MORACHI_AUTO_SKU_JPY_20261030 -->\n'
        '<script src="/admin/sku-price-inline.js?v=20261030"></script>\n</body>', 1)


def build_config(source):
    cfg = json.loads(source)
    routes = cfg.get('routes')
    if not isinstance(routes, list):
        raise ValueError('staticwebapp.config.json thiếu routes')
    # Preserve existing route order; use specific route with admin role.
    for route in routes:
        if route.get('route') in ('/api/manage/*', '/api/manage/sku/*'):
            roles = route.get('allowedRoles') or []
            if roles != ['morachiadmin']:
                raise ValueError('Route quản trị hiện tại không giới hạn morachiadmin')
            return json.dumps(cfg, indent=2, ensure_ascii=False) + '\n'
    routes.insert(0, {
        'route':'/api/manage/*',
        'allowedRoles':['morachiadmin']
    })
    return json.dumps(cfg, indent=2, ensure_ascii=False) + '\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('project', type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    project = args.project.expanduser().resolve()
    transformers = {
        'api/function_app.py':build_function,
        'admin/admin.js':build_admin_js,
        'admin/sku-mobile.html':build_sku_html,
        'staticwebapp.config.json':build_config,
    }
    staged = {}
    for rel, fn in transformers.items():
        p = project / rel
        if not p.is_file():
            raise ValueError(f'Không thấy file {p}')
        staged[rel] = fn(p.read_text(encoding='utf-8'))
    ast.parse(staged['api/function_app.py'])
    for rel in ('api/morachi_sku_core.py', 'api/morachi_sku_api.py',
                'admin/sku-price-inline.js'):
        dest = project / rel
        if dest.exists():
            raise ValueError(f'STOP: Đã tồn tại {dest}, không ghi đè')
        data = (SRC / rel).read_text(encoding='utf-8')
        if rel.endswith('.py'):
            ast.parse(data)
        staged[rel] = data
    print('CHECK OK: source phù hợp để thêm Auto SKU + JPY')
    for rel in staged:
        print(' ', 'UPDATE' if (project / rel).exists() else 'CREATE', rel)
    if args.check:
        print('Chỉ kiểm tra — CHƯA ghi file hoặc Cosmos DB')
        return
    backup = project / '_backup_sku_jpy' / datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    for rel in transformers:
        (backup / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project / rel, backup / rel)
    for rel, value in staged.items():
        dest = project / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(value, encoding='utf-8')
    print('INSTALLED — backup:', backup)
    print('Chỉ sửa file local. CHƯA DEPLOY, CHƯA ghi dữ liệu Cosmos DB.')
    print('LƯU Ý: Backend Functions phải không thể truy cập công khai trực tiếp.')
    print('COSMOS_ALLOWED_ACCOUNT phải khai báo chính xác account của môi trường.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, SyntaxError) as exc:
        sys.exit('STOP: ' + str(exc))
