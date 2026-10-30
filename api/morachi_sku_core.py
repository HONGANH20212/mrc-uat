"""SKU numbering and lossless variant merges for MORACHI Cosmos DB.

All writes must be protected by SWA admin auth and an unexposed Function backend.
SKU sequence reservation is atomic, with gaps allowed after failed product writes.
"""
import os
import re
from urllib.parse import urlparse

from azure.core import MatchConditions
from azure.cosmos.exceptions import CosmosResourceExistsError

SKU_PATTERN = re.compile(r'^SKU-MOR-(\d{4,})$')
COUNTER_ID = '_morachi_sku_sequence_v1'
COUNTER_BRAND = 'MORACHI_META'
PROTECTED_FIELDS = ('sku', 'purchase_price_jpy', 'cost_vnd', 'min_stock',
                    'low_stock_threshold', 'alert_threshold', 'cost_jpy')


def require_account():
    """Fail closed when the configured Cosmos destination isn't explicitly approved."""
    url = (os.environ.get('COSMOS_URL') or '').strip()
    approved = (os.environ.get('COSMOS_ALLOWED_ACCOUNT') or '').strip().lower()
    host = (urlparse(url).hostname or '').lower()
    if not approved or urlparse(url).scheme != 'https' or host != approved + '.documents.azure.com':
        raise PermissionError('Cấu hình COSMOS_ALLOWED_ACCOUNT không khớp Cosmos URL')
    if (os.environ.get('COSMOS_DB_NAME', 'morachi-db') != 'morachi-db' or
        os.environ.get('COSMOS_CONTAINER_NAME', 'products') != 'products'):
        raise PermissionError('Sai database/container cho quản lý SKU')
    return approved


def all_product_docs(ct):
    return list(ct.query_items(
        query='SELECT c.id, c.variants FROM c WHERE NOT IS_DEFINED(c.type) AND IS_DEFINED(c.id)',
        enable_cross_partition_query=True))


def current_skus(ct):
    all_codes = set()
    high = 0
    for doc in all_product_docs(ct):
        for v in doc.get('variants') or []:
            if not isinstance(v, dict):
                continue
            code = str(v.get('sku') or '').strip().upper()
            if not code:
                continue
            if code in all_codes:
                raise ValueError('Có mã SKU trùng trong DB, cần xử lý trước khi cấp SKU mới')
            all_codes.add(code)
            match = SKU_PATTERN.fullmatch(code)
            if match:
                high = max(high, int(match.group(1)))
    return all_codes, high


def ensure_counter(ct, observed_high):
    """Seed and reconcile counter with existing migrated SKUs; concurrent safe CAS."""
    require_account()
    for _ in range(12):
        try:
            doc = ct.read_item(item=COUNTER_ID, partition_key=COUNTER_BRAND)
        except Exception as e:
            if getattr(e, 'status_code', None) != 404:
                raise
            try:
                ct.create_item(body={
                    'id': COUNTER_ID, 'type': 'sku_counter', 'brand': COUNTER_BRAND,
                    'last': observed_high
                })
            except CosmosResourceExistsError:
                pass
            continue
        previous = int(doc.get('last', 0))
        if previous >= observed_high:
            return
        try:
            ct.patch_item(item=COUNTER_ID, partition_key=COUNTER_BRAND,
                          patch_operations=[{'op': 'set', 'path': '/last', 'value': observed_high}],
                          etag=doc['_etag'], match_condition=MatchConditions.IfNotModified)
            return
        except Exception as e:
            if getattr(e, 'status_code', None) not in (409, 412):
                raise
    raise RuntimeError('Không thể đồng bộ bộ đếm SKU vì xung đột đồng thời')


def reserve_code(ct, reserved):
    for _ in range(50):
        doc = ct.patch_item(item=COUNTER_ID, partition_key=COUNTER_BRAND,
                            patch_operations=[{'op': 'incr', 'path': '/last', 'value': 1}])
        code = f"SKU-MOR-{int(doc['last']):04d}"
        if code.upper() not in reserved:
            reserved.add(code.upper())
            return code
    raise RuntimeError('Không cấp được SKU không trùng')


def add_skus_on_create(ct, variants):
    require_account()
    if not isinstance(variants, list):
        raise ValueError('Danh sách phân loại không hợp lệ')
    if not variants:
        return []
    existing, high = current_skus(ct)
    ensure_counter(ct, high)
    result = []
    for v in variants:
        if not isinstance(v, dict) or not str(v.get('name') or '').strip():
            raise ValueError('Phân loại phải có tên')
        # New product must never be allowed to impersonate an existing SKU.
        item = {k: val for k, val in v.items() if k not in PROTECTED_FIELDS}
        item['sku'] = reserve_code(ct, existing)
        result.append(item)
    return result


def merge_and_assign_on_update(ct, previous, incoming):
    require_account()
    if not isinstance(incoming, list):
        raise ValueError('Danh sách phân loại không hợp lệ')
    old = previous.get('variants') or []
    if not isinstance(old, list):
        old = []
    original_by_sku = {str(v.get('sku')).strip().upper(): (i, v)
                       for i, v in enumerate(old) if isinstance(v, dict) and v.get('sku')}
    existing_codes, high = current_skus(ct)
    used_old = set()
    result = []
    needs_ids = False
    for index, v in enumerate(incoming):
        if not isinstance(v, dict) or not str(v.get('name') or '').strip():
            raise ValueError('Phân loại phải có tên')
        old_variant = None
        supplied = str(v.get('sku') or '').strip().upper()
        if supplied:
            found = original_by_sku.get(supplied)
            if not found or found[0] in used_old:
                raise ValueError('SKU không thuộc sản phẩm này hoặc đã trùng')
            old_index, old_variant = found
            used_old.add(old_index)
        else:
            # Fallback for older Admin versions without hidden SKU fields: exact
            # unique variant name matching only. Never attach cost to wrong color.
            matches = [(i, val) for i, val in enumerate(old)
                       if isinstance(val, dict) and i not in used_old and
                       str(val.get('name') or '').strip().casefold() ==
                       str(v.get('name') or '').strip().casefold()]
            if len(matches) == 1:
                old_index, old_variant = matches[0]
                used_old.add(old_index)
        if old_variant is None:
            needs_ids = True
            item = {k: val for k, val in v.items() if k not in PROTECTED_FIELDS}
            item['sku'] = None
        else:
            item = dict(old_variant)
            item.update({k: val for k, val in v.items() if k not in PROTECTED_FIELDS})
            item['sku'] = old_variant.get('sku') or None
        result.append(item)
    if needs_ids or any(not v.get('sku') for v in result):
        ensure_counter(ct, high)
        for v in result:
            if not v.get('sku'):
                v['sku'] = reserve_code(ct, existing_codes)
    if len({v['sku'] for v in result}) != len(result):
        raise ValueError('SKU bị trùng trong danh sách phân loại')
    return result
