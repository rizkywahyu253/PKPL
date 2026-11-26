const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');

class FakeElement {
    constructor(id = '') {
        this.id = id;
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.className = '';
        this.style = {};
        this.attributes = {};
        this.children = [];
        this.listeners = {};
        this.classList = {
            values: new Set(),
            add: value => this.classList.values.add(value),
            remove: value => this.classList.values.delete(value),
            contains: value => this.classList.values.has(value)
        };
    }

    addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
    }

    async emit(type, event = {}) {
        const results = [];
        for (const handler of this.listeners[type] || []) results.push(await handler(event));
        return results;
    }

    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); return this; }
    focus() { this.focused = true; }
    reset() { this.resetCount = (this.resetCount || 0) + 1; }
    appendChild(child) { this.children.push(child); }
    querySelectorAll() { return this.cards || []; }
}

// Mock: records database/authentication calls and payloads for assertions.
class SupabaseCallMock {
    constructor(responseStub = {}) {
        this.calls = [];
        this.responseStub = responseStub;
        this.auth = {
            getSession: () => Promise.resolve({ data: { session: null } }),
            onAuthStateChange: callback => {
                this.calls.push({ scope: 'auth', method: 'onAuthStateChange' });
                this.authListener = callback;
                return { data: { subscription: { unsubscribe() {} } } };
            },
            signUp: args => this.authCall('signUp', args),
            signInWithPassword: args => this.authCall('signInWithPassword', args),
            resetPasswordForEmail: (email, options) => this.authCall('resetPasswordForEmail', { email, options }),
            signOut: () => this.authCall('signOut'),
            updateUser: args => this.authCall('updateUser', args)
        };
    }

    authCall(method, payload) {
        this.calls.push({ scope: 'auth', method, payload });
        return Promise.resolve(this.responseStub[method] || {
            data: { user: { id: 'test-user', email: 'student@example.com', user_metadata: { name: 'Student' } } },
            error: null
        });
    }

    from(table) { return new SupabaseQueryMock(this, table); }
}

// Stub: supplies deterministic backend responses without contacting Supabase.
class SupabaseQueryMock {
    constructor(owner, table) {
        this.owner = owner;
        this.table = table;
        this.operations = [];
    }

    record(method, payload) {
        const operation = { scope: 'db', table: this.table, method, payload };
        this.operations.push(operation);
        this.owner.calls.push(operation);
        return this;
    }

    select(payload) { return this.record('select', payload); }
    insert(payload) { return this.record('insert', payload); }
    upsert(payload) { return this.record('upsert', payload); }
    update(payload) { return this.record('update', payload); }
    delete() { return this.record('delete'); }
    eq(column, value) {
        const last = this.operations.at(-1);
        (last.filters ||= []).push([column, value]);
        return this;
    }

    result() {
        if (this.table === 'orders') return { data: { id: 'db-order-1' }, error: null };
        return { data: null, error: null };
    }

    single() { return Promise.resolve(this.result()); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
}

function createHarness({ scripts = [], queryMap = {}, authResponses = {} } = {}) {
    const elements = new Map();
    const readyHandlers = [];
    const openedUrls = [];
    const storage = new Map();
    const localStorage = {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
    };
    const document = {
        body: { style: {} },
        addEventListener(type, handler) {
            if (type === 'DOMContentLoaded') readyHandlers.push(handler);
        },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new FakeElement(id));
            return elements.get(id);
        },
        querySelector(selector) { return (queryMap[selector] || [])[0] || null; },
        querySelectorAll(selector) { return queryMap[selector] || []; },
        createElement(tag) { return new FakeElement(tag); }
    };
    const supabase = new SupabaseCallMock(authResponses);
    const context = vm.createContext({
        document,
        localStorage,
        supabaseClient: supabase,
        location: { hash: '', origin: 'http://localhost', pathname: '/index.html' },
        console: { warn() {}, error() {}, log() {} },
        setTimeout() { return 1; },
        open: (url, target) => openedUrls.push({ url, target })
    });
    context.window = context;

    for (const filename of scripts) {
        const sourcePath = path.join(appRoot, filename);
        vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
    }
    for (const handler of readyHandlers) handler();

    return {
        context,
        document,
        elements,
        supabase,
        openedUrls,
        storage,
        element: id => document.getElementById(id)
    };
}

