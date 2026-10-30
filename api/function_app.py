import os
import re
import json
import uuid
import mimetypes
from datetime import datetime, timedelta
from email.parser import BytesParser
from email.policy import default

import azure.functions as func
from azure.cosmos import CosmosClient
from azure.core import MatchConditions
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

from jpy_import_web import jpy_import_bp
app.register_functions(jpy_import_bp)

# MORACHI_AUTO_SKU_JPY_20261030
from morachi_sku_api import sku_bp
from morachi_sku_core import add_skus_on_create, merge_and_assign_on_update
app.register_functions(sku_bp)


# --- CẤU HÌNH KẾT NỐI (Lấy từ Environment Variables của Azure) ---
COSMOS_URL = os.environ.get("COSMOS_URL")
COSMOS_KEY = os.environ.get("COSMOS_KEY")
COSMOS_DB_NAME = os.environ.get("COSMOS_DB_NAME", "morachi-db")
COSMOS_CONTAINER_NAME = os.environ.get("COSMOS_CONTAINER_NAME", "products")

BLOB_CONNECTION_STRING = os.environ.get("BLOB_CONNECTION_STRING")

BLOB_CONTAINER_NAME = os.environ.get("BLOB_CONTAINER_NAME", "products")

# --- CẤU HÌNH BẢO VỆ ĐƠN HÀNG ---
ORDER_SHIPPING_FEE = int(os.environ.get("ORDER_SHIPPING_FEE", "15000"))
ORDER_MAX_ITEMS = int(os.environ.get("ORDER_MAX_ITEMS", "20"))
ORDER_MAX_QTY_PER_ITEM = int(os.environ.get("ORDER_MAX_QTY_PER_ITEM", "20"))
ORDER_MAX_BODY_BYTES = int(os.environ.get("ORDER_MAX_BODY_BYTES", "65536"))
ORDER_MAX_PER_PHONE_30M = int(os.environ.get("ORDER_MAX_PER_PHONE_30M", "3"))
CORS_ALLOWED_ORIGIN = os.environ.get(
    "CORS_ALLOWED_ORIGIN",
    "https://www.morachi.com.vn"
)

# --- HÀM TRỢ GIÚP (HELPER FUNCTIONS) ---

def cors_headers():
    """Chỉ cho frontend Morachi gọi API từ trình duyệt."""
    return {
        "Access-Control-Allow-Origin": CORS_ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin"
    }

def json_response(data, status_code=200):
    """Trả về dữ liệu dạng JSON chuẩn"""
    return func.HttpResponse(
        json.dumps(data, ensure_ascii=False),
        mimetype="application/json",
        status_code=status_code,
        headers=cors_headers()
    )

def options_response():
    """Xử lý yêu cầu OPTIONS của trình duyệt"""
    return func.HttpResponse(status_code=200, headers=cors_headers())

def get_cosmos_container():
    """Khởi tạo kết nối tới cơ sở dữ liệu Cosmos DB"""
    if not COSMOS_URL or not COSMOS_KEY:
        raise ValueError("Thiếu cấu hình Azure Cosmos DB trong ứng dụng.")
    client = CosmosClient(COSMOS_URL, credential=COSMOS_KEY)
    database = client.get_database_client(COSMOS_DB_NAME)
    return database.get_container_client(COSMOS_CONTAINER_NAME)

def get_blob_container_client():
    """Khởi tạo kết nối tới Azure Blob Storage để lưu ảnh"""
    if not BLOB_CONNECTION_STRING:
        raise ValueError("Thiếu cấu hình Azure Blob Storage.")
    blob_service_client = BlobServiceClient.from_connection_string(BLOB_CONNECTION_STRING)
    return blob_service_client.get_container_client(BLOB_CONTAINER_NAME)

def to_display_order(value, default=999999):
    """Chuẩn hóa thứ tự hiển thị sản phẩm. Số nhỏ sẽ hiển thị trước."""
    try:
        number = int(float(value))
        return number if number > 0 else default
    except (TypeError, ValueError):
        return default

def to_sort_timestamp(value):
    """Chuyển created_at/updated_at sang timestamp để sort phụ, lỗi thì trả 0."""
    try:
        if not value:
            return 0
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


# --- PHÂN LOẠI SẢN PHẨM / TAXONOMY ---
VALID_PRODUCT_CATEGORIES = {"makeup", "skincare", "supplement"}
VALID_MAKEUP_SUBCATEGORIES = {"face", "eyes", "lips", "cheeks", "brows"}

CATEGORY_ALIASES = {
    "makeup": "makeup", "trang diem": "makeup", "trang điểm": "makeup",
    "skincare": "skincare", "cham soc da": "skincare", "chăm sóc da": "skincare",
    "supplement": "supplement", "thuc pham chuc nang": "supplement", "thực phẩm chức năng": "supplement",
}
SUBCATEGORY_ALIASES = {
    "face": "face", "mat": "face", "mặt": "face",
    "eyes": "eyes", "eye": "eyes", "mắt": "eyes",
    "lips": "lips", "lip": "lips", "moi": "lips", "môi": "lips",
    "cheeks": "cheeks", "cheek": "cheeks", "ma": "cheeks", "má": "cheeks",
    "brows": "brows", "brow": "brows", "may": "brows", "mày": "brows",
}

def normalize_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return bool(default)
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "y", "on", "checked"):
        return True
    if text in ("0", "false", "no", "n", "off", "", "none", "null"):
        return False
    return bool(default)

def normalize_category_value(value):
    text = str(value or "").strip().lower()
    return CATEGORY_ALIASES.get(text, text if text in VALID_PRODUCT_CATEGORIES else "")

def normalize_subcategory_value(value):
    text = str(value or "").strip().lower()
    return SUBCATEGORY_ALIASES.get(text, text)

def normalize_collections(value):
    if isinstance(value, list):
        raw = value
    elif value is None:
        raw = []
    else:
        raw = re.split(r"[,;|]", str(value))
    result = []
    seen = set()
    for item in raw:
        text = str(item or "").strip().lower()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result

def apply_product_taxonomy(existing, data):
    """Trả về các field phân loại đã chuẩn hóa, giữ tương thích dữ liệu cũ."""
    existing = existing or {}
    data = data or {}

    raw_category = data.get("category") if "category" in data else existing.get("category", "")
    raw_category_text = str(raw_category or "").strip().lower()
    legacy_highend_category = raw_category_text in ("highend", "2highend", "high end")
    category = normalize_category_value(raw_category)
    subcategory = normalize_subcategory_value(
        data.get("subcategory") if "subcategory" in data else existing.get("subcategory", "")
    )

    # Hiện UI Trang Điểm có 5 nhóm con cố định. Nếu category khác Makeup mà request
    # có gửi subcategory rỗng thì cho phép xóa; còn dữ liệu cũ không gửi thì vẫn giữ.
    if category == "makeup" and subcategory and subcategory not in VALID_MAKEUP_SUBCATEGORIES:
        subcategory = ""

    product_type = str(
        data.get("product_type") if "product_type" in data else existing.get("product_type", "")
    ).strip().lower()

    collections = normalize_collections(
        data.get("collections") if "collections" in data else existing.get("collections", [])
    )
    existing_highend = normalize_bool(existing.get("is_highend"), "highend" in collections)
    if legacy_highend_category:
        existing_highend = True
    is_highend = normalize_bool(data.get("is_highend"), existing_highend) if "is_highend" in data else existing_highend

    # Đồng bộ is_highend <-> collections để frontend cũ/mới đều đọc được.
    collections = [item for item in collections if item != "highend"]
    if is_highend:
        collections.append("highend")

    source = str(
        data.get("category_source") if "category_source" in data else existing.get("category_source", "")
    ).strip().lower()
    if source not in ("manual", "bulk", "suggestion", "migration", ""):
        source = "manual"

    confidence_raw = data.get("category_confidence") if "category_confidence" in data else existing.get("category_confidence")
    try:
        confidence = int(float(confidence_raw)) if confidence_raw not in (None, "") else None
        if confidence is not None:
            confidence = max(0, min(100, confidence))
    except (TypeError, ValueError):
        confidence = None

    return {
        "category": category,
        "subcategory": subcategory,
        "product_type": product_type,
        "is_highend": is_highend,
        "collections": collections,
        "category_source": source,
        "category_confidence": confidence,
    }

