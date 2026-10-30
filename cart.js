// === HỆ THỐNG GIỎ HÀNG BẰNG LOCALSTORAGE ===

// 1. Khởi tạo giỏ hàng từ bộ nhớ trình duyệt
// (Bọc trong try/catch: nếu dữ liệu localStorage bị lỗi/hỏng, JSON.parse sẽ
// ném lỗi và làm dừng toàn bộ phần code phía dưới của file này -> khiến các
// hàm như setupAddressAutocomplete, toggleBankInfo, submitOrder... không
// bao giờ được định nghĩa, dẫn đến popup thanh toán không hiện ra được)
// Ưu tiên dữ liệu phiên nếu WebView/Safari không cho ghi localStorage.
// Giỏ hàng phiên vẫn giữ khi người dùng chuyển trang trong cùng tab.
const MORACHI_CART_FALLBACK_KEY = 'morachi_cart_session_fallback_v1';
let cart = [];
(function restoreCart() {
    for (const source of ['session', 'local']) {
        try {
            const storage = source === 'session' ? sessionStorage : localStorage;
            const key = source === 'session' ? MORACHI_CART_FALLBACK_KEY : 'morachi_cart';
            const raw = storage.getItem(key);
            if (raw === null) continue;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('Dữ liệu giỏ không phải danh sách');
            cart = parsed.filter(item => item && typeof item === 'object' && item.id && item.title)
                .map(item => ({...item, quantity: Math.max(1, Number(item.quantity) || 1)}));
            return;
        } catch (error) {
            console.warn('Không đọc được giỏ hàng từ', source, error);
        }
    }
})();
let currentCheckoutOrderId = ""; 
let vnProvinces = []; // Dữ liệu địa chỉ mới 2 cấp: Tỉnh/Thành phố -> Phường/Xã

// Dữ liệu dùng riêng cho popup thanh toán.
// Giúp nút "Mua ngay" chỉ đặt đúng 1 sản phẩm và không bị lẫn với giỏ hàng hiện có.
let checkoutItems = [];
let isBuyNowMode = false;


(function installMorachiCartHarmonyStyle() {
    if (document.getElementById('morachi-cart-harmony-style')) return;

    const style = document.createElement('style');
    style.id = 'morachi-cart-harmony-style';
    style.textContent = `
        body.morachi-cart-open .floating-contact,
        body.product-detail-page .floating-contact {
            display: none !important;
        }

        /* Khi drawer giỏ hàng mở:
           - Ẩn bottom navigation của trang chủ.
           - Đưa overlay/drawer lên trên toàn bộ fixed navigation.
           Nhờ vậy nút "Tiến hành thanh toán" không còn bị che. */
        body.morachi-cart-open .mobile-bottom-nav {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }

        body.morachi-cart-open .cart-overlay {
            z-index: 2998 !important;
        }

        body.morachi-cart-open .cart-drawer {
            z-index: 2999 !important;
        }

        .cart-drawer .btn-checkout {
            width: 100% !important;
            min-height: 56px !important;
            padding: 0 20px !important;
            border: 0 !important;
            border-radius: 999px !important;
            background: #101010 !important;
            color: #ffffff !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 10px !important;
            font-family: 'Encode Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 14px !important;
            font-weight: 700 !important;
            line-height: 1 !important;
            text-transform: none !important;
            box-shadow: 0 8px 24px rgba(0, 0, 0, .18) !important;
            cursor: pointer !important;
        }

        .cart-drawer .btn-checkout:hover,
        .cart-drawer .btn-checkout:active {
            background: #000000 !important;
        }

        .cart-drawer .btn-checkout i {
            font-size: 17px !important;
        }

        @media (max-width: 768px) {
            .cart-drawer .cart-footer {
                flex: 0 0 auto !important;
                position: relative !important;
                z-index: 4 !important;
                padding-left: 18px !important;
                padding-right: 18px !important;
                padding-bottom: calc(16px + env(safe-area-inset-bottom)) !important;
                background: #ffffff !important;
            }

            .cart-drawer .btn-checkout {
                min-height: 56px !important;
                font-size: 14px !important;
            }
        }
    `;
    document.head.appendChild(style);
})();

function syncMorachiCheckoutButtonUI() {
    document.querySelectorAll('.cart-drawer .btn-checkout').forEach(btn => {
        // Giữ nguyên handler/click hiện có, chỉ thay presentation.
        if (btn.dataset.morachiCheckoutUi === '1') return;
        btn.dataset.morachiCheckoutUi = '1';
        btn.innerHTML = '<i class="fa-solid fa-cart-shopping" aria-hidden="true"></i><span>Tiến hành thanh toán</span>';
    });
}


// 2. Lưu giỏ hàng
function saveCart() {
    const data = JSON.stringify(cart);
    let saved = false;
    try {
        localStorage.setItem('morachi_cart', data);
        saved = true;
        // Xóa bản phiên cũ, nhưng không coi lỗi xóa là lỗi lưu giỏ.
        try { sessionStorage.removeItem(MORACHI_CART_FALLBACK_KEY); } catch (_) {}
    } catch (error) {
        console.warn('localStorage không ghi được giỏ hàng; thử sessionStorage:', error);
        try {
            sessionStorage.setItem(MORACHI_CART_FALLBACK_KEY, data);
            saved = true;
        } catch (fallbackError) {
            console.error('Cả localStorage và sessionStorage đều không lưu được:', fallbackError);
        }
    }
    // Lỗi render không được làm khách tưởng việc lưu giỏ bị thất bại.
    try { updateCartUI(); }
    catch (renderError) { console.error('Lỗi hiển thị giỏ hàng:', renderError); }
    return saved;
}

// 3. Mở giỏ hàng (Luôn trượt ra)
function openCart() {
    const drawer = document.getElementById('cart-drawer');
    const overlay = document.getElementById('cart-overlay');

    if (drawer && overlay) {
        drawer.classList.add('active');
        overlay.classList.add('active');
        document.body.classList.add('morachi-cart-open');
        updateCartUI();
    }
}

// 3.1 Mở / Đóng giao diện giỏ hàng linh hoạt (Toggle)
function toggleCart() {
    const drawer = document.getElementById('cart-drawer');
    const overlay = document.getElementById('cart-overlay');

    if (drawer && overlay) {
        const willOpen = !drawer.classList.contains('active');

        drawer.classList.toggle('active', willOpen);
        overlay.classList.toggle('active', willOpen);
        document.body.classList.toggle('morachi-cart-open', willOpen);

        updateCartUI();
    }
}

// 4. Thêm sản phẩm vào giỏ hàng
function addToCart(product) {
    const qtyToAdd = Math.max(1, Number(product && product.quantity) || 1);
    const normalizedProduct = normalizeCartItem({
        ...(product || {}),
        quantity: qtyToAdd,
        variant: (product && product.variant) || 'Mặc định'
    });

    if (!normalizedProduct.id || !normalizedProduct.title) {
        console.error('Sản phẩm thêm vào giỏ thiếu id/title:', normalizedProduct);
        return false;
    }

    const existingItem = cart.find(item =>
        String(item.id) === String(normalizedProduct.id) &&
        String(item.variant || 'Mặc định') === String(normalizedProduct.variant || 'Mặc định')
    );

    const previousCart = cart.map(item => ({ ...item }));
    if (existingItem) {
        existingItem.quantity =
            Math.max(1, Number(existingItem.quantity) || 1) + qtyToAdd;
    } else {
        cart.push(normalizedProduct);
    }

    const saved = saveCart();
    if (!saved) {
        // Không hiển thị giỏ đã thêm khi cả hai loại storage đều thất bại.
        cart = previousCart;
        try { updateCartUI(); } catch (error) { console.error(error); }
        return false;
    }
    return normalizedProduct;
}

// 5. Cập nhật giao diện giỏ hàng
function updateCartUI() {
    const countElements = document.querySelectorAll('.cart-count');
    const totalQty = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    countElements.forEach(el => el.innerText = totalQty);

    const itemsContainer = document.getElementById('cart-items');
    const totalEl = document.getElementById('cart-total-price');
    
    if (!itemsContainer || !totalEl) return;

    if (cart.length === 0) {
        itemsContainer.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: #999;">
                <i class="fas fa-shopping-bag" style="font-size: 60px; margin-bottom: 20px; opacity: 0.2;"></i>
                <p style="font-size: 16px;">Giỏ hàng của bạn đang trống</p>
                <button onclick="toggleCart()" style="margin-top: 20px; padding: 12px 25px; border: 2px solid #f57224; background: transparent; color: #f57224; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.2s;">TIẾP TỤC MUA SẮM</button>
            </div>
        `;
        totalEl.innerText = '0 đ';
        return;
    }

    let totalPrice = 0;
    itemsContainer.innerHTML = cart.map((item, index) => {
        const itemTotal = toPriceNumber(item.price) * (Number(item.quantity) || 1);
        totalPrice += itemTotal;
        
        return `
            <div class="cart-item" style="display: flex; gap: 15px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px dashed #eee; position: relative;">
                <img src="${checkoutEscapeHtml(item.image || 'images/icon-logo.png')}" alt="${checkoutEscapeHtml(item.title)}" onerror="this.src='images/icon-logo.png'" style="width: 80px; height: 80px; object-fit: contain; border: 1px solid #eee; border-radius: 8px; padding: 2px;">
                <div class="cart-item-info" style="flex: 1; padding-right: 25px;">
                    <div class="cart-item-title" style="font-weight: bold; font-size: 14px; margin-bottom: 5px; color: #333; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${checkoutEscapeHtml(item.title)}</div>
                    <div class="cart-item-variant" style="font-size: 12px; color: #888; margin-bottom: 5px;">Phân loại: ${checkoutEscapeHtml(item.variant)}</div>
                    <div class="cart-item-price" style="color: #f57224; font-weight: bold; margin-bottom: 10px; font-size: 15px;">${toPriceNumber(item.price).toLocaleString('vi-VN')} đ</div>
                    <div class="cart-item-qty" style="display: flex; align-items: center; border: 1px solid #ddd; width: fit-content; border-radius: 4px; overflow: hidden;">
                        <button onclick="changeCartQty(${index}, -1)" style="background: #f9f9f9; border: none; padding: 5px 12px; cursor: pointer; font-weight: bold; color: #555;">-</button>
                        <span style="padding: 0 12px; font-size: 13px; font-weight: bold; min-width: 30px; text-align: center;">${item.quantity}</span>
                        <button onclick="changeCartQty(${index}, 1)" style="background: #f9f9f9; border: none; padding: 5px 12px; cursor: pointer; font-weight: bold; color: #555;">+</button>
                    </div>
                </div>
                <button class="cart-item-remove" onclick="removeCartItem(${index})" title="Xóa sản phẩm" style="position: absolute; top: 0; right: 0; background: none; border: none; color: #ccc; cursor: pointer; font-size: 18px;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
    }).join('');

    totalEl.innerText = Number(totalPrice).toLocaleString('vi-VN') + ' đ';

    const checkoutBtn = document.querySelector('.cart-drawer .btn-checkout');
    if (checkoutBtn) {
        checkoutBtn.onclick = openCheckoutModal;
    }
    syncMorachiCheckoutButtonUI();
}

function changeCartQty(index, delta) {
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) cart.splice(index, 1);
    saveCart();
}


function removeCartItem(index) {
    cart.splice(index, 1);
    saveCart();
}

function toPriceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value ?? '').replace(/[^\d]/g, '');
    return cleaned ? Number(cleaned) : 0;
}

function normalizeCartItem(item) {
    const quantity = Number(item && item.quantity) > 0 ? Number(item.quantity) : 1;
    return {
        ...(item || {}),
        price: toPriceNumber(item && item.price),
        quantity
    };
}

function cloneCheckoutItems(items) {
    return (Array.isArray(items) ? items : []).map(normalizeCartItem);
}

function getCheckoutSubtotal() {
    return checkoutItems.reduce((sum, item) => sum + (toPriceNumber(item.price) * Number(item.quantity || 1)), 0);
}

function renderCheckoutItemsHtml(items) {
    return cloneCheckoutItems(items).map(item => `
        <div class="chk-item-row">
            <img src="${checkoutEscapeHtml(item.image || 'images/icon-logo.png')}" alt="${checkoutEscapeHtml(item.title || 'Sản phẩm')}" onerror="this.src='images/icon-logo.png'">
            <div class="chk-item-info">
                <div class="chk-item-title">${checkoutEscapeHtml(item.title || 'Sản phẩm')}</div>
                <div class="chk-item-variant">Phân loại: ${checkoutEscapeHtml(item.variant || 'Mặc định')}</div>
                <div class="chk-item-qty-label">SL: ${item.quantity || 1}</div>
            </div>
            <div class="chk-item-price">
                <div class="price">${toPriceNumber(item.price).toLocaleString('vi-VN')} đ</div>
                <div class="qty">x ${item.quantity || 1}</div>
            </div>
        </div>
    `).join('');
}

// Hàm dùng cho nút "Mua ngay" ở trang chi tiết sản phẩm.
// Hàm này chỉ đưa 1 sản phẩm vào popup thanh toán, sau đó trả lại giỏ hàng cũ.
window.openBuyNowCheckout = function(item) {
    if (!item) return false;

    const normalized = normalizeCartItem(item);
    if (!normalized.id || !normalized.title) {
        console.error('Sản phẩm Mua ngay không hợp lệ:', normalized);
        return false;
    }

    return openCheckoutModal([normalized], 'buy-now');
};

// ==============================================================
// ĐỊA CHỈ NHẬN HÀNG LƯU RIÊNG TRÊN TỪNG THIẾT BỊ/TRÌNH DUYỆT
// - localStorage chỉ tồn tại trên đúng trình duyệt + thiết bị + domain hiện tại.
// - Không đồng bộ địa chỉ sang máy khác và không gửi địa chỉ lên server trước khi đặt hàng.
// ==============================================================
const MORACHI_ADDRESS_CACHE_KEY = 'morachi_checkout_addresses_v2';
const MORACHI_SELECTED_ADDRESS_KEY = 'morachi_checkout_selected_address_v2';
let checkoutEditingAddressId = '';
let checkoutTemporaryAddress = null;

function checkoutEscapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getCheckoutSavedAddresses() {
    try {
        const value = JSON.parse(localStorage.getItem(MORACHI_ADDRESS_CACHE_KEY) || '[]');
        return Array.isArray(value) ? value.filter(item => item && item.id) : [];
    } catch (error) {
        console.warn('Không đọc được cache địa chỉ MORACHI:', error);
        return [];
    }
}

function persistCheckoutSavedAddresses(addresses) {
    try {
        localStorage.setItem(MORACHI_ADDRESS_CACHE_KEY, JSON.stringify((addresses || []).slice(0, 10)));
        return true;
    } catch (error) {
        console.warn('Không lưu được cache địa chỉ MORACHI:', error);
        return false;
    }
}

function getCheckoutSelectedAddressId() {
    try {
        return localStorage.getItem(MORACHI_SELECTED_ADDRESS_KEY) || '';
    } catch (error) {
        return '';
    }
}

function setCheckoutSelectedAddressId(id) {
    try {
        if (id) localStorage.setItem(MORACHI_SELECTED_ADDRESS_KEY, String(id));
        else localStorage.removeItem(MORACHI_SELECTED_ADDRESS_KEY);
    } catch (error) {}
}

function getCheckoutSelectedAddress() {
    if (checkoutTemporaryAddress) return checkoutTemporaryAddress;
    const addresses = getCheckoutSavedAddresses();
    const selectedId = getCheckoutSelectedAddressId();
    return addresses.find(item => String(item.id) === String(selectedId)) || addresses[0] || null;
}

function buildCheckoutFullAddress(address) {
    if (!address) return '';
    const values = [address.address, address.wardName, address.provinceName]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const result = [];
    values.forEach(value => {
        const normalized = value.toLowerCase().replace(/\s+/g, ' ');
        const duplicated = result.some(existing => {
            const current = existing.toLowerCase().replace(/\s+/g, ' ');
            return current.includes(normalized) || normalized.includes(current);
        });
        if (!duplicated) result.push(value);
    });
    return result.join(', ');
}

function renderCheckoutAddressSummary() {
    const target = document.getElementById('chk-address-summary');
    if (!target) return;

    const selected = getCheckoutSelectedAddress();
    if (!selected) {
        target.innerHTML = `
            <button type="button" class="checkout-address-empty" onclick="openCheckoutAddressEditor()">
                <span class="checkout-address-empty-icon"><i class="fas fa-map-marker-alt"></i></span>
                <span>
                    <strong>Thêm địa chỉ nhận hàng</strong>
                    <small>Nhập thông tin giao hàng để tiếp tục đặt hàng</small>
                </span>
                <i class="fas fa-chevron-right"></i>
            </button>
        `;
        return;
    }

    target.innerHTML = `
        <button type="button" class="checkout-address-selected" onclick="openCheckoutAddressList()">
            <span class="checkout-address-pin"><i class="fas fa-map-marker-alt"></i></span>
            <span class="checkout-address-copy">
                <span class="checkout-address-person">
                    <strong>${checkoutEscapeHtml(selected.name)}</strong>
                    <em></em>
                    <span>${checkoutEscapeHtml(selected.phone)}</span>
                </span>
                <span class="checkout-address-text">${checkoutEscapeHtml(buildCheckoutFullAddress(selected))}</span>
            </span>
            <i class="fas fa-chevron-right checkout-address-arrow"></i>
        </button>
    `;

    applyCheckoutAddressToForm(selected);
}

function applyCheckoutAddressToForm(address) {
    if (!address) return;
    const name = document.getElementById('chk-name');
    const phone = document.getElementById('chk-phone');
    const detail = document.getElementById('chk-address');
    if (name) name.value = address.name || '';
    if (phone) phone.value = address.phone || '';
    if (detail) detail.value = address.address || '';

    const province = document.getElementById('chk-province');
    const district = document.getElementById('chk-district');
    const ward = document.getElementById('chk-ward');
    if (province) {
        province.innerHTML = `<option value="${checkoutEscapeHtml(address.provinceCode || '')}" selected>${checkoutEscapeHtml(address.provinceName || 'Tỉnh/Thành phố')}</option>`;
    }
    if (district) {
        district.innerHTML = '<option value="" selected></option>';
    }
    if (ward) {
        ward.innerHTML = `<option value="${checkoutEscapeHtml(address.wardCode || '')}" selected>${checkoutEscapeHtml(address.wardName || 'Phường/Xã')}</option>`;
    }
}

function renderCheckoutAddressList() {
    const body = document.getElementById('checkout-address-sheet-body');
    const title = document.getElementById('checkout-address-sheet-title');
    if (!body || !title) return;

    title.textContent = 'Địa chỉ nhận hàng';
    const addresses = getCheckoutSavedAddresses();
    const selectedId = getCheckoutSelectedAddressId();

    body.innerHTML = `
        <div class="checkout-address-list">
            ${addresses.length ? addresses.map((item, index) => `
                <div class="checkout-address-list-item ${String(item.id) === String(selectedId) ? 'selected' : ''}">
                    <button type="button" class="checkout-address-radio" onclick="selectCheckoutSavedAddress('${checkoutEscapeHtml(item.id)}')" aria-label="Chọn địa chỉ">
                        <span></span>
                    </button>
                    <button type="button" class="checkout-address-list-main" onclick="selectCheckoutSavedAddress('${checkoutEscapeHtml(item.id)}')">
                        <span class="checkout-address-list-person"><strong>${checkoutEscapeHtml(item.name)}</strong><em></em>${checkoutEscapeHtml(item.phone)}</span>
                        <span>${checkoutEscapeHtml(buildCheckoutFullAddress(item))}</span>
                    </button>
                    <button type="button" class="checkout-address-edit-link" onclick="openCheckoutAddressEditor('${checkoutEscapeHtml(item.id)}')">Sửa</button>
                </div>
            `).join('') : `
                <div class="checkout-address-list-empty">
                    <i class="fas fa-map-marked-alt"></i>
                    <strong>Chưa có địa chỉ được lưu</strong>
                    <span>Địa chỉ chỉ được lưu trên thiết bị này.</span>
                </div>
            `}
            <button type="button" class="checkout-add-address-btn" onclick="openCheckoutAddressEditor()">
                <i class="fas fa-plus"></i> Thêm địa chỉ mới
            </button>
            <div class="checkout-device-cache-note">
                <i class="fas fa-shield-alt"></i>
                <div>
                    <strong>Dữ liệu được lưu (cache) tại thiết bị</strong>
                    <span>Thông tin địa chỉ và phương thức thanh toán chỉ được lưu trên trình duyệt này để dùng cho lần sau.</span>
                    <small><i class="fas fa-check"></i> Bảo mật và không tự đồng bộ sang thiết bị khác</small>
                </div>
            </div>
        </div>
    `;
}

window.openCheckoutAddressList = function() {
    const sheet = document.getElementById('checkout-address-sheet');
    if (!sheet) return;
    renderCheckoutAddressList();
    sheet.classList.add('active');
};

window.closeCheckoutAddressSheet = function() {
    const sheet = document.getElementById('checkout-address-sheet');
    if (sheet) sheet.classList.remove('active');
};

window.selectCheckoutSavedAddress = function(id) {
    const addresses = getCheckoutSavedAddresses();
    const address = addresses.find(item => String(item.id) === String(id));
    if (!address) return;
    checkoutTemporaryAddress = null;
    setCheckoutSelectedAddressId(address.id);
    applyCheckoutAddressToForm(address);
    renderCheckoutAddressSummary();
    closeCheckoutAddressSheet();
};

async function fillCheckoutAddressEditor(address) {
    await preFetchProvinces();

    const provinceSelect = document.getElementById('addr-province');
    const districtSelect = document.getElementById('addr-district');
    const wardSelect = document.getElementById('addr-ward');
    if (!provinceSelect || !districtSelect || !wardSelect) return;

    provinceSelect.innerHTML = '<option value="">Tỉnh / Thành phố</option>';
    vnProvinces.forEach(item => provinceSelect.add(new Option(item.name, item.code)));

    document.getElementById('addr-name').value = address?.name || '';
    document.getElementById('addr-phone').value = address?.phone || '';
    document.getElementById('addr-address').value = address?.address || '';
    document.getElementById('addr-save-address').checked = address ? true : true;

    if (address?.provinceCode) {
        provinceSelect.value = String(address.provinceCode);
        await checkoutAddressProvinceChanged();
        wardSelect.value = String(address.wardCode || '');
    } else {
        districtSelect.innerHTML = '<option value=""></option>';
        wardSelect.innerHTML = '<option value="">Phường / Xã</option>';
    }

    applyCheckoutAddressEditorSelect2();
}

