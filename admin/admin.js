var API_BASE_URL = "/api";
var isEditing = false;
var allProductsData = [];
var allOrdersData = [];

// MORACHI_SMOOTH_ADMIN_V1: reconcile table rows, not the page.
window.morachiSmoothRows = function(tbody, html, keyAttribute) {
    if (!tbody) return;
    const draft = document.createElement('tbody');
    draft.innerHTML = html;
    const upcoming = Array.from(draft.children);
    const old = new Map();
    for (const row of Array.from(tbody.children)) {
        const key = row.getAttribute(keyAttribute);
        if (key && !old.has(key)) old.set(key, row);
    }
    for (let i = 0; i < upcoming.length; i++) {
        const fresh = upcoming[i];
        const key = fresh.getAttribute(keyAttribute);
        const previous = key ? old.get(key) : null;
        const row = previous && previous.innerHTML === fresh.innerHTML ? previous : fresh;
        // A replaced row is only the one whose data changed.
        if (previous && row !== previous) previous.replaceWith(row);
        if (tbody.children[i] !== row) tbody.insertBefore(row, tbody.children[i] || null);
    }
    while (tbody.children.length > upcoming.length) tbody.lastElementChild.remove();
};

// =========================================================
// TÍNH NĂNG SẮP XẾP SẢN PHẨM BẰNG KÉO THẢ
// - Lưu vào API nếu backend hỗ trợ display_order
// - Đồng thời lưu localStorage để refresh không bị quay về thứ tự cũ
// =========================================================
const MORACHI_PRODUCT_ORDER_KEY = "morachi_product_order_ids";

window.clearShopProductCache = function() {
    try {
        sessionStorage.removeItem("morachi_products_cache");
        sessionStorage.removeItem("morachi_products_cache_time");
    } catch (e) {}
};

window.getSavedProductOrderIds = function() {
    try {
        const raw = localStorage.getItem(MORACHI_PRODUCT_ORDER_KEY);
        const ids = JSON.parse(raw || "[]");
        return Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    } catch (e) {
        return [];
    }
};

window.saveProductOrderIdsLocal = function(ids) {
    try {
        const cleanIds = [...new Set((ids || []).map(String).filter(Boolean))];
        localStorage.setItem(MORACHI_PRODUCT_ORDER_KEY, JSON.stringify(cleanIds));
    } catch (e) {
        console.warn("Không lưu được thứ tự sản phẩm vào localStorage:", e);
    }
};

window.applySavedProductOrder = function(products) {
    const list = Array.isArray(products) ? products.map(p => ({ ...p })) : [];
    const savedIds = window.getSavedProductOrderIds();

    if (!savedIds.length) {
        return list.map((p, index) => ({
            ...p,
            display_order: Number(p.display_order || p.sort_order || p.position || index + 1)
        }));
    }

    const orderMap = new Map(savedIds.map((id, index) => [String(id), index + 1]));
    const maxSavedOrder = savedIds.length;

    return list.map((p, index) => {
        const savedOrder = orderMap.get(String(p.id));
        const apiOrder = Number(p.display_order || p.sort_order || p.position);
        const fallbackOrder = Number.isFinite(apiOrder) && apiOrder > 0 ? apiOrder : maxSavedOrder + index + 1;

        return {
            ...p,
            display_order: savedOrder || fallbackOrder
        };
    });
};

window.getProductDisplayOrder = function(product, fallbackIndex = 999999) {
    const raw = product.display_order ?? product.sort_order ?? product.position;
    const number = Number(raw);
    return Number.isFinite(number) && number > 0 ? number : fallbackIndex;
};

window.sortProductsForAdmin = function(products) {
    return [...(products || [])].sort((a, b) => {
        const orderA = window.getProductDisplayOrder(a, 999999);
        const orderB = window.getProductDisplayOrder(b, 999999);

        if (orderA !== orderB) return orderA - orderB;

        const dateA = new Date(a.created_at || a.updated_at || 0).getTime() || 0;
        const dateB = new Date(b.created_at || b.updated_at || 0).getTime() || 0;
        return dateB - dateA;
    });
};


window.verifyProductOrderSavedToServer = async function(expectedIds) {
    try {
        const res = await fetch(`${API_BASE_URL}/manage/products?t=${Date.now()}&verify_order=1`, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" }
        });
        if (!res.ok) return false;
        const products = await res.json();
        if (!Array.isArray(products)) return false;

        const byId = new Map(products.map(p => [String(p.id), p]));
        return expectedIds.every((id, index) => {
            const product = byId.get(String(id));
            if (!product) return false;
            const order = Number(product.display_order ?? product.sort_order ?? product.position);
            return Number.isFinite(order) && order === index + 1;
        });
    } catch (e) {
        console.warn("Không kiểm tra được display_order từ server:", e);
        return false;
    }
};

// Alias để giữ tương thích với code đang gọi tên cũ
function getDisplayOrder(product, index = 0) {
    return window.getProductDisplayOrder(product, index + 1);
}

function sortProductsByDisplayOrder(products) {
    return window.sortProductsForAdmin(window.applySavedProductOrder(products));
}

window.getNextProductDisplayOrder = function() {
    if (!allProductsData || allProductsData.length === 0) return 1;

    const maxOrder = allProductsData.reduce((max, item, index) => {
        const order = window.getProductDisplayOrder(item, index + 1);
        return Math.max(max, order);
    }, 0);

    return maxOrder + 1;
};

window.showReorderStatus = function(message, type = "info") {
    let el = document.getElementById("reorder-status");

    if (!el) {
        el = document.createElement("div");
        el.id = "reorder-status";
        el.className = "reorder-status";
        document.body.appendChild(el);
    }

    el.className = "reorder-status show " + type;
    el.innerHTML = message;

    clearTimeout(window.__reorderStatusTimer);
    window.__reorderStatusTimer = setTimeout(() => {
        el.classList.remove("show");
    }, 3000);
};

window.buildProductPayloadForOrderSave = function(product) {
    return {
        title: product.title || "",
        brand: product.brand || "",
        current_price: product.current_price || "",
        old_price: product.old_price || "",
        discount: product.discount || "",
        description: product.description || "",
        specifications: product.specifications || "",
        ingredients: product.ingredients || "",
        usage_manual: product.usage_manual || "",
        thumbnail: product.thumbnail || "",
        status: product.status || "active",
        variants: Array.isArray(product.variants) ? product.variants : [],
        display_order: Number(product.display_order) || 999999
    };
};

