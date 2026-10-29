"""MORACHI UAT Finance. SWA admin role is mandatory at reverse proxy.

IMPORTANT: HTTP functions below are ANONYMOUS to the Functions host.
Only expose through protected Static Web Apps /api/finance/* route; do not
expose the standalone Functions endpoint publicly. The backend hard-locks mrc-uat.
"""
import json
import os
import uuid
import re
from datetime import datetime, timezone, date, timedelta
from urllib.parse import urlparse

import azure.functions as func
from azure.cosmos import CosmosClient
from azure.core import MatchConditions
from finance_logic import build_report, period_range, window_for, utc_iso, legacy_cost_key, order_day, is_cancelled

finance_bp = func.Blueprint()
ACCOUNT = (
    os.environ.get("COSMOS_ALLOWED_ACCOUNT") or "mrc-uat"
).strip().lower()
CATEGORIES = {'shipping_jp','carton','tape','shipping_vn','packing','other'}
MAX_BODY_BYTES = 8000

def response(data, status=200):
    return func.HttpResponse(json.dumps(data,ensure_ascii=False), status_code=status,
        mimetype='application/json', headers={'Cache-Control':'no-store'})

def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def finance_container():
    url = (os.environ.get('COSMOS_URL') or '').strip()
    key = os.environ.get('COSMOS_KEY') or ''
    db = os.environ.get('COSMOS_DB_NAME') or 'morachi-db'
    collection = os.environ.get('COSMOS_CONTAINER_NAME') or 'products'
    host = (urlparse(url).hostname or '').lower()
    if (urlparse(url).scheme != 'https' or host != f'{ACCOUNT}.documents.azure.com'
            or db != 'morachi-db' or collection != 'products'):
        raise PermissionError(
            "Kết nối Cosmos DB không khớp cấu hình cho phép"
    )
    if not key: raise RuntimeError('Thiếu COSMOS_KEY cho UAT')
    c = CosmosClient(url,credential=key).get_database_client(db).get_container_client(collection)
    if c.read().get('partitionKey',{}).get('paths') != ['/brand']:
        raise RuntimeError('Partition key khác /brand; cần kiểm tra schema')
    return c

def query(ct, sql, params=None):
    return list(ct.query_items(query=sql, parameters=params or [],enable_cross_partition_query=True))

def read_body(req):
    data = req.get_body()
    if not data or len(data)>MAX_BODY_BYTES: raise ValueError('Dữ liệu rỗng hoặc quá lớn')
    try: obj = json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeError): raise ValueError('JSON không hợp lệ')
    if not isinstance(obj,dict): raise ValueError('JSON phải là object')
    return obj

def validate_expense(data):
    category = str(data.get('category') or '')
    currency = str(data.get('currency') or '')
    if category not in CATEGORIES: raise ValueError('Loại chi phí không hợp lệ')
    if currency not in ('JPY','VND'): raise ValueError('Tiền tệ phải là JPY hoặc VND')
    amount = data.get('amount')
    if isinstance(amount,bool) or not isinstance(amount,int) or not 1<=amount<=1_000_000_000:
        raise ValueError('Số tiền phải là số nguyên dương (tối đa 1 tỷ)')
    raw_date = str(data.get('date') or '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',raw_date): raise ValueError('Ngày phát sinh không hợp lệ')
    try: date.fromisoformat(raw_date)
    except ValueError: raise ValueError('Ngày phát sinh không tồn tại')
    name = str(data.get('name') or '').strip()[:100]
    if category == 'other' and not name: raise ValueError('Vui lòng nhập tên chi phí khác')
    batch = str(data.get('batch') or '').strip()[:80]
    note = str(data.get('note') or '').strip()[:500]
    return {'category':category,'currency':currency,'amount':amount,'date':raw_date,
            'name': name if category=='other' else '', 'batch':batch,'note':note,
            'rate':170, 'amount_vnd':amount*(170 if currency=='JPY' else 1)}