def normalize_product(data, existing=None):
    """Chuẩn hóa dữ liệu sản phẩm, hỗ trợ xóa rỗng dữ liệu tùy chọn"""
    existing = existing or {}
    
    def get_field(key, default_val=""):
        # Nếu Admin có gửi lên (ngay cả khi gửi lên chuỗi rỗng ""), thì lấy giá trị đó
        if key in data:
            val = data[key]
            return str(val).strip() if val is not None else ""
        # Nếu không gửi lên, thì mới lấy lại đồ cũ trong database
        return str(existing.get(key, default_val)).strip()

    # Các trường bắt buộc (Không cho phép lưu rỗng)
    title = str(data.get("title", "")).strip() or existing.get("title", "")
    brand = str(data.get("brand", "")).strip() or existing.get("brand", "")
    current_price = str(data.get("current_price", "")).strip() or existing.get("current_price", "")

    product = {
        "title": title.strip() if title else "",
        "brand": brand.strip() if brand else "",
        "current_price": current_price.strip() if current_price else "",
        "thumbnail": get_field("thumbnail"),
        "old_price": get_field("old_price"),
        "discount": get_field("discount"), # Giờ đây nếu admin xóa trắng, nó sẽ lưu rỗng thay vì giữ data cũ
        "rating": get_field("rating", "4.9"),
        "sold_text": get_field("sold_text", "1k/tháng"),
        "description": get_field("description"),
        "specifications": get_field("specifications"),
        "ingredients": get_field("ingredients"),
        "usage_manual": get_field("usage_manual"),
        "status": get_field("status", "active"),
        "variants": data.get("variants") if "variants" in data else existing.get("variants", []),
        # Trường này dùng để đồng bộ thứ tự kéo thả từ admin ra trang chủ trên mọi thiết bị.
        "display_order": to_display_order(
            data.get("display_order") if "display_order" in data else existing.get("display_order"),
            to_display_order(existing.get("display_order"), 999999)
        )
    }
    product.update(apply_product_taxonomy(existing, data))
    return product

def parse_multipart_file(req: func.HttpRequest):
    """Phân tách dữ liệu file gửi từ trình duyệt (form-data)"""
    content_type = req.headers.get("content-type") or req.headers.get("Content-Type")
    if not content_type or "multipart/form-data" not in content_type:
        raise ValueError("Yêu cầu không đúng định dạng multipart/form-data")

    body = req.get_body()
    raw_data = b"Content-Type: " + content_type.encode("utf-8") + b"\r\n\r\n" + body
    msg = BytesParser(policy=default).parsebytes(raw_data)

    for part in msg.iter_parts():
        content_disposition = part.get("Content-Disposition", "")
        if "filename=" in content_disposition:
            filename = part.get_filename()
            file_bytes = part.get_payload(decode=True)
            mime_type = part.get_content_type()
            return filename, file_bytes, mime_type
    
    raise ValueError("Không tìm thấy tệp tin ảnh trong dữ liệu gửi lên.")

# --- ROUTES SẢN PHẨM ---