function preventableEvent(extra = {}) {
    return { preventDefault() {}, ...extra };
}

test('TC-REG-01 valid registration sends user details to Supabase', async () => {
    // Arrange
    const h = createHarness({ scripts: ['auth.js'] });
    h.element('regName').value = 'Ayu';
    h.element('regEmail').value = 'ayu@example.com';
    h.element('regPhone').value = '08123456789';
    h.element('regPassword').value = 'password8';
    h.element('regConfirmPassword').value = 'password8';

    // Act
    await h.element('registerForm').emit('submit', preventableEvent());

    // Assert
    const signup = h.supabase.calls.find(call => call.method === 'signUp');
    assert.equal(signup.payload.email, 'ayu@example.com');
    assert.equal(signup.payload.options.data.name, 'Ayu');
    assert.equal(h.element('registerAlert').className, 'auth-alert success');
});

test('TC-REG-02 password under eight characters is rejected before API call', async () => {
    // Arrange
    const h = createHarness({ scripts: ['auth.js'] });
    h.element('regName').value = 'Ayu';
    h.element('regEmail').value = 'ayu@example.com';
    h.element('regPhone').value = '08123456789';
    h.element('regPassword').value = 'short7';
    h.element('regConfirmPassword').value = 'short7';

    // Act
    await h.element('registerForm').emit('submit', preventableEvent());

    // Assert
    assert.match(h.element('registerAlert').textContent, /at least 8 characters/i);
    assert.equal(h.supabase.calls.some(call => call.method === 'signUp'), false);
});

test('TC-LOGIN-01 valid login stores authenticated user state', async () => {
    // Arrange
    const user = { id: 'u-7', email: 'ayu@example.com', user_metadata: { name: 'Ayu' } };
    const h = createHarness({ scripts: ['auth.js'], authResponses: {
        signInWithPassword: { data: { user }, error: null }
    } });
    h.element('loginEmail').value = 'ayu@example.com';
    h.element('loginPassword').value = 'password8';

    // Act
    await h.element('loginForm').emit('submit', preventableEvent());

    // Assert
    assert.equal(h.context.currentUser.id, 'u-7');
    assert.equal(h.element('navUserName').textContent, 'Hi, Ayu');
    assert.equal(h.element('loginAlert').className, 'auth-alert success');
});

test('TC-LOGIN-02 malformed email is rejected without authentication request', async () => {
    // Arrange
    const h = createHarness({ scripts: ['auth.js'] });
    h.element('loginEmail').value = 'not-an-email';
    h.element('loginPassword').value = 'password8';

    // Act
    await h.element('loginForm').emit('submit', preventableEvent());

    // Assert
    assert.match(h.element('loginAlert').textContent, /valid email/i);
    assert.equal(h.supabase.calls.some(call => call.method === 'signInWithPassword'), false);
});

test('TC-FORGOT-01 valid address requests a reset link', async () => {
    // Arrange
    const h = createHarness({ scripts: ['auth.js'], authResponses: {
        resetPasswordForEmail: { data: {}, error: null }
    } });
    h.element('forgotEmail').value = 'ayu@example.com';

    // Act
    await h.element('forgotPasswordForm').emit('submit', preventableEvent());

    // Assert
    const request = h.supabase.calls.find(call => call.method === 'resetPasswordForEmail');
    assert.equal(request.payload.email, 'ayu@example.com');
    assert.equal(request.payload.options.redirectTo, 'http://localhost/index.html');
    assert.equal(h.element('forgotAlert').className, 'auth-alert success');
});

test('TC-FORGOT-02 empty email does not request a reset link', async () => {
    // Arrange
    const h = createHarness({ scripts: ['auth.js'] });

    // Act
    await h.element('forgotPasswordForm').emit('submit', preventableEvent());

    // Assert
    assert.match(h.element('forgotAlert').textContent, /enter your email/i);
    assert.equal(h.supabase.calls.some(call => call.method === 'resetPasswordForEmail'), false);
});