@finance_bp.route(route='finance/report',methods=['GET'])
def get_finance_report(req:func.HttpRequest)->func.HttpResponse:
    try:
        mode=req.params.get('mode','day')
        if mode not in ('day','month'): return response({'error':'mode không hợp lệ'},400)
        from zoneinfo import ZoneInfo
        today=datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).date().isoformat()
        period=req.params.get('period') or (today if mode=='day' else today[:7])
        start,end=window_for(mode,period)
        ct=finance_container()
        orders=query(ct,'''SELECT * FROM c WHERE c.type = 'order' AND c.created_at >= @from AND c.created_at < @to''',
                    [{'name':'@from','value':utc_iso(start)}, {'name':'@to','value':utc_iso(end)}])
        products=query(ct,"SELECT c.id, c.title, c.brand, c.variants FROM c WHERE NOT IS_DEFINED(c.type) AND IS_DEFINED(c.variants)")
        costs=query(ct,'''SELECT * FROM c WHERE c.type = 'expense' AND c.date >= @from AND c.date < @to''',
                    [{'name':'@from','value':start.isoformat()},{'name':'@to','value':end.isoformat()}])
        legacy_costs=query(ct, "SELECT * FROM c WHERE c.type = 'legacy_cost' AND c.order_month >= @from AND c.order_month <= @to",
            [{'name':'@from','value':start.isoformat()[:7]},
             {'name':'@to','value':(end-timedelta(days=1)).isoformat()[:7]}])
        return response(build_report(orders,products,costs,mode,period,legacy_costs))
    except (ValueError,PermissionError) as ex:
        return response({'error':str(ex)},400)
    except Exception:
        return response({'error':'Không tải được báo cáo; kiểm tra log Functions và cấu hình UAT'},500)

@finance_bp.route(route='finance/expenses',methods=['POST'])
def add_finance_expense(req:func.HttpRequest)->func.HttpResponse:
    try:
        payload=validate_expense(read_body(req))
        ct=finance_container()
        now=utc_now()
        doc={'id':'expense-'+uuid.uuid4().hex, 'brand':'EXPENSE','type':'expense',
             **payload, 'created_at':now,'updated_at':now}
        saved=ct.create_item(body=doc)
        return response({'id':saved['id'],'message':'Đã lưu chi phí lên Cosmos DB UAT'},201)
    except (ValueError,PermissionError) as ex: return response({'error':str(ex)},400)
    except Exception: return response({'error':'Không thể lưu chi phí vào UAT'},500)

@finance_bp.route(route='finance/expenses/{id}',methods=['PUT','DELETE'])
def modify_finance_expense(req:func.HttpRequest)->func.HttpResponse:
    try:
        item_id = req.route_params.get('id','')
        if not re.fullmatch(r'expense-[0-9a-f]{32}',item_id):
            return response({'error':'ID chi phí không hợp lệ'},400)
        etag=req.headers.get('If-Match','').strip()
        if not etag: return response({'error':'Thiếu ETag, tải lại danh sách để tránh ghi đè'},428)
        ct=finance_container()
        current=ct.read_item(item=item_id,partition_key='EXPENSE')
        if current.get('type')!='expense' or current.get('brand')!='EXPENSE':
            return response({'error':'Không tìm thấy bản ghi chi phí'},404)
        if current.get('_etag') != etag:
            return response({'error':'Khoản chi phí đã được cập nhật ở nơi khác; vui lòng tải lại'},409)
        if req.method=='DELETE':
            ct.delete_item(item=item_id,partition_key='EXPENSE',etag=etag,
                           match_condition=MatchConditions.IfNotModified)
            return response({'message':'Đã xóa khoản chi phí trên UAT'})
        payload=validate_expense(read_body(req))
        current.update(payload)
        current['updated_at']=utc_now()
        ct.replace_item(item=item_id,body=current,etag=etag,
                        match_condition=MatchConditions.IfNotModified)
        return response({'message':'Đã cập nhật chi phí trên UAT'})
    except (ValueError,PermissionError) as ex: return response({'error':str(ex)},400)
    except Exception as ex:
        if getattr(ex,'status_code',None) in (409,412):
            return response({'error':'Dữ liệu đã thay đổi; vui lòng tải lại trước khi sửa'},409)
        if getattr(ex,'status_code',None)==404: return response({'error':'Không tìm thấy chi phí'},404)
        return response({'error':'Không thể cập nhật chi phí; kiểm tra log Functions'},500)


