/** A checkout total, kept deliberately small. */
export interface LineItem {
    /** Stock-keeping unit. */
    sku: string;
    /** How many were bought. */
    quantity: number;
    /** Price of one unit, in minor units. */
    unitPrice: number;
}

/** Sum the line items into a total in minor units. */
export function totalOf(items: readonly LineItem[]): number {
    return items.reduce(
        (total, item) => total + item.quantity * item.unitPrice,
        0,
    );
}
