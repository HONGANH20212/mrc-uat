#!/usr/bin/env python3
"""Controlled one-time SKU-only migration for MORACHI Production.

  DRY RUN (default): python3 morachi_prod_sku_migration.py --csv ~/MORACHI_PROD_SKU_PREVIEW.csv
  WRITE:             python3 morachi_prod_sku_migration.py --csv ~/MORACHI_PROD_SKU_PREVIEW.csv --apply

Requires: azure-cosmos, azure-core (existing api/.venv); Production Cosmos key is
requested interactively without echo and is never saved. Does NOT read UAT settings.
"""
from __future__ import annotations
import argparse
import csv
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from collections import defaultdict

ACCOUNT = "morachidb"
URL = f"https://{ACCOUNT}.documents.azure.com:443/"
DATABASE = "morachi-db"
CONTAINER = "products"
EXPECTED_PRODUCTS = 85
EXPECTED_VARIANTS = 240
SKU_RE = re.compile(r"SKU-MOR-\d{4,}$")
REQUIRED = {
    "product_id", "variant_index", "brand", "product_name", "variant_name",
    "stock_existing", "new_sku", "approval"
}


def stop(message):
    raise ValueError("DỪNG: " + message)


def norm(value):
    return unicodedata.normalize("NFC", str(value if value is not None else "")).strip()


def read_reviewed_csv(filename):
    if not filename.is_file():
        stop(f"Không tìm thấy CSV: {filename}")
    with filename.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
            stop("CSV thiếu cột bắt buộc: " + ", ".join(sorted(REQUIRED - set(reader.fieldnames or []))))
        rows = list(reader)
    if len(rows) != EXPECTED_VARIANTS:
        stop(f"CSV có {len(rows)} dòng; cần đúng {EXPECTED_VARIANTS} dòng như bản đã duyệt")
    if len({norm(r['product_id']) for r in rows}) != EXPECTED_PRODUCTS:
        stop(f"CSV phải gồm đủ {EXPECTED_PRODUCTS} Product ID")

    keys = set()
    skus = set()
    approved = []
    for number, row in enumerate(rows, 2):
        if None in row:
            stop(f"Dòng {number}: cấu trúc CSV không đúng, có cột thừa")
        pid, sku = norm(row["product_id"]), norm(row["new_sku"]).upper()
        try:
            index = int(norm(row["variant_index"]))
        except ValueError:
            stop(f"Dòng {number}: variant_index không hợp lệ")
        if not pid or index < 0:
            stop(f"Dòng {number}: thiếu product_id hoặc index âm")
        key = (pid, index)
        if key in keys:
            stop(f"Dòng {number}: product_id và variant_index bị trùng")
        keys.add(key)
        if not SKU_RE.fullmatch(sku) or sku in skus:
            stop(f"Dòng {number}: SKU sai định dạng hoặc trùng: {sku}")
        skus.add(sku)
        flag = norm(row["approval"]).upper()
        if flag not in {"YES", "NO"}:
            stop(f"Dòng {number}: approval phải là YES hoặc NO")
        row["_pid"] = pid
        row["_index"] = index
        row["_sku"] = sku
        if flag == "YES":
            approved.append(row)
    if not approved:
        stop("Không có dòng approval=YES")
    return rows, approved


def get_container():
    from azure.cosmos import CosmosClient
    key = getpass.getpass(f"Dán khóa Cosmos DB PRODUCTION ({ACCOUNT}), ký tự sẽ không hiện: ").strip()
    if not key:
        stop("Chưa nhập khóa Cosmos DB Production")
    client = CosmosClient(URL, credential=key)
    container = client.get_database_client(DATABASE).get_container_client(CONTAINER)
    meta = container.read()
    paths = (meta.get("partitionKey") or {}).get("paths")
    if paths != ["/brand"]:
        stop(f"Partition key không phải /brand: {paths}")
    return container


def read_products(container):
    products = list(container.query_items(
        query=("SELECT * FROM c WHERE NOT IS_DEFINED(c.type) "
               "AND IS_DEFINED(c.id) AND IS_DEFINED(c.title)"),
        enable_cross_partition_query=True
    ))
    variants = sum(sum(isinstance(v, dict) for v in (p.get("variants") or []))
                   for p in products)
    if len(products) != EXPECTED_PRODUCTS or variants != EXPECTED_VARIANTS:
        stop(f"Production hiện có {len(products)} products / {variants} variants; "
             f"khác baseline {EXPECTED_PRODUCTS}/{EXPECTED_VARIANTS}. Cần xuất và duyệt lại.")
    if len({norm(p.get("id")) for p in products}) != len(products):
        stop("Product ID bị trùng trong kết quả đọc")
    return products


def validate(rows, approved, products):
    by_id = {norm(p.get("id")): p for p in products}
    available = {}
    existing = set()
    for product in products:
        pid = norm(product["id"])
        for index, variant in enumerate(product.get("variants") or []):
            if not isinstance(variant, dict):
                continue
            available[(pid, index)] = (product, variant)
            if norm(variant.get("sku")):
                existing.add(norm(variant.get("sku")).upper())

    if len(available) != len(rows):
        stop("Số dòng CSV và variants Production không khớp")
    if set(available) != {(r["_pid"], r["_index"]) for r in rows}:
        stop("Danh sách Product ID / Variant Index đã thay đổi. Xuất CSV mới.")

    for number, row in enumerate(rows, 2):
        key = (row["_pid"], row["_index"])
        product, variant = available[key]
        for field, expected, actual in (
            ("brand", row["brand"], product.get("brand")),
            ("product_name", row["product_name"], product.get("title")),
            ("variant_name", row["variant_name"], variant.get("name")),
        ):
            if norm(expected) != norm(actual):
                stop(f"Dòng {number}: {field} khác dữ liệu hiện tại, cần xuất lại CSV")
        if row["_sku"] in existing:
            stop(f"SKU {row['_sku']} đã tồn tại trong Cosmos DB, không ghi đè")

    selected_by_id = defaultdict(list)
    for row in approved:
        product, variant = available[(row["_pid"], row["_index"])]
        if norm(variant.get("sku")):
            stop(f"{row['_pid']} / {row['_index']}: đã có SKU trên DB, không ghi đè")
        if not product.get("_etag"):
            stop(f"{row['_pid']}: thiếu _etag để chống ghi đè concurrent")
        selected_by_id[row["_pid"]].append(row)
    return selected_by_id