window.persistProductOrder = async function() {
    const tbody = document.getElementById("admin-product-list");
    if (!tbody) return;

    const visibleIds = [...tbody.querySelectorAll("tr[data-product-id]")]
        .map(row => String(row.dataset.productId))
        .filter(Boolean);

    if (visibleIds.length <= 1) return;

    const productById = new Map(allProductsData.map(p => [String(p.id), p]));
    const visibleSet = new Set(visibleIds);

    // Giữ nguyên vị trí các sản phẩm đang bị lọc ẩn, chỉ đổi thứ tự các dòng đang hiển thị.
    const currentGlobalOrder = window.sortProductsForAdmin(allProductsData);
    const visibleQueue = [...visibleIds];

    const newGlobalOrder = currentGlobalOrder.map(product => {
        const id = String(product.id);
        if (!visibleSet.has(id)) return product;

        const nextVisibleId = visibleQueue.shift();
        return productById.get(String(nextVisibleId)) || product;
    });

    // Đánh lại thứ tự từ 1 -> n
    newGlobalOrder.forEach((product, index) => {
        product.display_order = index + 1;
    });

    allProductsData = newGlobalOrder;

    // LƯU LOCAL TRƯỚC: giúp refresh không bị quay về thứ tự cũ dù backend chưa hỗ trợ display_order
    const allIdsInNewOrder = newGlobalOrder.map(p => String(p.id));
    window.saveProductOrderIdsLocal(allIdsInNewOrder);
    window.clearShopProductCache();

    window.showReorderStatus('<i class="fas fa-spinner fa-spin"></i> Đang lưu thứ tự sản phẩm...', 'info');

    const orders = newGlobalOrder.map(product => ({
        id: product.id,
        display_order: Number(product.display_order) || 999999
    }));

    let savedToServer = false;

    try {
        // Ưu tiên endpoint riêng nếu backend có hỗ trợ.
        try {
            const bulkRes = await fetch(`${API_BASE_URL}/products/reorder`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orders, items: orders })
            });

            if (bulkRes.ok) {
                savedToServer = true;
            }
        } catch (e) {
            savedToServer = false;
        }

        // Nếu backend chưa có /products/reorder thì dùng API cập nhật sản phẩm hiện có.
        if (!savedToServer) {
            const results = [];
            for (const product of newGlobalOrder) {
                const res = await fetch(`${API_BASE_URL}/products/${product.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(window.buildProductPayloadForOrderSave(product))
                });
                results.push(res);
            }

            savedToServer = results.every(res => res.ok);
        }

        if (savedToServer) {
            const verified = await window.verifyProductOrderSavedToServer(allIdsInNewOrder);
            if (verified) {
                window.showReorderStatus('<i class="fas fa-check-circle"></i> Đã lưu thứ tự lên server. Điện thoại sẽ hiển thị đúng sau khi tải lại!', 'success');
            } else {
                window.showReorderStatus('<i class="fas fa-exclamation-triangle"></i> Admin đã đổi thứ tự, nhưng API chưa trả về display_order. Cần cập nhật backend để điện thoại thấy đúng.', 'warning');
            }
        } else {
            window.showReorderStatus('<i class="fas fa-info-circle"></i> Đã lưu thứ tự trên trình duyệt này. Backend chưa lưu display_order nên điện thoại chưa đồng bộ.', 'warning');
        }

        window.renderTable(window.sortProductsForAdmin(allProductsData));
    } catch (err) {
        console.error(err);
        // Không reload lại vì sẽ làm người dùng tưởng bị mất thứ tự. LocalStorage vẫn giữ thứ tự đã kéo.
        window.showReorderStatus('<i class="fas fa-info-circle"></i> Đã giữ thứ tự trên trình duyệt. API chưa lưu được.', 'warning');
        window.renderTable(window.sortProductsForAdmin(allProductsData));
    }
};

window.getDragAfterElement = function(container, y) {
    const draggableElements = [...container.querySelectorAll("tr.drag-sort-row:not(.dragging)")];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }

        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
};

window.enableProductDragSort = function() {
    const tbody = document.getElementById("admin-product-list");
    if (!tbody) return;

    const dragState = tbody.__morachiDragState || (tbody.__morachiDragState = {current:null});
    const rows = [...tbody.querySelectorAll("tr[data-product-id]")];

    rows.forEach(row => {
        const handle = row.querySelector(".drag-handle");
        if (!handle || row.dataset.morachiDragBound === '1') return;
        row.dataset.morachiDragBound = '1';

        row.draggable = false;

        handle.addEventListener("mousedown", () => {
            row.draggable = true;
        });

        handle.addEventListener("mouseup", () => {
            row.draggable = false;
        });

        handle.addEventListener("touchstart", () => {
            row.draggable = true;
        }, { passive: true });

        row.addEventListener("dragstart", (event) => {
            dragState.current = row;
            row.classList.add("dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", row.dataset.productId || "");
        });

        row.addEventListener("dragend", () => {
            row.classList.remove("dragging");
            row.draggable = false;
            dragState.current = null;
            window.persistProductOrder();
        });
    });

    if (!tbody.dataset.morachiDragOverBound) {
        tbody.dataset.morachiDragOverBound = '1';
        tbody.addEventListener("dragover", (event) => {
            if (!dragState.current) return;
            event.preventDefault();
            const afterElement = window.getDragAfterElement(tbody, event.clientY);
            if (afterElement == null) tbody.appendChild(dragState.current);
            else tbody.insertBefore(dragState.current, afterElement);
        });
    }
};



// =========================================================
// PHÂN LOẠI SẢN PHẨM V6
// - category: makeup | skincare | supplement
// - subcategory Makeup: face | eyes | lips | cheeks | brows
// - 2highend là collection độc lập thông qua is_highend/collections
// =========================================================
window.selectedProductIds = window.selectedProductIds || new Set();
window.__taxonomySuggestions = [];

const MORACHI_CATEGORY_LABELS = {
    makeup: "Trang Điểm",
    skincare: "Chăm sóc da",
    supplement: "Thực phẩm chức năng"
};
const MORACHI_SUBCATEGORY_LABELS = {
    face: "Mặt",
    eyes: "Mắt",
    lips: "Môi",
    cheeks: "Má",
    brows: "Mày"
};

window.normalizeAdminText = function(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
};

window.normalizeProductCategory = function(value) {
    const text = window.normalizeAdminText(value);
    if (["makeup", "trang diem"].includes(text)) return "makeup";
    if (["skincare", "cham soc da"].includes(text)) return "skincare";
    if (["supplement", "thuc pham chuc nang"].includes(text)) return "supplement";
    return "";
};

window.normalizeProductSubcategory = function(value) {
    const text = window.normalizeAdminText(value);
    const aliases = {
        face: "face", mat: "face",
        eyes: "eyes", eye: "eyes",
        lips: "lips", lip: "lips", moi: "lips",
        cheeks: "cheeks", cheek: "cheeks", ma: "cheeks",
        brows: "brows", brow: "brows", may: "brows"
    };
    return aliases[text] || "";
};

window.getProductCollectionsAdmin = function(product) {
    const value = product && product.collections;
    if (Array.isArray(value)) return value.map(window.normalizeAdminText).filter(Boolean);
    if (!value) return [];
    return String(value).split(/[,;|]/).map(window.normalizeAdminText).filter(Boolean);
};

window.isProductHighendAdmin = function(product) {
    if (!product) return false;
    const raw = product.is_highend;
    if (raw === true || raw === 1 || String(raw).toLowerCase() === "true") return true;
    if (["highend", "2highend", "high end"].includes(window.normalizeAdminText(product.category))) return true;
    return window.getProductCollectionsAdmin(product).includes("highend");
};

window.isProductUnclassified = function(product) {
    return !window.normalizeProductCategory(product && product.category);
};

window.getProductCategoryBadgeHtml = function(product) {
    const category = window.normalizeProductCategory(product && product.category);
    const subcategory = window.normalizeProductSubcategory(product && product.subcategory);
    const highend = window.isProductHighendAdmin(product);
    const parts = [];

    if (category) {
        parts.push(`<span class="taxonomy-badge ${category}">${MORACHI_CATEGORY_LABELS[category]}</span>`);
        if (category === "makeup" && subcategory) {
            parts.push(`<span class="taxonomy-badge sub">${MORACHI_SUBCATEGORY_LABELS[subcategory]}</span>`);
        }
    } else {
        parts.push('<span class="taxonomy-badge unclassified"><i class="fas fa-triangle-exclamation" style="margin-right:4px;"></i>Chưa phân loại</span>');
    }

    if (highend) parts.push('<span class="taxonomy-badge highend">★ 2highend</span>');
    return `<div class="taxonomy-badge-wrap">${parts.join("")}</div>`;
};

window.updateTaxonomyStats = function(products) {
    const el = document.getElementById("stat-unclassified");
    if (!el) return;
    el.innerText = (products || []).filter(window.isProductUnclassified).length.toLocaleString("vi-VN");
};

window.getCurrentProductFilters = function() {
    return {
        keyword: (document.getElementById("admin-search-input")?.value || "").toLowerCase().trim(),
        brand: document.getElementById("filter-brand")?.value || "",
        category: document.getElementById("filter-category")?.value || "",
        subcategory: document.getElementById("filter-subcategory")?.value || ""
    };
};

window.applyAdminProductFilters = function() {
    const filters = window.getCurrentProductFilters();
    window.filterProducts(filters.keyword, filters.brand, filters.category, filters.subcategory);
};

window.bindTaxonomyFilters = function() {
    const categoryEl = document.getElementById("filter-category");
    if (categoryEl && !categoryEl.dataset.taxonomyBound) {
        categoryEl.dataset.taxonomyBound = "1";
        categoryEl.addEventListener("change", () => {
            const sub = document.getElementById("filter-subcategory");
            if (sub && categoryEl.value && !["makeup", "highend"].includes(categoryEl.value)) sub.value = "";
            window.applyAdminProductFilters();
        });
    }
    const subEl = document.getElementById("filter-subcategory");
    if (subEl && !subEl.dataset.taxonomyBound) {
        subEl.dataset.taxonomyBound = "1";
        subEl.addEventListener("change", window.applyAdminProductFilters);
    }
};

window.filterUnclassifiedProducts = function() {
    const category = document.getElementById("filter-category");
    if (category) category.value = "unclassified";
    const sub = document.getElementById("filter-subcategory");
    if (sub) sub.value = "";
    window.applyAdminProductFilters();
};

window.clearProductTaxonomyFilters = function() {
    const search = document.getElementById("admin-search-input");
    const brand = document.getElementById("filter-brand");
    const category = document.getElementById("filter-category");
    const sub = document.getElementById("filter-subcategory");
    if (search) search.value = "";
    if (brand) brand.value = "";
    if (category) category.value = "";
    if (sub) sub.value = "";
    window.applyAdminProductFilters();
};

window.updateProductSelectionUI = function() {
    const selected = window.selectedProductIds;
    const count = document.getElementById("selected-product-count");
    if (count) count.innerText = selected.size;

    document.querySelectorAll(".product-bulk-checkbox").forEach(cb => {
        cb.checked = selected.has(String(cb.value));
    });

    const all = document.getElementById("check-all-products");
    if (all) {
        const visible = [...document.querySelectorAll(".product-bulk-checkbox")];
        all.checked = visible.length > 0 && visible.every(cb => cb.checked);
        all.indeterminate = visible.some(cb => cb.checked) && !all.checked;
    }
};

window.toggleProductSelection = function(id, checked) {
    id = String(id);
    if (checked) window.selectedProductIds.add(id);
    else window.selectedProductIds.delete(id);
    window.updateProductSelectionUI();
};

window.toggleAllProducts = function(source) {
    document.querySelectorAll(".product-bulk-checkbox").forEach(cb => {
        const id = String(cb.value);
        if (source.checked) window.selectedProductIds.add(id);
        else window.selectedProductIds.delete(id);
    });
    window.updateProductSelectionUI();
};

window.clearProductSelection = function() {
    window.selectedProductIds.clear();
    window.updateProductSelectionUI();
};

window.setRadioValue = function(name, value) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
        input.checked = String(input.value) === String(value || "");
    });
};

window.getCheckedValue = function(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
};

window.updateProductSubcategoryVisibility = function() {
    const category = window.getCheckedValue("product-category");
    const field = document.getElementById("product-subcategory-field");
    if (field) field.style.display = category === "makeup" ? "block" : "none";
    if (category && category !== "makeup") window.setRadioValue("product-subcategory", "");
};

window.updateBulkSubcategoryVisibility = function() {
    const category = window.getCheckedValue("bulk-category");
    const field = document.getElementById("bulk-subcategory-field");
    if (field) field.style.display = category === "makeup" ? "block" : "none";
    if (category && category !== "makeup") window.setRadioValue("bulk-subcategory", "");
};

window.setProductTaxonomyForm = function(product) {
    const category = window.normalizeProductCategory(product && product.category);
    const subcategory = window.normalizeProductSubcategory(product && product.subcategory);
    window.setRadioValue("product-category", category);
    window.setRadioValue("product-subcategory", subcategory);
    const highend = document.getElementById("product-highend");
    if (highend) highend.checked = window.isProductHighendAdmin(product || {});
    const type = document.getElementById("product-type");
    if (type) type.value = product && product.product_type ? product.product_type : "";
    window.updateProductSubcategoryVisibility();
};

// ----- Bộ luật gợi ý: chỉ hỗ trợ nhập nhanh, Admin luôn là người xác nhận -----
window.suggestProductTaxonomy = function(product) {
    const title = window.normalizeAdminText(product && product.title);
    const brand = window.normalizeAdminText(product && product.brand);
    const text = `${title} ${brand}`.trim();

    const scoreRules = {
        supplement: [
            [/thuc pham chuc nang|supplement/, 100], [/vien uong|vitamin|collagen/, 95],
            [/omega|dha|epa|calcium|canxi|probiotic|enzyme|zinc|sat\b/, 88]
        ],
        skincare: [
            [/sua rua mat|cleanser|cleansing|tay trang/, 96], [/toner|serum|essence/, 94],
            [/kem chong nang|sunscreen|uv gel|uv milk/, 94], [/kem duong|duong am|moisturizer/, 92],
            [/mat na|face mask|sheet mask|skin care|skincare/, 90], [/lotion/, 82]
        ],
        makeup: [
            [/phan phu|face powder|finish powder|finishing powder/, 100], [/foundation|kem nen|cushion/, 98],
            [/concealer|che khuyet|primer|base makeup/, 95], [/son\b|\blip\b|lipstick|lip balm|lip tint|rouge/, 98],
            [/mascara|eyeliner|ke mat|eye shadow|eyeshadow|phan mat/, 98],
            [/cream cheek|ma hong|blush|cheek/, 98], [/eyebrow|brow|ke may|chi may/, 98],
            [/highlight|highlighter|contour|tao khoi/, 92]
        ]
    };

    const scores = {};
    Object.entries(scoreRules).forEach(([key, rules]) => {
        scores[key] = rules.reduce((max, [regex, score]) => regex.test(text) ? Math.max(max, score) : max, 0);
    });
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    let category = sorted[0][1] > 0 ? sorted[0][0] : "";
    let confidence = sorted[0][1] || 0;
    let note = "";
    if (sorted[1] && sorted[1][1] > 0 && Math.abs(sorted[0][1] - sorted[1][1]) < 12) {
        confidence = Math.min(confidence, 65);
        note = "Tên có dấu hiệu thuộc nhiều nhóm; nên kiểm tra thủ công.";
    }

    let subcategory = "";
    let productType = "";
    if (category === "makeup") {
        const subRules = [
            ["cheeks", /cream cheek|ma hong|blush|cheek/, "blush", 100],
            ["brows", /eyebrow|brow|ke may|chi may|mascara may/, "eyebrow", 100],
            ["eyes", /mascara|eyeliner|ke mat|eye shadow|eyeshadow|phan mat/, "eye_makeup", 100],
            ["lips", /son\b|\blip\b|lipstick|lip balm|lip tint|rouge|moi\b/, "lip", 100],
            ["face", /phan phu|face powder|finish powder|finishing powder/, "powder", 100],
            ["face", /foundation|kem nen|cushion/, "foundation", 98],
            ["face", /concealer|che khuyet/, "concealer", 98],
            ["face", /primer|base makeup|lot nen/, "primer", 94],
            ["face", /highlight|highlighter|contour|tao khoi/, "highlight_contour", 92]
        ];
        const matches = subRules.filter(([, regex]) => regex.test(text));
        const uniqueSubs = [...new Set(matches.map(m => m[0]))];
        if (uniqueSubs.length === 1) {
            subcategory = uniqueSubs[0];
            const best = matches.sort((a,b) => b[3]-a[3])[0];
            productType = best[2];
            confidence = Math.min(100, Math.max(confidence, best[3]));
        } else if (uniqueSubs.length > 1) {
            confidence = Math.min(confidence, 60);
            note = "Sản phẩm có nhiều chức năng Trang Điểm; cần chọn Mặt/Mắt/Môi/Má/Mày thủ công.";
        }
    } else if (category === "skincare") {
        const typeRules = [
            [/sua rua mat|cleanser/, "cleanser"], [/cleansing|tay trang/, "cleansing"], [/toner/, "toner"],
            [/serum/, "serum"], [/essence/, "essence"], [/sunscreen|chong nang|uv gel|uv milk/, "sunscreen"],
            [/mask|mat na/, "mask"], [/moisturizer|kem duong|duong am/, "moisturizer"], [/lotion/, "lotion"]
        ];
        productType = (typeRules.find(([r]) => r.test(text)) || [null, ""])[1];
    } else if (category === "supplement") {
        const typeRules = [
            [/collagen/, "collagen"], [/vitamin/, "vitamin"], [/omega|dha|epa/, "omega"],
            [/probiotic/, "probiotic"], [/calcium|canxi/, "calcium"], [/zinc/, "zinc"]
        ];
        productType = (typeRules.find(([r]) => r.test(text)) || [null, ""])[1];
    }

    const highendBrands = [
        "dior", "chanel", "suqqu", "decorte", "cosme decorte", "cle de peau", "cle de peau beaute",
        "ysl", "yves saint laurent", "givenchy", "lancome", "estee lauder", "nars", "guerlain", "tom ford"
    ];
    const isHighend = highendBrands.some(name => brand === name || brand.includes(name));

    if (!category) note = "Chưa đủ từ khóa để gợi ý chính xác.";
    return { category, subcategory, product_type: productType, is_highend: isHighend, confidence, note };
};

window.getTaxonomySuggestionLabel = function(suggestion) {
    if (!suggestion || !suggestion.category) return "Chưa xác định";
    let label = MORACHI_CATEGORY_LABELS[suggestion.category] || suggestion.category;
    if (suggestion.subcategory) label += ` > ${MORACHI_SUBCATEGORY_LABELS[suggestion.subcategory] || suggestion.subcategory}`;
    if (suggestion.is_highend) label += " + 2highend";
    return label;
};

window.suggestCurrentProductCategory = function() {
    const product = {
        title: document.getElementById("title")?.value || "",
        brand: document.getElementById("brand")?.value || ""
    };
    const suggestion = window.suggestProductTaxonomy(product);
    const hint = document.getElementById("product-taxonomy-suggestion");
    if (!suggestion.category) {
        if (hint) hint.innerHTML = `<span style="color:var(--warning);"><i class="fas fa-triangle-exclamation"></i> ${suggestion.note}</span>`;
        return;
    }
    window.setRadioValue("product-category", suggestion.category);
    window.setRadioValue("product-subcategory", suggestion.subcategory);
    const type = document.getElementById("product-type");
    if (type && suggestion.product_type) type.value = suggestion.product_type;
    const highend = document.getElementById("product-highend");
    if (highend && suggestion.is_highend) highend.checked = true;
    window.updateProductSubcategoryVisibility();
    if (hint) hint.innerHTML = `<span style="color:var(--success);"><i class="fas fa-circle-check"></i> Gợi ý ${window.getTaxonomySuggestionLabel(suggestion)} • độ tin cậy ${suggestion.confidence}%.</span>${suggestion.note ? ` <span>${suggestion.note}</span>` : ""}`;
};

window.openBulkCategoryModal = function() {
    if (!window.selectedProductIds.size) return alert("Vui lòng tick ít nhất 1 sản phẩm.");
    window.setRadioValue("bulk-category", "");
    window.setRadioValue("bulk-subcategory", "");
    const highend = document.getElementById("bulk-highend");
    const highendUpdate = document.getElementById("bulk-highend-update");
    if (highend) highend.checked = false;
    if (highendUpdate) highendUpdate.checked = false;
    const count = document.getElementById("bulk-category-selected-count");
    if (count) count.innerText = window.selectedProductIds.size;
    const msg = document.getElementById("bulk-category-message");
    if (msg) msg.innerText = "";
    window.updateBulkSubcategoryVisibility();
    const modal = document.getElementById("bulkCategoryModal");
    if (modal) modal.style.display = "flex";
};

window.closeBulkCategoryModal = function() {
    const modal = document.getElementById("bulkCategoryModal");
    if (modal) modal.style.display = "none";
};

window.callBulkCategoryApi = async function(ids, patch) {
    const res = await fetch(`${API_BASE_URL}/products/bulk-category`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, ...patch })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
};

window.applyBulkProductCategory = async function() {
    const ids = [...window.selectedProductIds];
    if (!ids.length) return alert("Chưa chọn sản phẩm.");

    const category = window.getCheckedValue("bulk-category");
    const subcategory = window.getCheckedValue("bulk-subcategory");
    const updateHighend = !!document.getElementById("bulk-highend-update")?.checked;
    const isHighend = !!document.getElementById("bulk-highend")?.checked;
    if (!category && !updateHighend) return alert("Chọn danh mục hoặc bật cập nhật 2highend.");
    if (category === "makeup" && !subcategory) return alert("Trang Điểm cần chọn Mặt / Mắt / Môi / Má / Mày.");

    const patch = { category_source: "bulk", category_confidence: 100 };
    if (category) {
        patch.category = category;
        patch.subcategory = category === "makeup" ? subcategory : "";
    }
    if (updateHighend) patch.is_highend = isHighend;

    const msg = document.getElementById("bulk-category-message");
    if (msg) { msg.style.color = "#4f46e5"; msg.innerText = "Đang cập nhật..."; }
    try {
        const result = await window.callBulkCategoryApi(ids, patch);
        if (msg) { msg.style.color = "var(--success)"; msg.innerText = result.message || "Cập nhật thành công."; }
        window.clearShopProductCache();
        window.clearProductSelection();
        await window.loadAdminProducts({silent:true});
        setTimeout(window.closeBulkCategoryModal, 700);
    } catch (error) {
        if (msg) { msg.style.color = "var(--danger)"; msg.innerText = error.message; }
    }
};

window.buildSuggestionRows = function(products) {
    const rows = (products || []).map(product => ({ product, suggestion: window.suggestProductTaxonomy(product) }));
    window.__taxonomySuggestions = rows;
    const list = document.getElementById("suggestion-list");
    if (!list) return;

    const header = `<div class="suggestion-row header"><div></div><div>Sản phẩm</div><div>Gợi ý</div><div>Tin cậy</div></div>`;
    const body = rows.map((row, index) => {
        const suggestion = row.suggestion;
        const canApply = !!suggestion.category && suggestion.confidence >= 70;
        const checked = suggestion.confidence >= 85 && suggestion.category ? "checked" : "";
        const confidenceClass = suggestion.confidence >= 85 ? "good" : "warn";
        const safeTitle = window.escapeAdminHtml ? window.escapeAdminHtml(row.product.title || "") : String(row.product.title || "");
        return `<div class="suggestion-row">
            <div><input type="checkbox" class="suggestion-checkbox" value="${index}" ${checked} ${canApply ? "" : "disabled"}></div>
            <div><div class="suggestion-product-name">${safeTitle}</div><div class="suggestion-note">${suggestion.note || (window.isProductUnclassified(row.product) ? "Chưa phân loại" : "Đã có danh mục; chỉ cập nhật nếu anh tick.")}</div></div>
            <div>${window.getTaxonomySuggestionLabel(suggestion)}</div>
            <div class="suggestion-confidence ${confidenceClass}">${suggestion.confidence || 0}%</div>
        </div>`;
    }).join("");
    list.innerHTML = header + body;
};

window.openAutoSuggestionModal = function(productIds = null) {
    let source = allProductsData || [];
    if (Array.isArray(productIds) && productIds.length) {
        const idSet = new Set(productIds.map(String));
        source = source.filter(p => idSet.has(String(p.id)));
    } else {
        const unclassified = source.filter(window.isProductUnclassified);
        if (unclassified.length) source = unclassified;
    }
    window.buildSuggestionRows(source);
    const msg = document.getElementById("suggestion-message");
    if (msg) msg.innerText = `Đang hiển thị ${source.length} sản phẩm. Mục ≥85% được tick sẵn.`;
    const modal = document.getElementById("autoSuggestionModal");
    if (modal) modal.style.display = "flex";
};

window.suggestSelectedProducts = function() {
    const ids = [...window.selectedProductIds];
    if (!ids.length) return alert("Vui lòng tick sản phẩm cần gợi ý.");
    window.openAutoSuggestionModal(ids);
};

window.closeAutoSuggestionModal = function() {
    const modal = document.getElementById("autoSuggestionModal");
    if (modal) modal.style.display = "none";
};

window.applySelectedSuggestions = async function() {
    const selectedIndexes = [...document.querySelectorAll(".suggestion-checkbox:checked")].map(cb => Number(cb.value));
    if (!selectedIndexes.length) return alert("Chưa tick gợi ý nào để áp dụng.");

    const groups = new Map();
    selectedIndexes.forEach(index => {
        const row = window.__taxonomySuggestions[index];
        if (!row || !row.suggestion.category) return;
        const s = row.suggestion;
        const key = JSON.stringify([s.category, s.subcategory || "", s.product_type || "", !!s.is_highend, s.confidence]);
        if (!groups.has(key)) groups.set(key, { ids: [], suggestion: s });
        groups.get(key).ids.push(String(row.product.id));
    });

    const msg = document.getElementById("suggestion-message");
    if (msg) { msg.style.color = "#4f46e5"; msg.innerText = "Đang áp dụng các gợi ý đã chọn..."; }
    let updated = 0;
    try {
        for (const { ids, suggestion } of groups.values()) {
            const patch = {
                category: suggestion.category,
                subcategory: suggestion.category === "makeup" ? suggestion.subcategory : "",
                product_type: suggestion.product_type || "",
                category_source: "suggestion",
                category_confidence: suggestion.confidence
            };
            // Không tự gỡ 2highend nếu thuật toán không nhận ra; chỉ thêm khi gợi ý chắc chắn.
            if (suggestion.is_highend) patch.is_highend = true;
            const result = await window.callBulkCategoryApi(ids, patch);
            updated += Number(result.updated || 0);
        }
        if (msg) { msg.style.color = "var(--success)"; msg.innerText = `Đã áp dụng phân loại cho ${updated} sản phẩm.`; }
        window.clearShopProductCache();
        window.clearProductSelection();
        await window.loadAdminProducts({silent:true});
        setTimeout(window.closeAutoSuggestionModal, 900);
    } catch (error) {
        if (msg) { msg.style.color = "var(--danger)"; msg.innerText = `Có lỗi: ${error.message}`; }
    }
};

// =========================================================
// PHẦN 1: QUẢN LÝ KHO SẢN PHẨM
// =========================================================

window.loadAdminProducts = async function(options = {}) {
    const tbody = document.getElementById("admin-product-list");
    if (!tbody) return;
    const silent = !!options.silent || !!tbody.querySelector('tr[data-product-id]');
    const serial = window.__morachiProductsRequest = (window.__morachiProductsRequest || 0) + 1;
    if (!silent) tbody.innerHTML = "<tr><td colspan='9' style='text-align:center; padding: 40px;'><i class='fas fa-spinner fa-spin'></i> Đang tải dữ liệu...</td></tr>";

    try {
        const response = await fetch(`${API_BASE_URL}/manage/products?t=${new Date().getTime()}`, {cache:'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const products = await response.json();
        if (serial !== window.__morachiProductsRequest) return;
        if (!Array.isArray(products)) throw new Error('API trả về danh sách sản phẩm không hợp lệ');
        allProductsData = sortProductsByDisplayOrder(products);

        window.updateDashboardStats(allProductsData);
        window.updateTaxonomyStats(allProductsData);
        window.populateBrandFilter(allProductsData);
        window.bindTaxonomyFilters();
        window.applyAdminProductFilters();
    } catch (err) {
        console.error('Không đồng bộ được sản phẩm:', err);
        if (!silent) tbody.innerHTML = "<tr><td colspan='9' style='text-align:center; color:red; padding: 40px;'>Lỗi kết nối API!</td></tr>";
        else if (typeof window.showReorderStatus === 'function') window.showReorderStatus('Không cập nhật được sản phẩm, dữ liệu đang hiển thị được giữ nguyên.', 'error');
    }
}

window.updateDashboardStats = function(products) {
    if(!document.getElementById("stat-total")) return;

    let total = products.length;
    let active = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let brands = new Set();

    products.forEach(p => {
        if(p.brand) brands.add(p.brand.trim());
        
        let totalStock = 0;
        if (p.variants && p.variants.length > 0) {
            totalStock = p.variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);
        }

        if (totalStock > 0) active++;
        if (totalStock > 0 && totalStock <= 10) lowStock++;
        if (totalStock === 0) outOfStock++;
    });

    document.getElementById("stat-total").innerText = total.toLocaleString();
    document.getElementById("stat-active").innerText = active.toLocaleString();
    document.getElementById("stat-low").innerText = lowStock.toLocaleString();
    document.getElementById("stat-out").innerText = outOfStock.toLocaleString();
    document.getElementById("stat-brands").innerText = brands.size.toLocaleString();
}

window.populateBrandFilter = function(products) {
    const brandSelect = document.getElementById("filter-brand");
    if(!brandSelect) return;

    const currentValue = brandSelect.value;
    let brands = [...new Set(products.map(p => p.brand).filter(b => b))].sort((a,b) => String(a).localeCompare(String(b), "vi"));
    let html = `<option value="">Thương hiệu</option>`;
    brands.forEach(b => { html += `<option value="${String(b).replace(/"/g, '&quot;')}">${b}</option>`; });
    brandSelect.innerHTML = html;
    if (brands.includes(currentValue)) brandSelect.value = currentValue;

    brandSelect.onchange = window.applyAdminProductFilters;
}