// Bật ô tìm kiếm cho Tỉnh/Thành phố và Phường/Xã trong form địa chỉ mới.
// Khách có thể gõ trực tiếp tên địa phương thay vì kéo danh sách dài.
function applyCheckoutAddressEditorSelect2(retryCount = 0) {
    if (typeof jQuery === 'undefined' || typeof jQuery.fn.select2 === 'undefined') {
        if (retryCount < 20) {
            window.setTimeout(() => applyCheckoutAddressEditorSelect2(retryCount + 1), 150);
        }
        return;
    }

    const $province = $('#addr-province');
    const $ward = $('#addr-ward');
    const $dropdownParent = $('#checkout-address-sheet-body');

    if (!$province.length || !$ward.length || !$dropdownParent.length) return;

    [$province, $ward].forEach($select => {
        if ($select.data('select2')) $select.select2('destroy');
    });

    const commonOptions = {
        width: '100%',
        dropdownParent: $dropdownParent,
        minimumResultsForSearch: 0,
        allowClear: false,
        language: {
            noResults: () => 'Không tìm thấy kết quả',
            searching: () => 'Đang tìm...'
        }
    };

    $province.select2({
        ...commonOptions,
        placeholder: 'Nhập hoặc chọn Tỉnh / Thành phố'
    });

    $ward.select2({
        ...commonOptions,
        placeholder: 'Nhập hoặc chọn Phường / Xã'
    });

    $province.off('select2:open.morachiAddress').on('select2:open.morachiAddress', () => {
        window.setTimeout(() => document.querySelector('.select2-container--open .select2-search__field')?.focus(), 0);
    });

    $ward.off('select2:open.morachiAddress').on('select2:open.morachiAddress', () => {
        window.setTimeout(() => document.querySelector('.select2-container--open .select2-search__field')?.focus(), 0);
    });
}

function refreshCheckoutWardSelect2() {
    if (typeof jQuery === 'undefined' || typeof jQuery.fn.select2 === 'undefined') return;
    const $ward = $('#addr-ward');
    if ($ward.data('select2')) $ward.trigger('change.select2');
}

window.openCheckoutAddressEditor = async function(id = '') {
    const body = document.getElementById('checkout-address-sheet-body');
    const title = document.getElementById('checkout-address-sheet-title');
    const sheet = document.getElementById('checkout-address-sheet');
    if (!body || !title || !sheet) return;

    const addresses = getCheckoutSavedAddresses();
    const address = id ? addresses.find(item => String(item.id) === String(id)) : null;
    checkoutEditingAddressId = address?.id || '';
    title.textContent = 'Địa chỉ nhận hàng';

    body.innerHTML = `
        <form class="checkout-address-form" autocomplete="off" onsubmit="event.preventDefault(); saveCheckoutAddress();">
            <label>Họ và tên</label>
            <input
                type="text"
                id="addr-name"
                placeholder="Nhập họ và tên"
                autocomplete="name"
                oninput="clearCheckoutAddressFieldError(this)"
                required
            >

            <label>Số điện thoại</label>
            <input
                type="tel"
                id="addr-phone"
                placeholder="Nhập đủ 10 số, ví dụ 0912345678"
                autocomplete="tel"
                inputmode="numeric"
                maxlength="10"
                pattern="0[0-9]{9}"
                oninput="this.value=this.value.replace(/\D/g,'').slice(0,10); clearCheckoutAddressFieldError(this)"
                required
            >

            <label>Tỉnh / Thành phố</label>
            <select id="addr-province" onchange="clearCheckoutAddressFieldError(this); checkoutAddressProvinceChanged()" required>
                <option value="">Tỉnh / Thành phố</option>
            </select>

            <select id="addr-district" hidden aria-hidden="true" tabindex="-1">
                <option value=""></option>
            </select>

            <label>Phường / Xã</label>
            <select id="addr-ward" onchange="clearCheckoutAddressFieldError(this)" required>
                <option value="">Phường / Xã</option>
            </select>

            <label>Địa chỉ cụ thể</label>
            <div class="checkout-address-detail-wrap">
                <input
                    type="text"
                    id="addr-address"
                    placeholder="Số nhà, tên đường, tòa nhà..."
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="sentences"
                    spellcheck="false"
                    oninput="clearCheckoutAddressFieldError(this)"
                    required
                >
            </div>

            <div
                id="addr-form-error"
                class="checkout-address-form-error"
                role="alert"
                aria-live="polite"
            ></div>

            <label class="checkout-save-address-toggle">
                <span>Lưu địa chỉ này</span>
                <input type="checkbox" id="addr-save-address" checked>
                <span class="checkout-toggle-ui"></span>
            </label>

            <button type="submit" class="checkout-save-address-submit">Lưu địa chỉ</button>
        </form>
    `;

    sheet.classList.add('active');
    await fillCheckoutAddressEditor(address);
};

function setupCheckoutAddressEditorAutocomplete() {
    // Đã tắt hoàn toàn gợi ý địa chỉ để người dùng tự nhập chính xác.
    const dropdown = document.getElementById('addr-address-suggestions');
    if (dropdown) {
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
    }
}

window.checkoutAddressProvinceChanged = async function() {
    const provinceSelect = document.getElementById('addr-province');
    const districtSelect = document.getElementById('addr-district');
    const wardSelect = document.getElementById('addr-ward');
    if (!provinceSelect || !districtSelect || !wardSelect) return;

    const provinceCode = provinceSelect.value;
    districtSelect.innerHTML = '<option value=""></option>';
    wardSelect.innerHTML = '<option value="">Phường / Xã</option>';

    if (!provinceCode) {
        return;
    }

    const province = await ensureProvinceDetail(provinceCode);
    (province?.wards || []).forEach(item => wardSelect.add(new Option(item.name, item.code)));
    refreshCheckoutWardSelect2();
};

window.checkoutAddressDistrictChanged = function() {
    const provinceCode = document.getElementById('addr-province')?.value;
    const districtCode = '';
    const wardSelect = document.getElementById('addr-ward');
    if (!wardSelect) return;

    wardSelect.innerHTML = '<option value="">Phường / Xã</option>';
    const province = vnProvinces.find(item => String(item.code) === String(provinceCode));
    const district = districtCode;
    (province?.wards || []).forEach(item => wardSelect.add(new Option(item.name, item.code)));
};


window.clearCheckoutAddressFieldError = function(element) {
    if (!element) return;

    element.classList.remove('checkout-field-invalid');
    element.removeAttribute('aria-invalid');

    const formError = document.getElementById('addr-form-error');
    if (formError) {
        formError.textContent = '';
        formError.classList.remove('show');
    }
};

function clearCheckoutAddressErrors() {
    document.querySelectorAll('.checkout-address-form .checkout-field-invalid')
        .forEach(element => {
            element.classList.remove('checkout-field-invalid');
            element.removeAttribute('aria-invalid');
        });

    const formError = document.getElementById('addr-form-error');
    if (formError) {
        formError.textContent = '';
        formError.classList.remove('show');
    }
}

function showCheckoutAddressError(message, element) {
    clearCheckoutAddressErrors();

    const formError = document.getElementById('addr-form-error');
    if (formError) {
        formError.innerHTML = `<i class="fas fa-circle-exclamation"></i><span>${checkoutEscapeHtml(message)}</span>`;
        formError.classList.add('show');
    }

    if (element) {
        element.classList.add('checkout-field-invalid');
        element.setAttribute('aria-invalid', 'true');

        try {
            element.focus({ preventScroll: true });
        } catch (error) {
            element.focus();
        }

        element.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }
}

async function reopenCheckoutAddressEditorWithError(address, message, fieldId) {
    await window.openCheckoutAddressEditor(address?.id || '');

    window.setTimeout(() => {
        showCheckoutAddressError(
            message,
            document.getElementById(fieldId)
        );
    }, 80);
}

