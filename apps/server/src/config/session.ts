import { getBackendConfig } from './backend.js'

// ─── 前端缓存 ────────────────────────────────────────────────
// 是否把 session 产物缓存到 localStorage
export const getSessionLocalStorageEnabled = () =>
  getBackendConfig().session.localStorageEnabled

// ─── 超时配置 ────────────────────────────────────────────────
// 视觉文字识别超时（毫秒）
export const getVisionTextTimeoutMs = () =>
  getBackendConfig().session.visionTextTimeoutMs

// ─── Session 消息格式化 ──────────────────────────────────────
// agent 消息采样字符数
export const getAgentMessageSampleChars = () =>
  getBackendConfig().session.agentMessageSampleChars
// agent 推理消息截断长度
export const getAgentReasoningMessageChars = () =>
  getBackendConfig().session.agentReasoningMessageChars
// archive 命令输出截断限制
export const getArchiveCommandOutputMaxChars = () =>
  getBackendConfig().session.archiveCommandOutputMaxChars