window.filterProducts = function(keyword, brandFilter, categoryFilter, subcategoryFilter) {
    keyword = String(keyword || "").toLowerCase().trim();
    brandFilter = brandFilter || "";
    categoryFilter = categoryFilter || "";
    subcategoryFilter = subcategoryFilter || "";

    const filtered = allProductsData.filter(p => {
        const titleMatch = (p.title || "").toLowerCase().includes(keyword);
        const brandMatch = brandFilter ? p.brand === brandFilter : true;
        const category = window.normalizeProductCategory(p.category);
        const subcategory = window.normalizeProductSubcategory(p.subcategory);

        let categoryMatch = true;
        if (categoryFilter === "highend") categoryMatch = window.isProductHighendAdmin(p);
        else if (categoryFilter === "unclassified") categoryMatch = !category;
        else if (categoryFilter) categoryMatch = category === categoryFilter;

        const subcategoryMatch = subcategoryFilter ? subcategory === subcategoryFilter : true;
        return titleMatch && brandMatch && categoryMatch && subcategoryMatch;
    });
    window.renderTable(sortProductsByDisplayOrder(filtered));
}

window.bindAdminSearch = function() {
    const searchInput = document.getElementById("admin-search-input");
    if (!searchInput || searchInput.dataset.adminSearchBound) return;
    searchInput.dataset.adminSearchBound = "1";
    searchInput.addEventListener("input", window.applyAdminProductFilters);
}