test('TC-CATALOG-01 search and category filter update visible product cards', async () => {
    // Arrange
    const cards = [
        new FakeElement('basic').setAttribute('data-name', 'CultureSquared Basic Black'),
        new FakeElement('fatigue').setAttribute('data-name', 'CultureSquared Fatigue Short Black')
    ];
    cards[0].setAttribute('data-category', "Men's BoardShorts");
    cards[1].setAttribute('data-category', "Men's Streetwear Shorts");
    const category = new FakeElement('boardshort-filter');
    category.setAttribute('data-category', "Men's BoardShorts");
    const h = createHarness({
        scripts: ['quantity.js', 'products.js'],
        queryMap: { '.filter-pill': [category], '#detailSizeOptions .size-pill': [] }
    });
    h.element('productGrid').cards = cards;
    h.element('productSearchInput').value = 'fatigue';

    // Act
    await h.element('productSearchInput').emit('input', { target: h.element('productSearchInput') });

    // Assert
    assert.equal(cards[0].style.display, 'none');
    assert.equal(cards[1].style.display, 'flex');
    assert.equal(h.element('noProductsFound').style.display, 'none');

    // Act: clear search and apply category.
    h.element('productSearchInput').value = '';
    await h.element('productSearchInput').emit('input', { target: h.element('productSearchInput') });
    await category.emit('click');

    // Assert
    assert.equal(cards[0].style.display, 'flex');
    assert.equal(cards[1].style.display, 'none');
});

test('TC-CATALOG-02 unmatched search shows empty state', async () => {
    // Arrange
    const cards = [new FakeElement('basic').setAttribute('data-name', 'Basic')];
    cards[0].setAttribute('data-category', "Men's BoardShorts");
    const h = createHarness({ scripts: ['quantity.js', 'products.js'] });
    h.element('productGrid').cards = cards;
    h.element('productSearchInput').value = 'no-such-product';

    // Act
    await h.element('productSearchInput').emit('input', { target: h.element('productSearchInput') });

    // Assert
    assert.equal(cards[0].style.display, 'none');
    assert.equal(h.element('noProductsFound').style.display, 'block');
});

test('TC-CATALOG-03 opening detail selects product and resets quantity', () => {
    // Arrange
    const h = createHarness({ scripts: ['quantity.js', 'products.js'] });
    h.element('detailQuantity').value = '4';

    // Act
    h.context.openProductDetailModal('prod-2');

    // Assert
    assert.equal(h.context.selectedProduct.id, 'prod-2');
    assert.equal(h.element('detailProductName').textContent, 'CultureSquared Fatigue Short Black');
    assert.equal(h.element('detailQuantity').value, 1);
    assert.equal(h.element('productDetailModal').classList.contains('active'), true);
});

test('TC-WA-01 WhatsApp order blocks missing size and opens a composed URL when selected', async () => {
    // Arrange
    const size = new FakeElement('size-m');
    size.setAttribute('data-size', 'M');
    const h = createHarness({
        scripts: ['quantity.js', 'products.js'],
        queryMap: { '#detailSizeOptions .size-pill': [size] }
    });
    h.context.openProductDetailModal('prod-1');

    // Act + Assert: missing size is rejected.
    await h.element('detailBuyWaBtn').emit('click');
    assert.equal(h.element('sizeErrorMsg').style.display, 'block');
    assert.equal(h.openedUrls.length, 0);

    // Act: choose M and order.
    await size.emit('click');
    h.element('detailQuantity').value = '2';
    await h.element('detailBuyWaBtn').emit('click');

    // Assert
    assert.equal(h.openedUrls.length, 1);
    assert.equal(h.openedUrls[0].target, '_blank');
    const opened = new URL(h.openedUrls[0].url);
    assert.equal(opened.hostname, 'wa.me');
    assert.match(decodeURIComponent(opened.searchParams.get('text')), /Size: M/);
    assert.match(decodeURIComponent(opened.searchParams.get('text')), /Jumlah: 2 pcs/);
});