window.saveCheckoutAddress = function() {
    const nameInput = document.getElementById('addr-name');
    const phoneInput = document.getElementById('addr-phone');
    const provinceSelect = document.getElementById('addr-province');
    const districtSelect = document.getElementById('addr-district');
    const wardSelect = document.getElementById('addr-ward');
    const detailInput = document.getElementById('addr-address');
    const saveOnDevice =
        document.getElementById('addr-save-address')?.checked !== false;

    const name = nameInput?.value.trim() || '';
    const phone = String(phoneInput?.value || '')
        .replace(/\D/g, '')
        .slice(0, 10);
    const detail = detailInput?.value.trim() || '';

    if (phoneInput) phoneInput.value = phone;

    if (!name) {
        showCheckoutAddressError(
            'Vui lòng nhập họ và tên người nhận.',
            nameInput
        );
        return;
    }

    if (!/^0\d{9}$/.test(phone)) {
        showCheckoutAddressError(
            'Số điện thoại phải có đúng 10 số và bắt đầu bằng số 0. Ví dụ: 0912345678.',
            phoneInput
        );
        return;
    }

    if (!provinceSelect?.value) {
        showCheckoutAddressError(
            'Vui lòng chọn Tỉnh / Thành phố.',
            provinceSelect
        );
        return;
    }

    if (!wardSelect?.value) {
        showCheckoutAddressError(
            'Vui lòng chọn Phường / Xã.',
            wardSelect
        );
        return;
    }

    if (!detail) {
        showCheckoutAddressError(
            'Vui lòng nhập địa chỉ cụ thể: số nhà, tên đường, thôn/xóm hoặc tòa nhà.',
            detailInput
        );
        return;
    }

    clearCheckoutAddressErrors();

    const address = {
        id:
            checkoutEditingAddressId ||
            `addr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        phone,
        provinceCode: provinceSelect.value,
        provinceName:
            provinceSelect.options[provinceSelect.selectedIndex]?.text || '',
        districtCode: '',
        districtName: '',
        wardCode: wardSelect.value,
        wardName:
            wardSelect.options[wardSelect.selectedIndex]?.text || '',
        address: detail,
        updatedAt: new Date().toISOString()
    };

    checkoutTemporaryAddress = address;

    if (saveOnDevice) {
        const addresses = getCheckoutSavedAddresses();
        const index = addresses.findIndex(
            item => String(item.id) === String(address.id)
        );

        if (index >= 0) addresses[index] = address;
        else addresses.unshift(address);

        // Khi localStorage bị chặn, giữ địa chỉ trong phiên checkout hiện tại.
        if (persistCheckoutSavedAddresses(addresses)) {
            setCheckoutSelectedAddressId(address.id);
            checkoutTemporaryAddress = null;
        }
    }

    applyCheckoutAddressToForm(address);
    renderCheckoutAddressSummary();
    closeCheckoutAddressSheet();
};

async function initializeCheckoutAddressCache() {
    await preFetchProvinces();
    const selected = getCheckoutSelectedAddress();
    if (selected) {
        if (!getCheckoutSelectedAddressId() && selected.id) setCheckoutSelectedAddressId(selected.id);
        applyCheckoutAddressToForm(selected);
    }
    renderCheckoutAddressSummary();
}

function renderCheckoutOrderItems(items) {
    return cloneCheckoutItems(items).map(item => `
        <div class="checkout-order-product">
            <img src="${checkoutEscapeHtml(item.image || 'images/icon-logo.png')}" alt="${checkoutEscapeHtml(item.title || 'Sản phẩm')}" onerror="this.src='images/icon-logo.png'">
            <div class="checkout-order-product-info">
                <strong>${checkoutEscapeHtml(item.title || 'Sản phẩm')}</strong>
                <span>Phân loại: ${checkoutEscapeHtml(item.variant || 'Mặc định')}</span>
                <span>SL: ${Number(item.quantity || 1)}</span>
                <b>${toPriceNumber(item.price).toLocaleString('vi-VN')}đ</b>
            </div>
        </div>
    `).join('');
}

function openCheckoutModal(itemsOverride = null, mode = 'cart') {
    const hasOverride =
        Array.isArray(itemsOverride) && itemsOverride.length > 0;
    const sourceItems = hasOverride ? itemsOverride : cart;

    if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
        alert('Giỏ hàng của bạn đang trống!');
        return false;
    }

    isBuyNowMode = mode === 'buy-now';
    checkoutItems = cloneCheckoutItems(sourceItems);

    const drawer = document.getElementById('cart-drawer');
    const overlay = document.getElementById('cart-overlay');
    if (drawer) drawer.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('morachi-cart-open');

    const shippingFee = 15000;
    const subtotal = getCheckoutSubtotal();
    const total = subtotal + shippingFee;

    // Đủ entropy cho đơn thật; giữ nguyên mã trong lần retry của popup hiện tại.
    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
        currentCheckoutOrderId = 'MO' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    } else {
        // Fallback chỉ cho môi trường WebView không hỗ trợ crypto.
        currentCheckoutOrderId = 'MO' + Date.now().toString(36).toUpperCase() +
            Math.floor(Math.random() * 0xFFFFFF).toString(36).toUpperCase();
    }

    const BANK_ACCOUNT = '2470168848012';
    const ACCOUNT_NAME = 'VO THI HONG ANH';
    const qrUrl = 'images/Screenshot_18.png';

    let modal = document.getElementById('checkout-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'checkout-modal';
        modal.className = 'checkout-modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="checkout-box checkout-mobile-order">
            <header class="checkout-mobile-header">
                <button type="button" onclick="closeCheckoutModal()" aria-label="Quay lại"><i class="fas fa-arrow-left"></i></button>
                <h2>Đặt hàng</h2>
                <span></span>
            </header>

            <main class="checkout-mobile-content">
                <section class="checkout-order-section checkout-address-section">
                    <div class="checkout-section-title">
                        <span>1</span>
                        <h3>Địa chỉ nhận hàng</h3>
                    </div>
                    <div id="chk-address-summary"></div>
                    <button type="button" class="checkout-add-address-inline" onclick="openCheckoutAddressEditor()">
                        <i class="fas fa-plus"></i> Thêm địa chỉ mới
                    </button>
                </section>

                <section class="checkout-order-section">
                    <div class="checkout-section-title dark">
                        <span>2</span>
                        <h3>Thông tin đơn hàng</h3>
                    </div>
                    <div class="checkout-order-products">${renderCheckoutOrderItems(checkoutItems)}</div>
                    <div class="checkout-cost-summary">
                        <div><span>Tạm tính</span><strong>${subtotal.toLocaleString('vi-VN')}đ</strong></div>
                        <div><span>Phí vận chuyển</span><strong>${shippingFee.toLocaleString('vi-VN')}đ</strong></div>
                        <div><span>Giảm giá</span><strong>-</strong></div>
                        <div class="checkout-grand-total"><span>Tổng cộng</span><strong id="chk-total">${total.toLocaleString('vi-VN')}đ</strong></div>
                    </div>
                </section>

                <section class="checkout-order-section">
                    <div class="checkout-section-title dark">
                        <span>3</span>
                        <h3>Phương thức thanh toán</h3>
                    </div>
                    <div class="checkout-payment-list">
                        <label class="checkout-payment-option">
                            <i class="fas fa-money-bill-wave cod-icon"></i>
                            <span><strong>Thanh toán khi nhận hàng (COD)</strong><small>Thanh toán bằng tiền mặt khi nhận hàng</small></span>
                            <input type="radio" name="chk-payment" value="cod" checked onchange="toggleBankInfo()">
                            <em></em>
                        </label>
                        <label class="checkout-payment-option">
                            <i class="fas fa-university bank-icon"></i>
                            <span><strong>Chuyển khoản qua VietQR</strong><small>Mã QR tự động điền số tiền &amp; nội dung đơn hàng</small></span>
                            <input type="radio" name="chk-payment" value="bank" onchange="toggleBankInfo()">
                            <em></em>
                        </label>
                    </div>

                    <div id="bank-info-box" style="display:none;"></div>
                </section>
            </main>

            <div id="bank-payment-popup" class="bank-payment-popup" aria-hidden="true">
                <div class="bank-payment-backdrop" onclick="closeBankPaymentPopup()"></div>

                <section class="bank-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-payment-title">
                    <div class="bank-payment-handle"></div>

                    <header class="bank-payment-header">
                        <button type="button" class="bank-payment-close" onclick="closeBankPaymentPopup()" aria-label="Đóng">
                            <i class="fas fa-times"></i>
                        </button>
                        <div>
                            <h3 id="bank-payment-title">Thanh toán chuyển khoản</h3>
                            <p>Quét mã VietQR để thanh toán</p>
                        </div>
                    </header>

                    <div class="bank-payment-body">
                        <div class="bank-payment-order-code">
                            <span>Mã đơn hàng</span>
                            <strong id="chk-order-id">${currentCheckoutOrderId}</strong>
                        </div>

                        <div class="bank-payment-qr-wrap">
                            <img id="chk-qr-img" src="${qrUrl}" alt="Mã QR chuyển khoản VietQR">
                        </div>

                        <div class="bank-payment-details">
                            <div>
                                <span>Ngân hàng</span>
                                <strong>MB Quân Đội</strong>
                            </div>
                            <div>
                                <span>Chủ tài khoản</span>
                                <strong>${ACCOUNT_NAME}</strong>
                            </div>
                            <div>
                                <span>Số tài khoản</span>
                                <strong class="bank-copy-value">${BANK_ACCOUNT}</strong>
                            </div>
                            <div>
                                <span>Số tiền</span>
                                <strong id="chk-qr-amount" class="bank-payment-amount">${total.toLocaleString('vi-VN')}đ</strong>
                            </div>
                            <div>
                                <span>Nội dung chuyển khoản</span>
                                <strong id="chk-qr-content" class="bank-payment-content">${currentCheckoutOrderId}</strong>
                            </div>
                        </div>
                    </div>


                </section>
            </div>

            <footer class="checkout-mobile-footer">

                <button class="btn-checkout-confirm" onclick="submitOrder()">
                    <span class="submit-texts"><strong>Đặt hàng</strong><small>Xác nhận thông tin và tạo đơn hàng</small></span>
                </button>
                <p><i class="fas fa-lock"></i> Thông tin của bạn được bảo mật</p>
            </footer>

            <div id="checkout-address-sheet" class="checkout-address-sheet" aria-hidden="true">
                <div class="checkout-address-sheet-backdrop" onclick="closeCheckoutAddressSheet()"></div>
                <div class="checkout-address-sheet-panel">
                    <header>
                        <button type="button" onclick="closeCheckoutAddressSheet()"><i class="fas fa-times"></i></button>
                        <h3 id="checkout-address-sheet-title">Địa chỉ nhận hàng</h3>
                        <span></span>
                    </header>
                    <div id="checkout-address-sheet-body" class="checkout-address-sheet-body"></div>
                </div>
            </div>

            <div class="checkout-hidden-address-fields" aria-hidden="true">
                <input id="chk-name" type="text">
                <input id="chk-phone" type="tel">
                <select id="chk-province"><option value="">Tỉnh / Thành phố</option></select>
                <select id="chk-district"><option value="">Quận / Huyện</option></select>
                <select id="chk-ward"><option value="">Phường / Xã</option></select>
                <input id="chk-address" type="text" autocomplete="off">
            </div>
        </div>
    `;

    modal.classList.add('active');
    document.documentElement.classList.add('checkout-open');
    document.body.classList.add('checkout-open');
    initializeCheckoutAddressCache();
    return true;
}


// Public API cho product-detail.html
window.addToCart = addToCart;
window.openCart = openCart;
window.toggleCart = toggleCart;
window.openCheckoutModal = openCheckoutModal;

window.closeCheckoutModal = function() {
    const modal = document.getElementById('checkout-modal');
    if (modal) modal.classList.remove('active');
    document.documentElement.classList.remove('checkout-open');
    document.body.classList.remove('checkout-open');
    checkoutItems = [];
    isBuyNowMode = false;
    checkoutEditingAddressId = '';
    checkoutTemporaryAddress = null;
    closeBankPaymentPopup();
};

window.toggleBankInfo = function() {
    const checkedInput = document.querySelector('input[name="chk-payment"]:checked');
    const method = checkedInput ? checkedInput.value : 'cod';

    const box = document.getElementById('bank-info-box');
    if (box) box.style.display = 'none';

    if (method === 'bank') {
        openBankPaymentPopup();
    } else {
        closeBankPaymentPopup();
    }
};

window.openBankPaymentPopup = function() {
    const popup = document.getElementById('bank-payment-popup');
    if (!popup) return;

    popup.classList.add('active');
    popup.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('bank-payment-open');
    document.body.classList.add('bank-payment-open');
};

window.closeBankPaymentPopup = function() {
    const popup = document.getElementById('bank-payment-popup');
    if (!popup) return;

    popup.classList.remove('active');
    popup.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('bank-payment-open');
    document.body.classList.remove('bank-payment-open');
};



// ==========================================
// TẢI DỮ LIỆU ĐỊA CHỈ NGẦM (BACKGROUND PRE-LOAD) VÀ CACHE
// ==========================================
(function preloadLibraries() {
    if (typeof jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js";
        script.onload = () => {
            const css = document.createElement('link');
            css.rel = "stylesheet";
            css.href = "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/css/select2.min.css";
            document.head.appendChild(css);

            const s2Script = document.createElement('script');
            s2Script.src = "https://cdnjs.cloudflare.com/ajax/libs/select2/4.0.13/js/select2.min.js";
            document.head.appendChild(s2Script);
        };
        document.head.appendChild(script);
    }
})();

// Hàm tải dữ liệu địa chỉ mới 2 cấp được gọi NGAY KHI VÀO TRANG, không chờ ấn thanh toán.
// Dữ liệu lấy từ State_list(2) và City_list(2), lưu trong file nội bộ của website.
async function preFetchProvinces() {
    if (vnProvinces.length > 0) return;
    try {
        let raw = null;
        try { raw = localStorage.getItem('morachi_vn_addresses_2level_v1'); }
        catch (storageError) { console.warn('Không đọc được cache địa chỉ:', storageError); }
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length) vnProvinces = parsed;
            } catch (error) { console.warn('Cache địa chỉ không hợp lệ, tải lại:', error); }
        }
        // Không để lỗi localStorage ngăn người mua chọn tỉnh/phường.
        if (!vnProvinces.length) {
            const res = await fetch('/data/vn-addresses-2level.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const parsed = await res.json();
            if (!Array.isArray(parsed) || !parsed.length) throw new Error('Dữ liệu địa chỉ rỗng');
            vnProvinces = parsed;
            try { localStorage.setItem('morachi_vn_addresses_2level_v1', JSON.stringify(vnProvinces)); } catch(e){}
        }
    } catch (e) { console.error('Lỗi tải dữ liệu địa chỉ 2 cấp:', e); }
}