# MORACHI_LEGACY_COST_V1: Price corrections for orders whose old product/variant
# names no longer exist in the product catalog. No order/product is rewritten.
@finance_bp.route(route='finance/legacy-costs', methods=['POST','PUT','DELETE'])
def manage_legacy_cost(req:func.HttpRequest)->func.HttpResponse:
    try:
        payload = read_body(req)
        key = str(payload.get('legacy_key') or '').strip()
        month = str(payload.get('order_month') or '').strip()
        if not re.fullmatch(r'[a-f0-9]{64}', key):
            raise ValueError('Mã nhóm giá vốn lịch sử không hợp lệ')
        try: begin, end = period_range('month', month)
        except (ValueError, TypeError): raise ValueError('Tháng không hợp lệ')
        ct = finance_container()  # UAT hard-lock; never writes Production.
        doc_id = 'legacy-cost-' + key
        previous = None
        try:
            previous = ct.read_item(item=doc_id, partition_key='FINANCE_LEGACY_COST')
        except Exception as ex:
            if getattr(ex, 'status_code', None) != 404: raise
        if req.method == 'POST':
            if previous is not None:
                return response({'error':'Giá vốn lịch sử đã có; tải lại trước khi sửa'},409)
            price = payload.get('purchase_price_jpy')
            if type(price) is not int or price <= 0 or price > 10_000_000:
                raise ValueError('Giá nhập JPY phải là số nguyên dương')
            orders = query(ct, "SELECT * FROM c WHERE c.type = 'order' AND c.created_at >= @from AND c.created_at < @to",
                [{'name':'@from','value':utc_iso(begin)}, {'name':'@to','value':utc_iso(end)}])
            matches = []
            for order in orders:
                if is_cancelled(order): continue
                if (order_day(order) or '')[:7] != month: continue
                items = order.get('items') if isinstance(order.get('items'),list) else order.get('products')
                for item in (items if isinstance(items,list) else []):
                    if isinstance(item,dict) and legacy_cost_key(order,item) == key:
                        matches.append(item)
            if not matches:
                return response({'error':'Không tìm thấy dòng đơn chưa hủy tương ứng trong tháng; hãy tải lại báo cáo'},409)
            first = matches[0]
            now = utc_now()
            doc = {'id':doc_id, 'brand':'FINANCE_LEGACY_COST', 'type':'legacy_cost',
                   'legacy_key':key, 'order_month':month,
                   'product_id':str(first.get('id') or '')[:100],
                   'original_brand':str(first.get('brand') or '')[:100],
                   'title':str(first.get('title') or '')[:250],
                   'variant':str(first.get('variant') or '')[:250],
                   'purchase_price_jpy':price,'rate':170,'created_at':now,'updated_at':now}
            ct.create_item(body=doc)
            return response({'message':'Đã lưu giá vốn lịch sử vào UAT; báo cáo sẽ tính lại','matched_lines':len(matches)},201)
        if previous is None or previous.get('type') != 'legacy_cost' or previous.get('order_month') != month:
            return response({'error':'Không tìm thấy nhóm giá vốn lịch sử trong tháng đã chọn'},404)
        etag = str(payload.get('etag') or '').strip()
        if not etag or etag != previous.get('_etag'):
            return response({'error':'Dữ liệu đã thay đổi, vui lòng tải lại trước khi sửa/xóa'},409)
        if req.method == 'DELETE':
            ct.delete_item(item=doc_id,partition_key='FINANCE_LEGACY_COST',
                           etag=etag,match_condition=MatchConditions.IfNotModified)
            return response({'message':'Đã xóa giá vốn lịch sử, báo cáo sẽ tính lại'})
        price = payload.get('purchase_price_jpy')
        if type(price) is not int or price <= 0 or price > 10_000_000:
            raise ValueError('Giá nhập JPY phải là số nguyên dương')
        previous['purchase_price_jpy'] = price
        previous['updated_at'] = utc_now()
        ct.replace_item(item=doc_id,body=previous,etag=etag,
                        match_condition=MatchConditions.IfNotModified)
        return response({'message':'Đã cập nhật giá vốn lịch sử'})
    except (ValueError,PermissionError) as ex:
        return response({'error':str(ex)},400)
    except Exception as ex:
        if getattr(ex,'status_code',None) in (409,412):
            return response({'error':'Xung đột cập nhật; tải lại báo cáo rồi thử lại'},409)
        return response({'error':'Lỗi lưu giá vốn lịch sử. Xem log Azure Functions UAT.'},500)
