"""Admin-only inline JPY price update and explicit SKU backfill for one product."""
import base64
import json
import re
import os

import azure.functions as func
from azure.core import MatchConditions
from azure.cosmos import CosmosClient
from morachi_sku_core import require_account, current_skus, ensure_counter, reserve_code

sku_bp = func.Blueprint()
RATE = 170


def resp(payload, status=200):
    return func.HttpResponse(json.dumps(payload, ensure_ascii=False),
                             status_code=status, mimetype='application/json',
                             headers={'Cache-Control': 'no-store'})


def ensure_admin(req):
    # Only safe if backend is NOT directly internet-accessible: direct callers
    # could forge this header. SWA must be sole trusted reverse proxy.
    principal = req.headers.get('x-ms-client-principal') or ''
    if not principal:
        raise PermissionError('Cần đăng nhập quyền morachiadmin')
    try:
        user = json.loads(base64.b64decode(principal).decode('utf-8'))
    except Exception:
        raise PermissionError('Thông tin xác thực Admin không hợp lệ')
    if 'morachiadmin' not in (user.get('userRoles') or []):
        raise PermissionError('Thiếu quyền morachiadmin')


def container():
    require_account()
    return CosmosClient(os.environ['COSMOS_URL'], credential=os.environ['COSMOS_KEY']) \
        .get_database_client('morachi-db').get_container_client('products')


def get_doc(ct, product_id):
    matches = list(ct.query_items(query=(
        'SELECT * FROM c WHERE c.id = @id AND NOT IS_DEFINED(c.type)'),
        parameters=[{'name': '@id', 'value': product_id}], enable_cross_partition_query=True))
    if len(matches) != 1:
        raise ValueError('Không tìm thấy đúng một sản phẩm')
    return matches[0]


def request_body(req):
    if len(req.get_body()) > 4096:
        raise ValueError('Dữ liệu vượt giới hạn')
    body = req.get_json()
    if not isinstance(body, dict) or not isinstance(body.get('product_id'), str):
        raise ValueError('Thiếu product_id')
    if not body.get('expected_etag') or not isinstance(body['expected_etag'], str):
        raise ValueError('Thiếu ETag, vui lòng tải lại dữ liệu')
    return body


def validate_etag(doc, body):
    if doc.get('_etag') != body['expected_etag']:
        raise Conflict('Dữ liệu đã thay đổi; vui lòng tải lại')


class Conflict(Exception):
    pass


@sku_bp.route(route='manage/sku/price', methods=['PUT'])
def update_sku_price(req: func.HttpRequest) -> func.HttpResponse:
    try:
        ensure_admin(req)
        body = request_body(req)
        jpy = body.get('purchase_price_jpy')
        if type(jpy) is not int or not 1 <= jpy <= 1_000_000:
            raise ValueError('Giá JPY phải là số nguyên từ 1 đến 1.000.000')
        if type(body.get('variant_index')) is not int or body['variant_index'] < 0:
            raise ValueError('Variant index không hợp lệ')
        ct = container()
        doc = get_doc(ct, body['product_id'])
        validate_etag(doc, body)
        variants = doc.get('variants') or []
        idx = body['variant_index']
        if idx >= len(variants) or not isinstance(variants[idx], dict):
            raise ValueError('Phân loại không còn tồn tại')
        v = variants[idx]
        if not v.get('sku') or v['sku'] != body.get('sku'):
            raise Conflict('SKU/phân loại không còn khớp; tải lại trang')
        result = ct.patch_item(item=doc['id'], partition_key=doc['brand'],
            patch_operations=[
                {'op':'set','path':f'/variants/{idx}/purchase_price_jpy','value':jpy},
                {'op':'set','path':f'/variants/{idx}/cost_vnd','value':jpy*RATE}
            ], etag=doc['_etag'], match_condition=MatchConditions.IfNotModified)
        return resp({'ok':True, 'sku':v['sku'], 'purchase_price_jpy':jpy,
                     'cost_vnd':jpy*RATE, 'etag':result.get('_etag')})
    except PermissionError as e:
        return resp({'error':str(e)}, 403)
    except Conflict as e:
        return resp({'error':str(e)}, 409)
    except ValueError as e:
        return resp({'error':str(e)}, 400)
    except Exception as e:
        if getattr(e, 'status_code', None) in (409, 412):
            return resp({'error':'Dữ liệu đã thay đổi đồng thời, hãy tải lại'},409)
        return resp({'error':'Không thể lưu giá JPY; kiểm tra Function logs'},500)


@sku_bp.route(route='manage/sku/ensure', methods=['POST'])
def ensure_skus_for_product(req: func.HttpRequest) -> func.HttpResponse:
    """Explicit action for legacy products missing SKU; does not edit prices/stock."""
    try:
        ensure_admin(req)
        body = request_body(req)
        ct = container()
        doc = get_doc(ct, body['product_id'])
        validate_etag(doc, body)
        variants = doc.get('variants') or []
        missing = [i for i, v in enumerate(variants)
                   if isinstance(v, dict) and not str(v.get('sku') or '').strip()]
        if not missing:
            return resp({'ok':True,'created':0})
        if len(missing) > 100:
            raise ValueError('Quá nhiều phân loại, không thể tự cấp SKU trong một lần')
        used, high = current_skus(ct)
        ensure_counter(ct, high)
        ops = [{'op':'set','path':f'/variants/{i}/sku','value':reserve_code(ct, used)}
               for i in missing]
        ct.patch_item(item=doc['id'], partition_key=doc['brand'],
                      patch_operations=ops, etag=doc['_etag'],
                      match_condition=MatchConditions.IfNotModified)
        return resp({'ok':True,'created':len(ops)})
    except PermissionError as e:
        return resp({'error':str(e)},403)
    except Conflict as e:
        return resp({'error':str(e)},409)
    except ValueError as e:
        return resp({'error':str(e)},400)
    except Exception as e:
        if getattr(e,'status_code',None) in (409,412):
            return resp({'error':'Dữ liệu đã thay đổi đồng thời; hãy tải lại'},409)
        return resp({'error':'Không thể cấp SKU; kiểm tra Function logs'},500)