// Dữ liệu Phường/Xã đã có sẵn theo từng Tỉnh/Thành phố trong file nội bộ.
async function ensureProvinceDetail(pCode) {
    const idx = vnProvinces.findIndex(x => x.code == pCode);
    if (idx === -1) return null;
    let p = vnProvinces[idx];

    if (p.wards && p.wards.length > 0) return p;
    return p;
}

function applySelect2() {
    if (typeof jQuery === 'undefined' || typeof jQuery.fn.select2 === 'undefined') return;

    const $selects = $('#chk-province, #chk-ward');

    // Nếu Select2 đã khởi tạo rồi thì hủy trước để tránh bị nhân đôi layout/event
    $selects.each(function () {
        if ($(this).data('select2')) {
            $(this).select2('destroy');
        }
    });

    const select2Options = {
        width: '100%',
        dropdownParent: $('body'), // đưa dropdown ra body để không làm modal/card bị co giãn
        dropdownAutoWidth: false,
        minimumResultsForSearch: 8
    };

    $('#chk-province').select2(select2Options);
    $('#chk-ward').select2(select2Options);

    $('.select2-container').css({
        width: '100%',
        minWidth: '0',
        maxWidth: '100%'
    });

    function updateSelect2FullTitle() {
        $('#chk-province, #chk-ward').each(function () {
            const text = $(this).find('option:selected').text() || '';
            const $rendered = $(this)
                .next('.select2-container')
                .find('.select2-selection__rendered');

            $rendered.attr('title', text);
        });
    }

    // Gỡ event cũ trước khi gắn event mới để không bị gọi nhiều lần
    $('#chk-province')
        .off('select2:select.morachi')
        .on('select2:select.morachi', async function () {
            await window.loadWards();
            updateSelect2FullTitle();
        });

    $('#chk-district')
        .off('select2:select.morachi')
        .on('select2:select.morachi', function () {
            window.loadWards();
            updateSelect2FullTitle();
        });

    $('#chk-province, #chk-ward')
        .off('change.morachiTitle')
        .on('change.morachiTitle', updateSelect2FullTitle);

    updateSelect2FullTitle();
}

window.loadDistricts = async function() {
    if (typeof jQuery === 'undefined') return;
    const pCode = $('#chk-province').val();
    const dSelect = $('#chk-district');
    const wSelect = $('#chk-ward');

    wSelect.empty().append('<option value="">Phường/Xã</option>').trigger('change');

    if(!pCode) {
        dSelect.empty().append('<option value=""></option>').trigger('change');
        return;
    }

    const p = await ensureProvinceDetail(pCode);
    dSelect.empty().append('<option value=""></option>');
    if (p && p.wards) {
        p.wards.forEach(w => wSelect.append(new Option(w.name, w.code)));
    }
    
    wSelect.trigger('change');
};

window.loadWards = function() {
    if (typeof jQuery === 'undefined') return;
    const pCode = $('#chk-province').val();
    const dCode = '';
    const wSelect = $('#chk-ward');
    
    wSelect.empty().append('<option value="">Phường/Xã</option>');
    
    if(!pCode) {
        wSelect.trigger('change');
        return;
    }
    
    const p = vnProvinces.find(x => x.code == pCode);
    const d = dCode;
    if(p && p.wards) {
        p.wards.forEach(w => {
            wSelect.append(new Option(w.name, w.code));
        });
    }
    wSelect.trigger('change');
};

// ==========================================
// GỢI Ý ĐỊA CHỈ ĐÃ ĐƯỢC TẮT HOÀN TOÀN
// ==========================================
let searchTimeout;
window.setupAddressAutocomplete = function() {
    clearTimeout(searchTimeout);

    const dropdown = document.getElementById('address-suggestions');
    if (dropdown) {
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
    }

    const addressInput = document.getElementById('chk-address');
    if (addressInput) {
        addressInput.setAttribute('autocomplete', 'off');
        addressInput.setAttribute('autocorrect', 'off');
        addressInput.setAttribute('spellcheck', 'false');
    }
};

// ==============================================================
// XỬ LÝ ĐẶT HÀNG VÀ BẮN API VÀO DATABASE
// ==============================================================
let morachiOrderSubmitInFlight = false;
window.submitOrder = async function() {
    if (morachiOrderSubmitInFlight) return;
    const btn = document.querySelector('.btn-checkout-confirm');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    
    const textNode = btn.querySelector('.submit-texts strong');
    if(textNode) textNode.innerText = "Đang xử lý...";

    const name = document.getElementById('chk-name').value.trim();
    const phone = String(
        document.getElementById('chk-phone').value || ''
    ).replace(/\D/g, '').slice(0, 10);
    const address = document.getElementById('chk-address').value.trim();
    const selectedAddress = getCheckoutSelectedAddress();

    const resetSubmitButton = () => {
        if (textNode) textNode.innerText = "Đặt hàng";
        btn.disabled = false;
    };

    if (!name) {
        resetSubmitButton();
        await reopenCheckoutAddressEditorWithError(
            selectedAddress,
            'Vui lòng nhập họ và tên người nhận.',
            'addr-name'
        );
        return;
    }

    if (!/^0\d{9}$/.test(phone)) {
        resetSubmitButton();
        await reopenCheckoutAddressEditorWithError(
            selectedAddress,
            'Số điện thoại phải có đúng 10 số và bắt đầu bằng số 0. Ví dụ: 0912345678.',
            'addr-phone'
        );
        return;
    }

    if (
        !selectedAddress ||
        !selectedAddress.provinceCode ||
        !selectedAddress.wardCode
    ) {
        resetSubmitButton();

        const missingFieldId = !selectedAddress?.provinceCode
            ? 'addr-province'
            : 'addr-ward';

        await reopenCheckoutAddressEditorWithError(
            selectedAddress,
            'Vui lòng chọn đầy đủ Tỉnh / Thành phố và Phường / Xã.',
            missingFieldId
        );
        return;
    }

    if (!address) {
        resetSubmitButton();
        await reopenCheckoutAddressEditorWithError(
            selectedAddress,
            'Vui lòng nhập địa chỉ cụ thể: số nhà, tên đường, thôn/xóm hoặc tòa nhà.',
            'addr-address'
        );
        return;
    }

    document.getElementById('chk-phone').value = phone;

    // Phòng trường hợp trình duyệt bị cache hoặc popup bị mở lại, không để đơn hàng gửi lên bị rỗng sản phẩm.
    if ((!checkoutItems || checkoutItems.length === 0) && Array.isArray(cart) && cart.length > 0) {
        checkoutItems = cloneCheckoutItems(cart);
    }

    if (!checkoutItems || checkoutItems.length === 0) {
        alert("Không tìm thấy sản phẩm trong đơn hàng. Vui lòng thử lại!");
        if(textNode) textNode.innerText = "Đặt hàng";
        btn.disabled = false;
        return;
    }

    // Kiểm tra xem có hàng Order không
    let hasOrderItems = false;
    let orderDetails = [];
    
    checkoutItems.forEach(item => {
        if (item.status === 'order' || item.status === 'out') {
            hasOrderItems = true;
            orderDetails.push(`
                <li style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed #ddd; text-align: left;">
                    <div style="color: #333; font-weight: 600; font-size: 14px; margin-bottom: 4px;">${item.title}</div>
                    <div style="font-size: 13px; color: #666;">
                        Phân loại: <span style="color:#333;">${item.variant}</span><br>
                        Dự kiến có hàng: <span style="color: #e74c3c; font-weight: bold;">${item.date || 'Đang cập nhật'}</span>
                    </div>
                </li>
            `);
        }
    });

    if (hasOrderItems) {
        showCustomConfirmModal(orderDetails.join(''), 
            function() {
                executeOrderSubmit(btn, name, phone, address);
            }, 
            function() {
                if(textNode) textNode.innerText = "Đặt hàng";
                btn.disabled = false;
            }
        );
    } else {
        executeOrderSubmit(btn, name, phone, address);
    }
};