test('TC-CART-01 adding an item and same-size item updates the existing quantity', async () => {
    // Arrange
    const h = createHarness({ scripts: ['cart.js'] });
    h.context.currentUser = { id: 'u-1' };
    h.context.appProducts = [{ id: 'prod-1', name: 'Basic', price: 85000 }];

    // Act
    await h.context.addToCart('prod-1', 'M', 2);
    await h.context.addToCart('prod-1', 'M', 1);

    // Assert
    assert.equal(h.context.userCart.length, 1);
    assert.equal(h.context.userCart[0].quantity, 3);
    assert.equal(h.context.userCart[0].size, 'M');
    assert.equal(h.supabase.calls.filter(call => call.table === 'cart' && call.method === 'insert').length, 1);
    assert.equal(h.supabase.calls.find(call => call.table === 'cart' && call.method === 'update').payload.quantity, 3);
});

test('TC-CART-02 unauthenticated add redirects to login and leaves cart unchanged', async () => {
    // Arrange
    const h = createHarness({ scripts: ['cart.js'] });
    let loginOpened = 0;
    h.context.openLoginModal = () => { loginOpened += 1; };

    // Act
    await h.context.addToCart('prod-1', 'M', 1);

    // Assert
    assert.equal(loginOpened, 1);
    assert.equal(h.context.userCart.length, 0);
});

test('TC-CART-03 totals include shipping below threshold and remove deletes the item', async () => {
    // Arrange
    const h = createHarness({ scripts: ['cart.js'] });
    h.context.currentUser = { id: 'u-1' };
    h.context.appProducts = [{ id: 'prod-1', price: 85000 }];
    h.context.userCart = [{ id: 'c1', product_id: 'prod-1', quantity: 2, size: 'M' }];

    // Act
    const totals = h.context.getCartTotals();
    await h.context.removeFromCart('c1');

    // Assert
    assert.deepEqual(JSON.parse(JSON.stringify(totals)), { subtotal: 170000, shippingFee: 20000, total: 190000 });
    assert.equal(h.context.userCart.length, 0);
    assert.equal(h.supabase.calls.some(call => call.table === 'cart' && call.method === 'delete'), true);
});

test('TC-CART-04 cart quantity buttons increment and remove at zero boundary', async () => {
    // Arrange
    const h = createHarness({ scripts: ['cart.js'] });
    h.context.currentUser = { id: 'u-1' };
    h.context.appProducts = [{ id: 'prod-1', price: 85000 }];
    h.context.userCart = [{ id: 'c1', product_id: 'prod-1', quantity: 1, size: 'M' }];
    const button = new FakeElement('increase');
    button.setAttribute('data-action', 'increase');
    button.setAttribute('data-id', 'c1');
    const handler = h.element('cartItemsList').listeners.click[0];

    // Act
    await handler({ target: { closest: () => button } });

    // Assert
    assert.equal(h.context.userCart[0].quantity, 2);
    assert.equal(h.supabase.calls.some(call => call.table === 'cart' && call.method === 'update'), true);

    // Arrange / Act: the existing row handler decreases quantity to zero.
    const decrease = new FakeElement('decrease');
    decrease.setAttribute('data-action', 'decrease');
    decrease.setAttribute('data-id', 'c1');
    await handler({ target: { closest: () => decrease } });
    assert.equal(h.context.userCart[0].quantity, 1);
    await handler({ target: { closest: () => decrease } });
    await Promise.resolve();

    // Assert
    assert.equal(h.context.userCart.length, 0);
    assert.equal(h.supabase.calls.some(call => call.table === 'cart' && call.method === 'delete'), true);
});

