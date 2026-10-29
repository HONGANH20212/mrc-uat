"""MORACHI UAT /api/inventory/jpy/* — Excel-based batch purchase price editor.

UAT only (account mrc-uat). Use behind Static Web Apps role morachiadmin.
Do not expose Azure Functions public endpoint directly (func host uses ANONYMOUS).
Frontend must submit structured JSON. Excel parsing happens in browser.
"""
from __future__ import annotations

import hashlib
import json
import os
from collections import Counter, defaultdict
from urllib.parse import urlparse

import azure.functions as func
from azure.core import MatchConditions
from azure.cosmos import CosmosClient
from azure.cosmos.exceptions import CosmosHttpResponseError

jpy_import_bp = func.Blueprint()
RATE = 170
MAX_ROWS = 1500
MAX_BODY = 700_000
EXPECTED_UAT_ACCOUNT = (
    os.environ.get("COSMOS_ALLOWED_ACCOUNT") or "mrc-uat"
).strip().lower()


def _response(data, status=200):
    return func.HttpResponse(json.dumps(data, ensure_ascii=False),
                             status_code=status, mimetype="application/json",
                             headers={"Cache-Control": "no-store"})


def _container():
    url = (os.environ.get("COSMOS_URL") or "").strip()
    key = os.environ.get("COSMOS_KEY") or ""
    db = os.environ.get("COSMOS_DB_NAME") or "morachi-db"
    name = os.environ.get("COSMOS_CONTAINER_NAME") or "products"
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    account = host.removesuffix(".documents.azure.com") if host.endswith(".documents.azure.com") else ""
    if parsed.scheme != "https" or account != EXPECTED_UAT_ACCOUNT:
        raise PermissionError("API nhập giá Yên chỉ cho phép Account mrc-uat (UAT).")
    if db != "morachi-db" or name != "products":
        raise PermissionError("Chỉ cho phép morachi-db/products trên UAT.")
    if not key:
        raise RuntimeError("Thiếu COSMOS_KEY trên backend.")
    client = CosmosClient(url, credential=key)
    ct = client.get_database_client(db).get_container_client(name)
    if (ct.read().get("partitionKey", {}).get("paths") or []) != ["/brand"]:
        raise RuntimeError("Partition key khác /brand; không thể cập nhật tự động.")
    return ct


def _read_products(ct):
    return list(ct.query_items(
        query="SELECT * FROM c WHERE NOT IS_DEFINED(c.type) AND IS_DEFINED(c.id) AND IS_DEFINED(c.title)",
        enable_cross_partition_query=True,
    ))


def _number(value, *, optional=True):
    if value is None or value == "":
        if optional:
            return None
        raise ValueError("Giá Yên bắt buộc nhập")
    if isinstance(value, bool):
        raise ValueError("Giá Yên phải là số nguyên")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("Giá Yên phải là số nguyên")
    if isinstance(value, str):
        value = value.strip()
        if not value and optional:
            return None
        if not value.isascii() or not value.isdecimal():
            raise ValueError("Giá Yên chỉ được dùng chữ số 0-9, không có ¥ hoặc dấu phân cách")
    try:
        number = int(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError("Giá Yên không hợp lệ") from None
    if not 1 <= number <= 1_000_000:
        raise ValueError("Giá Yên phải từ 1 đến 1.000.000 JPY")
    return number


def _clean_text(value):
    return str(value or "").strip()


def _catalog_rows(products):
    rows = []
    for doc in products:
        variants = doc.get("variants")
        if not isinstance(variants, list):
            continue
        for i, item in enumerate(variants):
            if not isinstance(item, dict):
                continue
            sku = _clean_text(item.get("sku"))
            if not sku:
                continue
            old = item.get("purchase_price_jpy")
            rows.append({
                "sku": sku,
                "product_id": str(doc.get("id") or ""),
                "variant_index": i,
                "brand": _clean_text(doc.get("brand")),
                "product_name": _clean_text(doc.get("title")),
                "variant_name": _clean_text(item.get("name")),
                "stock": item.get("stock", 0),
                "image": _clean_text(item.get("image") or doc.get("thumbnail")),
                "old_jpy": _number(old) if old not in (None, "") else None,
            })
    return sorted(rows, key=lambda row: (row["sku"], row["product_id"], row["variant_index"]))


def _parse_payload(req):
    raw = req.get_body()
    if len(raw) > MAX_BODY:
        raise ValueError("File nhập quá lớn")
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("JSON không hợp lệ") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("rows"), list):
        raise ValueError("Thiếu danh sách rows")
    if len(obj["rows"]) > MAX_ROWS:
        raise ValueError(f"Tối đa {MAX_ROWS} SKU mỗi lần nhập")
    return obj