def save_private(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, default=str)


def main():
    parser = argparse.ArgumentParser(description="MORACHI Production — add ONLY missing variants[].sku")
    parser.add_argument("--csv", type=Path, required=True, help="CSV đã kiểm tra approval YES/NO")
    parser.add_argument("--apply", action="store_true", help="Cho phép ghi sau bước xác nhận thủ công")
    args = parser.parse_args()

    rows, approved = read_reviewed_csv(args.csv.expanduser())
    print(f"CSV hợp lệ: {len(rows)} dòng / {len(approved)} approval=YES / "
          f"{len(rows)-len(approved)} approval=NO")
    print(f"Target cố định: {ACCOUNT} / {DATABASE} / {CONTAINER}")
    print("Script không đọc api/local.settings.json và không ghi đơn hàng/giá/tồn kho.")

    container = get_container()
    products = read_products(container)
    selected_by_id = validate(rows, approved, products)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = Path.home() / "MORACHI_PROD_BACKUPS" / f"sku_{stamp}_{os.getpid()}"
    snapshot = directory / "products_before.json"
    save_private(snapshot, {
        "account": ACCOUNT, "db": DATABASE, "container": CONTAINER,
        "created_utc": stamp, "products": products
    })
    print(f"ĐÃ SAO LƯU {len(products)} product docs: {snapshot}")
    print(f"Preflight OK: dự kiến bổ sung {len(approved)} SKU trên {len(selected_by_id)} sản phẩm")

    if not args.apply:
        print("DRY RUN — KHÔNG GHI COSMOS DB. Đọc CSV và backup; chạy thêm --apply nếu muốn ghi.")
        return 0

    prompt = f"GHI {len(approved)} SKU VAO {ACCOUNT}"
    print("CẢNH BÁO: sắp cập nhật SKU trực tiếp trên PRODUCTION. Không phải thao tác atomic toàn hệ thống.")
    if input(f"Nhập chính xác [{prompt}] để đồng ý: ").strip() != prompt:
        stop("Chưa xác nhận ghi Production")

    from azure.core import MatchConditions
    results = []
    errors = []
    for pid in sorted(selected_by_id):
        rows_to_apply = sorted(selected_by_id[pid], key=lambda x: x["_index"])
        reference = {norm(p["id"]): p for p in products}[pid]
        try:
            # Read latest item for preflight on this document, catching edits since snapshot.
            live = container.read_item(item=pid, partition_key=reference["brand"])
            if live.get("_etag") != reference.get("_etag"):
                stop(f"{pid}: sản phẩm thay đổi từ lúc backup, dừng để tránh ghi đè")
            for row in rows_to_apply:
                current = live["variants"][row["_index"]]
                if norm(current.get("sku")) or norm(current.get("name")) != norm(row["variant_name"]):
                    stop(f"{pid}: phân loại thay đổi hoặc đã có SKU")
            etag = live["_etag"]
            for offset in range(0, len(rows_to_apply), 10):
                batch = rows_to_apply[offset: offset+10]
                ops = [{"op": "add", "path": f"/variants/{row['_index']}/sku", "value": row["_sku"]}
                       for row in batch]
                updated = container.patch_item(item=pid, partition_key=reference["brand"],
                    patch_operations=ops, etag=etag,
                    match_condition=MatchConditions.IfNotModified)
                etag = updated.get("_etag")
                if not etag and offset+10 < len(rows_to_apply):
                    stop(f"{pid}: patch thành công nhưng thiếu _etag mới")
                results.extend({"product_id": pid, "variant_index": row["_index"], "sku": row["_sku"]}
                               for row in batch)
                print(f"ĐÃ GHI: {pid} / {len(batch)} SKU (tổng {len(results)}/{len(approved)})")
                save_private(directory / f"journal_{len(results):04d}.json", results)
        except Exception as exc:
            errors.append({"product_id": pid, "error": str(exc)})
            print(f"DỪNG khi cập nhật {pid}: {exc}", file=sys.stderr)
            break

    save_private(directory / "result.json", {"updated": len(results), "target": len(approved),
                                                   "completed": not errors and len(results)==len(approved),
                                                   "errors": errors, "rows": results})
    print(f"KẾT QUẢ: {len(results)}/{len(approved)} SKU. Log: {directory / 'result.json'}")
    if errors or len(results) != len(approved):
        print("CHƯA HOÀN TẤT: kiểm tra Production và log, KHÔNG chạy lại mù quáng.", file=sys.stderr)
        return 1
    print("Hoàn tất. Kiểm tra lại bằng Cosmos DB Data Explorer Query đếm SKU trước khi xuất Excel.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"LỖI: {exc}", file=sys.stderr)
        sys.exit(1)