test('TC-CART-05 free shipping applies at the 500000 IDR threshold and to an empty cart', () => {
    // Arrange
    const h = createHarness({ scripts: ['cart.js'] });
    h.context.appProducts = [{ id: 'prod-1', price: 250000 }];
    h.context.userCart = [{ product_id: 'prod-1', quantity: 2 }];

    // Act
    const thresholdTotals = h.context.getCartTotals();
    h.context.userCart = [];
    const emptyTotals = h.context.getCartTotals();

    // Assert
    assert.deepEqual(JSON.parse(JSON.stringify(thresholdTotals)), { subtotal: 500000, shippingFee: 0, total: 500000 });
    assert.deepEqual(JSON.parse(JSON.stringify(emptyTotals)), { subtotal: 0, shippingFee: 0, total: 0 });
});

test('TC-WISHLIST-01 wishlist add is unique and removal persists', async () => {
    // Arrange
    const h = createHarness({ scripts: ['wishlist.js'] });
    h.context.currentUser = { id: 'u-1' };

    // Act
    await h.context.addToWishlist('prod-1');
    await h.context.addToWishlist('prod-1');
    await h.context.removeFromWishlist('prod-1');

    // Assert
    assert.equal(h.context.userWishlist.length, 0);
    assert.equal(h.supabase.calls.filter(call => call.table === 'wishlist' && call.method === 'insert').length, 1);
    assert.equal(h.supabase.calls.some(call => call.table === 'wishlist' && call.method === 'delete'), true);
});

test('TC-WISHLIST-02 unauthenticated wishlist add redirects to login', async () => {
    // Arrange
    const h = createHarness({ scripts: ['wishlist.js'] });
    let loginOpened = 0;
    h.context.openLoginModal = () => { loginOpened += 1; };

    // Act
    await h.context.addToWishlist('prod-1');

    // Assert
    assert.equal(loginOpened, 1);
    assert.equal(h.context.userWishlist.length, 0);
});

test('TC-CHECKOUT-01 incomplete delivery data blocks order creation', async () => {
    // Arrange
    const h = createHarness({ scripts: ['checkout.js'] });
    h.context.currentUser = { id: 'u-1' };
    h.context.userCart = [{ id: 'c1', product_id: 'prod-1', size: 'M', quantity: 1 }];
    h.context.getCartTotals = () => ({ subtotal: 85000, shippingFee: 20000, total: 105000 });

    // Act
    await h.element('checkoutForm').emit('submit', preventableEvent());

    // Assert
    assert.match(h.element('checkoutAlert').textContent, /fill in all delivery details/i);
    assert.equal(h.supabase.calls.some(call => call.table === 'orders' && call.method === 'insert'), false);
});

test('TC-CHECKOUT-02 valid checkout creates order, items, clears cart, and confirms', async () => {
    // Arrange
    const h = createHarness({ scripts: ['checkout.js'] });
    h.context.currentUser = { id: 'u-1' };
    h.context.appProducts = [{ id: 'prod-1', price: 85000 }];
    h.context.userCart = [{ id: 'c1', product_id: 'prod-1', size: 'M', quantity: 2 }];
    h.context.getCartTotals = () => ({ subtotal: 170000, shippingFee: 20000, total: 190000 });
    const formValues = {
        checkoutRecipientName: 'Ayu',
        checkoutPhone: '08123456789',
        checkoutAddress: 'Jl. Mawar 1',
        checkoutCity: 'Malang',
        checkoutPostalCode: '65100'
    };
    for (const [id, value] of Object.entries(formValues)) h.element(id).value = value;

    // Act
    await h.element('checkoutForm').emit('submit', preventableEvent());

    // Assert
    assert.equal(h.context.userOrders[0].id, 'db-order-1');
    assert.equal(h.context.userOrders[0].total, 190000);
    assert.equal(h.context.userOrders[0].items[0].quantity, 2);
    assert.equal(h.element('orderConfirmationModal').classList.contains('active'), true);
    assert.equal(h.element('confirmedOrderAddress').textContent, 'Ayu (08123456789) - Jl. Mawar 1, Malang, 65100');
    assert.equal(h.context.userCart.length, 0);
    assert.equal(h.supabase.calls.some(call => call.table === 'orders' && call.method === 'insert'), true);
    assert.equal(h.supabase.calls.some(call => call.table === 'order_items' && call.method === 'insert'), true);
});