def _prepare(rows, products):
    """Fail entire preflight on mismatch; no DB write happens here."""
    docs = {str(p.get("id")): p for p in products}
    all_skus = Counter(
        _clean_text(v.get("sku")).upper()
        for p in products for v in (p.get("variants") or [])
        if isinstance(v, dict) and _clean_text(v.get("sku"))
    )
    seen = set()
    changes = []
    skipped_blank = 0
    unchanged = 0
    for n, row in enumerate(rows, 2):
        if not isinstance(row, dict):
            raise ValueError(f"Dòng {n}: cấu trúc không hợp lệ")
        sku = _clean_text(row.get("sku"))
        pid = _clean_text(row.get("product_id"))
        try:
            i = int(row.get("variant_index"))
        except (ValueError, TypeError):
            raise ValueError(f"Dòng {n}: vị trí màu không hợp lệ") from None
        key = (pid, i)
        if not sku or not pid or key in seen:
            raise ValueError(f"Dòng {n}: thiếu SKU/ID hoặc trùng dòng")
        seen.add(key)
        product = docs.get(pid)
        if not product:
            raise ValueError(f"Dòng {n}: sản phẩm không còn tồn tại; hãy Xuất Excel mới")
        variants = product.get("variants") or []
        if i < 0 or i >= len(variants) or not isinstance(variants[i], dict):
            raise ValueError(f"Dòng {n}: màu/phân loại đã thay đổi; hãy Xuất Excel mới")
        variant = variants[i]
        expected = (
            sku == _clean_text(variant.get("sku"))
            and _clean_text(row.get("brand")) == _clean_text(product.get("brand"))
            and _clean_text(row.get("product_name")) == _clean_text(product.get("title"))
            and _clean_text(row.get("variant_name")) == _clean_text(variant.get("name"))
        )
        if not expected or all_skus[sku.upper()] != 1:
            raise ValueError(f"Dòng {n}: SKU hoặc tên đã thay đổi/trùng; hãy Xuất Excel mới")
        current_raw = variant.get("purchase_price_jpy")
        current = _number(current_raw) if current_raw not in (None, "") else None
        old = _number(row.get("old_jpy"))
        if old != current:
            raise ValueError(f"Dòng {n}: giá Yên hiện tại trên DB đã thay đổi; hãy Xuất Excel mới")
        target = _number(row.get("new_jpy"))
        if target is None:
            skipped_blank += 1
            continue
        current_cost = variant.get("cost_vnd")
        if target == current and current_cost == target * RATE:
            unchanged += 1
            continue
        if not product.get("_etag"):
            raise ValueError(f"Dòng {n}: không có ETag, chưa thể cập nhật")
        changes.append({
            "sku": sku,
            "product_id": pid,
            "variant_index": i,
            "brand": _clean_text(product.get("brand")),
            "product_name": _clean_text(product.get("title")),
            "variant_name": _clean_text(variant.get("name")),
            "old_jpy": current,
            "new_jpy": target,
            "cost_vnd": target * RATE,
        })
    # Stable summary digest ties confirmed changes to previewed changes.
    changes.sort(key=lambda c: (c["product_id"], c["variant_index"]))
    serial = [{k: c[k] for k in ("product_id", "variant_index", "sku", "old_jpy", "new_jpy")}
              for c in changes]
    digest = hashlib.sha256(json.dumps(serial, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return changes, digest, skipped_blank, unchanged


def _patch(ct, products, changes):
    grouped = defaultdict(list)
    for item in changes:
        grouped[item["product_id"]].append(item)
    by_id = {str(p["id"]): p for p in products}
    count = 0
    errors = []
    for pid, variants in grouped.items():
        doc = by_id[pid]
        etag = doc.get("_etag")
        for at in range(0, len(variants), 5):
            batch = variants[at:at + 5]
            ops = []
            for row in batch:
                prefix = f'/variants/{row["variant_index"]}'
                ops.extend([
                    {"op": "set", "path": prefix + "/purchase_price_jpy", "value": row["new_jpy"]},
                    {"op": "set", "path": prefix + "/cost_vnd", "value": row["cost_vnd"]},
                ])
            try:
                result = ct.patch_item(item=pid, partition_key=doc.get("brand"),
                                       patch_operations=ops, etag=etag,
                                       match_condition=MatchConditions.IfNotModified)
                count += len(batch)
                etag = result.get("_etag")
                if not etag and at + 5 < len(variants):
                    raise RuntimeError("Thiếu ETag mới sau PATCH")
            except Exception as ex:
                # Do not leak credentials, endpoints or internal exception messages.
                status = getattr(ex, "status_code", None)
                errors.append({"product_id": pid, "skus": [x["sku"] for x in batch],
                               "reason": "Xung đột dữ liệu (ETag)" if status in (409, 412)
                               else "PATCH không thành công; kiểm tra log Azure Functions"})
                break
    return count, errors


@jpy_import_bp.route(route="inventory/jpy/catalog", methods=["GET"])
def bulk_jpy_catalog(req: func.HttpRequest) -> func.HttpResponse:
    try:
        ct = _container()
        data = _catalog_rows(_read_products(ct))
        return _response({"account": EXPECTED_UAT_ACCOUNT, "rate": RATE, "count": len(data), "rows": data})
    except PermissionError as ex:
        return _response({"error": str(ex)}, 403)
    except Exception:
        return _response({"error": "Không thể tải danh sách SKU UAT. Xem log Function."}, 500)


@jpy_import_bp.route(route="inventory/jpy/preview", methods=["POST"])
def bulk_jpy_preview(req: func.HttpRequest) -> func.HttpResponse:
    try:
        obj = _parse_payload(req)
        ct = _container()
        changes, digest, blank, unchanged = _prepare(obj["rows"], _read_products(ct))
        return _response({
            "account": EXPECTED_UAT_ACCOUNT, "rate": RATE,
            "count": len(changes), "blank": blank, "unchanged": unchanged,
            "preview_hash": digest, "changes": changes[:MAX_ROWS],
        })
    except (ValueError, TypeError) as ex:
        return _response({"error": str(ex)}, 400)
    except PermissionError as ex:
        return _response({"error": str(ex)}, 403)
    except Exception:
        return _response({"error": "Lỗi kiểm tra file nhập. Xem log Function."}, 500)


@jpy_import_bp.route(route="inventory/jpy/apply", methods=["POST"])
def bulk_jpy_apply(req: func.HttpRequest) -> func.HttpResponse:
    try:
        obj = _parse_payload(req)
        if obj.get("confirm") != ("WRITE-TO-UAT" if EXPECTED_UAT_ACCOUNT == "mrc-uat" else "WRITE-TO-PRODUCTION") or obj.get("account") != EXPECTED_UAT_ACCOUNT:
            raise ValueError("Thiếu xác nhận cập nhật UAT")
        if not isinstance(obj.get("preview_hash"), str) or len(obj["preview_hash"]) != 64:
            raise ValueError("Chưa xem trước nội dung cập nhật")
        ct = _container()
        products = _read_products(ct)
        changes, digest, _, _ = _prepare(obj["rows"], products)
        if not changes:
            raise ValueError("Không có SKU nào cần ghi")
        if digest != obj["preview_hash"]:
            return _response({"error": "Danh sách nhập khác bản đã xem trước; hãy kiểm tra lại"}, 409)
        success, errors = _patch(ct, products, changes)
        return _response({"account": EXPECTED_UAT_ACCOUNT, "updated": success,
                          "total": len(changes), "errors": errors,
                          "message": "Hoàn tất" if not errors else "Đã ghi một phần; không bấm ghi lại khi chưa Xuất file mới"},
                         200 if not errors else 207)
    except (ValueError, TypeError) as ex:
        return _response({"error": str(ex)}, 400)
    except PermissionError as ex:
        return _response({"error": str(ex)}, 403)
    except Exception:
        return _response({"error": "Lỗi khi cập nhật UAT; xem log Function."}, 500)