async function executeOrderSubmit(btn, name, phone, address) {
    if (morachiOrderSubmitInFlight) return;
    morachiOrderSubmitInFlight = true;
    const textNode = btn.querySelector('.submit-texts strong');
    const provEl = document.getElementById('chk-province');
    const distEl = document.getElementById('chk-district');
    const wardEl = document.getElementById('chk-ward');

    const prov = provEl.options[provEl.selectedIndex]
        ? provEl.options[provEl.selectedIndex].text
        : '';
    const dist = '';
    const ward = wardEl.options[wardEl.selectedIndex]
        ? wardEl.options[wardEl.selectedIndex].text
        : '';

    const checkedPayment =
        document.querySelector('input[name="chk-payment"]:checked');
    const method = checkedPayment ? checkedPayment.value : 'cod';
    const orderItems = cloneCheckoutItems(checkoutItems);

    // Frontend chỉ gửi id/phân loại/số lượng.
    // Backend sẽ tự đọc tên, giá và tồn kho thật từ Cosmos DB.
    const safeRequestItems = orderItems.map(item => ({
        id: item.id,
        sku: item.sku || '',
        variant: item.variant || 'Mặc định',
        quantity: Number(item.quantity || 1)
    }));

    const orderData = {
        order_id: currentCheckoutOrderId,
        customer_info: {
            name,
            phone,
            address,
            prov,
            dist,
            ward
        },
        items: safeRequestItems,
        payment_method: method
    };

    try {
        const response = await fetch('/api/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });

        let responseData = {};
        try {
            responseData = await response.json();
        } catch (parseError) {}

        if (!response.ok) {
            throw new Error(
                responseData.error ||
                `Không thể tạo đơn hàng (HTTP ${response.status})`
            );
        }

        const savedOrder = responseData.order || {};
        const serverOrderId = savedOrder.order_id;

        if (!serverOrderId) {
            throw new Error(
                'Máy chủ không trả về mã đơn hàng hợp lệ.'
            );
        }

        // Server đã xác nhận đơn. Cache trên điện thoại chỉ là tiện ích phụ:
        // quota/private mode KHÔNG được biến đơn thành thông báo thất bại.
        try {
            let allOrders = JSON.parse(localStorage.getItem('morachi_orders') || '[]');
            if (!Array.isArray(allOrders)) allOrders = [];
            if (!allOrders.some(order => order && order.order_id === serverOrderId)) {
                allOrders.unshift(savedOrder);
                // Tránh đầy bộ nhớ điện thoại vì lịch sử không giới hạn.
                localStorage.setItem('morachi_orders', JSON.stringify(allOrders.slice(0, 50)));
                const orderCount = parseInt(localStorage.getItem('morachi_order_count') || '0', 10) || 0;
                localStorage.setItem('morachi_order_count', String(orderCount + 1));
            }
        } catch (cacheError) {
            console.warn('Đơn đã được ghi trên Azure, nhưng điện thoại không lưu được lịch sử:', cacheError);
        }

        if (!isBuyNowMode) {
            cart = [];
            if (!saveCart()) console.warn('Đơn đã tạo; giỏ hàng cũ không xóa được trên trình duyệt.');
        }
        try { closeCheckoutModal(); }
        catch (uiError) { console.warn('Không đóng được popup checkout:', uiError); }
        checkoutItems = [];
        isBuyNowMode = false;
        try { showSuccessModal(name, serverOrderId, method); }
        catch (uiError) {
            console.error('Đơn đã được tạo nhưng popup thành công lỗi:', uiError);
            alert('Đặt hàng thành công! Mã đơn: ' + serverOrderId);
        }

    } catch (error) {
        console.error('Lỗi tạo đơn:', error);
        showOrderSubmitErrorModal(
            error.message ||
            'Không thể tạo đơn hàng. Vui lòng thử lại.'
        );

    } finally {
        morachiOrderSubmitInFlight = false;
        if (textNode) textNode.innerText = 'Đặt hàng';
        btn.disabled = false;
    }
}

function showOrderSubmitErrorModal(message) {
    const oldModal = document.getElementById(
        'custom-order-error-modal'
    );
    if (oldModal) oldModal.remove();

    const modal = document.createElement('div');
    modal.id = 'custom-order-error-modal';
    modal.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:999999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:18px',
        'background:rgba(0,0,0,.58)'
    ].join(';');

    modal.innerHTML = `
        <div style="
            width:min(100%,420px);
            overflow:hidden;
            border-radius:16px;
            background:#fff;
            box-shadow:0 20px 60px rgba(0,0,0,.25);
            font-family:Inter,Arial,sans-serif;
        ">
            <div style="
                padding:24px 22px 16px;
                text-align:center;
                background:#fff3f4;
            ">
                <div style="
                    width:58px;
                    height:58px;
                    margin:0 auto 12px;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    border-radius:50%;
                    background:#d90c1c;
                    color:#fff;
                    font-size:25px;
                ">
                    <i class="fas fa-triangle-exclamation"></i>
                </div>
                <h3 style="
                    margin:0;
                    color:#b70d18;
                    font-size:19px;
                ">CHƯA TẠO ĐƯỢC ĐƠN</h3>
            </div>
            <div style="padding:20px 22px 22px;text-align:center;">
                <p style="
                    margin:0 0 18px;
                    color:#555;
                    font-size:14px;
                    line-height:1.65;
                ">${String(message || '').replace(/[<>&"']/g, '')}</p>
                <button
                    type="button"
                    onclick="document.getElementById('custom-order-error-modal')?.remove()"
                    style="
                        width:100%;
                        padding:13px;
                        border:0;
                        border-radius:10px;
                        background:#c90d1b;
                        color:#fff;
                        font-weight:700;
                        cursor:pointer;
                    "
                >Đóng</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

// ==============================================================
// HÀM TẠO GIAO DIỆN POPUP ĐẶT HÀNG THÀNH CÔNG ĐẸP MẮT
// ==============================================================
function showSuccessModal(name, orderId, method) {
    let oldModal = document.getElementById('custom-success-modal');
    if (oldModal) oldModal.remove();

    let methodMsg = "";
    if (method === 'bank') {
        methodMsg = "Vui lòng đảm bảo bạn đã quét mã QR để chuyển khoản. Hệ thống Admin đã ghi nhận đơn hàng.";
    } else {
        methodMsg = "Chúng tôi sẽ đóng gói và thu tiền mặt (COD) tận nhà cho bạn.";
    }

    const modalHtml = `
    <div id="custom-success-modal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 999999; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s ease;">
        <div style="background: white; width: 90%; max-width: 450px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); overflow: hidden; transform: translateY(-20px); transition: transform 0.3s ease; font-family: 'Segoe UI', Tahoma, Geneva, sans-serif; text-align: center;">
            
            <div style="background: #e8f8f0; padding: 30px 20px 20px;">
                <div style="width: 70px; height: 70px; background: #27ae60; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 35px; margin: 0 auto 15px; box-shadow: 0 4px 15px rgba(39, 174, 96, 0.3);">
                    <i class="fas fa-check"></i>
                </div>
                <h3 style="margin: 0; color: #219653; font-size: 20px; font-weight: bold;">ĐẶT HÀNG THÀNH CÔNG!</h3>
            </div>
            
            <div style="padding: 25px 20px;">
                <p style="margin-top: 0; color: #333; font-size: 15px; line-height: 1.5; font-weight: 500;">
                    Cảm ơn <strong style="color: #f57224;">${name}</strong> đã tin tưởng và mua sắm tại MORACHI!
                </p>
                
                <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px dashed #ddd; font-size: 14px; color: #555;">
                    <div style="margin-bottom: 5px;">Mã đơn hàng của bạn là:</div>
                    <div style="font-size: 22px; font-weight: bold; color: #f57224; letter-spacing: 1px;">${orderId}</div>
                </div>
                
                <p style="margin-bottom: 0; color: #666; font-size: 14px; line-height: 1.6;">
                    ${methodMsg}
                </p>
            </div>
            
            <div style="padding: 20px; background: #fafafa; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid #eee;">
                <button id="btn-success-track" style="width: 100%; padding: 14px; border: none; background: #f57224; color: white; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 10px rgba(245, 114, 36, 0.3); font-size: 14px; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <i class="fas fa-map-marker-alt"></i> TRA CỨU ĐƠN HÀNG
                </button>
                <button id="btn-success-close" style="width: 100%; padding: 12px; border: 1px solid #ddd; background: white; color: #555; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 13px;">
                    TIẾP TỤC MUA SẮM
                </button>
            </div>
            
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('custom-success-modal');
    const box = modal.querySelector('div');

    setTimeout(() => {
        modal.style.opacity = '1';
        box.style.transform = 'translateY(0)';
    }, 10);

    const btnTrack = document.getElementById('btn-success-track');
    const btnClose = document.getElementById('btn-success-close');
    
    btnTrack.onmouseover = () => btnTrack.style.background = '#d35400';
    btnTrack.onmouseout = () => btnTrack.style.background = '#f57224';
    btnClose.onmouseover = () => btnClose.style.background = '#f5f5f5';
    btnClose.onmouseout = () => btnClose.style.background = 'white';

    btnClose.onclick = () => { 
        closeCustomSuccessModal(modal, box); 
    };
    btnTrack.onclick = () => { 
        closeCustomSuccessModal(modal, box);
        window.location.href = "tracking.html"; 
    };
}

function closeCustomSuccessModal(modal, box) {
    modal.style.opacity = '0';
    box.style.transform = 'translateY(-20px)';
    setTimeout(() => {
        modal.remove();
    }, 300);
}

