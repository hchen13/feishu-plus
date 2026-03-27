import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/feishu";
import { registerFeishuChatTools } from "./src/chat.js";
import { feishuPlugin } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { consumeTurnOverride } from "./src/quota.js";
import { registerFeishuDocTools } from "./src/docx.js";
import { registerFeishuWikiTools } from "./src/wiki.js";
import { registerFeishuDriveTools } from "./src/drive.js";
import { registerFeishuPermTools } from "./src/perm.js";
import { registerFeishuBitableTools } from "./src/bitable.js";
import { registerFeishuTaskTools } from "./src/task.js";
import { registerFeishuSheetTools } from "./src/sheet.js";
import { registerFeishuIdTools } from "./src/id-index.js";
import { registerFeishuIdAdminTools } from "./src/id-index-admin.js";

export { monitorFeishuProvider } from "./src/monitor.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu, clearProbeCache } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";
export { feishuPlugin } from "./src/channel.js";

const plugin = {
  id: "feishu-plus",
  name: "Feishu",
  description: "Feishu channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });

    // Apply per-turn model downgrade for quota-restricted users.
    // bot.ts sets a TurnOverride in the Map just before dispatch and clears it
    // in a finally block, so this hook only fires when a downgrade is needed.
    api.on("before_model_resolve", (_event, ctx) => {
      if (!ctx.sessionKey) return;
      const override = consumeTurnOverride(ctx.sessionKey);
      if (!override) return;
      const slashIdx = override.model.indexOf("/");
      const providerOverride = slashIdx !== -1 ? override.model.slice(0, slashIdx) : undefined;
      const modelOverride = slashIdx !== -1 ? override.model.slice(slashIdx + 1) : override.model;
      // NOTE: override.thinking is computed and stored but the SDK's
      // before_model_resolve result has no thinkingOverride field yet.
      // When SDK support is added, pass override.thinking here.
      return { modelOverride, providerOverride };
    });
    registerFeishuDocTools(api);
    registerFeishuChatTools(api);
    registerFeishuWikiTools(api);
    registerFeishuDriveTools(api);
    registerFeishuPermTools(api);
    registerFeishuBitableTools(api);
    registerFeishuTaskTools(api);
    registerFeishuSheetTools(api);
    registerFeishuIdTools(api);
    registerFeishuIdAdminTools(api);
  },
};

export default plugin;