window.renderTable = function(products) {
    const tbody = document.getElementById("admin-product-list");
    if (!tbody) return;

    const sortedProducts = window.sortProductsForAdmin(products || []);

    if (sortedProducts.length === 0) {
        window.morachiSmoothRows(tbody, "<tr><td colspan='9' style='text-align:center; padding: 40px; color:#888;'>Không tìm thấy sản phẩm phù hợp.</td></tr>", 'data-product-id');
        return;
    }

    const productRowsHtml = sortedProducts.map((p, index) => {
        const variants = p.variants || [];
        let totalStock = variants.reduce((sum, v) => sum + (parseInt(v.stock) || 0), 0);

        let variantHtml = '';
        if (variants.length > 0) {
            let limitVariants = variants.slice(0, 3);
            variantHtml = limitVariants.map(v => `<span class="variant-pill">${v.name}</span>`).join('');
            if (variants.length > 3) {
                variantHtml += `<span class="variant-pill" style="background:#fff2eb; color:#f57224; border:none;">+${variants.length - 3}</span>`;
            }
        }

        const badgeHtml = p.discount ? `<span class="badge-hot">${p.discount}</span>` : '';
        const categoryHtml = window.getProductCategoryBadgeHtml(p);

        let stockDot = '';
        let stockText = '';
        let statusBadge = '';

        if (totalStock > 10) {
            stockDot = '<div class="dot green"></div>';
            stockText = `<div style="color:var(--success);">${totalStock} <br><span style="font-size:11px; font-weight:normal; color:#888;">Còn hàng</span></div>`;
            statusBadge = `<span class="status-badge active">Đang bán</span>`;
        } else if (totalStock > 0 && totalStock <= 10) {
            stockDot = '<div class="dot yellow"></div>';
            stockText = `<div style="color:var(--warning);">${totalStock} <br><span style="font-size:11px; font-weight:normal; color:#888;">Sắp hết</span></div>`;
            statusBadge = `<span class="status-badge active">Đang bán</span>`;
        } else {
            stockDot = '<div class="dot red"></div>';
            stockText = `<div style="color:var(--danger);">0 <br><span style="font-size:11px; font-weight:normal; color:#888;">Hết hàng</span></div>`;
            statusBadge = `<span class="status-badge out">Hết hàng</span>`;
        }

        return `
            <tr class="drag-sort-row" data-product-id="${p.id}">
                <td class="sort-cell">
                    <button type="button" class="drag-handle" title="Giữ chuột và kéo để đổi thứ tự">
                        <i class="fas fa-grip-vertical"></i>
                    </button>
                    <span class="sort-number">${window.getProductDisplayOrder(p, index + 1)}</span>
                </td>
                <td style="text-align: center;"><input type="checkbox" class="product-bulk-checkbox" value="${p.id}" ${window.selectedProductIds.has(String(p.id)) ? 'checked' : ''} onchange="window.toggleProductSelection('${p.id}', this.checked)"></td>
                <td>
                    <div class="product-cell">
                        <img src="${p.thumbnail}" onerror="this.src='/images/icon-logo.png'">
                        <div class="info">
                            <div class="name">${p.title} ${badgeHtml}</div>
                            <div class="variants-list">${variantHtml}</div>
                        </div>
                    </div>
                </td>
                <td style="color:#555; font-weight:500;">${p.brand || 'N/A'}</td>
                <td>${categoryHtml}</td>
                <td>
                    <div class="stock-status">
                        ${stockDot} ${stockText}
                    </div>
                </td>
                <td style="color: var(--accent); font-weight: 600;">${Number(p.current_price).toLocaleString('vi-VN')} đ</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="actions">
                        <button class="btn-icon" title="Chỉnh sửa" onclick="window.editProduct('${p.id}')"><i class="fas fa-pen"></i></button>
                        <button class="btn-icon" title="Xóa" style="color:var(--danger);" onclick="window.deleteProduct('${p.id}', '${p.brand}')"><i class="far fa-trash-alt"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
    window.morachiSmoothRows(tbody, productRowsHtml, 'data-product-id');

    window.enableProductDragSort();
    window.updateProductSelectionUI();
}

window.deleteProduct = async function(id, brand) {
    if (!confirm(`Bạn có chắc chắn muốn xóa sản phẩm ${brand}?`)) return;
    try {
        const res = await fetch(`${API_BASE_URL}/products/${id}`, { method: "DELETE" });
        if (res.ok) { 
            window.clearShopProductCache();
            await window.loadAdminProducts({silent:true});
            window.showReorderStatus?.('Đã xóa sản phẩm', 'success');
        }
    } catch (err) { alert("Lỗi hệ thống khi xóa!"); }
}

window.addVariantRow = function(data = {}) {
    const container = document.getElementById("variants-container");
    if (!container) return;

    const row = document.createElement("div");
    row.className = "variant-row";
    
    row.innerHTML = `
        <div>
            <label>Phân loại <span style="color:red">*</span></label>
            <input type="text" class="v-name" autocomplete="off" value="${data.name || ''}" placeholder="VD: Đỏ, 50ml" required>
        </div>
        <div>
            <label>Số lượng</label>
            <input type="number" class="v-stock" autocomplete="off" value="${data.stock !== undefined ? data.stock : 0}">
        </div>
        <div>
            <label>Trạng thái</label>
            <select class="v-status">
                <option value="instock" ${data.status === 'instock' ? 'selected' : ''}>Sẵn hàng</option>
                <option value="order" ${data.status === 'order' ? 'selected' : ''}>Hàng Order</option>
                <option value="out" ${data.status === 'out' ? 'selected' : ''}>Hết hàng</option>
            </select>
        </div>
        <div>
            <label>Dự kiến</label>
            <input type="text" class="v-date" autocomplete="off" value="${data.date || ''}" placeholder="VD: 25/05">
        </div>
        <div>
            <label>Giá riêng</label>
            <input type="number" class="v-price" autocomplete="off" value="${data.price || ''}" placeholder="Giá VNĐ">
        </div>
        <div>
            <label>Ảnh riêng</label>
            <input type="file" class="v-file" accept="image/*" style="font-size: 11px; padding: 4px; border:none;">
            <input type="hidden" class="v-image-url" value="${data.image || ''}">
        </div>
        <button type="button" onclick="this.parentElement.remove()" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size: 16px; padding-bottom: 5px;" title="Xóa dòng này">
            <i class="fas fa-times"></i>
        </button>
        ${data.image ? `<div style="grid-column: 1/-1; margin-top: 5px; font-size: 11px;"><a href="${data.image}" target="_blank" style="color:#3498db; text-decoration:none;"><i class="fas fa-image"></i> Xem ảnh đã lưu</a></div>` : ''}
    `;
    // MORACHI_AUTO_SKU_JPY_20261030: keep variant identity through edits/renames.
    row.dataset.morachiSku = String(data.sku || '');
    container.appendChild(row);
}

window.editProduct = async function(id) {
    try {
        // KHẮC PHỤC: Đảm bảo so sánh chính xác ID tuyệt đối
        const p = allProductsData.find(item => String(item.id) === String(id));
        
        if (p) {
            document.getElementById("product-id").value = p.id;
            document.getElementById("product-thumbnail-old").value = p.thumbnail || ""; 
            document.getElementById("title").value = p.title || "";
            document.getElementById("brand").value = p.brand || "";
            document.getElementById("current_price").value = p.current_price || "";
            
            if (document.getElementById("old_price")) document.getElementById("old_price").value = p.old_price || "";
            if (document.getElementById("discount")) document.getElementById("discount").value = p.discount || "";
            
            if (document.getElementById("description")) document.getElementById("description").value = p.description || "";
            if (document.getElementById("specifications")) document.getElementById("specifications").value = p.specifications || "";
            if (document.getElementById("ingredients")) document.getElementById("ingredients").value = p.ingredients || "";
            if (document.getElementById("usage_manual")) document.getElementById("usage_manual").value = p.usage_manual || "";
            window.setProductTaxonomyForm(p);
            const suggestionHint = document.getElementById("product-taxonomy-suggestion");
            if (suggestionHint) suggestionHint.innerText = "";
            
            const container = document.getElementById("variants-container");
            if (container) {
                container.innerHTML = "";
                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => window.addVariantRow(v));
                } else {
                    window.addVariantRow();
                }
            }
            window.openModal(true);
        }
    } catch (err) { alert("Lỗi khi tải thông tin sản phẩm!"); }
}

window.openModal = function(isEdit = false) {
    isEditing = isEdit;
    const msg = document.getElementById("message");
    if(msg) msg.innerText = "";
    
    const titleEl = document.getElementById("modalTitle");
    if(titleEl) titleEl.innerText = isEdit ? "Cập nhật sản phẩm" : "Thêm sản phẩm mới";
    
    const modal = document.getElementById("productModal");
    if(modal) modal.style.display = "flex";

    // KHẮC PHỤC LỖI NHẢY ẢNH: Luôn làm sạch ô chọn file ảnh mỗi khi mở form (chống dính ảnh từ sản phẩm trước)
    const thumbnailInput = document.getElementById("thumbnail_file");
    if(thumbnailInput) thumbnailInput.value = "";
    
    if (!isEdit) {
        const formEl = document.getElementById("product-form");
        if(formEl) formEl.reset();
        document.getElementById("product-id").value = "";
        document.getElementById("product-thumbnail-old").value = ""; // Clear ảnh cũ
        window.setProductTaxonomyForm({});
        const suggestionHint = document.getElementById("product-taxonomy-suggestion");
        if (suggestionHint) suggestionHint.innerText = "";
        
        const container = document.getElementById("variants-container");
        if (container) {
            container.innerHTML = "";
            window.addVariantRow(); 
        }
    }
}

window.closeModal = function() {
    const modal = document.getElementById("productModal");
    if(modal) modal.style.display = "none";
}

var form = document.getElementById("product-form");
if (form) {
    form.addEventListener("submit", async function(e) {
        e.preventDefault();
        const msg = document.getElementById("message") || document.createElement('div');
        msg.innerText = "Đang lưu và đồng bộ dữ liệu...";
        msg.style.color = "#4f46e5";

        try {
            const id = document.getElementById("product-id").value;
            const file = document.getElementById("thumbnail_file").files[0];
            let imageUrl = "";

            if (file) {
                const formData = new FormData();
                formData.append("file", file);
                const resImg = await fetch(`${API_BASE_URL}/upload-image`, { method: "POST", body: formData });
                if (!resImg.ok) throw new Error("Lỗi upload ảnh chính");
                const dataImg = await resImg.json();
                imageUrl = dataImg.url;
            }

            const variantsArray = [];
            const variantRows = document.querySelectorAll(".variant-row");
            
            for (let row of variantRows) {
                const vNameInput = row.querySelector(".v-name");
                if (!vNameInput || vNameInput.value.trim() === "") continue;

                const vStockInput = row.querySelector(".v-stock");
                const vStatusInput = row.querySelector(".v-status");
                const vDateInput = row.querySelector(".v-date");
                const vPriceInput = row.querySelector(".v-price");
                
                let vImageUrl = row.querySelector(".v-image-url") ? row.querySelector(".v-image-url").value : "";
                const vFile = row.querySelector(".v-file");

                if (vFile && vFile.files && vFile.files[0]) {
                    msg.innerText = `Đang tải ảnh phân loại: ${vNameInput.value}...`;
                    const vFormData = new FormData();
                    vFormData.append("file", vFile.files[0]);
                    try {
                        const vResImg = await fetch(`${API_BASE_URL}/upload-image`, { method: "POST", body: vFormData });
                        if (vResImg.ok) {
                            const vDataImg = await vResImg.json();
                            vImageUrl = vDataImg.url;
                        }
                    } catch (e) {
                        console.error("Lỗi upload ảnh biến thể:", e);
                    }
                }

                variantsArray.push({
                    name: vNameInput.value.trim(),
                    stock: vStockInput ? (parseInt(vStockInput.value) || 0) : 0,
                    status: vStatusInput ? vStatusInput.value : "instock",
                    date: vDateInput ? vDateInput.value.trim() : "",
                    price: vPriceInput && vPriceInput.value ? parseInt(vPriceInput.value) : null,
                    image: vImageUrl,
                    sku: row.dataset.morachiSku || ''
                });
            }
            
            const productData = {
                title: document.getElementById("title").value.trim(),
                brand: document.getElementById("brand").value.trim(),
                current_price: document.getElementById("current_price").value.trim(),
                old_price: document.getElementById("old_price") ? document.getElementById("old_price").value.trim() : "",
                discount: document.getElementById("discount") ? document.getElementById("discount").value.trim() : "",
                
                description: document.getElementById("description") ? document.getElementById("description").value.trim() : "",
                specifications: document.getElementById("specifications") ? document.getElementById("specifications").value.trim() : "",
                ingredients: document.getElementById("ingredients") ? document.getElementById("ingredients").value.trim() : "",
                usage_manual: document.getElementById("usage_manual") ? document.getElementById("usage_manual").value.trim() : "",

                category: window.getCheckedValue("product-category"),
                subcategory: window.getCheckedValue("product-category") === "makeup" ? window.getCheckedValue("product-subcategory") : "",
                product_type: document.getElementById("product-type") ? document.getElementById("product-type").value.trim().toLowerCase() : "",
                is_highend: !!document.getElementById("product-highend")?.checked,
                category_source: "manual",
                category_confidence: window.getCheckedValue("product-category") ? 100 : null,
                
                status: "active",
                variants: variantsArray,
                display_order: (() => {
                    const existingProduct = allProductsData.find(item => String(item.id) === String(id));
                    return existingProduct ? window.getProductDisplayOrder(existingProduct, 999999) : window.getNextProductDisplayOrder();
                })()
            };

            if (imageUrl) {
                productData.thumbnail = imageUrl; 
            } else {
                productData.thumbnail = document.getElementById("product-thumbnail-old").value; 
            }

            if (productData.category === "makeup" && !productData.subcategory) {
                throw new Error("Vui lòng chọn danh mục con Mặt / Mắt / Môi / Má / Mày cho sản phẩm Trang Điểm.");
            }

            const url = isEditing ? `${API_BASE_URL}/products/${id}` : `${API_BASE_URL}/products`;
            const method = isEditing ? "PUT" : "POST";

            const res = await fetch(url, {
                method: method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(productData)
            });

            if (res.ok) {
                msg.innerText = isEditing ? "Cập nhật thành công!" : "Thêm mới thành công!";
                msg.style.color = "var(--success)";
                
                window.clearShopProductCache();
                
                window.closeModal();
                await window.loadAdminProducts({silent:true});
                window.showReorderStatus?.(isEditing ? 'Đã cập nhật sản phẩm' : 'Đã thêm sản phẩm', 'success');
            } else {
                throw new Error("API backend từ chối lưu dữ liệu");
            }
        } catch (err) {
            msg.innerText = err.message || "Có lỗi xảy ra!";
            msg.style.color = "var(--danger)";
            console.error(err);
        }
    });
}


// =========================================================
// HỖ TRỢ HIỂN THỊ ĐỊA CHỈ ĐƠN HÀNG
// Chỉ đọc dữ liệu sẵn có từ đơn hàng, không thay đổi logic đơn hàng.
// Hỗ trợ nhiều tên field để tránh đơn cũ/đơn mới bị thiếu địa chỉ.
// =========================================================
window.escapeAdminHtml = window.escapeAdminHtml || function(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

window.cleanOrderText = window.cleanOrderText || function(value) {
    const text = String(value ?? "").trim();
    if (!text || text.toLowerCase() === "undefined" || text.toLowerCase() === "null") return "";
    return text;
};

window.firstOrderValue = window.firstOrderValue || function(...values) {
    for (const value of values) {
        const text = window.cleanOrderText(value);
        if (text) return text;
    }
    return "";
};

window.orderHasCustomerEditMeta = function(order) {
    const o = order || {};
    const c = o.customer_info || {};
    return Boolean(o.updated_by_customer || o.customer_updated_at || o.customer_edit_at || c.updated_by_customer || c.customer_updated_at || c.customer_edit_at);
};

window.pickOrderCustomerValue = function(order, topLevelFields, nestedFields) {
    const o = order || {};
    const c = o.customer_info || {};
    const topValues = topLevelFields.map(key => o[key]);
    const nestedValues = nestedFields.map(key => c[key]);
    const nestedEdited = Boolean(c.updated_by_customer || c.customer_updated_at || c.customer_edit_at);
    const topEdited = Boolean(o.updated_by_customer || o.customer_updated_at || o.customer_edit_at);

    // Backend có thể lưu thông tin khách sửa ở top-level hoặc trong customer_info.
    // Ưu tiên đúng nơi có dấu hiệu vừa được khách cập nhật để tránh hiển thị dữ liệu cũ.
    if (nestedEdited && !topEdited) return window.firstOrderValue(...nestedValues, ...topValues);
    if (topEdited && !nestedEdited) return window.firstOrderValue(...topValues, ...nestedValues);
    if (nestedEdited && topEdited) return window.firstOrderValue(...topValues, ...nestedValues);

    return window.firstOrderValue(...topValues, ...nestedValues);
};

window.buildOrderAddress = function(order) {
    const o = order || {};
    const c = o.customer_info || {};
    const edited = window.orderHasCustomerEditMeta(o);

    const fullAddress = edited
        ? window.firstOrderValue(c.customer_address, c.shipping_address, c.full_address, c.address, o.customer_address, o.shipping_address, o.full_address, o.address)
        : window.firstOrderValue(o.customer_address, o.shipping_address, o.full_address, o.address, c.customer_address, c.shipping_address, c.full_address, c.address);

    const detail = edited
        ? window.firstOrderValue(c.address, c.customer_address, c.address_detail, c.detail_address, c.street, o.customer_address, o.address, o.address_detail, o.detail_address, o.street)
        : window.firstOrderValue(o.customer_address, o.address, o.address_detail, o.detail_address, o.street, c.address, c.customer_address, c.address_detail, c.detail_address, c.street);

    const ward = window.pickOrderCustomerValue(o, ["ward", "ward_name", "customer_ward"], ["ward", "ward_name", "customer_ward"]);
    const district = window.pickOrderCustomerValue(o, ["district", "dist", "district_name", "customer_district"], ["district", "dist", "district_name", "customer_district"]);
    const province = window.pickOrderCustomerValue(o, ["province", "prov", "city", "province_name", "customer_province"], ["province", "prov", "city", "province_name", "customer_province"]);

    const parts = [];
    const addPart = (value) => {
        const text = window.cleanOrderText(value);
        if (!text) return;
        const normalized = text.toLowerCase().replace(/\s+/g, " ");
        const exists = parts.some(part => {
            const current = part.toLowerCase().replace(/\s+/g, " ");
            return current.includes(normalized) || normalized.includes(current);
        });
        if (!exists) parts.push(text);
    };

    addPart(fullAddress || detail);
    addPart(ward);
    addPart(district);
    addPart(province);

    return parts.join(", ");
};

// =========================================================
// HIỂN THỊ / XUẤT PHƯƠNG THỨC THANH TOÁN ĐƠN HÀNG
// Lưu ý: khách chọn chuyển khoản không có nghĩa là tiền đã vào tài khoản.
// Cần đối soát sao kê theo Mã đơn / Số tiền rồi mới xem là đã chuyển khoản.
// =========================================================
window.getOrderPaymentInfo = window.getOrderPaymentInfo || function(order) {
    const o = order || {};
    const rawMethod = window.cleanOrderText(
        o.payment_method || o.paymentMethod || o.payment_type || o.paymentType || o.payment || o.method
    ).toLowerCase();
    const rawLabel = window.cleanOrderText(o.payment_label || o.paymentLabel);
    const rawStatus = window.cleanOrderText(o.payment_status || o.paymentStatus);
    const statusText = window.cleanOrderText(o.status).toLowerCase();

    let type = 'unknown';
    if (
        rawMethod === 'bank' || rawMethod === 'transfer' || rawMethod === 'bank_transfer' ||
        rawMethod.includes('bank') || rawMethod.includes('vietqr') || rawMethod.includes('chuyển') ||
        statusText.includes('chuyển khoản')
    ) {
        type = 'bank';
    } else if (
        rawMethod === 'cod' || rawMethod === 'shipcod' || rawMethod.includes('cod') ||
        statusText.includes('shipcod') || statusText.includes('thanh toán khi nhận hàng')
    ) {
        type = 'cod';
    }

    if (type === 'bank') {
        const note = rawStatus || (statusText.includes('đã xác nhận') ? 'Đã đối soát' : 'Cần kiểm tra sao kê');
        return {
            type,
            label: rawLabel || 'Chuyển khoản',
            exportLabel: 'Chuyển khoản',
            note,
            html: `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                <span style="background:#eaf4ff; color:#1f6fb2; padding:4px 9px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap;"><i class="fas fa-university"></i> Chuyển khoản</span>
                <span style="font-size:11px; color:#7a828a;">${window.escapeAdminHtml(note)}</span>
            </div>`
        };
    }

    if (type === 'cod') {
        const note = rawStatus || 'Thu tiền khi giao hàng';
        return {
            type,
            label: rawLabel || 'Ship COD',
            exportLabel: 'Ship COD',
            note,
            html: `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                <span style="background:#e8f8f0; color:#1f8f4d; padding:4px 9px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap;"><i class="fas fa-money-bill-wave"></i> COD</span>
                <span style="font-size:11px; color:#7a828a;">${window.escapeAdminHtml(note)}</span>
            </div>`
        };
    }

    return {
        type,
        label: rawLabel || 'Chưa rõ',
        exportLabel: 'Chưa rõ',
        note: rawStatus || 'Thiếu payment_method',
        html: `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
            <span style="background:#f1f3f5; color:#777; padding:4px 9px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap;"><i class="fas fa-question-circle"></i> Chưa rõ</span>
            <span style="font-size:11px; color:#999;">Thiếu payment_method</span>
        </div>`
    };
};

// MORACHI_ORDER_TERMINAL_CANCEL_V1
// Đơn Đã hủy chỉ hiển thị ở danh sách hủy và không thể cập nhật tracking/trạng thái.
window.morachiOrderStatus = function(order) {
    return String((order && order.status) || 'Chờ xác nhận').trim().replace(/\s+/g, ' ');
};
window.morachiIsCancelled = function(order) {
    return window.normalizeAdminText(window.morachiOrderStatus(order)) === 'da huy';
};
window.morachiCanImportTracking = function(order) {
    return !!order && window.morachiOrderStatus(order) === 'Đang chuẩn bị hàng'
        && !window.morachiIsCancelled(order)
        && !String(order.spx_tracking_code || '').trim();
};
window.morachiVisibleOrders = function() {
    const filter = window.normalizeAdminText(window.__morachiOrderStatusFilter || '');
    if (!filter) return allOrdersData.filter(o => !window.morachiIsCancelled(o));
    if (filter === 'da huy') return allOrdersData.filter(window.morachiIsCancelled);
    return allOrdersData.filter(o => !window.morachiIsCancelled(o)
        && window.normalizeAdminText(window.morachiOrderStatus(o)) === filter);
};

// =========================================================
// PHẦN 2: QUẢN LÝ ĐƠN HÀNG
// =========================================================

window.switchTab = function(tabId) {
    const secProducts = document.getElementById('section-products');
    const secOrders = document.getElementById('section-orders');
    const menuProducts = document.getElementById('menu-products');
    const menuOrders = document.getElementById('menu-orders');

    if (secProducts) secProducts.classList.remove('active');
    if (secOrders) secOrders.classList.remove('active');
    if (menuProducts) menuProducts.classList.remove('active');
    if (menuOrders) menuOrders.classList.remove('active');

    const activeSec = document.getElementById(`section-${tabId}`);
    const activeMenu = document.getElementById(`menu-${tabId}`);
    if (activeSec) activeSec.classList.add('active');
    if (activeMenu) activeMenu.classList.add('active');

    if (tabId === 'orders') {
        window.loadOrders();
    }
}

window.updateOrderDashboardStats = function(orders) {
    let todayCount = 0;
    let prepCount = 0;
    let transitCount = 0;
    let deliveringCount = 0;

    let todayString = new Date().toDateString();

    orders.forEach(o => {
        let orderDate = o.created_at || o.date;
        if (orderDate) {
            let d = new Date(orderDate);
            if (!isNaN(d.getTime()) && d.toDateString() === todayString) {
                todayCount++;
            }
        }

        let status = o.status || "";
        if (status === "Đang chuẩn bị hàng") prepCount++;
        if (status === "Đang chờ hàng về Việt Nam") transitCount++;
        if (status === "Đang giao hàng") deliveringCount++;
    });

    const statToday = document.getElementById('stat-order-today');
    if(statToday) statToday.innerHTML = todayCount.toLocaleString('vi-VN');

    const statPrep = document.getElementById('stat-order-prep');
    if(statPrep) statPrep.innerHTML = prepCount.toLocaleString('vi-VN');

    const statTransit = document.getElementById('stat-order-transit');
    if(statTransit) statTransit.innerHTML = transitCount.toLocaleString('vi-VN');

    const statDelivering = document.getElementById('stat-order-delivering');
    if(statDelivering) statDelivering.innerHTML = deliveringCount.toLocaleString('vi-VN');
}

window.loadOrders = async function(options = {}) {
    const tbody = document.getElementById('admin-order-list');
    if (!tbody) return;
    const silent = !!options.silent || !!tbody.querySelector('tr[data-order-id]');
    const serial = window.__morachiOrdersRequest = (window.__morachiOrdersRequest || 0) + 1;
    if (!silent) tbody.innerHTML = "<tr><td colspan='8' style='text-align:center; padding: 40px;'><i class='fas fa-spinner fa-spin'></i> Đang tải đơn hàng...</td></tr>";

    try {
        const response = await fetch(`${API_BASE_URL}/orders?t=${new Date().getTime()}`, {cache:'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const orders = await response.json();
        if (serial !== window.__morachiOrdersRequest) return;
        if (!Array.isArray(orders)) throw new Error('API trả về danh sách đơn hàng không hợp lệ');
        allOrdersData = orders;
        localStorage.setItem('morachi_orders', JSON.stringify(allOrdersData));

        if (!silent) {
            const checkAllEl = document.getElementById('check-all-orders');
            if (checkAllEl) checkAllEl.checked = false;
        }
        window.updateOrderDashboardStats(allOrdersData);
        window.renderOrdersTable(window.morachiVisibleOrders());
        window.updateBulkActionBar();
    } catch (err) {
        console.error("Lỗi lấy đơn hàng:", err);
        if (!silent) tbody.innerHTML = "<tr><td colspan='8' style='text-align:center; color:red; padding: 40px;'>Lỗi kết nối máy chủ!</td></tr>";
        else window.showReorderStatus?.('Không đồng bộ được đơn hàng; danh sách hiện tại vẫn được giữ nguyên.', 'error');
    }
}

window.renderOrdersTable = function(ordersList) {
    const tbody = document.getElementById('admin-order-list');
    if (!tbody) return;

    if (!ordersList || ordersList.length === 0) {
        window.morachiSmoothRows(tbody, "<tr><td colspan='8' style='text-align:center; padding: 40px; color:#888;'>Không tìm thấy đơn hàng phù hợp với trạng thái này.</td></tr>", 'data-order-id');
        return;
    }

    const orderRowsHtml = ordersList.map(o => {
        const c = o.customer_info || {};
        const items = o.items || [];
        const isCancelled = window.morachiIsCancelled(o);
        
        let timeDisplay = "";
        let orderDate = o.created_at || o.date; 
        
        if (orderDate) {
            let d = new Date(orderDate);
            if (!isNaN(d.getTime())) { 
                let hours = String(d.getHours()).padStart(2, '0');
                let minutes = String(d.getMinutes()).padStart(2, '0');
                
                let today = new Date();
                let yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                
                let dateStr = "";
                if (d.toDateString() === today.toDateString()) {
                    dateStr = "Hôm nay";
                } else if (d.toDateString() === yesterday.toDateString()) {
                    dateStr = "Hôm qua";
                } else {
                    dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
                }
                timeDisplay = `${hours}:${minutes} • ${dateStr}`;
            } else {
                timeDisplay = "Không có CSDL";
            }
        } else {
            timeDisplay = "Chưa cập nhật";
        }
        
        let itemDisplay = '';
        if (items.length > 0) {
            itemDisplay = `<div style="font-size:13px; font-weight: 500; color: var(--text-main); margin-bottom:3px;">${items[0].title} (${items[0].variant || 'Mặc định'}) x<b>${items[0].quantity}</b></div>`;
            
            if (items.length > 1) {
                let otherItemsHtml = items.slice(1).map(i => `
                    <div style="padding: 6px 0; border-bottom: 1px dashed #eaeef2;">
                        <div style="font-weight: 500;">• ${i.title}</div>
                        <div style="color: #7a828a; font-size: 11px; margin-top: 2px; padding-left: 10px;">
                            Phân loại: ${i.variant || 'Mặc định'} - Số lượng: <b style="color:var(--text-main);">${i.quantity}</b>
                        </div>
                    </div>
                `).join('');
                
                itemDisplay += `
                <details style="font-size:12px; margin-top: 5px; outline:none; cursor:pointer;">
                    <summary style="outline:none; color: #3498db; font-weight: 600; list-style-position: inside; transition: 0.2s;">
                        + ${items.length - 1} sản phẩm khác (Bấm để xem)
                    </summary>
                    <div style="background: #f8f9fa; padding: 5px 12px; border-radius: 8px; margin-top: 6px; border: 1px solid #eaeef2; color: var(--text-main);">
                        ${otherItemsHtml}
                    </div>
                </details>`;
            }
        }

        let badgeClass = 'yellow';
        let statusText = o.status || 'Chờ xác nhận';
        
        if (statusText.includes('Đã xác nhận chuyển khoản')) {
            badgeClass = 'green';
        } else if (statusText === 'Đang chuẩn bị hàng' || statusText.includes('Chờ xác nhận đã chuyển khoản')) {
            badgeClass = 'yellow'; 
        } else if (statusText.includes('Xác nhận đặt đơn Shipcod thành công') || statusText === 'Đang chờ hàng về Việt Nam') {
            badgeClass = 'purple';
        } else if (statusText === 'Đang giao hàng') {
            badgeClass = 'blue';
        } else if (statusText === 'Đã giao hàng') {
            badgeClass = 'green';
        } else if (statusText === 'Đã hủy') {
            badgeClass = 'red';
        }

        let statusBadge = `<span class="badge-status ${badgeClass}">${statusText}</span>`;
        const paymentInfo = window.getOrderPaymentInfo(o);

        let spxHtml = o.spx_tracking_code 
            ? `<div style="margin-top:4px; color:var(--success); font-size:11px; font-weight:500;"><i class="fas fa-truck"></i> SPX: <b>${o.spx_tracking_code}</b></div>` 
            : ``;

        const customerNameText = window.getOrderCustomerName
            ? window.getOrderCustomerName(o)
            : window.firstOrderValue(o.customer_name, o.name, o.receiver_name, c.name, c.customer_name, 'N/A');
        const customerPhoneText = window.getOrderCustomerPhone
            ? window.getOrderCustomerPhone(o)
            : window.firstOrderValue(o.customer_phone, o.phone, o.receiver_phone, c.phone, c.customer_phone, '');

        const addressText = window.buildOrderAddress(o);
        const addressHtml = addressText
            ? `<div style="font-size:12px; color:#555; margin-top:5px; line-height:1.45; max-width: 280px;"><i class="fas fa-map-marker-alt" style="color:#aaa; font-size:10px; margin-right:4px;"></i>${window.escapeAdminHtml(addressText)}</div>`
            : `<div style="font-size:12px; color:#bbb; margin-top:5px; line-height:1.45;"><i class="fas fa-map-marker-alt" style="font-size:10px; margin-right:4px;"></i>Chưa có địa chỉ</div>`;
        const customerEditedHtml = window.orderHasCustomerEditMeta(o)
            ? `<div style="font-size:11px; color:#d97706; margin-top:5px; font-weight:600;"><i class="fas fa-pen"></i> Khách đã chỉnh thông tin</div>`
            : ``;

        return `
            <tr data-order-id="${o.id}">
                <td style="text-align: center;">
                    <input type="checkbox" class="order-checkbox" value="${o.id}" data-orderid="${o.order_id || 'N/A'}" data-total="${o.total_amount || 0}" ${isCancelled ? 'disabled title="Đơn đã hủy, không được sửa"' : ''} onclick="window.updateBulkActionBar()">
                </td>
                <td>
                    <div style="font-weight:700; color:var(--text-main); font-size:13px;">${o.order_id || 'N/A'}</div>
                    <div style="font-size:11px; color:var(--text-light); margin-top:3px;">${timeDisplay}</div>
                </td>
                <td>
                    <div style="font-weight:600; color:var(--text-main); font-size:13px;">${window.escapeAdminHtml(customerNameText || 'N/A')}</div>
                    <div style="font-size:12px; color:var(--text-light); margin-top:3px;"><i class="fas fa-phone-alt" style="color:#aaa; font-size:10px;"></i> ${window.escapeAdminHtml(customerPhoneText || '')}</div>
                    ${addressHtml}
                    ${customerEditedHtml}
                </td>
                <td>
                    ${itemDisplay}
                    ${spxHtml}
                </td>
                <td style="font-weight:700; color:#e74c3c; font-size:14px;">${Number(o.total_amount || 0).toLocaleString('vi-VN')}đ</td>
                <td>${paymentInfo.html}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="action-btns">
                        ${isCancelled
                            ? '<button type="button" disabled title="Đơn đã hủy: khóa vĩnh viễn"><i class="fas fa-lock"></i></button>'
                            : `<button title="Cập nhật Trạng thái" onclick="window.updateOrderStatus('${o.id}', '${o.status || ''}', '${o.spx_tracking_code || ''}')"><i class="fas fa-check"></i></button>`}
                        <button title="In hóa đơn/Vận đơn"><i class="fas fa-print"></i></button>
                        <button title="Thao tác khác"><i class="fas fa-ellipsis-h"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    window.morachiSmoothRows(tbody, orderRowsHtml, 'data-order-id');
}

window.filterOrdersByStatus = function(status) {
    window.__morachiOrderStatusFilter = status || '';
    const checkAllEl = document.getElementById('check-all-orders');
    if (checkAllEl) checkAllEl.checked = false;
    window.renderOrdersTable(window.morachiVisibleOrders());
    window.updateBulkActionBar();
}

window.updateBulkActionBar = function() {
    const checkboxes = document.querySelectorAll('.order-checkbox:checked:not(:disabled)');
    const bulkBar = document.getElementById('bulk-action-bar');
    if (!bulkBar) return;

    if (checkboxes.length > 0) {
        bulkBar.classList.add('show');
        let totalMoney = 0;
        checkboxes.forEach(cb => {
            totalMoney += parseInt(cb.getAttribute('data-total') || 0);
        });
        
        document.getElementById('selected-count').innerText = checkboxes.length;
        document.getElementById('selected-total').innerText = totalMoney.toLocaleString('vi-VN') + 'đ';
        
        document.querySelectorAll('.sel-count').forEach(el => {
            el.innerText = checkboxes.length;
        });
    } else {
        bulkBar.classList.remove('show');
    }
}

window.toggleAllOrders = function(source) {
    const checkboxes = document.querySelectorAll('.order-checkbox');
    checkboxes.forEach(cb => { cb.checked = !cb.disabled && source.checked; });
    window.updateBulkActionBar();
}

window.applyBulkStatus = async function() {
    const selectedStatus = document.getElementById('bulk-status-select').value;
    
    if (!selectedStatus) {
        alert("Vui lòng chọn trạng thái muốn cập nhật từ danh sách!");
        return;
    }

    const checkboxes = document.querySelectorAll('.order-checkbox:checked:not(:disabled)');
    if (checkboxes.length === 0) {
        alert("Vui lòng tích chọn ít nhất 1 đơn hàng trong bảng!");
        return;
    }

    const selectedOrders = Array.from(checkboxes).map(cb => ({
        id: cb.value,
        orderId: cb.getAttribute('data-orderid'),
        order: allOrdersData.find(o => String(o.id) === String(cb.value))
    }));
    if (selectedOrders.some(x => !x.order || window.morachiIsCancelled(x.order))) {
        alert('Có đơn đã hủy hoặc không còn tồn tại trong lựa chọn. Vui lòng tải lại danh sách.');
        await window.loadOrders();
        return;
    }
    if (selectedStatus === 'Đang giao hàng' &&
        selectedOrders.some(x => !window.morachiCanImportTracking(x.order))) {
        alert('Chỉ đơn ở trạng thái "Đang chuẩn bị hàng" và chưa có mã tracking mới được chuyển sang "Đang giao hàng".');
        return;
    }

    if (!confirm(`Bạn có chắc chắn muốn chuyển ${selectedOrders.length} đơn hàng sang trạng thái:\n"${selectedStatus}"?`)) return;

    const updatePayloads = [];
    
    if (selectedStatus === 'Đang giao hàng') {
        for (let order of selectedOrders) {
            let spxCode = prompt(`Trạng thái "Đang giao hàng" BẮT BUỘC có mã vận đơn.\nNhập mã vận đơn cho đơn hàng [ ${order.orderId} ]:`, "");
            if (spxCode !== null && spxCode.trim() !== "") {
                updatePayloads.push({ id: order.id, body: { status: selectedStatus, spx_tracking_code: spxCode.trim() } });
            } else {
                alert(`❌ Đã bỏ qua cập nhật đơn hàng ${order.orderId} do không nhập mã vận đơn.`);
            }
        }
    } else {
        for (let order of selectedOrders) {
            updatePayloads.push({ id: order.id, body: { status: selectedStatus } });
        }
    }

    if (updatePayloads.length === 0) return;

    try {
        const updatePromises = updatePayloads.map(async payload => {
            const res = await fetch(`${API_BASE_URL}/orders/${payload.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload.body)
            });
            if (!res.ok) throw new Error("Cập nhật thất bại");
            return res;
        });

        await Promise.all(updatePromises);
        alert(`✅ Cập nhật thành công ${updatePayloads.length} đơn hàng!`);
        
        const checkAllEl = document.getElementById('check-all-orders');
        if(checkAllEl && checkAllEl.checked) checkAllEl.click(); 
        
        await window.loadOrders({silent:true});
    } catch (err) {
        await window.loadOrders({silent:true});
        alert("Có lỗi khi cập nhật hàng loạt. Có thể một số đơn đã thành công; danh sách đã được tải lại để kiểm tra.");
    }
}

window.updateOrderStatus = async function(id, currentStatus, currentSpxCode) {
    const order = allOrdersData.find(o => String(o.id) === String(id));
    if (!order || window.morachiIsCancelled(order)) {
        alert('Đơn đã hủy hoặc không còn trong danh sách; không được thay đổi trạng thái.');
        return;
    }
    const rawStatus = prompt('Cập nhật trạng thái:', currentStatus || 'Đang chuẩn bị hàng');
    if (rawStatus === null) return;
    const newStatus = rawStatus.trim();
    if (!newStatus) { alert('Trạng thái không được để trống.'); return; }
    const body = { status: newStatus };
    if (newStatus === 'Đang giao hàng') {
        if (!window.morachiCanImportTracking(order)) {
            alert('Chỉ đơn "Đang chuẩn bị hàng" chưa có tracking mới được chuyển sang "Đang giao hàng".');
            return;
        }
        const code = prompt('Nhập mã vận đơn SPX (bắt buộc):', '');
        if (code === null) return;
        if (!/^SPX[A-Z0-9]+$/i.test(code.trim())) {
            alert('Mã vận đơn SPX không hợp lệ.');
            return;
        }
        body.spx_tracking_code = code.trim().toUpperCase();
    }
    if (newStatus === 'Đã hủy' && !confirm('Đã hủy là trạng thái cuối cùng, không thể khôi phục. Xác nhận hủy đơn?')) return;
    try {
        const response = await fetch(`${API_BASE_URL}/orders/${encodeURIComponent(id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        await window.loadOrders({silent:true});
        window.showReorderStatus?.('Đã cập nhật trạng thái đơn', 'success');
    } catch (err) {
        alert('Không cập nhật được: ' + err.message);
        await window.loadOrders({silent:true});
    }
}

// =========================================================
// NHẬP TRACKING SPX HÀNG LOẠT
// - Nhận file .xlsx/.xls/.csv export từ SPX
// - Tự tìm cột Tracking No. / Receiver Name / Receiver Phone Number
// - Match đơn theo Tên khách hàng + Số điện thoại, cập nhật Mã vận đơn
//   và chuyển trạng thái sang "Đang giao hàng"
// =========================================================
window.normalizeVietnameseText = window.normalizeVietnameseText || function(value) {
    return String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};

window.normalizeOrderPhone = window.normalizeOrderPhone || function(value) {
    let digits = String(value ?? "").replace(/\D/g, "");
    if (!digits) return "";

    // SPX/Excel thường làm mất số 0 đầu: 0852268290 -> 852268290
    if (digits.length === 9) digits = "0" + digits;

    // Trường hợp nhập dạng 84xxxxxxxxx hoặc +84xxxxxxxxx
    if (digits.startsWith("84") && digits.length >= 11) {
        digits = "0" + digits.slice(2);
    }

    return digits;
};

window.getOrderCustomerName = function(order) {
    return window.cleanOrderText(
        window.pickOrderCustomerValue(order, ["customer_name", "name", "receiver_name"], ["name", "customer_name", "receiver_name"])
    );
};

window.getOrderCustomerPhone = function(order) {
    return window.normalizeOrderPhone(
        window.pickOrderCustomerValue(order, ["customer_phone", "phone", "receiver_phone"], ["phone", "customer_phone", "receiver_phone"])
    );
};

window.getOrderMatchKey = window.getOrderMatchKey || function(order) {
    const name = window.normalizeVietnameseText(window.getOrderCustomerName(order));
    const phone = window.getOrderCustomerPhone(order);
    return `${name}|${phone}`;
};

window.parseCsvRows = window.parseCsvRows || function(text) {
    const rows = [];
    let row = [];
    let value = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '"' && inQuotes && next === '"') {
            value += '"';
            i++;
            continue;
        }

        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }

        if (ch === ',' && !inQuotes) {
            row.push(value);
            value = "";
            continue;
        }

        if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && next === '\n') i++;
            row.push(value);
            if (row.some(cell => String(cell).trim() !== "")) rows.push(row);
            row = [];
            value = "";
            continue;
        }

        value += ch;
    }

    row.push(value);
    if (row.some(cell => String(cell).trim() !== "")) rows.push(row);
    return rows;
};

window.readSPXFileRows = window.readSPXFileRows || function(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const fileName = String(file && file.name || "").toLowerCase();

        reader.onerror = () => reject(new Error("Không đọc được file."));

        if (fileName.endsWith(".csv")) {
            reader.onload = () => resolve(window.parseCsvRows(String(reader.result || "")));
            reader.readAsText(file, "utf-8");
            return;
        }

        reader.onload = () => {
            try {
                if (!window.XLSX) {
                    reject(new Error("Thiếu thư viện đọc Excel XLSX. Vui lòng kiểm tra kết nối internet hoặc xuất file SPX dạng CSV."));
                    return;
                }

                const data = new Uint8Array(reader.result);
                const workbook = window.XLSX.read(data, { type: "array" });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rows = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
                resolve(rows);
            } catch (err) {
                reject(err);
            }
        };

        reader.readAsArrayBuffer(file);
    });
};

