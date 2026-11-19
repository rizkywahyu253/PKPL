const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInThisContext } = require('node:vm');
const path = require('node:path');

const sourcePath = path.join(__dirname, '../quantity.js');
runInThisContext(readFileSync(sourcePath, 'utf8'), { filename: sourcePath });
const { createQuantityControls } = globalThis.QuantityControls;

// Fake: mimics the string-valued DOM input without a browser.
class FakeQuantityInput {
    constructor(value) { this._value = String(value); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
}

// Spy: returns configured stock and records dependency calls.
function createStockSpy(stock) {
    const spy = () => { spy.calls += 1; return stock; };
    spy.calls = 0;
    return spy;
}

const scenarios = [
    { name: 'decrement lowers a quantity above one', action: 'decrement', value: 2, stock: 50, expected: '1' },
    { name: 'decrement keeps the minimum at one', action: 'decrement', value: 1, stock: 50, expected: '1' },
    { name: 'decrement preserves invalid input at the minimum fallback', action: 'decrement', value: 'invalid', stock: 50, expected: 'invalid' },
    { name: 'increment raises quantity below stock', action: 'increment', value: 49, stock: 50, expected: '50', stockCalls: 1 },
    { name: 'increment does not exceed stock', action: 'increment', value: 50, stock: 50, expected: '50', stockCalls: 1 },
    { name: 'increment uses one as invalid quantity fallback', action: 'increment', value: 'invalid', stock: 50, expected: '2', stockCalls: 1 },
    { name: 'increment uses default maximum when stock is absent', action: 'increment', value: 49, stock: 0, expected: '50', stockCalls: 1 },
];

for (const scenario of scenarios) {
    test(scenario.name, () => {
        // Arrange
        const input = new FakeQuantityInput(scenario.value);
        const stockSpy = createStockSpy(scenario.stock);
        const controls = createQuantityControls(input, stockSpy);

        // Act
        controls[scenario.action]();

        // Assert
        assert.equal(input.value, scenario.expected);
        assert.equal(stockSpy.calls, scenario.stockCalls || 0);
    });
}
