/**
 * Simulates what a built factory actually produces.
 *
 * The solver sizes every node for the exact demand. Once machine counts are
 * rounded, each node can make at most its capacity, and only as much as its
 * inputs deliver. Walking from raw materials to the targets:
 *   realized(node) = min(capacity, demand × min over inputs(allocated / needed))
 * A producer's realized output is shared among its consumers (and its targets)
 * in proportion to their demand. Raw materials are treated as unlimited.
 */
import { RATE_EPSILON } from "./game-constants";

export interface FlowNode {
    key: string;
    /** Rate the plan asks this node to produce */
    demand: number;
    /** Most the built machines can produce (Infinity for raw supply) */
    capacity: number;
    isRaw: boolean;
}

export interface FlowEdge {
    key: string;
    source: string;
    target: string;
    /** Rate the consumer needs from this source at full demand */
    demand: number;
    /**
     * A byproduct of the source (not its main output): its own stream, this many per main
     * output, shared only among the consumers of that byproduct
     */
    byproduct?: { item: string; perMain: number };
}

export interface FlowTarget {
    source: string;
    demand: number;
}

export interface FlowResult {
    /** Actual output per node (raw: what consumers actually draw) */
    realized: Map<string, number>;
    /** Nodes whose output is held back by an input (realized < capacity because of supply) */
    inputLimited: Set<string>;
    /** Actual rate moving along each edge (what the consumer draws) */
    edgeActual: Map<string, number>;
    /** Rate the producer offered each edge (Infinity for raw supply); below demand = under-supplied */
    edgeOffered: Map<string, number>;
    /** Delivered to each target, in the order given */
    delivered: number[];
}

export function simulateFlow(nodes: FlowNode[], edges: FlowEdge[], targets: FlowTarget[]): FlowResult {
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const incoming = new Map<string, FlowEdge[]>();
    const outgoingDemand = new Map<string, number>();

    // Demand on each output stream of a node: its main output, and each byproduct apart
    const stream = (e: FlowEdge) => (e.byproduct ? `${e.source}|${e.byproduct.item}` : e.source);
    const streamDemand = new Map<string, number>();
    edges.forEach((e) => {
        if (!incoming.has(e.target)) incoming.set(e.target, []);
        incoming.get(e.target)!.push(e);
        streamDemand.set(stream(e), (streamDemand.get(stream(e)) || 0) + e.demand);
        if (!e.byproduct) outgoingDemand.set(e.source, (outgoingDemand.get(e.source) || 0) + e.demand);
    });
    targets.forEach((t) => {
        outgoingDemand.set(t.source, (outgoingDemand.get(t.source) || 0) + t.demand);
        streamDemand.set(t.source, (streamDemand.get(t.source) || 0) + t.demand);
    });

    const realized = new Map<string, number>();
    const inputLimited = new Set<string>();
    const visiting = new Set<string>();
    // Edges that close a cycle are treated as fully supplied
    const backEdges = new Set<string>();

    const allocated = (e: FlowEdge): number => {
        const source = byKey.get(e.source);
        if (!source || source.isRaw || backEdges.has(e.key)) return Infinity;
        const total = streamDemand.get(stream(e)) || 0;
        const made = resolve(e.source) * (e.byproduct?.perMain ?? 1);
        return total > RATE_EPSILON ? made * (e.demand / total) : 0;
    };

    function resolve(key: string): number {
        const cached = realized.get(key);
        if (cached !== undefined) return cached;
        const node = byKey.get(key);
        if (!node) return 0;
        if (node.isRaw) return Infinity;

        visiting.add(key);
        let supplyFactor = Infinity;
        for (const e of incoming.get(key) ?? []) {
            if (visiting.has(e.source)) {
                backEdges.add(e.key);
                continue;
            }
            if (e.demand <= RATE_EPSILON) continue;
            supplyFactor = Math.min(supplyFactor, allocated(e) / e.demand);
        }
        visiting.delete(key);

        const potential = node.demand * supplyFactor;
        const value = Math.max(0, Math.min(node.capacity, potential));
        if (potential < node.capacity - RATE_EPSILON) inputLimited.add(key);
        realized.set(key, value);
        return value;
    }

    nodes.forEach((n) => resolve(n.key));

    const edgeOffered = new Map<string, number>(edges.map((e) => [e.key, allocated(e)]));

    // Consumers draw their inputs in proportion to what they actually make and pass on:
    // output nobody takes backs up and the machine waits (a rounded-up nursery doesn't eat
    // fertilizer for flax nobody uses)
    const outgoing = new Map<string, FlowEdge[]>();
    edges.forEach((e) => {
        if (!e.byproduct) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
    });
    const hasTarget = new Set(targets.map((t) => t.source));
    // How much of a node's main output is taken: all of it when it feeds a target or
    // nothing (end of the line), else what its consumers really draw
    const takenMemo = new Map<string, number>();
    const takenVisiting = new Set<string>();
    const takenOf = (key: string): number => {
        const made = realized.get(key) ?? 0;
        if (takenMemo.has(key)) return takenMemo.get(key)!;
        const outs = outgoing.get(key) ?? [];
        if (hasTarget.has(key) || outs.length === 0 || takenVisiting.has(key)) return made;
        takenVisiting.add(key);
        const drawn = outs.reduce((sum, e) => sum + draw(e), 0);
        takenVisiting.delete(key);
        const taken = Math.min(made, drawn);
        takenMemo.set(key, taken);
        return taken;
    };
    function draw(e: FlowEdge): number {
        const consumer = byKey.get(e.target);
        if (!consumer || consumer.demand <= RATE_EPSILON) return e.demand;
        return e.demand * (takenOf(e.target) / consumer.demand);
    }
    const edgeActual = new Map<string, number>();
    edges.forEach((e) => edgeActual.set(e.key, draw(e)));

    // Raw supply shows what was actually drawn
    nodes.forEach((n) => {
        if (!n.isRaw) return;
        const drawn = edges.filter((e) => e.source === n.key).reduce((sum, e) => sum + (edgeActual.get(e.key) || 0), 0);
        realized.set(n.key, drawn);
    });

    // Targets receive whatever the producer makes beyond what other nodes draw
    const drawnFrom = new Map<string, number>();
    edges.forEach((e) => drawnFrom.set(e.source, (drawnFrom.get(e.source) || 0) + (edgeActual.get(e.key) || 0)));
    const remaining = new Map<string, number>();
    const delivered = targets.map((t) => {
        if (!remaining.has(t.source)) {
            remaining.set(t.source, Math.max(0, (realized.get(t.source) || 0) - (drawnFrom.get(t.source) || 0)));
        }
        const sameSource = targets.filter((x) => x.source === t.source);
        const share = sameSource.reduce((s, x) => s + x.demand, 0);
        return share > RATE_EPSILON ? remaining.get(t.source)! * (t.demand / share) : 0;
    });

    return { realized, inputLimited, edgeActual, edgeOffered, delivered };
}