window.findColumnIndexByNames = window.findColumnIndexByNames || function(row, names) {
    const normalizedNames = names.map(window.normalizeVietnameseText);
    for (let i = 0; i < row.length; i++) {
        const cell = window.normalizeVietnameseText(row[i]);
        if (!cell) continue;
        if (normalizedNames.some(name => cell === name || cell.includes(name) || name.includes(cell))) {
            return i;
        }
    }
    return -1;
};

window.extractSPXRecordsFromRows = window.extractSPXRecordsFromRows || function(rows) {
    const trackingNames = ["Tracking No.", "Tracking No", "Mã vận đơn", "Ma van don", "Mã tracking", "Tracking", "Mã đơn vận chuyển"];
    const nameNames = ["Receiver Name", "Tên người nhận", "Ten nguoi nhan", "Người nhận", "Nguoi nhan", "Receiver"];
    const phoneNames = ["Receiver Phone Number", "Số điện thoại người nhận", "So dien thoai nguoi nhan", "Receiver Phone", "Phone Number", "SĐT", "SDT", "Điện thoại"];
    const orderIdNames = ["Mã đơn", "Ma don", "Order ID", "Order No", "Seller Order No", "Mã đơn hàng", "Ma don hang", "Reference No", "Reference"];

    let headerRowIndex = -1;
    let trackingIndex = -1;
    let nameIndex = -1;
    let phoneIndex = -1;
    let orderIdIndex = -1;

    const maxScanRows = Math.min(rows.length, 30);
    for (let r = 0; r < maxScanRows; r++) {
        const row = rows[r] || [];
        const t = window.findColumnIndexByNames(row, trackingNames);
        const n = window.findColumnIndexByNames(row, nameNames);
        const p = window.findColumnIndexByNames(row, phoneNames);

        if (t >= 0 && n >= 0 && p >= 0) {
            headerRowIndex = r;
            trackingIndex = t;
            nameIndex = n;
            phoneIndex = p;
            orderIdIndex = window.findColumnIndexByNames(row, orderIdNames);
            break;
        }
    }

    if (headerRowIndex < 0) {
        throw new Error("Không tìm thấy đủ 3 cột bắt buộc trong file SPX: Tracking No., Receiver Name, Receiver Phone Number.");
    }

    const records = [];
    rows.slice(headerRowIndex + 1).forEach((row, index) => {
        const trackingCode = window.cleanOrderText(row[trackingIndex]).toUpperCase();
        const receiverName = window.cleanOrderText(row[nameIndex]);
        const receiverPhone = window.normalizeOrderPhone(row[phoneIndex]);
        const orderId = orderIdIndex >= 0 ? window.cleanOrderText(row[orderIdIndex]) : "";

        // Bỏ qua dòng mô tả tiếng Việt dưới header và dòng rỗng.
        if (!trackingCode || !receiverName || !receiverPhone) return;
        if (!/^SPX[A-Z0-9]+$/i.test(trackingCode)) return;

        records.push({
            rowNumber: headerRowIndex + index + 2,
            trackingCode,
            receiverName,
            receiverPhone,
            orderId
        });
    });

    return records;
};

