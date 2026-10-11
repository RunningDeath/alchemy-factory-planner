/**
 * Raw materials bought inside the module: purchasing portals next to the machines that
 * use them, all paid through one coin belt that comes in at the module's front edge.
 *
 * - A portal sells one item (the blueprint stores it as the portal's SupplyName), so
 *   each bought item gets its own portals: one, or more only when one belt can't carry
 *   the rate. The game data has no portal speed; a portal is assumed to deliver up to
 *   one belt of its item.
 * - Prices are in copper (items.json base_cost per item; 1 silver = 1000 copper,
 *   1 gold = 100 silver). The module is paid in the smallest coin whose count still
 *   fits on one belt, so a single money input covers every portal.
 */
import { getItem } from "../item-utils";
import type { ModuleStep } from "./generator";

export const PURCHASING_PORTAL = "purchasing-portal";

/** Coins by what they are worth in copper, smallest first */
const COINS: [string, number][] = [
    ["Copper Coin", 1],
    ["Silver Coin", 1000],
    ["Gold Coin", 100000],
];

/** Copper per item at the purchasing portal, or null when it doesn't sell the item */
export function purchasePrice(itemName: string): number | null {
    const item = getItem(itemName);
    return item?.purchasable && item.base_cost ? item.base_cost : null;
}

/** What the module's steps take in that none of them makes, per item (belt inputs and stove fuel) */
function rawDemand(steps: ModuleStep[]): Map<string, number> {
    const made = new Set(steps.flatMap((st) => st.outputs.map((o) => o.itemName)));
    const demand = new Map<string, number>();
    const add = (item: string, rate: number) => !made.has(item) && rate > 0 && demand.set(item, (demand.get(item) ?? 0) + rate);
    for (const st of steps) {
        // Lanes feed every built machine, so a rounded-up machine counts in full
        const count = Math.ceil(st.machines - 1e-9);
        if (count <= 0) continue;
        st.inputs.forEach((f) => add(f.itemName, f.perMachineRate * count));
        if (st.heating?.kind === "stove") add(st.heating.fuelItem, st.heating.fuelRate);
    }
    return demand;
}

/** The coin that pays `copperPerMinute` on one belt (the biggest coin when none does) */
export function coinFor(copperPerMinute: number, beltSpeed: number): { itemName: string; value: number } {
    const [itemName, value] = COINS.find(([, v]) => copperPerMinute / v <= beltSpeed + 1e-6) ?? COINS[COINS.length - 1];
    return { itemName, value };
}

/**
 * Portal steps for every purchasable raw material of the module: as few portals as
 * possible (one per item unless the rate needs more than one belt), each taking coins.
 */
export function purchaseSteps(steps: ModuleStep[], beltSpeed: number): ModuleStep[] {
    const bought = [...rawDemand(steps)]
        .map(([itemName, rate]) => ({ itemName, rate, price: purchasePrice(itemName) }))
        .filter((b): b is { itemName: string; rate: number; price: number } => b.price !== null);
    if (bought.length === 0) return [];
    const coin = coinFor(
        bought.reduce((sum, b) => sum + b.rate * b.price, 0),
        beltSpeed,
    );
    return bought.map(({ itemName, rate, price }) => {
        const portals = Math.max(1, Math.ceil(rate / beltSpeed - 1e-9));
        return {
            nodeKey: `buy-${itemName}`,
            itemName,
            deviceId: PURCHASING_PORTAL,
            machines: portals,
            inputs: [{ itemName: coin.itemName, perMachineRate: (rate * price) / coin.value / portals }],
            outputs: [{ itemName, perMachineRate: rate / portals }],
            fluidInputs: [],
        };
    });
}
