// @wudao-org/slack — the Slack interface for wudao-harness (M60). Public surface.
export {
  DEFAULT_SLACK_SETTINGS,
  parseSlackSettings,
  loadSlackSettings,
  resolveToken,
  type SlackSettings,
} from "./settings.js";
export { threadKey, threadMapPath, parseThreadMapBody, loadThreadMap, type SlackThreadMap } from "./threads.js";
export { mdToMrkdown, truncateSummary, truncateThreadContext } from "./mrkdown.js";
export {
  parseInboundCommand,
  INBOUND_COMMAND_NAMES,
  type InboundChannel,
  type InboundCommand,
  type InboundMessage,
  type InboundTarget,
  type InboundChannelHandlers,
  type ParsedInboundCommand,
  type AskPrompt,
  type AskChoice,
  type AskResolution,
} from "./channel.js";
export {
  ASK_ACTION_ALLOW,
  ASK_ACTION_ALWAYS,
  ASK_ACTION_DENY,
  VIEW_SESSION_ACTION,
  askPromptText,
  buildAskBlocks,
  parseAskAction,
  askSettledText,
  type KnownBlock,
} from "./ask-blocks.js";
export { createChannelAskRelay, type ChannelAskRelay, type ChannelAskRelayArgs } from "./relay.js";
export {
  allowlistsPass,
  createChannelSessionManager,
  SUMMARY_MAX_CHARS,
  type ChannelSessionManager,
  type ChannelManagerOptions,
  type ManagedDriver,
  type ManagedDriverStatus,
  type ManagedHistoryEntry,
  type ManagedSession,
  type CreateSessionArgs,
} from "./manager.js";
export {
  createSlackChannel,
  normalizeSlackEvent,
  stripMentions,
  isMentioned,
  formatThreadReplies,
  threadContextFromReplies,
  type SlackChannelOptions,
  type SlackEventShape,
  type SlackAppLike,
  type SlackClientLike,
  type SlackMessageArgs,
  type SlackCommandArgs,
  type SlackActionArgs,
} from "./slack-channel.js";
export { disableInteractiveTools, createSlackRefusalAskUserTool, INTERACTIVE_TOOL_NAMES, SLACK_ASK_USER_REFUSAL } from "./tools.js";
export { runSlackDoctor, formatSlackDoctorReport, tokenClass, type SlackDoctorCheck, type SlackDoctorInput, type DoctorNetworkProbe } from "./doctor.js";
export { runSlack, runSlackDaemon, slackMain, slackDoctorMain, newSlackSessionId, type RunSlackProps, type SlackRuntime } from "./main.js";