window.getCreatedTimeForSort = window.getCreatedTimeForSort || function(order) {
    const raw = order && (order.created_at || order.date || order.updated_at);
    const time = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
};

window.importSPXTrackingFile = async function(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;

    try {
        // Không dùng dữ liệu localStorage: phải đọc trạng thái mới nhất từ server.
        const freshResponse = await fetch(`${API_BASE_URL}/orders?t=${Date.now()}`, {cache:'no-store'});
        if (!freshResponse.ok) throw new Error(`Không đọc được trạng thái đơn hàng mới nhất (HTTP ${freshResponse.status})`);
        const freshOrders = await freshResponse.json();
        if (!Array.isArray(freshOrders)) throw new Error('API đơn hàng không hợp lệ; dừng import tracking');
        allOrdersData = freshOrders;

        const rows = await window.readSPXFileRows(file);
        const spxRecords = window.extractSPXRecordsFromRows(rows);

        if (!spxRecords.length) {
            alert("Không tìm thấy mã vận đơn SPX hợp lệ trong file. Vui lòng kiểm tra lại file export từ SPX.");
            return;
        }

        const orders = Array.isArray(allOrdersData) ? [...allOrdersData] : [];
        const orderById = new Map();
        const queuesByCustomer = new Map();

        orders
            .sort((a, b) => window.getCreatedTimeForSort(a) - window.getCreatedTimeForSort(b))
            .forEach(order => {
                if (!order || !order.id) return;

                const ids = [order.order_id, order.orderId, order.code, order.id]
                    .map(v => window.cleanOrderText(v).toLowerCase())
                    .filter(Boolean);
                ids.forEach(id => orderById.set(id, order));

                // Cấm mọi trạng thái khác, đặc biệt đơn đã hủy.
                if (!window.morachiCanImportTracking(order)) return;
                const key = window.getOrderMatchKey(order);
                if (!key || key === "|") return;
                if (!queuesByCustomer.has(key)) queuesByCustomer.set(key, []);
                queuesByCustomer.get(key).push(order);
            });

        const usedOrderIds = new Set();
        const updatePayloads = [];
        const unmatched = [];
        const duplicateWarnings = [];
        const skippedStatus = [];
        const usedTrackingCodes = new Set();

        for (const record of spxRecords) {
            let matchedOrder = null;
            const trackingCode = record.trackingCode.toUpperCase();
            if (usedTrackingCodes.has(trackingCode)) {
                duplicateWarnings.push(`${trackingCode}: trùng mã tracking trong file, đã bỏ qua`);
                continue;
            }
            usedTrackingCodes.add(trackingCode);
            const key = `${window.normalizeVietnameseText(record.receiverName)}|${record.receiverPhone}`;
            const importOrderId = window.cleanOrderText(record.orderId).toLowerCase();
            if (importOrderId) {
                // Có mã đơn thì phải match chính xác; KHÔNG fallback sang tên + SĐT.
                const candidate = orderById.get(importOrderId);
                if (!candidate) {
                    unmatched.push(`${trackingCode}: không tìm thấy mã đơn ${record.orderId}`);
                    continue;
                }
                if (!window.morachiCanImportTracking(candidate)) {
                    skippedStatus.push(`${trackingCode}: đơn ${record.orderId} đang ở trạng thái "${window.morachiOrderStatus(candidate)}"`);
                    continue;
                }
                if (window.getOrderMatchKey(candidate) !== key) {
                    unmatched.push(`${trackingCode}: tên/SĐT không khớp mã đơn ${record.orderId}`);
                    continue;
                }
                if (usedOrderIds.has(String(candidate.id))) {
                    duplicateWarnings.push(`${trackingCode}: mã đơn ${record.orderId} đã xuất hiện trong file`);
                    continue;
                }
                matchedOrder = candidate;
            } else {
                // Không có mã đơn: chỉ cho phép match khi chính xác MỘT đơn chuẩn bị hàng.
                const eligible = queuesByCustomer.get(key) || [];
                if (eligible.length !== 1) {
                    if (eligible.length > 1) {
                        duplicateWarnings.push(`${trackingCode}: ${record.receiverName} - ${record.receiverPhone} có ${eligible.length} đơn đủ điều kiện, cần mã đơn để phân biệt; BỎ QUA`);
                    } else {
                        unmatched.push(`${trackingCode} | ${record.receiverName} | ${record.receiverPhone}: không có đơn đang chuẩn bị hàng`);
                    }
                    continue;
                }
                if (usedOrderIds.has(String(eligible[0].id))) {
                    duplicateWarnings.push(`${trackingCode}: một đơn đã được gán tracking khác trong file`);
                    continue;
                }
                matchedOrder = eligible[0];
            }
            // Kiểm tra phòng vệ cuối cùng trước khi gửi API.
            if (!matchedOrder || !window.morachiCanImportTracking(matchedOrder)) {
                skippedStatus.push(`${trackingCode}: đơn không còn đủ điều kiện`);
                continue;
            }
            usedOrderIds.add(String(matchedOrder.id));
            updatePayloads.push({
                order: matchedOrder, trackingCode,
                body: { status: 'Đang giao hàng', spx_tracking_code: trackingCode,
                        shipping_provider: 'SPX', tracking_updated_at: new Date().toISOString() }
            });
        }

        if (!updatePayloads.length) {
            alert(`Không match được đơn nào.\n\nKhông khớp: ${unmatched.slice(0, 10).join("\n")}`);
            return;
        }

        const confirmMessage = [
            `Tìm thấy ${spxRecords.length} mã SPX trong file.`,
            `Sẽ cập nhật ${updatePayloads.length} đơn sang trạng thái "Đang giao hàng".`,
            unmatched.length ? `Không khớp: ${unmatched.length} dòng.` : "Không có dòng không khớp.",
            skippedStatus.length ? `Bỏ qua do trạng thái không hợp lệ: ${skippedStatus.length} dòng.` : "",
            duplicateWarnings.length ? `Bỏ qua vì trùng/không phân biệt được đơn: ${duplicateWarnings.length} dòng.` : "",
            "",
            "Bạn có chắc chắn muốn cập nhật không?"
        ].filter(Boolean).join("\n");

        if (!confirm(confirmMessage)) return;

        let success = 0;
        const failed = [];

        for (const payload of updatePayloads) {
            try {
                const res = await fetch(`${API_BASE_URL}/orders/${payload.order.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload.body)
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                payload.order.status = payload.body.status;
                payload.order.spx_tracking_code = payload.body.spx_tracking_code;
                payload.order.shipping_provider = payload.body.shipping_provider;
                payload.order.tracking_updated_at = payload.body.tracking_updated_at;
                success++;
            } catch (err) {
                failed.push(`${payload.trackingCode} | ${window.getOrderCustomerName(payload.order)} | ${window.getOrderCustomerPhone(payload.order)}`);
            }
        }

        try {
            localStorage.setItem("morachi_orders", JSON.stringify(allOrdersData));
        } catch (e) {}

        window.updateOrderDashboardStats(allOrdersData);
        window.renderOrdersTable(window.morachiVisibleOrders());

        let resultMessage = `✅ Đã cập nhật thành công ${success}/${updatePayloads.length} đơn hàng sang "Đang giao hàng".`;
        if (failed.length) resultMessage += `\n\n❌ Cập nhật lỗi ${failed.length} dòng:\n${failed.slice(0, 10).join("\n")}`;
        if (unmatched.length) resultMessage += `\n\n⚠️ Không tìm thấy đơn khớp ${unmatched.length} dòng:\n${unmatched.slice(0, 10).join("\n")}`;
        if (skippedStatus.length) resultMessage += `\n\n⛔ Đã bỏ qua ${skippedStatus.length} đơn trạng thái không hợp lệ:\n${skippedStatus.slice(0, 10).join("\n")}`;
        if (duplicateWarnings.length) resultMessage += `\n\n⚠️ Bỏ qua ${duplicateWarnings.length} dòng trùng/không phân biệt được đơn:\n${duplicateWarnings.slice(0, 10).join("\n")}`;

        alert(resultMessage);
        window.loadOrders();
    } catch (err) {
        console.error("Lỗi import SPX:", err);
        alert("Lỗi import file SPX: " + (err && err.message ? err.message : err));
    } finally {
        if (input) input.value = "";
    }
};

window.exportSPX = function() {
    const ordersStr = localStorage.getItem('morachi_orders');
    if (!ordersStr) {
        alert("Không tìm thấy dữ liệu đơn hàng trong bộ nhớ!");
        return;
    }

    const orders = JSON.parse(ordersStr);
    if (orders.length === 0) {
        alert("Chưa có đơn hàng nào để xuất!");
        return;
    }

    let csvContent = "\uFEFF";
    csvContent += "Mã Đơn,Tên Khách Hàng,Số Điện Thoại,Địa Chỉ Chi Tiết,Tỉnh / Thành Phố,Phường / Xã,Sản Phẩm Chi Tiết,Tổng Tiền,Phương Thức Thanh Toán,Tình Trạng Thanh Toán,Trạng Thái,Mã Vận Đơn,Ngày Đặt\n";

    orders.forEach(o => {
        let orderId = o.order_id || "";
        let customerName = window.getOrderCustomerName ? window.getOrderCustomerName(o) : (o.customer_name || (o.customer_info ? (o.customer_info.name || "") : ""));
        let phone = window.getOrderCustomerPhone ? window.getOrderCustomerPhone(o) : (o.customer_phone || (o.customer_info ? (o.customer_info.phone || "") : ""));
        let addressDetail = window.pickOrderCustomerValue(
            o,
            ["address", "customer_address", "shipping_address", "full_address"],
            ["address", "customer_address", "shipping_address", "full_address"]
        );
        let province = window.pickOrderCustomerValue(
            o,
            ["province", "prov", "city", "province_name", "customer_province"],
            ["province", "prov", "city", "province_name", "customer_province"]
        );
        let ward = window.pickOrderCustomerValue(
            o,
            ["ward", "ward_name", "customer_ward"],
            ["ward", "ward_name", "customer_ward"]
        );
        
        let productsStr = "";
        if (o.items && o.items.length > 0) {
            productsStr = o.items.map(i => `${i.title} (${i.variant || 'Mặc định'}) - SL: ${i.quantity}`).join(" | ");
        }
        
        let total = o.total_amount || 0;
        let paymentInfo = window.getOrderPaymentInfo(o);
        let status = o.status || "";
        let spxCode = o.spx_tracking_code || "";
        
        let dateStr = "";
        let orderDate = o.created_at || o.date;
        if (orderDate) {
            let d = new Date(orderDate);
            if (!isNaN(d.getTime())) {
                dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
        }

        const escapeCSV = (str) => `"${String(str).replace(/"/g, '""')}"`;

        let row = [
            escapeCSV(orderId),
            escapeCSV(customerName),
            escapeCSV(phone),
            escapeCSV(addressDetail),
            escapeCSV(province),
            escapeCSV(ward),
            escapeCSV(productsStr),
            total,
            escapeCSV(paymentInfo.exportLabel),
            escapeCSV(paymentInfo.note),
            escapeCSV(status),
            escapeCSV(spxCode),
            escapeCSV(dateStr)
        ];

        csvContent += row.join(",") + "\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    
    let fileName = `DanhSachDonHang_${new Date().toISOString().slice(0,10)}.csv`;
    
    link.setAttribute("href", url);
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

document.addEventListener("DOMContentLoaded", () => {
    window.loadAdminProducts();
    window.bindAdminSearch();
    window.bindTaxonomyFilters();

    document.querySelectorAll('input[name="product-category"]').forEach(input => {
        input.addEventListener("change", window.updateProductSubcategoryVisibility);
    });
    document.querySelectorAll('input[name="bulk-category"]').forEach(input => {
        input.addEventListener("change", window.updateBulkSubcategoryVisibility);
    });
    window.updateProductSubcategoryVisibility();
    window.updateBulkSubcategoryVisibility();
});

window.onclick = function(event) {
    const productModal = document.getElementById("productModal");
    const bulkModal = document.getElementById("bulkCategoryModal");
    const suggestionModal = document.getElementById("autoSuggestionModal");
    if (event.target == productModal) window.closeModal();
    if (event.target == bulkModal) window.closeBulkCategoryModal();
    if (event.target == suggestionModal) window.closeAutoSuggestionModal();
}
