/* MORACHI inline JPY pricing: Admin only, never contains Cosmos secrets. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const sheet = byId('sheet');
  const grid = byId('grid');
  const variants = byId('variantRow');
  const info = byId('infoGrid');
  if (!sheet || !grid || !variants || !info) {
    console.warn('SKU price form: this SKU mobile layout is not supported');
    return;
  }

  const box = document.createElement('section');
  box.id = 'morachi-sku-price-editor';
  box.style.cssText = 'margin:14px 0;padding:13px;border:1px solid #e8ebf2;border-radius:15px;background:#fff;';
  box.innerHTML = `
    <div style="font-size:13px;font-weight:800;color:#16243a;margin-bottom:9px">Giá nhập JPY · Production/UAT theo cấu hình</div>
    <div id="morachi-sku-price-info" style="font-size:11px;color:#53627b;margin-bottom:9px">Đang tải dữ liệu SKU…</div>
    <label for="morachi-jpy-input" style="font-size:11px;font-weight:700;display:block;margin-bottom:5px">Giá nhập ¥ (số nguyên)</label>
    <input id="morachi-jpy-input" type="number" step="1" min="1" max="1000000" inputmode="numeric" placeholder="Ví dụ: 638"
      style="box-sizing:border-box;width:100%;padding:12px;border:1px solid #dce1e9;border-radius:11px;font-size:16px;background:#fff;color:#17243a" />
    <div id="morachi-jpy-calc" style="font-size:12px;color:#6d7788;margin:9px 0">Giá vốn: — (JPY × 170)</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" id="morachi-save-jpy" style="flex:1;padding:11px;background:#f57224;color:white;border:0;border-radius:11px;font-weight:800">Lưu giá JPY</button>
      <button type="button" id="morachi-assign-sku" hidden style="flex:1;padding:11px;border:1px solid #f57224;background:#fff7ef;color:#a25113;border-radius:11px;font-weight:800">Tạo SKU còn thiếu</button>
    </div>
    <p id="morachi-sku-price-msg" aria-live="polite" style="font-size:11px;color:#627086;line-height:1.4;margin:8px 0 0">Chỉ cập nhật giá nhập JPY và giá vốn; không đổi giá bán, tồn kho.</p>`;
  info.insertAdjacentElement('afterend', box);

  const input = byId('morachi-jpy-input');
  const msg = byId('morachi-sku-price-msg');
  const note = byId('morachi-sku-price-info');
  const calc = byId('morachi-jpy-calc');
  const save = byId('morachi-save-jpy');
  const assign = byId('morachi-assign-sku');
  let selectedId = '';
  let current = null;
  let loadSerial = 0;

  function say(s, bad = false) {
    msg.textContent = s;
    msg.style.color = bad ? '#ba2020' : '#627086';
  }
  function pickedIndex() {
    const el = variants.querySelector('[data-variant].active');
    const val = Number(el?.dataset.variant ?? 0);
    return Number.isInteger(val) && val >= 0 ? val : 0;
  }
  function updateCost() {
    const n = Number(input.value);
    calc.textContent = input.value && Number.isInteger(n) && n > 0
      ? `Giá vốn dự kiến: ${(n * 170).toLocaleString('vi-VN')} đ (×170)`
      : 'Giá vốn: — (JPY × 170)';
  }
  input.addEventListener('input', updateCost);

  async function getProduct() {
    const response = await fetch('/api/manage/products', {credentials:'same-origin',cache:'no-store'});
    if (!response.ok) throw new Error('Không tải được dữ liệu quản trị (HTTP ' + response.status + ')');
    const docs = await response.json();
    if (!Array.isArray(docs)) throw new Error('API quản trị trả dữ liệu không hợp lệ');
    if (selectedId) {
      const found = docs.find(p => String(p.id) === String(selectedId));
      if (found) return found;
    }
    // No guessing when product title is not unique.
    const title = (byId('modalTitle')?.textContent || '').trim();
    const brand = (byId('sheetBrand')?.textContent || '').trim();
    const matches = docs.filter(p => p.title === title && p.brand === brand);
    if (matches.length !== 1) throw new Error('Không xác định duy nhất Product ID; đóng và chọn lại sản phẩm');
    selectedId = String(matches[0].id);
    return matches[0];
  }
  async function render() {
    if (!sheet.classList.contains('show')) return;
    const serial = ++loadSerial;
    current = null;
    save.disabled = true;
    assign.hidden = true;
    note.textContent = 'Đang kiểm tra Product ID, SKU và giá hiện tại…';
    say('');
    try {
      const product = await getProduct();
      if (serial !== loadSerial) return;
      const idx = pickedIndex();
      const v = product.variants?.[idx];
      if (!v || typeof v !== 'object') throw new Error('Phân loại không còn tồn tại');
      current = {product, idx, variant:v};
      note.textContent = `SKU: ${v.sku || 'Chưa có'} · ${v.name || ''}`;
      input.value = Number.isInteger(Number(v.purchase_price_jpy)) && v.purchase_price_jpy != null
        ? String(v.purchase_price_jpy) : '';
      updateCost();
      assign.hidden = !!v.sku;
      save.disabled = !v.sku;
      say(!v.sku ? 'Chưa có SKU. Bấm Tạo SKU còn thiếu để cấp mã cho sản phẩm.'
                 : 'Chỉ ghi giá JPY + giá vốn. Giá bán và tồn kho được giữ nguyên.');
    } catch (err) {
      note.textContent = 'Không thể tải thông tin phân loại';
      say(err.message, true);
    }
  }
  const later = () => setTimeout(render, 0);
  grid.addEventListener('click', event => {
    const btn = event.target.closest('[data-product-id]');
    if (btn) { selectedId = String(btn.dataset.productId || ''); later(); }
  }, true);
  variants.addEventListener('click', event => {
    if (event.target.closest('[data-variant]')) later();
  });
  const observer = new MutationObserver(records => {
    if (records.some(r => r.type === 'attributes' && r.attributeName === 'class' && sheet.classList.contains('show')))
      later();
  });
  observer.observe(sheet, {attributes:true, attributeFilter:['class']});

  async function callApi(url, method, body) {
    const response = await fetch(url, {
      method, credentials:'same-origin', cache:'no-store',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
    return result;
  }
  save.addEventListener('click', async () => {
    if (!current || !current.variant.sku) return;
    const jpy = Number(input.value);
    if (!/^[0-9]+$/.test(input.value) || !Number.isInteger(jpy) || jpy < 1 || jpy > 1_000_000) {
      say('Giá JPY phải là số nguyên từ 1 đến 1.000.000', true); return;
    }
    if (!window.confirm(`Lưu ¥${jpy} cho ${current.variant.sku}?\nGiá vốn: ${(jpy * 170).toLocaleString('vi-VN')} đ`)) return;
    save.disabled = true;
    try {
      await callApi('/api/manage/sku/price', 'PUT', {
        product_id:current.product.id, variant_index:current.idx,
        sku:current.variant.sku, purchase_price_jpy:jpy,
        expected_etag:current.product._etag
      });
      say('Đã cập nhật giá nhập thành công.');
      await render();
      if (byId('reloadSheet')) byId('reloadSheet').click();
    } catch (err) { say('Không thể lưu: ' + err.message, true); save.disabled = false; }
  });
  assign.addEventListener('click', async () => {
    if (!current) return;
    if (!window.confirm('Tạo SKU cho các phân loại còn thiếu trong sản phẩm này? Không thay đổi tồn kho/giá bán.')) return;
    assign.disabled = true;
    try {
      const result = await callApi('/api/manage/sku/ensure', 'POST', {
        product_id:current.product.id, expected_etag:current.product._etag
      });
      say(`Đã cấp ${result.created || 0} SKU. Đang tải lại…`);
      await render();
      if (byId('reloadSheet')) byId('reloadSheet').click();
    } catch (err) { say('Không thể cấp SKU: ' + err.message, true); }
    finally { assign.disabled = false; }
  });
})();
