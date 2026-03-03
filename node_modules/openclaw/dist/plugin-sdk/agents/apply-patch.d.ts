import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
export type ApplyPatchSummary = {
    added: string[];
    modified: string[];
    deleted: string[];
};
export type ApplyPatchResult = {
    summary: ApplyPatchSummary;
    text: string;
};
export type ApplyPatchToolDetails = {
    summary: ApplyPatchSummary;
};
type SandboxApplyPatchConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
type ApplyPatchOptions = {
    cwd: string;
    sandbox?: SandboxApplyPatchConfig;
    signal?: AbortSignal;
};
declare const applyPatchSchema: import("@sinclair/typebox").TObject<{
    input: import("@sinclair/typebox").TString;
}>;
export declare function createApplyPatchTool(options?: {
    cwd?: string;
    sandbox?: SandboxApplyPatchConfig;
}): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails>;
export declare function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult>;
export {};
