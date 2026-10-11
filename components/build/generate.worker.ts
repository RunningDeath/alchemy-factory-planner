/// <reference lib="webworker" />
/**
 * Generates a module off the main thread, so the page stays responsive and shows
 * progress; terminating the worker aborts the generation.
 */
import { generateModule, type ModuleOptions, type ModuleStep } from "../../engine/build/generator";

export interface GenerateRequest {
    steps: ModuleStep[];
    options: Omit<ModuleOptions, "onProgress">;
}

export type GenerateMessage =
    | { type: "progress"; fraction: number; label: string }
    | { type: "done"; module: ReturnType<typeof generateModule> }
    | { type: "error"; message: string };

const post = (message: GenerateMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<GenerateRequest>) => {
    let lastPost = 0;
    let lastLabel = "";
    try {
        const generated = generateModule(event.data.steps, {
            ...event.data.options,
            onProgress: (fraction, label) => {
                if (label) lastLabel = label;
                // A few updates a second are plenty
                const now = Date.now();
                if (now - lastPost < 80 && fraction < 1) return;
                lastPost = now;
                post({ type: "progress", fraction, label: lastLabel });
            },
        });
        post({ type: "done", module: generated });
    } catch (e) {
        post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
};
