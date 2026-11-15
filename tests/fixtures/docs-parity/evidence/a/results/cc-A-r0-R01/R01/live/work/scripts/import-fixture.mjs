import { readFileSync } from "node:fs";
import { parseCsv } from "../src/csv.ts";

try {
    const text = readFileSync(
        new URL("../fixtures/orders.csv", import.meta.url),
        "utf8",
    );
    console.log(`${parseCsv(text).length} orders`);
} catch (error) {
    console.error(String(error));
    process.exit(1);
}