@app.route(route="upload-image", methods=["POST", "OPTIONS"])
def upload_image(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS": return options_response()
    try:
        filename, file_bytes, mime_type = parse_multipart_file(req)
        if not file_bytes: return json_response({"error": "Dữ liệu tệp tin trống"}, 400)
        
        container_client = get_blob_container_client()
        ext = os.path.splitext(filename)[1].lower() or ".jpg"
        # Tạo đường dẫn lưu ảnh theo Tháng/Năm để dễ quản lý
        blob_name = f"products/{datetime.utcnow().strftime('%Y/%m')}/{uuid.uuid4().hex}{ext}"
        blob_client = container_client.get_blob_client(blob_name)
        
        blob_client.upload_blob(file_bytes, content_settings=ContentSettings(content_type=mime_type))
        return json_response({"message": "Upload thành công", "url": blob_client.url}, 201)
    except Exception as e:
        return json_response({"error": str(e)}, 500)


PUBLIC_FIELDS = {
    "id", "title", "brand", "category", "subcategory",
    "collections", "thumbnail", "description", "current_price",
    "old_price", "discount", "display_order", "status",
    "product_type", "rating", "sold_text", "is_highend",
    "ingredients", "specifications", "usage_manual",
    "created_at", "updated_at"
}
PUBLIC_VARIANT_FIELDS = {
    "name", "image", "price", "status", "stock", "date", "sku"
}

def public_product(p):
    result = {k: v for k, v in p.items() if k in PUBLIC_FIELDS}
    result["variants"] = [
        {k: v for k, v in variant.items() if k in PUBLIC_VARIANT_FIELDS}
        for variant in (p.get("variants") or [])
        if isinstance(variant, dict)
    ]
    return result


@app.route(route="manage/products", methods=["GET"])
def admin_products(req: func.HttpRequest) -> func.HttpResponse:
    container = get_cosmos_container()
    query = "SELECT * FROM c WHERE c.status = 'active' AND NOT IS_DEFINED(c.type)"
    items = list(container.query_items(
        query=query, enable_cross_partition_query=True
    ))
    items.sort(key=lambda x: (
        to_display_order(x.get("display_order"), 999999),
        -to_sort_timestamp(x.get("created_at"))
    ))
    return json_response(items)


@app.route(route="products", methods=["GET", "POST", "OPTIONS"])
def products(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS": return options_response()
    container = get_cosmos_container()
    try:
        if req.method == "GET":
            # Lấy danh sách sản phẩm (Bỏ qua các bản ghi đơn hàng)
            query = "SELECT * FROM c WHERE c.status = 'active' AND NOT IS_DEFINED(c.type)"
            items = list(container.query_items(query=query, enable_cross_partition_query=True))
            # Ưu tiên thứ tự admin đã kéo thả. Sản phẩm chưa có display_order sẽ nằm sau, mới hơn lên trước.
            items.sort(key=lambda x: (
                to_display_order(x.get("display_order"), 999999),
                -to_sort_timestamp(x.get("created_at"))
            ))
            return json_response([public_product(p) for p in items])

        if req.method == "POST":
            body = req.get_json()
            product = normalize_product(body)
            # New variants receive unique SKU-MOR-xxxx on the backend.
            product['variants'] = add_skus_on_create(container, product.get('variants', []))
            now = datetime.utcnow().isoformat() + "Z"
            product.update({
                "id": str(uuid.uuid4()),
                "created_at": now,
                "updated_at": now
            })
            container.create_item(body=product)
            return json_response({"message": "Tạo sản phẩm thành công", "item": product}, 201)

    except Exception as e:
        return json_response({"error": str(e)}, 500)

@app.route(route="products/reorder", methods=["PUT", "OPTIONS"])
def reorder_products(req: func.HttpRequest) -> func.HttpResponse:
    """Lưu thứ tự kéo thả sản phẩm từ admin vào Cosmos DB."""
    if req.method == "OPTIONS": return options_response()
    container = get_cosmos_container()
    try:
        body = req.get_json()
        raw_orders = body.get("orders") or body.get("items") or []
        if not isinstance(raw_orders, list) or not raw_orders:
            return json_response({"error": "Thiếu danh sách thứ tự sản phẩm"}, 400)

        normalized_orders = []
        for index, row in enumerate(raw_orders):
            if not isinstance(row, dict):
                continue
            product_id = str(row.get("id", "")).strip()
            if not product_id:
                continue
            normalized_orders.append({
                "id": product_id,
                "display_order": to_display_order(row.get("display_order"), index + 1)
            })

        if not normalized_orders:
            return json_response({"error": "Danh sách thứ tự không hợp lệ"}, 400)

        updated_count = 0
        now = datetime.utcnow().isoformat() + "Z"

        for order_item in normalized_orders:
            query = "SELECT * FROM c WHERE c.id = @id AND NOT IS_DEFINED(c.type)"
            items = list(container.query_items(
                query=query,
                parameters=[{"name": "@id", "value": order_item["id"]}],
                enable_cross_partition_query=True
            ))
            if not items:
                continue

            product = items[0]
            product["display_order"] = order_item["display_order"]
            product["updated_at"] = now
            container.replace_item(item=product["id"], body=product)
            updated_count += 1

        return json_response({
            "message": "Đã lưu thứ tự sản phẩm",
            "updated": updated_count,
            "total": len(normalized_orders)
        })

    except Exception as e:
        return json_response({"error": str(e)}, 500)


@app.route(route="products/bulk-category", methods=["PUT", "OPTIONS"])
def bulk_product_category(req: func.HttpRequest) -> func.HttpResponse:
    """Gán danh mục hàng loạt cho các sản phẩm đã tick trong Admin."""
    if req.method == "OPTIONS":
        return options_response()

    container = get_cosmos_container()
    try:
        body = req.get_json() or {}
        raw_ids = body.get("ids") or body.get("product_ids") or []
        if not isinstance(raw_ids, list):
            return json_response({"error": "ids phải là một danh sách"}, 400)

        product_ids = []
        seen = set()
        for raw_id in raw_ids:
            product_id = str(raw_id or "").strip()
            if product_id and product_id not in seen:
                seen.add(product_id)
                product_ids.append(product_id)

        if not product_ids:
            return json_response({"error": "Chưa chọn sản phẩm để phân loại"}, 400)

        # Chỉ các field taxonomy sau được phép cập nhật hàng loạt.
        patch = {}
        for key in ("category", "subcategory", "product_type", "is_highend", "collections", "category_source", "category_confidence"):
            if key in body:
                patch[key] = body[key]

        if not patch:
            return json_response({"error": "Không có dữ liệu phân loại để cập nhật"}, 400)

        # Nếu Admin chọn category khác Makeup mà không truyền subcategory, chủ động xóa
        # subcategory Makeup cũ để tránh hiển thị sai.
        requested_category = normalize_category_value(patch.get("category")) if "category" in patch else None
        if requested_category and requested_category != "makeup" and "subcategory" not in patch:
            patch["subcategory"] = ""

        now = datetime.utcnow().isoformat() + "Z"
        updated_count = 0
        not_found = []
        failed = []

        for product_id in product_ids:
            try:
                query = "SELECT * FROM c WHERE c.id = @id AND NOT IS_DEFINED(c.type)"
                items = list(container.query_items(
                    query=query,
                    parameters=[{"name": "@id", "value": product_id}],
                    enable_cross_partition_query=True
                ))
                if not items:
                    not_found.append(product_id)
                    continue

                product = items[0]
                taxonomy = apply_product_taxonomy(product, patch)
                product.update(taxonomy)
                product["category_updated_at"] = now
                product["updated_at"] = now
                container.replace_item(item=product["id"], body=product)
                updated_count += 1
            except Exception as item_error:
                failed.append({"id": product_id, "error": str(item_error)})

        status = 200 if updated_count > 0 else 400
        return json_response({
            "message": f"Đã phân loại {updated_count}/{len(product_ids)} sản phẩm",
            "updated": updated_count,
            "total": len(product_ids),
            "not_found": not_found,
            "failed": failed,
        }, status)
    except Exception as e:
        return json_response({"error": str(e)}, 500)

@app.route(route="products/{id}", methods=["PUT", "DELETE", "OPTIONS"])
def product_by_id(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS": return options_response()
    container = get_cosmos_container()
    p_id = req.route_params.get("id")
    try:
        query = "SELECT * FROM c WHERE c.id = @id"
        items = list(container.query_items(query=query, parameters=[{"name": "@id", "value": p_id}], enable_cross_partition_query=True))
        if not items: return json_response({"error": "Không tìm thấy sản phẩm"}, 404)
        
        existing = items[0]
        old_brand = existing.get("brand")

        if req.method == "PUT":
            body = req.get_json()
            updated = normalize_product(body, existing)
            # Preserve original SKU/JPY/cost fields; assign only for new variants.
            updated['variants'] = merge_and_assign_on_update(
                container, existing, updated.get('variants', []))
            updated["id"] = p_id
            updated["created_at"] = existing.get("created_at")
            updated["updated_at"] = datetime.utcnow().isoformat() + "Z"
            
            # Logic quan trọng: Nếu đổi Brand (Partition Key), phải xóa cũ tạo mới
            if updated["brand"] != old_brand:
                container.delete_item(item=p_id, partition_key=old_brand)
                container.create_item(body=updated)
            else:
                container.replace_item(
                    item=p_id, body=updated, etag=existing['_etag'],
                    match_condition=MatchConditions.IfNotModified)
            return json_response({"message": "Cập nhật thành công", "item": updated})

        if req.method == "DELETE":
            container.delete_item(item=p_id, partition_key=old_brand)
            return json_response({"message": "Xóa thành công"})

    except Exception as e:
        return json_response({"error": str(e)}, 500)

@app.route(route="brands", methods=["GET", "OPTIONS"])
def brands(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS": return options_response()
    try:
        container = get_cosmos_container()
        query = "SELECT c.brand FROM c WHERE c.status = 'active' AND NOT IS_DEFINED(c.type)"
        items = list(container.query_items(query=query, enable_cross_partition_query=True))
        
        brand_count = {}
        for i in items:
            b = i.get("brand", "").strip()
            if b: brand_count[b] = brand_count.get(b, 0) + 1
            
        result = [{"brand": k, "count": v} for k, v in sorted(brand_count.items())]
        return json_response(result)
    except Exception as e:
        return json_response({"error": str(e)}, 500)


def clean_customer_text(value):
    """Làm sạch dữ liệu text khách hàng nhưng không làm thay đổi logic đơn hàng."""
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in ("undefined", "null", "none"):
        return ""
    return text

def first_customer_value(*values):
    """Lấy giá trị đầu tiên không rỗng từ nhiều tên field khác nhau."""
    for value in values:
        text = clean_customer_text(value)
        if text:
            return text
    return ""

def join_address_parts(*parts):
    """Ghép địa chỉ và hạn chế lặp lại phường/quận/tỉnh nếu đơn đã gửi địa chỉ đầy đủ."""
    result = []
    for part in parts:
        text = clean_customer_text(part)
        if not text:
            continue
        normalized = " ".join(text.lower().split())
        exists = False
        for current in result:
            current_normalized = " ".join(str(current).lower().split())
            if normalized in current_normalized or current_normalized in normalized:
                exists = True
                break
        if not exists:
            result.append(text)
    return ", ".join(result)

def normalize_customer_info_for_order(body):
    """Giữ nguyên customer_info cũ và bổ sung address chuẩn để admin hiển thị được."""
    body = body or {}
    customer_info = body.get("customer_info", {})
    if not isinstance(customer_info, dict):
        customer_info = {}

    normalized = dict(customer_info)

    name = first_customer_value(
        customer_info.get("name"), body.get("customer_name"), body.get("name")
    )
    phone = first_customer_value(
        customer_info.get("phone"), body.get("customer_phone"), body.get("phone")
    )

    detail_address = first_customer_value(
        customer_info.get("address"),
        customer_info.get("address_detail"),
        customer_info.get("detail_address"),
        customer_info.get("street"),
        body.get("address"),
        body.get("address_detail"),
        body.get("detail_address"),
        body.get("street")
    )
    ward = first_customer_value(
        customer_info.get("ward"), customer_info.get("ward_name"),
        body.get("ward"), body.get("ward_name")
    )
    district = first_customer_value(
        customer_info.get("district"), customer_info.get("dist"), customer_info.get("district_name"),
        body.get("district"), body.get("dist"), body.get("district_name")
    )
    province = first_customer_value(
        customer_info.get("province"), customer_info.get("prov"), customer_info.get("city"), customer_info.get("province_name"),
        body.get("province"), body.get("prov"), body.get("city"), body.get("province_name")
    )
    full_address = first_customer_value(
        customer_info.get("full_address"), customer_info.get("shipping_address"), customer_info.get("customer_address"),
        body.get("full_address"), body.get("shipping_address"), body.get("customer_address")
    )

    address = join_address_parts(full_address or detail_address, ward, district, province)

    if name:
        normalized["name"] = name
    if phone:
        normalized["phone"] = phone
    if address:
        normalized["address"] = address
    if detail_address:
        normalized["address_detail"] = detail_address
    if ward:
        normalized["ward"] = ward
    if district:
        normalized["district"] = district
    if province:
        normalized["province"] = province

    return normalized



def normalize_order_phone_for_lookup(value):
    """Chuẩn hóa SĐT để tra cứu/so sánh ổn định hơn."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(digits) == 9:
        digits = "0" + digits
    if digits.startswith("84") and len(digits) >= 11:
        digits = "0" + digits[2:]
    return digits


def get_order_phone_for_lookup(order):
    """Lấy SĐT của đơn hàng từ nhiều field cũ/mới để tra cứu sau khi khách chỉnh sửa."""
    info = order.get("customer_info", {}) if isinstance(order, dict) else {}
    if not isinstance(info, dict):
        info = {}
    return normalize_order_phone_for_lookup(
        info.get("phone")
        or info.get("customer_phone")
        or order.get("customer_phone")
        or order.get("phone")
        or order.get("receiver_phone")
    )


def merge_order_customer_update(existing_item, body):
    """Merge thông tin khách hàng khi khách chỉnh trên tracking.html.

    Chỉ bổ sung/ghi đè các field thông tin khách hàng khi payload có gửi lên.
    Các field đơn hàng khác như items, total_amount, payment_method, created_at... được giữ nguyên.
    Lưu cả customer_info và top-level alias để admin/tracking cũ mới đều đọc được.
    """
    existing_item = existing_item or {}
    body = body or {}

    old_info = existing_item.get("customer_info", {})
    if not isinstance(old_info, dict):
        old_info = {}

    new_info = body.get("customer_info", {})
    if not isinstance(new_info, dict):
        new_info = {}

    merged_info = dict(old_info)
    merged_info.update(new_info)

    name = first_customer_value(
        new_info.get("name"), new_info.get("customer_name"),
        body.get("customer_name"), body.get("name"), body.get("receiver_name"),
        merged_info.get("name"), merged_info.get("customer_name"),
        existing_item.get("customer_name"), existing_item.get("name"), existing_item.get("receiver_name")
    )
    phone = first_customer_value(
        new_info.get("phone"), new_info.get("customer_phone"),
        body.get("customer_phone"), body.get("phone"), body.get("receiver_phone"),
        merged_info.get("phone"), merged_info.get("customer_phone"),
        existing_item.get("customer_phone"), existing_item.get("phone"), existing_item.get("receiver_phone")
    )
    detail_address = first_customer_value(
        new_info.get("address"), new_info.get("customer_address"), new_info.get("full_address"), new_info.get("shipping_address"),
        body.get("customer_address"), body.get("full_address"), body.get("shipping_address"), body.get("address"),
        merged_info.get("address"), merged_info.get("customer_address"), merged_info.get("full_address"), merged_info.get("shipping_address"),
        existing_item.get("customer_address"), existing_item.get("full_address"), existing_item.get("shipping_address"), existing_item.get("address")
    )
    ward = first_customer_value(new_info.get("ward"), body.get("ward"), merged_info.get("ward"), existing_item.get("ward"))
    district = first_customer_value(new_info.get("district"), new_info.get("dist"), body.get("district"), body.get("dist"), merged_info.get("district"), merged_info.get("dist"), existing_item.get("district"), existing_item.get("dist"))
    province = first_customer_value(new_info.get("province"), new_info.get("prov"), new_info.get("city"), body.get("province"), body.get("prov"), body.get("city"), merged_info.get("province"), merged_info.get("prov"), merged_info.get("city"), existing_item.get("province"), existing_item.get("prov"), existing_item.get("city"))

    address = join_address_parts(detail_address, ward, district, province)
    updated_at = first_customer_value(body.get("customer_updated_at"), new_info.get("customer_updated_at")) or datetime.utcnow().isoformat() + "Z"

    if name:
        merged_info["name"] = name
        merged_info["customer_name"] = name
    if phone:
        merged_info["phone"] = phone
        merged_info["customer_phone"] = phone
    if address:
        merged_info["address"] = address
        merged_info["customer_address"] = address
        merged_info["full_address"] = address
        merged_info["shipping_address"] = address
    if ward:
        merged_info["ward"] = ward
    if district:
        merged_info["district"] = district
        merged_info["dist"] = district
    if province:
        merged_info["province"] = province
        merged_info["prov"] = province
        merged_info["city"] = province

    if body.get("updated_by_customer") or new_info.get("updated_by_customer"):
        merged_info["updated_by_customer"] = True
        merged_info["customer_updated_at"] = updated_at

    return merged_info, name, phone, address, updated_at


# =========================================================
# BẢO VỆ TẠO ĐƠN HÀNG
# - Không tin giá, tổng tiền, tên sản phẩm hoặc trạng thái từ frontend
# - Đọc sản phẩm/giá thật từ Cosmos DB
# - Bắt buộc đủ thông tin khách hàng
# - Chặn đơn rỗng, 0đ, trạng thái tự đặt và spam cùng SĐT
# =========================================================

BLOCKED_ORDER_TEXTS = {
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "test",
    "test user",
    "test address",
    "khong co",
    "không có"
}


def parse_money_to_int(value):
    """Chuyển 199000, '199.000đ' hoặc '199,000' thành số nguyên."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        try:
            return max(0, int(value))
        except Exception:
            return 0

    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return int(digits) if digits else 0


def parse_positive_int(value, default=0):
    try:
        number = int(value)
        return number if number > 0 else default
    except (TypeError, ValueError):
        return default


def is_blocked_order_text(value):
    return clean_customer_text(value).lower() in BLOCKED_ORDER_TEXTS


def validate_new_order_customer(body):
    """Kiểm tra và trả về customer_info đã chuẩn hóa."""
    info = body.get("customer_info", {})
    if not isinstance(info, dict):
        raise ValueError("Thông tin khách hàng không hợp lệ")

    name = first_customer_value(
        info.get("name"),
        info.get("customer_name"),
        body.get("customer_name"),
        body.get("name")
    )
    phone = normalize_order_phone_for_lookup(
        first_customer_value(
            info.get("phone"),
            info.get("customer_phone"),
            body.get("customer_phone"),
            body.get("phone")
        )
    )
    detail = first_customer_value(
        info.get("address"),
        info.get("address_detail"),
        body.get("address"),
        body.get("address_detail")
    )
    ward = first_customer_value(
        info.get("ward"),
        info.get("ward_name"),
        body.get("ward"),
        body.get("ward_name")
    )
    district = first_customer_value(
        info.get("dist"),
        info.get("district"),
        info.get("district_name"),
        body.get("dist"),
        body.get("district"),
        body.get("district_name")
    )
    province = first_customer_value(
        info.get("prov"),
        info.get("province"),
        info.get("city"),
        info.get("province_name"),
        body.get("prov"),
        body.get("province"),
        body.get("city"),
        body.get("province_name")
    )

    if len(name) < 2 or len(name) > 100 or is_blocked_order_text(name):
        raise ValueError("Họ tên người nhận không hợp lệ")

    if not re.fullmatch(r"0\d{9}", phone):
        raise ValueError("Số điện thoại phải có đúng 10 số và bắt đầu bằng 0")

    if (
        not detail
        or not ward
        or not province
        or is_blocked_order_text(detail)
    ):
        raise ValueError(
            "Vui lòng nhập đầy đủ địa chỉ cụ thể, Phường/Xã "
            "và Tỉnh/Thành phố"
        )

    if len(detail) < 3 or len(detail) > 300:
        raise ValueError("Địa chỉ cụ thể không hợp lệ")

    # Đơn mới dùng địa chỉ hành chính 2 cấp. District vẫn được giữ lại
    # nếu request cũ có gửi lên để không làm thay đổi dữ liệu/khả năng tương thích cũ.
    full_address = join_address_parts(detail, ward, district, province)
    if len(full_address) < 10 or len(full_address) > 500:
        raise ValueError("Địa chỉ nhận hàng không hợp lệ")

    return {
        "name": name,
        "phone": phone,
        "address": full_address,
        "address_detail": detail,
        "ward": ward,
        "dist": district,
        "district": district,
        "prov": province,
        "province": province
    }


def get_product_for_order(container, product_id):
    """Không tin brand do frontend gửi; tìm sản phẩm bằng id trong database."""
    query = """
        SELECT * FROM c
        WHERE c.id = @id
          AND NOT IS_DEFINED(c.type)
    """
    items = list(container.query_items(
        query=query,
        parameters=[{"name": "@id", "value": product_id}],
        enable_cross_partition_query=True
    ))
    return items[0] if items else None


def find_product_variant(product, requested_name, requested_sku=""):
    """Ưu tiên SKU chính xác; không chọn nhầm khi hai phân loại trùng tên."""
    variants = product.get("variants", [])
    if not isinstance(variants, list):
        variants = []

    if not variants:
        return None

    requested = clean_customer_text(requested_name).casefold()
    sku = clean_customer_text(requested_sku).upper()
    if sku:
        matches = [v for v in variants if isinstance(v, dict)
                   and clean_customer_text(v.get("sku")).upper() == sku]
        if len(matches) != 1:
            raise ValueError("SKU không tồn tại hoặc bị trùng; vui lòng tải lại sản phẩm")
        if requested and clean_customer_text(matches[0].get("name")).casefold() != requested:
            raise ValueError("Phân loại đã thay đổi; vui lòng tải lại sản phẩm")
        return matches[0]

    if not requested and len(variants) == 1:
        return variants[0]

    matches = [v for v in variants if isinstance(v, dict)
               and clean_customer_text(v.get("name")).casefold() == requested]
    if len(matches) > 1:
        raise ValueError("Có nhiều phân loại trùng tên; vui lòng tải lại và chọn đúng SKU")
    return matches[0] if matches else None


def validate_and_build_order_items(container, raw_items):
    """Tự lấy tên, ảnh, giá và trạng thái sản phẩm từ Cosmos DB."""
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("Đơn hàng phải có ít nhất một sản phẩm")

    if len(raw_items) > ORDER_MAX_ITEMS:
        raise ValueError("Đơn hàng có quá nhiều dòng sản phẩm")

    # Gộp dòng trùng sản phẩm/phân loại để không thể lách giới hạn số lượng.
    aggregated = {}
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("Dữ liệu sản phẩm không hợp lệ")

        product_id = clean_customer_text(raw.get("id"))
        variant_name = clean_customer_text(raw.get("variant")) or "Mặc định"
        variant_sku = clean_customer_text(raw.get("sku")).upper()
        quantity = parse_positive_int(raw.get("quantity"))

        if not product_id:
            raise ValueError("Thiếu mã sản phẩm")

        if quantity < 1:
            raise ValueError("Số lượng sản phẩm không hợp lệ")

        key = (product_id, variant_sku or variant_name.casefold())
        if key not in aggregated:
            aggregated[key] = {
                "id": product_id,
                "variant": variant_name,
                "sku": variant_sku,
                "quantity": 0
            }
        aggregated[key]["quantity"] += quantity

        if aggregated[key]["quantity"] > ORDER_MAX_QTY_PER_ITEM:
            raise ValueError(
                f"Số lượng tối đa cho một phân loại là "
                f"{ORDER_MAX_QTY_PER_ITEM}"
            )

    safe_items = []
    product_originals = {}
    product_updates = {}

    for row in aggregated.values():
        product_id = row["id"]
        requested_variant_name = row["variant"]
        requested_variant_sku = row.get("sku", "")
        quantity = row["quantity"]

        if product_id not in product_updates:
            product = get_product_for_order(container, product_id)
            if not product:
                raise ValueError("Có sản phẩm không tồn tại hoặc đã bị xóa")

            if clean_customer_text(product.get("status")).lower() != "active":
                raise ValueError(
                    f"Sản phẩm {clean_customer_text(product.get('title'))} "
                    f"đang ngừng bán"
                )

            # Giữ bản gốc để rollback nếu cập nhật kho/tạo đơn lỗi.
            product_originals[product_id] = json.loads(json.dumps(product))
            product_updates[product_id] = product

        product = product_updates[product_id]
        variants = product.get("variants", [])
        if not isinstance(variants, list):
            variants = []

        variant = find_product_variant(product, requested_variant_name, requested_variant_sku)
        if variants and not variant:
            raise ValueError(
                f"Phân loại '{requested_variant_name}' không tồn tại"
            )

        if variant:
            variant_name = clean_customer_text(variant.get("name"))
            unit_price = (
                parse_money_to_int(variant.get("price"))
                or parse_money_to_int(product.get("current_price"))
            )
            variant_status = (
                clean_customer_text(variant.get("status")).lower()
                or "instock"
            )
            image = (
                clean_customer_text(variant.get("image"))
                or clean_customer_text(product.get("thumbnail"))
            )
            expected_date = first_customer_value(
                variant.get("date"),
                variant.get("expected_date")
            )

            # Chỉ trừ kho với hàng có sẵn. Hàng order/out vẫn cho đặt trước.
            if variant_status == "instock":
                stock = parse_positive_int(variant.get("stock"), 0)
                if stock < quantity:
                    raise ValueError(
                        f"Phân loại '{variant_name}' chỉ còn {stock} sản phẩm"
                    )
                variant["stock"] = stock - quantity
                if variant["stock"] == 0:
                    variant["status"] = "out"
        else:
            variant_name = "Mặc định"
            unit_price = parse_money_to_int(product.get("current_price"))
            variant_status = "instock"
            image = clean_customer_text(product.get("thumbnail"))
            expected_date = ""

        if unit_price <= 0:
            raise ValueError(
                f"Giá sản phẩm '{clean_customer_text(product.get('title'))}' "
                f"không hợp lệ"
            )

        line_total = unit_price * quantity
        safe_items.append({
            "id": product_id,
            "title": clean_customer_text(product.get("title")),
            "brand": clean_customer_text(product.get("brand")),
            "image": image,
            "variant": variant_name,
            "sku": clean_customer_text(variant.get("sku")) if variant else "",
            "price": unit_price,
            "quantity": quantity,
            "status": variant_status,
            "date": expected_date,
            "line_total": line_total
        })

    return safe_items, product_originals, product_updates


def generate_order_code():
    """Mã đơn do server tạo, không thể thành N/A."""
    return "MO" + datetime.utcnow().strftime("%m%d%H%M%S") + uuid.uuid4().hex[:4].upper()


def find_order_by_code(container, order_code):
    query = """
        SELECT TOP 1 * FROM c
        WHERE c.type = 'order'
          AND c.order_id = @order_id
    """
    found = list(container.query_items(
        query=query,
        parameters=[{"name": "@order_id", "value": order_code}],
        enable_cross_partition_query=True
    ))
    return found[0] if found else None


def order_code_exists(container, order_code):
    return find_order_by_code(container, order_code) is not None


def enforce_phone_order_limit(container, phone):
    """Giới hạn cơ bản để giảm spam cùng một SĐT."""
    cutoff = (datetime.utcnow() - timedelta(minutes=30)).isoformat() + "Z"
    query = """
        SELECT TOP 10 c.id FROM c
        WHERE c.type = 'order'
          AND c.customer_info.phone = @phone
          AND c.created_at >= @cutoff
          AND c.status != 'Đã hủy'
    """
    items = list(container.query_items(
        query=query,
        parameters=[
            {"name": "@phone", "value": phone},
            {"name": "@cutoff", "value": cutoff}
        ],
        enable_cross_partition_query=True
    ))
    if len(items) >= ORDER_MAX_PER_PHONE_30M:
        raise PermissionError(
            "Số điện thoại này đã tạo quá nhiều đơn trong 30 phút. "
            "Vui lòng liên hệ Shop nếu cần hỗ trợ."
        )


def rollback_product_updates(container, originals, written_etags):
    """Rollback có ETag: không ghi đè cập nhật kho từ đơn khác."""
    for product_id, latest_etag in reversed(list(written_etags.items())):
        original = originals.get(product_id)
        if not original or not latest_etag:
            continue
        try:
            container.replace_item(
                item=product_id, body=original,
                etag=latest_etag,
                match_condition=MatchConditions.IfNotModified
            )
        except Exception as rollback_error:
            print(f"Rollback kho {product_id} bị từ chối/xung đột: {rollback_error}")



# --- ROUTES ĐƠN HÀNG & TRỪ KHO ---

@app.route(route="orders", methods=["GET", "POST", "OPTIONS"])
def orders_api(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    container = get_cosmos_container()

    try:
        if req.method == "GET":
            query = "SELECT * FROM c WHERE c.type = 'order'"
            items = list(container.query_items(
                query=query,
                enable_cross_partition_query=True
            ))
            items.sort(
                key=lambda item: item.get("created_at", ""),
                reverse=True
            )
            return json_response(items)

        # Chặn payload quá lớn trước khi parse JSON.
        raw_body = req.get_body()
        if not raw_body:
            return json_response({"error": "Thiếu dữ liệu đơn hàng"}, 400)

        if len(raw_body) > ORDER_MAX_BODY_BYTES:
            return json_response({"error": "Dữ liệu đơn hàng quá lớn"}, 413)

        try:
            body = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return json_response({"error": "JSON không hợp lệ"}, 400)

        if not isinstance(body, dict):
            return json_response({"error": "Dữ liệu đơn hàng không hợp lệ"}, 400)

        customer_info = validate_new_order_customer(body)

        requested_order_code = clean_customer_text(
            body.get("order_id")
        ).upper()

        if requested_order_code:
            if not re.fullmatch(r"MO[A-Z0-9]{6,20}", requested_order_code):
                return json_response(
                    {"error": "Mã đơn hàng không hợp lệ"},
                    400
                )

            existing_order = find_order_by_code(
                container,
                requested_order_code
            )

            # Chống gửi trùng: cùng mã đơn và cùng SĐT thì trả lại đơn cũ,
            # không trừ kho và không tạo thêm bản ghi.
            if existing_order:
                if (
                    get_order_phone_for_lookup(existing_order)
                    == customer_info["phone"]
                ):
                    return json_response({
                        "message": "Đơn hàng đã được ghi nhận trước đó",
                        "order": existing_order,
                        "duplicate": True
                    }, 200)

                return json_response(
                    {"error": "Mã đơn hàng đã tồn tại"},
                    409
                )

        enforce_phone_order_limit(container, customer_info["phone"])

        payment_method = clean_customer_text(
            body.get("payment_method")
        ).lower()
        if payment_method not in {"cod", "bank"}:
            return json_response(
                {"error": "Phương thức thanh toán không hợp lệ"},
                400
            )

        safe_items, product_originals, product_updates = (
            validate_and_build_order_items(
                container,
                body.get("items")
            )
        )

        subtotal = sum(
            int(item["line_total"])
            for item in safe_items
        )
        total_amount = subtotal + ORDER_SHIPPING_FEE

        if subtotal <= 0 or total_amount <= ORDER_SHIPPING_FEE:
            return json_response(
                {"error": "Tổng tiền đơn hàng không hợp lệ"},
                400
            )

        # Giữ mã MO... hợp lệ do giao diện tạo để khớp nội dung VietQR.
        # Khi frontend không gửi mã, backend tự tạo; không thể xuất hiện N/A.
        order_code = requested_order_code or generate_order_code()
        if not requested_order_code:
            while order_code_exists(container, order_code):
                order_code = generate_order_code()
        attempt_id = uuid.uuid4().hex

        status = (
            "Chờ xác nhận đã chuyển khoản"
            if payment_method == "bank"
            else "Xác nhận đặt đơn Shipcod thành công"
        )
        payment_label = (
            "Chuyển khoản VietQR"
            if payment_method == "bank"
            else "Ship COD"
        )
        payment_status = (
            "Cần kiểm tra sao kê"
            if payment_method == "bank"
            else "Thu tiền khi giao hàng"
        )

        now = datetime.utcnow().isoformat() + "Z"
        order_data = {
            # Cố định ID theo order_code: Cosmos chống ghi 2 lần cùng mã đơn.
            "id": "web-order-" + order_code,
            "checkout_attempt_id": attempt_id,
            "brand": "ORDER",
            "type": "order",
            "order_id": order_code,
            "customer_info": customer_info,
            "customer_name": customer_info["name"],
            "customer_phone": customer_info["phone"],
            "customer_address": customer_info["address"],
            "items": safe_items,
            "products": safe_items,
            "subtotal": subtotal,
            "shipping_fee": ORDER_SHIPPING_FEE,
            "total_amount": total_amount,
            "total": total_amount,
            "payment_method": payment_method,
            "payment_label": payment_label,
            "payment_status": payment_status,
            "status": status,
            "spx_tracking_code": "",
            "security_validation": "server_v2",
            "created_at": now,
            "updated_at": now
        }

        # Chỉ cập nhật kho sau khi toàn bộ dữ liệu đã hợp lệ.
        written_etags = {}
        try:
            for product_id, product_doc in product_updates.items():
                original = product_originals[product_id]
                # Hàng đặt trước không trừ kho; tránh replace tài liệu vô ích.
                if product_doc == original:
                    continue
                result = container.replace_item(
                    item=product_id, body=product_doc,
                    etag=original.get("_etag"),
                    match_condition=MatchConditions.IfNotModified
                )
                written_etags[product_id] = result.get("_etag")
                if not written_etags[product_id]:
                    raise RuntimeError("Không nhận được ETag mới sau khi trừ kho")

            container.create_item(body=order_data)

        except Exception:
            # create_item có thể đã thành công trước khi kết nối bị ngắt.
            # Chỉ rollback khi biết chắc đơn CHƯA được tạo.
            persisted = None
            try:
                persisted = container.read_item(
                    item=order_data["id"], partition_key="ORDER"
                )
            except Exception as check_error:
                if getattr(check_error, "status_code", None) != 404:
                    print("Không xác minh được trạng thái đơn, không rollback mù:", check_error)
                    raise
            if persisted and persisted.get("checkout_attempt_id") == attempt_id:
                return json_response({
                    "message": "Đơn đã được ghi nhận thành công",
                    "order": persisted, "duplicate": False
                }, 200)
            rollback_product_updates(container, product_originals, written_etags)
            if persisted:
                if get_order_phone_for_lookup(persisted) == customer_info["phone"]:
                    return json_response({
                        "message": "Đơn đã được ghi nhận trước đó",
                        "order": persisted, "duplicate": True
                    }, 200)
                return json_response({"error": "Mã đơn hàng đã tồn tại"}, 409)
            raise

        return json_response({
            "message": "Đặt hàng thành công",
            "order": order_data
        }, 201)

    except PermissionError as error:
        return json_response({"error": str(error)}, 429)
    except ValueError as error:
        return json_response({"error": str(error)}, 400)
    except Exception as error:
        print(f"Lỗi tạo đơn hàng: {error}")
        return json_response(
            {"error": "Không thể tạo đơn hàng. Vui lòng thử lại sau."},
            500
        )


# =========================================================
# API CÔNG KHAI RIÊNG CHO KHÁCH CHỈNH SỬA / HỦY ĐƠN
# - Không dùng chung API quản trị /api/orders/{id}
# - Chỉ cho phép khi đơn ở đúng trạng thái được cấu hình
# - Khách phải gửi đúng số điện thoại hiện đang lưu trên đơn
# - Không cho khách sửa giá, sản phẩm, thanh toán, mã vận đơn
# =========================================================

CUSTOMER_EDITABLE_STATUSES = {
    "xac nhan dat don shipcod thanh cong",
    "dang cho hang ve viet nam",
    "cho xac nhan da chuyen khoan",
    "cho xac nhan chuyen khoan"
}


def normalize_order_status_for_customer(value):
    """Chuẩn hóa trạng thái tiếng Việt để so sánh ổn định."""
    import unicodedata

    text = str(value or "").strip().lower().replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return " ".join(text.split())


def is_cancelled_order(order):
    return normalize_order_status_for_customer((order or {}).get('status')) == 'da huy'


def replace_order_atomically(container, item):
    """Optimistic lock: never overwrite a more recent cancel/status change."""
    etag = item.get('_etag')
    if not etag:
        raise ValueError('Thiếu ETag; không thể cập nhật an toàn')
    return container.replace_item(item=item['id'], body=item, etag=etag,
                                  match_condition=MatchConditions.IfNotModified)


def is_customer_order_editable(order):
    """Khách chỉ được chỉnh sửa/hủy ở các trạng thái cho phép."""
    if not isinstance(order, dict):
        return False

    status = normalize_order_status_for_customer(order.get("status"))

    # Khi đã có mã vận đơn, không cho khách thay đổi thông tin giao hàng.
    if clean_customer_text(order.get("spx_tracking_code")):
        return False

    return status in CUSTOMER_EDITABLE_STATUSES


def find_order_for_customer_action(container, identifier):
    """Tìm đơn bằng Cosmos id hoặc mã đơn hàng MO..."""
    identifier = clean_customer_text(identifier)
    if not identifier:
        return None

    try:
        return container.read_item(item=identifier, partition_key="ORDER")
    except Exception:
        query = """
            SELECT * FROM c
            WHERE c.type = 'order'
              AND c.order_id = @order_id
        """
        found = list(container.query_items(
            query=query,
            parameters=[{"name": "@order_id", "value": identifier}],
            enable_cross_partition_query=True
        ))
        return found[0] if found else None


@app.route(route="customer-orders/{id}", methods=["PUT", "OPTIONS"])
def customer_order_action(req: func.HttpRequest) -> func.HttpResponse:
    """
    Endpoint công khai giới hạn cho trang tracking.html.

    action=update_info:
      - Chỉ sửa họ tên, số điện thoại và địa chỉ.

    action=cancel:
      - Chỉ đổi trạng thái sang Đã hủy và ghi lý do.
    """
    if req.method == "OPTIONS":
        return options_response()

    container = get_cosmos_container()
    order_identifier = req.route_params.get("id")

    try:
        body = req.get_json()
        if not isinstance(body, dict):
            return json_response({"error": "Payload không hợp lệ"}, 400)

        item = find_order_for_customer_action(container, order_identifier)
        if not item:
            return json_response({"error": "Không tìm thấy đơn hàng"}, 404)

        lookup_phone = normalize_order_phone_for_lookup(body.get("lookup_phone"))
        saved_phone = get_order_phone_for_lookup(item)

        if not lookup_phone or lookup_phone != saved_phone:
            return json_response(
                {"error": "Số điện thoại xác minh không khớp với đơn hàng"},
                403
            )

        if not is_customer_order_editable(item):
            return json_response(
                {
                    "error": (
                        "Đơn hàng không còn được phép chỉnh sửa hoặc hủy. "
                        "Chỉ áp dụng khi trạng thái là: "
                        "Xác nhận đặt đơn Shipcod thành công, "
                        "Đang chờ hàng về Việt Nam hoặc "
                        "Chờ xác nhận đã chuyển khoản."
                    )
                },
                409
            )

        action = clean_customer_text(body.get("action")).lower()
        now = datetime.utcnow().isoformat() + "Z"

        if action == "update_info":
            name = clean_customer_text(body.get("name"))
            new_phone = normalize_order_phone_for_lookup(body.get("phone"))
            address = clean_customer_text(body.get("address"))

            if len(name) < 2 or len(name) > 100:
                return json_response({"error": "Họ tên không hợp lệ"}, 400)

            if len(new_phone) != 10 or not new_phone.startswith("0"):
                return json_response({"error": "Số điện thoại không hợp lệ"}, 400)

            if len(address) < 10 or len(address) > 500:
                return json_response({"error": "Địa chỉ không hợp lệ"}, 400)

            customer_info = item.get("customer_info", {})
            if not isinstance(customer_info, dict):
                customer_info = {}

            customer_info.update({
                "name": name,
                "customer_name": name,
                "phone": new_phone,
                "customer_phone": new_phone,
                "address": address,
                "customer_address": address,
                "full_address": address,
                "shipping_address": address,
                "updated_by_customer": True,
                "customer_updated_at": now
            })

            item["customer_info"] = customer_info
            item["customer_name"] = name
            item["name"] = name
            item["receiver_name"] = name
            item["customer_phone"] = new_phone
            item["phone"] = new_phone
            item["receiver_phone"] = new_phone
            item["customer_address"] = address
            item["full_address"] = address
            item["shipping_address"] = address
            item["address"] = address
            item["updated_by_customer"] = True
            item["customer_updated_at"] = now
            item["updated_at"] = now

            replace_order_atomically(container, item)
            return json_response({
                "message": "Đã cập nhật thông tin nhận hàng",
                "item": item
            })

        if action == "cancel":
            reason = clean_customer_text(body.get("reason"))
            if len(reason) > 500:
                return json_response({"error": "Lý do hủy quá dài"}, 400)

            item["status"] = "Đã hủy"
            item["cancel_reason"] = reason or "Khách hàng tự hủy trên trang tra cứu"
            item["cancelled_by_customer"] = True
            item["cancelled_at"] = now
            item["updated_at"] = now

            replace_order_atomically(container, item)
            return json_response({
                "message": "Đã hủy đơn hàng",
                "item": item
            })

        return json_response({"error": "Hành động không hợp lệ"}, 400)

    except ValueError:
        return json_response({"error": "Dữ liệu JSON không hợp lệ hoặc thiếu ETag"}, 400)
    except Exception as e:
        if getattr(e, 'status_code', None) in (409, 412):
            return json_response({"error": "Đơn đã được cập nhật đồng thời; tải lại trước khi thao tác"}, 409)
        return json_response({"error": "Không thể cập nhật đơn; kiểm tra log Functions"}, 500)


@app.route(route="orders/{id}", methods=["PUT", "DELETE", "OPTIONS"])
def order_by_id(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS": return options_response()
    container = get_cosmos_container()
    o_id = req.route_params.get("id")
    try:
        # Ưu tiên đọc theo id Cosmos. Nếu frontend gửi mã MO..., fallback tìm theo order_id.
        try:
            item = container.read_item(item=o_id, partition_key="ORDER")
        except Exception:
            query = "SELECT * FROM c WHERE c.type = 'order' AND c.order_id = @order_id"
            found = list(container.query_items(
                query=query,
                parameters=[{"name": "@order_id", "value": o_id}],
                enable_cross_partition_query=True
            ))
            if not found:
                raise
            item = found[0]
            o_id = item.get("id")

        if req.method == "PUT":
            body = req.get_json()
            if not isinstance(body, dict):
                return json_response({"error": "Payload không hợp lệ"}, 400)
            now = datetime.utcnow().isoformat() + "Z"
            old_status = str(item.get('status') or '').strip()
            if is_cancelled_order(item):
                return json_response({"error": "Đơn đã hủy là trạng thái cuối cùng; không cho sửa hoặc nhập tracking"}, 409)

            new_status = str(body.get('status', old_status) or '').strip()
            if not new_status:
                return json_response({"error": "Trạng thái không được để trống"}, 400)
            is_to_deliver = new_status == 'Đang giao hàng'
            has_tracking_update = any(k in body for k in
                                      ('spx_tracking_code', 'shipping_provider', 'tracking_updated_at'))
            if is_to_deliver or has_tracking_update:
                if old_status != 'Đang chuẩn bị hàng' or not is_to_deliver:
                    return json_response({"error": "Chỉ đơn Đang chuẩn bị hàng mới được nhập tracking và chuyển Đang giao hàng"}, 409)
                code = str(body.get('spx_tracking_code') or '').strip().upper()
                if not re.fullmatch(r'SPX[A-Z0-9]+', code):
                    return json_response({"error": "Mã vận đơn SPX không hợp lệ hoặc trống"}, 400)
                if str(item.get('spx_tracking_code') or '').strip():
                    return json_response({"error": "Đơn đã có mã tracking; không cho nhập lại"}, 409)
                item['spx_tracking_code'] = code
                item['shipping_provider'] = 'SPX'
                item['tracking_updated_at'] = now
            if is_cancelled_order({'status': new_status}):
                if has_tracking_update:
                    return json_response({"error": "Không thể thêm tracking khi hủy đơn"}, 409)
                new_status = 'Đã hủy'
                item['cancelled_at'] = now
                item['cancelled_by_customer'] = False
                item['cancel_reason'] = str(body.get('cancel_reason') or 'Admin hủy đơn').strip()[:500]
            item['status'] = new_status

            # Bổ sung lưu thông tin khách hàng sau khi chỉnh sửa trên tracking.html.
            has_customer_update = any(key in body for key in [
                "customer_info", "customer_name", "customer_phone", "customer_address",
                "full_address", "shipping_address", "name", "phone", "address",
                "receiver_name", "receiver_phone", "updated_by_customer", "customer_updated_at"
            ])
            if has_customer_update:
                customer_info, name, phone, address, updated_at = merge_order_customer_update(item, body)
                item["customer_info"] = customer_info

                if name:
                    item["customer_name"] = name
                    item["name"] = name
                    item["receiver_name"] = name
                if phone:
                    item["customer_phone"] = phone
                    item["phone"] = phone
                    item["receiver_phone"] = phone
                if address:
                    item["customer_address"] = address
                    item["full_address"] = address
                    item["shipping_address"] = address
                    item["address"] = address

                if body.get("updated_by_customer") or customer_info.get("updated_by_customer"):
                    item["updated_by_customer"] = True
                    item["customer_updated_at"] = updated_at

            item["updated_at"] = now
            replace_order_atomically(container, item)
            return json_response({"message": "Cập nhật đơn hàng thành công", "item": item})

        if req.method == "DELETE":
            container.delete_item(item=o_id, partition_key="ORDER")
            return json_response({"message": "Xóa đơn hàng thành công"})
            
    except Exception as e:
        if getattr(e, 'status_code', None) in (409, 412):
            return json_response({"error": "Đơn đã thay đổi trên hệ thống; tải lại trước khi thao tác"}, 409)
        if isinstance(e, ValueError):
            return json_response({"error": str(e)}, 400)
        return json_response({"error": "Không cập nhật được đơn hàng; kiểm tra log Functions"}, 500)

@app.route(route="track", methods=["GET", "OPTIONS"])
def track_order(req: func.HttpRequest) -> func.HttpResponse:
    """Tra cứu công khai theo SĐT, mã đơn hàng hoặc mã vận đơn.

    Endpoint này KHÔNG gọi /api/orders (API quản trị). Nó đọc Cosmos DB trực tiếp
    và chỉ trả những đơn khớp từ khóa tra cứu.
    """
    if req.method == "OPTIONS":
        return options_response()

    keyword = clean_customer_text(
        req.params.get("q")
        or req.params.get("order_id")
        or req.params.get("phone")
        or req.params.get("keyword")
    )
    if not keyword:
        return json_response({"error": "Thiếu thông tin tra cứu"}, 400)

    def normalize_code(value):
        # Cho phép khách nhập: MO638738, mo638738, MO-638738, #MO638738...
        return re.sub(r"[^A-Z0-9]", "", clean_customer_text(value).upper())

    def phone_candidates(order):
        info = order.get("customer_info", {}) if isinstance(order, dict) else {}
        if not isinstance(info, dict):
            info = {}
        values = [
            info.get("phone"),
            info.get("customer_phone"),
            info.get("receiver_phone"),
            order.get("customer_phone"),
            order.get("phone"),
            order.get("receiver_phone"),
            order.get("shipping_phone"),
        ]
        return {
            normalize_order_phone_for_lookup(v)
            for v in values
            if clean_customer_text(v)
        }

    try:
        container = get_cosmos_container()
        keyword_code = normalize_code(keyword)
        target_phone = normalize_order_phone_for_lookup(keyword)
        is_phone_lookup = bool(re.fullmatch(r"0\d{9}", target_phone))

        # ---------------------------------------------------------
        # 1. MÃ ĐƠN HÀNG
        # Ưu tiên query trực tiếp field order_id, không phụ thuộc c.type.
        # ---------------------------------------------------------
        if keyword_code.startswith("MO"):
            direct = list(container.query_items(
                query=(
                    "SELECT * FROM c "
                    "WHERE IS_DEFINED(c.order_id) AND c.order_id = @order_id"
                ),
                parameters=[{"name": "@order_id", "value": keyword_code}],
                enable_cross_partition_query=True,
            ))
            if direct:
                direct.sort(key=lambda x: x.get("created_at", ""), reverse=True)
                return json_response(direct)

        # Chỉ lấy document có dấu hiệu là đơn hàng. Không dùng API /api/orders.
        query = """
            SELECT * FROM c
            WHERE c.type = 'order'
               OR IS_DEFINED(c.order_id)
               OR IS_DEFINED(c.orderId)
               OR IS_DEFINED(c.order_code)
               OR IS_DEFINED(c.code)
        """
        all_orders = list(container.query_items(
            query=query,
            enable_cross_partition_query=True,
        ))

        items = []
        for order in all_orders:
            if not isinstance(order, dict):
                continue

            order_codes = [
                order.get("order_id"),
                order.get("orderId"),
                order.get("order_code"),
                order.get("orderCode"),
                order.get("code"),
            ]
            order_code_match = any(
                normalize_code(value) == keyword_code
                for value in order_codes
                if clean_customer_text(value)
            )

            # Cosmos id chỉ được phép khớp đúng nguyên văn, tránh normalize UUID.
            cosmos_id_match = (
                clean_customer_text(order.get("id")).upper()
                == clean_customer_text(keyword).upper()
            )

            tracking_codes = [
                order.get("spx_tracking_code"),
                order.get("tracking_code"),
                order.get("trackingCode"),
                order.get("shipping_code"),
            ]
            tracking_match = any(
                normalize_code(value) == keyword_code
                for value in tracking_codes
                if clean_customer_text(value)
            )

            # Chỉ chạy nhánh SĐT khi input thực sự là SĐT VN 10 số.
            phone_match = (
                is_phone_lookup
                and target_phone in phone_candidates(order)
            )

            if order_code_match or cosmos_id_match or tracking_match or phone_match:
                items.append(order)

        items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return json_response(items)

    except Exception as e:
        return json_response({"error": str(e)}, 500)

# MORACHI UAT FINANCE BLUEPRINT (added by install_revenue.py)
from finance_api import finance_bp
app.register_blueprint(finance_bp)


# MORACHI_OFFLINE_ORDERS_V1: Tạo đơn Offline dùng chung doanh thu /api/finance/report.
from offline_orders_api import bp_offline_orders
app.register_blueprint(bp_offline_orders)
