/*
 * Quantity controls for the product detail modal.
 * Kept dependency-injected so the boundary behavior can be unit tested.
 */
globalThis.QuantityControls = (function () {
    function createQuantityControls(input, getStock) {
        function decrement() {
            const current = parseInt(input.value, 10) || 1;
            if (current > 1) {
                input.value = current - 1;
            }
        }

        function increment() {
            const current = parseInt(input.value, 10) || 1;
            const max = getStock() || 50;
            if (current < max) {
                input.value = current + 1;
            }
        }

        return { decrement, increment };
    }

    return { createQuantityControls };
})();