// ==============================================================
// HÀM TẠO GIAO DIỆN POPUP CẢNH BÁO HÀNG ORDER ĐẸP MẮT
// ==============================================================
function showCustomConfirmModal(itemsHtml, onConfirm, onCancel) {
    let oldModal = document.getElementById('custom-confirm-modal');
    if (oldModal) oldModal.remove();

    const modalHtml = `
    <div id="custom-confirm-modal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 999999; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s ease;">
        <div style="background: white; width: 90%; max-width: 450px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); overflow: hidden; transform: translateY(-20px); transition: transform 0.3s ease; font-family: 'Segoe UI', Tahoma, Geneva, sans-serif;">
            
            <div style="background: #fff5f0; padding: 20px; text-align: center; border-bottom: 1px solid #ffe0d2;">
                <div style="width: 50px; height: 50px; background: #f57224; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; margin: 0 auto 10px;">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <h3 style="margin: 0; color: #d35400; font-size: 16px; font-weight: bold;">LƯU Ý ĐƠN HÀNG</h3>
            </div>
            
            <div style="padding: 20px;">
                <p style="margin-top: 0; color: #333; font-size: 14px; line-height: 1.5; text-align: center;">
                    Trong đơn hàng của bạn có chứa sản phẩm <strong style="color: #e74c3c;">HÀNG ORDER / TẠM HẾT HÀNG</strong>:
                </p>
                
                <ul style="list-style: none; padding: 15px; margin: 15px 0; background: #f9f9f9; border-radius: 8px; max-height: 180px; overflow-y: auto; border: 1px solid #eee;">
                    ${itemsHtml}
                </ul>
                
                <p style="margin-bottom: 0; color: #333; font-size: 14px; text-align: center; font-weight: 500;">
                    Bạn có đồng ý tiếp tục đặt hàng và chờ giao theo ngày dự kiến không?
                </p>
            </div>
            
            <div style="padding: 15px 20px; background: #fafafa; display: flex; gap: 10px; border-top: 1px solid #eee;">
                <button id="btn-confirm-cancel" style="flex: 1; padding: 12px; border: 1px solid #ddd; background: white; color: #555; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 13px;">XEM LẠI GIỎ HÀNG</button>
                <button id="btn-confirm-ok" style="flex: 1; padding: 12px; border: none; background: #f57224; color: white; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 10px rgba(245, 114, 36, 0.3); font-size: 13px;">ĐỒNG Ý ĐẶT HÀNG</button>
            </div>
            
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('custom-confirm-modal');
    const box = modal.querySelector('div');

    setTimeout(() => {
        modal.style.opacity = '1';
        box.style.transform = 'translateY(0)';
    }, 10);

    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnOk = document.getElementById('btn-confirm-ok');
    
    btnCancel.onmouseover = () => btnCancel.style.background = '#f5f5f5';
    btnCancel.onmouseout = () => btnCancel.style.background = 'white';
    btnOk.onmouseover = () => btnOk.style.background = '#d35400';
    btnOk.onmouseout = () => btnOk.style.background = '#f57224';

    btnCancel.onclick = () => { closeCustomConfirmModal(modal, box, onCancel); };
    btnOk.onclick = () => { closeCustomConfirmModal(modal, box, onConfirm); };
}

function closeCustomConfirmModal(modal, box, callback) {
    modal.style.opacity = '0';
    box.style.transform = 'translateY(-20px)';
    setTimeout(() => {
        modal.remove();
        if (callback) callback();
    }, 300);
}

// KHAI BÁO TOÀN BỘ CSS MỚI VÀ FIX HIỂN THỊ SELECT2 DROPDOWN
let oldCheckoutStyle = document.getElementById('checkout-style');
if(oldCheckoutStyle) oldCheckoutStyle.remove();

const checkoutStyle = document.createElement('style');
checkoutStyle.id = 'checkout-style';
checkoutStyle.innerHTML = `
    html.checkout-open,
    body.checkout-open { overflow: hidden !important; }

    .checkout-modal {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(20, 20, 24, .58);
        opacity: 0;
        visibility: hidden;
        transition: opacity .22s ease, visibility .22s ease;
        font-family: Inter, 'Segoe UI', Arial, sans-serif;
    }

    .checkout-modal.active { opacity: 1; visibility: visible; }

    .checkout-mobile-order {
        position: relative;
        width: min(100%, 540px);
        max-height: min(94vh, 880px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 22px;
        background: #fff;
        color: #222328;
        box-shadow: 0 24px 70px rgba(0,0,0,.24);
        transform: translateY(18px);
        transition: transform .22s ease;
    }

    .checkout-modal.active .checkout-mobile-order { transform: translateY(0); }

    .checkout-mobile-header {
        min-height: 62px;
        display: grid;
        grid-template-columns: 44px 1fr 44px;
        align-items: center;
        padding: 8px 14px;
        background: #fff;
        border-bottom: 1px solid #ececef;
        flex: 0 0 auto;
    }

    .checkout-mobile-header button {
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #c90d1b;
        font-size: 19px;
        cursor: pointer;
    }

    .checkout-mobile-header h2 {
        margin: 0;
        text-align: center;
        font-size: 17px;
        font-weight: 800;
        color: #1f2024;
    }

    .checkout-mobile-content {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        padding: 0 18px 18px;
        background: #fff;
    }

    .checkout-order-section {
        padding: 19px 0;
        border-bottom: 1px solid #ececef;
    }

    .checkout-order-section:last-child { border-bottom: 0; }

    .checkout-section-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
    }

    .checkout-section-title > span {
        width: 25px;
        height: 25px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: #c90d1b;
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        flex: 0 0 auto;
    }

    .checkout-section-title.dark > span { background: #2e3035; }

    .checkout-section-title h3 {
        margin: 0;
        color: #26272b;
        font-size: 14px;
        font-weight: 800;
    }

    .checkout-address-empty,
    .checkout-address-selected {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px;
        border: 1.5px solid #df2633;
        border-radius: 12px;
        background: #fff;
        color: #25262a;
        text-align: left;
        cursor: pointer;
    }

    .checkout-address-empty > span:nth-child(2),
    .checkout-address-copy { flex: 1; min-width: 0; }

    .checkout-address-empty strong,
    .checkout-address-empty small {
        display: block;
    }

    .checkout-address-empty strong { font-size: 13px; color: #c90d1b; }
    .checkout-address-empty small { margin-top: 4px; color: #7c7f86; font-size: 11px; line-height: 1.4; }

    .checkout-address-empty-icon,
    .checkout-address-pin {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: #fff1f2;
        color: #c90d1b;
        flex: 0 0 auto;
    }

    .checkout-address-person {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 5px;
        font-size: 12px;
        line-height: 1.3;
    }

    .checkout-address-person strong { font-size: 13px; }
    .checkout-address-person em,
    .checkout-address-list-person em { width: 1px; height: 14px; background: #d7d8dc; }

    .checkout-address-text {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        color: #494c53;
        font-size: 11.5px;
        line-height: 1.45;
    }

    .checkout-address-arrow { color: #757981; font-size: 12px; }

    .checkout-add-address-inline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 13px;
        padding: 7px 4px;
        border: 0;
        background: transparent;
        color: #c90d1b;
        font-size: 12px;
        font-weight: 750;
        cursor: pointer;
    }

    .checkout-order-products { display: flex; flex-direction: column; gap: 13px; }

    .checkout-order-product {
        display: flex;
        gap: 12px;
        align-items: flex-start;
    }

    .checkout-order-product img {
        width: 82px;
        height: 82px;
        object-fit: contain;
        border: 1px solid #ececef;
        border-radius: 10px;
        background: #fff;
        flex: 0 0 auto;
    }

    .checkout-order-product-info { min-width: 0; flex: 1; }
    .checkout-order-product-info strong {
        display: -webkit-box;
        overflow: hidden;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        margin-bottom: 5px;
        color: #303136;
        font-size: 13px;
        line-height: 1.35;
    }
    .checkout-order-product-info span { display: block; color: #74777e; font-size: 11px; line-height: 1.45; }
    .checkout-order-product-info b { display: block; margin-top: 7px; color: #d20e1d; font-size: 13px; }

    .checkout-cost-summary {
        margin-top: 17px;
        padding-top: 12px;
        border-top: 1px solid #ededf0;
    }
    .checkout-cost-summary > div {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        padding: 6px 0;
        color: #4d5056;
        font-size: 11px;
    }
    .checkout-cost-summary strong { color: #34363a; font-weight: 700; }
    .checkout-cost-summary .checkout-grand-total {
        margin-top: 7px;
        padding-top: 12px;
        border-top: 1px solid #ededf0;
        align-items: center;
        color: #202126;
        font-weight: 800;
    }
    .checkout-cost-summary .checkout-grand-total strong { color: #d20e1d; font-size: 23px; }

    .checkout-payment-list { display: flex; flex-direction: column; gap: 10px; }
    .checkout-payment-option {
        position: relative;
        min-height: 65px;
        display: grid;
        grid-template-columns: 34px 1fr 22px;
        gap: 10px;
        align-items: center;
        padding: 12px 14px;
        border: 1px solid #e5e6e9;
        border-radius: 11px;
        background: #fff;
        cursor: pointer;
    }
    .checkout-payment-option:has(input:checked) { border-color: #db1c29; background: #fffafa; }
    .checkout-payment-option > i { font-size: 20px; text-align: center; }
    .checkout-payment-option .cod-icon { color: #2caf63; }
    .checkout-payment-option .bank-icon { color: #307ccb; }
    .checkout-payment-option > span { min-width: 0; }
    .checkout-payment-option strong,
    .checkout-payment-option small { display: block; }
    .checkout-payment-option strong { color: #34363a; font-size: 12px; line-height: 1.35; }
    .checkout-payment-option small { margin-top: 3px; color: #72757c; font-size: 10.5px; line-height: 1.35; }
    .checkout-payment-option input { position: absolute; opacity: 0; pointer-events: none; }
    .checkout-payment-option em {
        width: 17px;
        height: 17px;
        border: 1.5px solid #c8cad0;
        border-radius: 50%;
        background: #fff;
    }
    .checkout-payment-option input:checked + em { border: 5px solid #d20e1d; }

    .checkout-bank-box {
        margin-top: 12px;
        padding: 14px;
        border: 1px dashed #df5963;
        border-radius: 12px;
        background: #fff9f9;
        color: #3e4045;
        font-size: 11px;
    }
    .checkout-bank-box > strong { display: block; margin-bottom: 12px; color: #c90d1b; }
    .checkout-bank-content { display: flex; gap: 16px; align-items: center; }
    .checkout-bank-content > div { flex: 1; min-width: 0; }
    .checkout-bank-content span { display: block; margin: 4px 0; line-height: 1.35; }
    .checkout-bank-content b { color: #c90d1b; }
    .checkout-bank-content img {
        width: 145px;
        height: 145px;
        flex: 0 0 145px;
        object-fit: contain;
        border: 1px solid #f0d7da;
        border-radius: 10px;
        background: #fff;
        padding: 3px;
        box-shadow: 0 4px 14px rgba(201, 13, 27, 0.08);
    }


    .bank-payment-popup {
        position: fixed;
        inset: 0;
        z-index: 10030;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 12px;
    }

    .bank-payment-popup.active {
        display: flex;
    }

    .bank-payment-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(17, 18, 22, 0.55);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
    }

    .bank-payment-dialog {
        position: relative;
        z-index: 1;
        width: min(100%, 410px);
        max-height: min(92vh, 760px);
        overflow-y: auto;
        border-radius: 22px;
        background: #fff;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
        animation: bankPopupSlideUp .24s ease-out;
        -webkit-overflow-scrolling: touch;
    }

    @keyframes bankPopupSlideUp {
        from {
            opacity: 0;
            transform: translateY(28px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .bank-payment-handle {
        width: 44px;
        height: 5px;
        margin: 7px auto 0;
        border-radius: 999px;
        background: #d8d9dd;
    }

    .bank-payment-header {
        position: relative;
        padding: 10px 42px 8px 14px;
        border-bottom: 1px solid #ededf0;
        text-align: center;
    }

    .bank-payment-header > div {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    .bank-payment-header h3 {
        margin: 0;
        color: #23252a;
        font-size: 15px;
        line-height: 1.25;
        font-weight: 800;
    }

    .bank-payment-header p {
        margin: 2px 0 0;
        color: #74777f;
        font-size: 10px;
        line-height: 1.35;
    }

    .bank-payment-close {
        position: absolute;
        top: 9px;
        right: 9px;
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 50%;
        background: #f3f3f5;
        color: #676a72;
        cursor: pointer;
        font-size: 15px;
    }

    .bank-payment-body {
        padding: 10px 14px 14px;
    }

    .bank-payment-order-code {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border: 1px solid #f3d3d6;
        border-radius: 12px;
        background: #fff8f8;
    }

    .bank-payment-order-code span {
        color: #777a82;
        font-size: 10px;
    }

    .bank-payment-order-code strong {
        color: #c90d1b;
        font-size: 12px;
        word-break: break-all;
    }

    .bank-payment-qr-wrap {
        padding: 10px 0 8px;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    .bank-payment-qr-wrap img {
        width: min(54vw, 205px);
        height: min(54vw, 205px);
        max-width: 205px;
        max-height: 205px;
        object-fit: contain;
        border: 1px solid #ebd9db;
        border-radius: 16px;
        background: #fff;
        padding: 7px;
        box-shadow: 0 10px 30px rgba(46, 18, 21, .11);
    }


    .bank-payment-details {
        overflow: hidden;
        border: 1px solid #ececef;
        border-radius: 12px;
        background: #fff;
    }

    .bank-payment-details > div {
        min-height: 34px;
        padding: 6px 10px;
        display: grid;
        grid-template-columns: minmax(88px, .88fr) minmax(0, 1.2fr);
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid #eeeeef;
    }

    .bank-payment-details > div:last-child {
        border-bottom: 0;
    }

    .bank-payment-details span {
        color: #777a82;
        font-size: 9px;
    }

    .bank-payment-details strong {
        color: #303238;
        font-size: 10px;
        text-align: right;
        word-break: break-word;
    }

    .bank-payment-details .bank-payment-amount,
    .bank-payment-details .bank-payment-content {
        color: #c90d1b;
        font-size: 12px;
    }

    html.bank-payment-open,
    body.bank-payment-open {
        overflow: hidden !important;
    }

    .checkout-mobile-footer {
        flex: 0 0 auto;
        padding: 12px 18px max(12px, env(safe-area-inset-bottom));
        border-top: 1px solid #ececef;
        background: rgba(255,255,255,.98);
        box-shadow: 0 -7px 20px rgba(0,0,0,.06);
    }
    .btn-checkout-confirm {
        width: 100%;
        min-height: 52px;
        border: 0;
        border-radius: 8px;
        background: linear-gradient(90deg, #dc0b1b, #c40b18);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(201,13,27,.18);
    }
    .btn-checkout-confirm:disabled { opacity: .68; cursor: wait; }
    .btn-checkout-confirm .submit-texts strong,
    .btn-checkout-confirm .submit-texts small { display: block; }
    .btn-checkout-confirm .submit-texts strong { font-size: 14px; font-weight: 800; }
    .btn-checkout-confirm .submit-texts small { margin-top: 2px; font-size: 10px; opacity: .88; }
    .checkout-mobile-footer p { margin: 8px 0 0; text-align: center; color: #7c7f86; font-size: 10px; }
    .checkout-mobile-footer p i { margin-right: 5px; }

    .checkout-address-sheet {
        position: absolute;
        inset: 0;
        z-index: 30;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity .2s ease, visibility .2s ease;
    }
    .checkout-address-sheet.active { pointer-events: auto; opacity: 1; visibility: visible; }
    .checkout-address-sheet-backdrop { position: absolute; inset: 0; background: rgba(18,18,22,.42); }
    .checkout-address-sheet-panel {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        max-height: 92%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 22px 22px 0 0;
        background: #fff;
        box-shadow: 0 -18px 46px rgba(0,0,0,.17);
        transform: translateY(25px);
        transition: transform .22s ease;
    }
    .checkout-address-sheet.active .checkout-address-sheet-panel { transform: translateY(0); }
    .checkout-address-sheet-panel > header {
        min-height: 58px;
        display: grid;
        grid-template-columns: 42px 1fr 42px;
        align-items: center;
        padding: 7px 12px;
        border-bottom: 1px solid #ececef;
    }
    .checkout-address-sheet-panel > header button {
        width: 38px;
        height: 38px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #55585e;
        cursor: pointer;
        font-size: 17px;
    }
    .checkout-address-sheet-panel > header h3 { margin: 0; text-align: center; font-size: 15px; font-weight: 800; }
    .checkout-address-sheet-body { min-height: 0; overflow-y: auto; padding: 10px 18px 18px; }

    .checkout-address-list-item {
        display: grid;
        grid-template-columns: 25px 1fr 38px;
        gap: 8px;
        align-items: center;
        padding: 14px 0;
        border-bottom: 1px solid #ececef;
    }
    .checkout-address-radio,
    .checkout-address-list-main,
    .checkout-address-edit-link { border: 0; background: transparent; cursor: pointer; }
    .checkout-address-radio { width: 22px; height: 22px; padding: 0; }
    .checkout-address-radio span {
        width: 16px;
        height: 16px;
        display: block;
        border: 1.5px solid #c8cad0;
        border-radius: 50%;
    }
    .checkout-address-list-item.selected .checkout-address-radio span { border: 5px solid #d20e1d; }
    .checkout-address-list-main { min-width: 0; padding: 0; text-align: left; color: #55585e; font-size: 11px; line-height: 1.45; }
    .checkout-address-list-person { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; color: #3a3c41; }
    .checkout-address-list-person strong { font-size: 12px; }
    .checkout-address-edit-link { color: #d20e1d; font-size: 11px; font-weight: 750; }
    .checkout-add-address-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 13px 0 4px;
        padding: 8px 4px;
        border: 0;
        background: transparent;
        color: #d20e1d;
        font-size: 12px;
        font-weight: 750;
        cursor: pointer;
    }
    .checkout-address-list-empty { padding: 28px 10px; text-align: center; color: #7a7d84; }
    .checkout-address-list-empty i { display: block; margin-bottom: 10px; color: #d20e1d; font-size: 27px; }
    .checkout-address-list-empty strong,
    .checkout-address-list-empty span { display: block; }
    .checkout-address-list-empty strong { color: #34363a; font-size: 13px; }
    .checkout-address-list-empty span { margin-top: 5px; font-size: 11px; }

    .checkout-device-cache-note {
        display: flex;
        gap: 11px;
        margin-top: 14px;
        padding: 15px;
        border: 1px solid #f0dadc;
        border-radius: 13px;
        background: #fff8f7;
    }
    .checkout-device-cache-note > i { color: #3c3f45; font-size: 18px; }
    .checkout-device-cache-note strong,
    .checkout-device-cache-note span,
    .checkout-device-cache-note small { display: block; }
    .checkout-device-cache-note strong { color: #34363a; font-size: 12px; }
    .checkout-device-cache-note span { margin-top: 5px; color: #666a71; font-size: 10.5px; line-height: 1.45; }
    .checkout-device-cache-note small { margin-top: 9px; color: #249d58; font-size: 10px; }
    .checkout-device-cache-note small i { margin-right: 5px; }


    /* Tắt hoàn toàn danh sách dự đoán địa chỉ */
    #addr-address-suggestions,
    #address-suggestions,
    .checkout-address-suggestions {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
    }

    .checkout-address-form { padding-top: 4px; }
    .checkout-address-form > label:not(.checkout-save-address-toggle) {
        display: block;
        margin: 12px 0 6px;
        color: #35373c;
        font-size: 11px;
        font-weight: 700;
    }
    .checkout-address-form input[type="text"],
    .checkout-address-form input[type="tel"],
    .checkout-address-form select {
        width: 100%;
        height: 44px;
        padding: 0 12px;
        border: 1px solid #e0e1e5;
        border-radius: 8px;
        outline: none;
        background: #fff;
        color: #303237;
        font-size: 13px;
        box-sizing: border-box;
    }
    .checkout-address-form input:focus,
    .checkout-address-form select:focus { border-color: #d20e1d; box-shadow: 0 0 0 3px rgba(210,14,29,.07); }

    .checkout-address-form .checkout-field-invalid {
        border-color: #e30613 !important;
        background: #fff8f8 !important;
        box-shadow: 0 0 0 3px rgba(227, 6, 19, .08) !important;
    }

    .checkout-address-form-error {
        display: none;
        align-items: flex-start;
        gap: 8px;
        margin-top: 12px;
        padding: 10px 12px;
        border: 1px solid #fecaca;
        border-radius: 9px;
        background: #fff5f5;
        color: #b91c1c;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.5;
    }

    .checkout-address-form-error.show {
        display: flex;
    }

    .checkout-address-form-error i {
        margin-top: 2px;
        flex: 0 0 auto;
    }
    .checkout-address-detail-wrap { position: relative; }
    .checkout-address-suggestions {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(100% + 4px);
        z-index: 5;
        display: none;
        max-height: 180px;
        overflow-y: auto;
        border: 1px solid #e0e1e5;
        border-radius: 9px;
        background: #fff;
        box-shadow: 0 10px 26px rgba(0,0,0,.13);
    }
    .checkout-address-suggestions button {
        width: 100%;
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border: 0;
        border-bottom: 1px solid #efeff1;
        background: #fff;
        color: #4a4d54;
        text-align: left;
        font-size: 10.5px;
        line-height: 1.4;
        cursor: pointer;
    }
    .checkout-address-suggestions button i { color: #d20e1d; margin-top: 2px; }

    .checkout-save-address-toggle {
        min-height: 44px;
        display: flex;
        align-items: center;
        margin-top: 12px;
        cursor: pointer;
    }
    .checkout-save-address-toggle > span:first-child { flex: 1; color: #404247; font-size: 11px; }
    .checkout-save-address-toggle input { position: absolute; opacity: 0; }
    .checkout-toggle-ui {
        position: relative;
        width: 42px;
        height: 24px;
        border-radius: 999px;
        background: #d8d9dd;
        transition: .18s ease;
    }
    .checkout-toggle-ui::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 5px rgba(0,0,0,.18);
        transition: .18s ease;
    }
    .checkout-save-address-toggle input:checked + .checkout-toggle-ui { background: #d20e1d; }
    .checkout-save-address-toggle input:checked + .checkout-toggle-ui::after { transform: translateX(18px); }
    .checkout-save-address-submit {
        width: 100%;
        height: 48px;
        margin-top: 13px;
        border: 0;
        border-radius: 8px;
        background: linear-gradient(90deg, #dc0b1b, #c40b18);
        color: #fff;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
    }

    .checkout-hidden-address-fields { display: none !important; }

    @media (max-width: 600px) {
        .checkout-modal { padding: 0; background: #fff; }
        .checkout-mobile-order {
            width: 100%;
            height: 100%;
            max-height: none;
            border-radius: 0;
            box-shadow: none;
        }
        .checkout-mobile-content { padding-left: 15px; padding-right: 15px; }
        .checkout-order-product img { width: 78px; height: 78px; }
        .checkout-address-sheet-panel { max-height: 94%; }

        .bank-payment-popup {
            padding: 10px;
            align-items: center;
        }

        .bank-payment-dialog {
            width: 100%;
            max-height: 92vh;
            border-radius: 22px;
        }

        .bank-payment-header {
            padding: 9px 38px 7px 12px;
        }

        .bank-payment-body {
            padding: 9px 12px 12px;
        }

        .bank-payment-qr-wrap img {
            width: min(52vw, 190px);
            height: min(52vw, 190px);
            max-width: 190px;
            max-height: 190px;
        }

        .checkout-bank-content img {
            width: 132px;
            height: 132px;
            flex-basis: 132px;
        }
    }

    @media (max-width: 360px) {
        .checkout-mobile-content { padding-left: 12px; padding-right: 12px; }
        .checkout-order-product img { width: 68px; height: 68px; }
        .checkout-cost-summary .checkout-grand-total strong { font-size: 20px; }
        .checkout-bank-content { align-items: flex-start; gap: 10px; }
        .checkout-bank-content img {
            width: 118px;
            height: 118px;
            flex-basis: 118px;
        }
        .bank-payment-qr-wrap img {
            width: min(50vw, 182px);
            height: min(50vw, 182px);
            max-width: 182px;
            max-height: 182px;
        }
        .bank-payment-details > div {
            min-height: 32px;
            padding: 6px 8px;
            gap: 8px;
        }
        .bank-payment-details span { font-size: 8.8px; }
        .bank-payment-details strong { font-size: 9.8px; }
    }
`;
document.head.appendChild(checkoutStyle);


// ==============================================================
// 10. TÍNH NĂNG NÚT LIÊN HỆ NỔI (FLOATING CONTACT) TỰ ĐỘNG
// ==============================================================
function initFloatingContact() {
    if (document.querySelector('.floating-contact')) return;

    const style = document.createElement('style');
    style.innerHTML = `
        .floating-contact { position: fixed; bottom: 30px; right: 30px; display: flex; flex-direction: column; gap: 15px; z-index: 9999; }
        .float-btn { width: 45px; height: 45px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 22px; text-decoration: none; box-shadow: 0 4px 10px rgba(0,0,0,0.3); transition: transform 0.2s ease, box-shadow 0.2s ease; position: relative; }
        .float-btn:hover { transform: translateY(-5px) scale(1.05); color: white; box-shadow: 0 6px 15px rgba(0,0,0,0.4); }
        .float-btn .tooltip { position: absolute; right: 55px; background: rgba(0,0,0,0.8); color: white; padding: 5px 12px; border-radius: 6px; font-size: 13px; white-space: nowrap; opacity: 0; visibility: hidden; transition: 0.3s ease; pointer-events: none; font-weight: bold; }
        .float-btn:hover .tooltip { opacity: 1; visibility: visible; right: 60px; }
        .btn-messenger { background: linear-gradient(45deg, #00C6FF, #0072FF); animation: pulse-ring 2s infinite; }
        .btn-facebook { background: #1877F2; }
        .btn-tiktok1 { background: #000000; border: 2px solid #fff; }
        .btn-tiktok2 { background: #000000; border: 2px solid #00f2fe; }

        @keyframes pulse-ring {
            0% { box-shadow: 0 0 0 0 rgba(0, 132, 255, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(0, 132, 255, 0); }
            100% { box-shadow: 0 0 0 0 rgba(0, 132, 255, 0); }
        }

        @media (max-width: 768px) {
            .floating-contact { bottom: 20px; right: 15px; transform: scale(0.9); transform-origin: bottom right; }
        }
    `;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.className = 'floating-contact';
    container.innerHTML = `
        <a href="https://www.facebook.com/profile.php?id=61572066442519" target="_blank" class="float-btn btn-messenger">
            <i class="fab fa-facebook-messenger"></i>
            <span class="tooltip">Chat Messenger</span>
        </a>
        <a href="https://www.facebook.com/profile.php?id=61572066442519" target="_blank" class="float-btn btn-facebook">
            <i class="fab fa-facebook-f"></i>
            <span class="tooltip">Facebook Fanpage</span>
        </a>
        <a href="https://www.tiktok.com/@donhatnoidia2026" target="_blank" class="float-btn btn-tiktok1">
            <i class="fab fa-tiktok"></i>
            <span class="tooltip">Tiệm đồ nhật nội địa</span>
        </a>
        <a href="https://www.tiktok.com/@morachijanpan" target="_blank" class="float-btn btn-tiktok2">
            <i class="fab fa-tiktok"></i>
            <span class="tooltip">Morachi</span>
        </a>
    `;
    document.body.appendChild(container);
}

document.addEventListener('DOMContentLoaded', () => {
    updateCartUI();
    initFloatingContact(); 
    preFetchProvinces(); // Kích hoạt tải dữ liệu địa chỉ ngầm ngay khi vào web
});



if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncMorachiCheckoutButtonUI, { once: true });
} else {
    syncMorachiCheckoutButtonUI();
}

