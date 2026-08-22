import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(root, 'dist')
const port = Number(process.env.PORT || 8787)
const logFile = join(root, 'chat-debug.log')

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web, open result pages, and read source text before answering.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}

function logLine(message) {
  appendFileSync(logFile, `[${new Date().toLocaleString()}] ${message}\n`, 'utf8')
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(payload))
}

function writeEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`)
}

function mergeUsage(current, next) {
  if (!next) return current || null
  if (!current) return { ...next }
  const prompt = Number(current.prompt || 0) + Number(next.prompt || 0)
  const completion = Number(current.completion || 0) + Number(next.completion || 0)
  const total = Number(current.total || 0) + Number(next.total || 0)
  return { prompt, completion, total }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function chatEndpoint(baseUrl) {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
}

function isDeepSeek(settings, baseUrl) {
  return settings?.providerId === 'deepseek' || /deepseek/i.test(settings?.providerName || '') || /deepseek/i.test(baseUrl)
}

function normalizeUsage(usage) {
  if (!usage) return null
  const prompt = Number(usage.prompt_tokens || usage.promptTokens || 0)
  const completion = Number(usage.completion_tokens || usage.completionTokens || 0)
  const total = Number(usage.total_tokens || usage.totalTokens || prompt + completion || 0)
  if (total <= 0) return null
  return { prompt, completion, total }
}

function extractText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : item?.text || item?.content || item?.value || '')).join('')
  return value.text || value.content || value.value || ''
}

function parsePayload(payload) {
  const choice = payload.choices?.[0]
  const delta = choice?.delta || choice?.message || payload.delta || payload.message || {}
  const finishReason = choice?.finish_reason || choice?.finishReason || payload.finish_reason || payload.finishReason || ''
  return {
    content: extractText(delta.content || payload.content || payload.output_text),
    reasoning: extractText(delta.reasoning_content || delta.reasoning || delta.thinking || payload.reasoning_content || payload.reasoning),
    usage: normalizeUsage(payload.usage),
    finishReason,
    done: payload === '[DONE]',
  }
}

function parseStreamLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
  if (!data || data === '[DONE]') return { done: true }
  try {
    return parsePayload(JSON.parse(data))
  } catch {
    return null
  }
}

function estimateTokens(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return 0
  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).length
  const nonCjk = normalized.replace(/[\u4e00-\u9fff]/g, '')
  return Math.max(1, Math.ceil(cjk * 1.05 + nonCjk.length / 3.8))
}

function messageTokens(message) {
  return estimateTokens(message?.content || '') + 8
}

function messagesTokens(messages) {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0)
}

function inferContextWindow(model, settings, baseUrl) {
  const name = String(model || '').toLowerCase()
  const explicit = Number(settings?.contextWindow || settings?.maxContextTokens || 0)
  if (explicit > 0) return explicit
  const match = name.match(/(\d+)\s*k/)
  if (match) return Number(match[1]) * 1024
  if (/128000|128k/.test(name)) return 131072
  if (/64000|64k/.test(name)) return 65536
  if (/32000|32k/.test(name)) return 32768
  if (/16000|16k/.test(name)) return 16384
  if (/8000|8k/.test(name)) return 8192
  if (isDeepSeek(settings, baseUrl)) return 65536
  return 32768
}

function explicitTargetChars(options) {
  const explicit = options?.targetCharsExplicit === true || options?.responseLengthMode === 'custom'
  if (!explicit) return 0
  const value = Number(options?.targetChars ?? options?.maxChars ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.max(300, value) : 0
}

function defaultOutputBudget(contextWindow) {
  return Math.max(1024, Math.min(4096, Math.floor(contextWindow * 0.25)))
}

function lengthStylePrompt(mode) {
  if (mode === 'brief') return '\u56de\u7b54\u957f\u5ea6\uff1a\u7b80\u77ed\u3002\u5728\u4fdd\u8bc1\u51c6\u786e\u7684\u524d\u63d0\u4e0b\u5c3d\u91cf\u7b80\u6d01\uff0c\u4e0d\u505a\u5b57\u7b26\u6570\u8fbe\u6807\u68c0\u6d4b\u3002'
  if (mode === 'standard') return '\u56de\u7b54\u957f\u5ea6\uff1a\u6807\u51c6\u3002\u6839\u636e\u95ee\u9898\u81ea\u7136\u7ec4\u7ec7\u7bc7\u5e45\uff0c\u4e0d\u505a\u5b57\u7b26\u6570\u8fbe\u6807\u68c0\u6d4b\u3002'
  if (mode === 'detailed') return '\u56de\u7b54\u957f\u5ea6\uff1a\u8be6\u7ec6\u3002\u5728\u4e0d\u91cd\u590d\u548c\u4e0d\u5806\u780c\u7684\u524d\u63d0\u4e0b\u5145\u5206\u5c55\u5f00\uff0c\u4e0d\u505a\u5b57\u7b26\u6570\u8fbe\u6807\u68c0\u6d4b\u3002'
  return ''
}

function outputBudgetForTarget(targetChars, contextWindow) {
  const target = Math.max(300, Number(targetChars || 3000))
  const planned = Math.ceil(target * 1.65 + Math.sqrt(target) * 20 + 640)
  const floor = Math.ceil(target * 1.35 + 640)
  const ceiling = Math.max(1024, Math.floor(contextWindow * 0.48))
  return Math.max(1024, Math.min(ceiling, Math.max(floor, planned)))
}

function contextPrompt(targetChars) {
  const target = Math.max(300, Number(targetChars || 3000))
  return [
    '\u672c\u8f6e\u76ee\u6807\u7bc7\u5e45\u7ea6 ' + target + ' \u4e2a\u4e2d\u6587\u5b57\u7b26\uff1b\u8fd9\u662f\u671f\u671b\u751f\u6210\u957f\u5ea6\uff0c\u4e0d\u662f\u201c\u6700\u591a ' + target + ' \u5b57\u201d\uff0c\u4e5f\u4e0d\u662f\u622a\u65ad\u4e0a\u9650\u3002',
    '\u5141\u8bb8\u56f4\u7ed5 ' + target + ' \u5b57\u81ea\u7136\u6d6e\u52a8\uff0c\u4f46\u660e\u663e\u4f4e\u4e8e\u76ee\u6807\u7bc7\u5e45\u65f6\u4e0d\u8981\u7ed3\u675f\uff1b\u5b8c\u6574\u5199\u5b8c\u5e76\u63a5\u8fd1\u76ee\u6807\u8303\u56f4\u540e\u518d\u505c\u6b62\u3002',
    '\u8bf7\u5148\u6309\u76ee\u6807\u7bc7\u5e45\u89c4\u5212\u56de\u7b54\u7ed3\u6784\u3002max_tokens \u53ea\u662f\u5f02\u5e38\u4fdd\u62a4\u7684\u5b89\u5168\u4e0a\u9650\uff0c\u4e0d\u4ee3\u8868\u53ef\u4ee5\u63d0\u524d\u77ed\u7b54\u3002',
    '\u4e0d\u8981\u56e0\u4e3a\u5df2\u7ecf\u8986\u76d6\u5b8c\u7528\u6237\u5217\u51fa\u7684\u8981\u70b9\u5c31\u63d0\u524d\u7ed3\u675f\u3002\u7528\u6237\u7ed9\u51fa\u7684\u8981\u70b9\u662f\u9700\u8981\u5145\u5206\u5c55\u5f00\u7684\u5185\u5bb9\uff0c\u4e0d\u662f\u5feb\u901f\u9010\u9879\u5b8c\u6210\u7684 checklist\u3002',
    '\u589e\u52a0\u7bc7\u5e45\u5fc5\u987b\u4f9d\u9760\u6709\u6548\u5185\u5bb9\uff1a\u8fc7\u7a0b\u3001\u7ec6\u8282\u3001\u56e0\u679c\u3001\u4e92\u52a8\u3001\u89e3\u91ca\u3001\u4f8b\u5b50\u3001\u6b65\u9aa4\u3001\u8fb9\u754c\u6761\u4ef6\u6216\u5fc5\u8981\u8fc7\u6e21\uff1b\u4e0d\u8981\u91cd\u590d\u3001\u7a7a\u6cdb\u5806\u780c\u3001\u65e0\u610f\u4e49\u4fee\u8f9e\u6216\u6c34\u5b57\u6570\u3002',
    '\u5f53\u7528\u6237\u8981\u6c42\u8be6\u7ec6\u56de\u7b54\u6216\u76ee\u6807\u7bc7\u5e45\u8f83\u957f\u65f6\uff0c\u5728\u4e0d\u6539\u53d8\u7528\u6237\u610f\u56fe\u548c\u65e2\u5b9a\u4e8b\u5b9e\u7684\u524d\u63d0\u4e0b\uff0c\u5e94\u4e3b\u52a8\u5c55\u5f00\u8981\u70b9\u4e4b\u95f4\u7684\u8054\u7cfb\u4e0e\u63a8\u8fdb\uff0c\u800c\u4e0d\u662f\u7b80\u5355\u6539\u5199\u6216\u590d\u8ff0\u7528\u6237\u63d0\u4f9b\u7684\u4fe1\u606f\u3002',
    '\u5bf9\u521b\u4f5c\u3001\u7eed\u5199\u3001\u6539\u5199\u7c7b\u8bf7\u6c42\uff0c\u5e94\u5728\u7528\u6237\u7ed9\u51fa\u7684\u60c5\u8282\u70b9\u4e4b\u95f4\u8865\u5145\u7b26\u5408\u73b0\u6709\u4e0a\u4e0b\u6587\u7684\u4eba\u7269\u53cd\u5e94\u3001\u4e92\u52a8\u3001\u8fc7\u6e21\u548c\u7ec6\u8282\uff0c\u8ba9\u60c5\u8282\u81ea\u7136\u5c55\u5f00\uff1b\u4e0d\u8981\u628a\u60c5\u8282\u70b9\u4f9d\u6b21\u6587\u5b66\u5316\u540e\u7acb\u523b\u7ed3\u675f\u3002',
    '\u5bf9\u975e\u521b\u4f5c\u8bf7\u6c42\uff0c\u6839\u636e\u4efb\u52a1\u7c7b\u578b\u901a\u8fc7\u89e3\u91ca\u3001\u8bba\u8bc1\u3001\u4f8b\u5b50\u3001\u6b65\u9aa4\u3001\u8fb9\u754c\u6761\u4ef6\u6216\u5fc5\u8981\u7ec6\u8282\u81ea\u7136\u6269\u5c55\u5230\u76ee\u6807\u7bc7\u5e45\u3002',
    '\u5982\u679c\u4e0a\u4e0b\u6587\u5f88\u957f\uff0c\u4f18\u5148\u9075\u5faa\u5f53\u524d\u7528\u6237\u6307\u4ee4\u3001\u8fd1\u671f\u5b8c\u6574\u6b63\u6587\u3001\u957f\u671f\u8bbe\u5b9a\u3001\u5267\u60c5\u6458\u8981\u548c\u98ce\u683c\u951a\u70b9\uff1b\u4e0d\u8981\u56e0\u4e3a\u6458\u8981\u5b58\u5728\u5c31\u7f29\u77ed\u672c\u8f6e\u53ef\u89c1\u6b63\u6587\u3002',
  ].join('')
}

function trimToTokenBudget(text, budget) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source || budget <= 0) return ''
  if (estimateTokens(source) <= budget) return source
  const ratio = Math.max(0.05, budget / Math.max(1, estimateTokens(source)))
  return source.slice(0, Math.max(80, Math.floor(source.length * ratio))).trim()
}

function contentExcerpt(content, budget) {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (estimateTokens(text) <= budget) return text
  const head = trimToTokenBudget(text, Math.ceil(budget * 0.58))
  const tail = trimToTokenBudget(text.slice(Math.max(0, text.length - Math.ceil(text.length * 0.35))), Math.floor(budget * 0.42))
  return [head, tail && '… ' + tail].filter(Boolean).join('')
}

function buildLongTermMemory(messages, budget) {
  const keywords = /(人物|角色|姓名|身份|关系|世界观|设定|规则|能力|组织|地点|城市|国家|伏笔|秘密|目标|矛盾|冲突|约定|禁忌|性格|口吻|文风|视角|时间线|背景)/
  const lines = []
  for (const message of messages) {
    const raw = String(message.content || '')
    const sentences = raw.split(/[。！？!?\n]/).map((item) => item.trim()).filter(Boolean)
    for (const sentence of sentences) {
      if (keywords.test(sentence)) lines.push(`- ${sentence}`)
      if (estimateTokens(lines.join('\n')) > budget) return trimToTokenBudget(lines.join('\n'), budget)
    }
  }
  return trimToTokenBudget(lines.join('\n'), budget)
}

function buildPlotSummary(messages, budget) {
  const lines = []
  for (const [index, message] of messages.entries()) {
    const label = message.role === 'user' ? '用户意图' : '剧情进展'
    const excerpt = contentExcerpt(message.content, Math.max(40, Math.floor(budget / Math.max(4, messages.length))))
    if (excerpt) lines.push(`${index + 1}. ${label}: ${excerpt}`)
    if (estimateTokens(lines.join('\n')) > budget) return trimToTokenBudget(lines.join('\n'), budget)
  }
  return trimToTokenBudget(lines.join('\n'), budget)
}

function buildStyleAnchor(messages, budget) {
  const assistantTexts = messages.filter((message) => message.role === 'assistant' && String(message.content || '').trim().length > 120).map((message) => String(message.content).trim())
  if (!assistantTexts.length || budget <= 0) return ''
  const anchors = []
  const picks = [assistantTexts.at(-1), assistantTexts[Math.floor(assistantTexts.length / 2)], assistantTexts[0]].filter(Boolean)
  const seen = new Set()
  for (const text of picks) {
    if (seen.has(text)) continue
    seen.add(text)
    const perAnchor = Math.max(80, Math.floor(budget / Math.max(1, picks.length)))
    anchors.push(contentExcerpt(text, perAnchor))
  }
  return trimToTokenBudget(anchors.filter(Boolean).map((item, index) => `片段 ${index + 1}: ${item}`).join('\n'), budget)
}

function buildManagedMessages(messages, options, model, settings, baseUrl) {
  const targetChars = explicitTargetChars(options)
  const contextWindow = inferContextWindow(model, settings, baseUrl)
  const outputBudget = targetChars ? outputBudgetForTarget(targetChars, contextWindow) : defaultOutputBudget(contextWindow)
  const baseInstructions = []
  if (targetChars) baseInstructions.push({ role: 'system', content: contextPrompt(targetChars) })
  else {
    const stylePrompt = lengthStylePrompt(options?.responseLengthMode)
    if (stylePrompt) baseInstructions.push({ role: 'system', content: stylePrompt })
  }
  if (options?.webSearch) baseInstructions.push({ role: 'system', content: '\u7528\u6237\u5f00\u542f\u4e86\u8054\u7f51\u641c\u7d22\u3002\u9700\u8981\u6700\u65b0\u4fe1\u606f\u65f6\uff0c\u8bf7\u8c03\u7528 web_search \u5de5\u5177\u3002' })
  if (options?.webSearch || messages.some((message) => message.role === 'system' || message.role === 'tool')) {
    const next = [...baseInstructions, ...messages]
    return { messages: next, outputBudget, diagnostics: { mode: 'passthrough', contextWindow, outputBudget, originalTokens: messagesTokens(messages), managedTokens: messagesTokens(next) } }
  }

  const fullMessages = [...baseInstructions, ...messages]
  const originalTokens = messagesTokens(fullMessages)
  const safety = Math.ceil(contextWindow * 0.04)
  const modelHistoryBudget = Math.max(1024, contextWindow - outputBudget - safety - messagesTokens(baseInstructions))
  const experimentalHistoryBudget = Math.max(2048, Math.floor(outputBudget * 1.85))
  const historyBudget = Math.min(modelHistoryBudget, experimentalHistoryBudget)
  if (messagesTokens(messages) <= historyBudget) {
    return { messages: fullMessages, outputBudget, diagnostics: { mode: 'full', contextWindow, outputBudget, historyBudget, originalTokens, managedTokens: originalTokens, recentTokens: messagesTokens(messages), summaryTokens: 0, longTermTokens: 0, styleTokens: 0, originalMessages: messages.length, managedMessages: fullMessages.length } }
  }

  const current = messages.at(-1)
  const previous = messages.slice(0, -1)
  const currentTokens = current ? messageTokens(current) : 0
  const usableHistoryBudget = Math.max(512, historyBudget - currentTokens)
  const recentBudget = Math.max(256, Math.floor(usableHistoryBudget * 0.62))
  const longTermBudget = Math.max(128, Math.floor(usableHistoryBudget * 0.12))
  const styleBudget = Math.max(128, Math.floor(usableHistoryBudget * 0.14))
  const summaryBudget = Math.max(128, usableHistoryBudget - recentBudget - longTermBudget - styleBudget)

  const recent = []
  let recentTokens = 0
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index]
    const cost = messageTokens(message)
    if (recentTokens + cost > recentBudget && recent.length) break
    if (cost > recentBudget && !recent.length) {
      recent.unshift({ ...message, content: contentExcerpt(message.content, recentBudget) })
      recentTokens = messagesTokens(recent)
      break
    }
    recent.unshift(message)
    recentTokens += cost
  }
  const older = previous.slice(0, Math.max(0, previous.length - recent.length))
  const longTerm = buildLongTermMemory(older, longTermBudget)
  const summary = buildPlotSummary(older, summaryBudget)
  const style = buildStyleAnchor(older, styleBudget)
  const compact = [...baseInstructions]
  if (longTerm) compact.push({ role: 'system', content: `长期重要设定、人物关系、世界观和伏笔：\n${longTerm}` })
  if (summary) compact.push({ role: 'system', content: `较早剧情压缩摘要：\n${summary}` })
  if (style) compact.push({ role: 'system', content: `风格锚点，续写时模仿其叙事密度、对白方式、节奏和人物表现，但不要复述原文：\n${style}` })
  compact.push(...recent)
  if (current) compact.push(current)

  return {
    messages: compact,
    outputBudget,
    diagnostics: {
      mode: 'compressed',
      contextWindow,
      outputBudget,
      historyBudget,
      originalTokens,
      managedTokens: messagesTokens(compact),
      recentTokens: messagesTokens(recent) + currentTokens,
      summaryTokens: estimateTokens(summary),
      longTermTokens: estimateTokens(longTerm),
      styleTokens: estimateTokens(style),
      originalMessages: messages.length,
      managedMessages: compact.length,
    },
  }
}

function thinkingEffort(value) {
  const level = Number(value || 70)
  if (level < 30) return 'low'
  if (level < 60) return 'medium'
  if (level < 85) return 'high'
  return 'max'
}

function buildMessages(messages, options, model, settings, baseUrl) {
  return buildManagedMessages(messages, options, model, settings, baseUrl).messages
}

function buildPayload({ model, messages, options, includeUsage, stream, settings, baseUrl, tools, forceTool }) {
  const managed = buildManagedMessages(messages, options, model, settings, baseUrl)
  const payload = { model, messages: managed.messages, stream, max_tokens: managed.outputBudget }
  payload.__diagnostics = managed.diagnostics
  if (stream && includeUsage) payload.stream_options = { include_usage: true }
  if (tools?.length) payload.tools = tools
  if (tools?.length) payload.tool_choice = forceTool ? { type: 'function', function: { name: 'web_search' } } : 'auto'
  if (isDeepSeek(settings, baseUrl)) {
    payload.thinking = { type: options?.deepThink ? 'enabled' : 'disabled' }
    if (options?.deepThink) payload.reasoning_effort = thinkingEffort(options?.thinkingLevel)
  }
  return payload
}
async function requestUpstream({ baseUrl, headers, model, messages, options, includeUsage = false, stream = true, settings, tools, forceTool = false }) {
  const payload = buildPayload({ model, messages, options, includeUsage, stream, settings, baseUrl, tools, forceTool })
  const diagnostics = payload.__diagnostics
  delete payload.__diagnostics
  if (!tools?.length) logLine(`CONTEXT mode=${diagnostics.mode} context=${diagnostics.contextWindow} outputBudget=${diagnostics.outputBudget} originalTokens=${diagnostics.originalTokens} managedTokens=${diagnostics.managedTokens} recentTokens=${diagnostics.recentTokens || 0} summaryTokens=${diagnostics.summaryTokens || 0} longTermTokens=${diagnostics.longTermTokens || 0} styleTokens=${diagnostics.styleTokens || 0} messages=${diagnostics.originalMessages || messages.length}->${diagnostics.managedMessages || payload.messages.length}`)
  return fetch(chatEndpoint(baseUrl), { method: 'POST', headers, body: JSON.stringify(payload) })
}

function stripHtml(text) {
  return text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeSearchUrl(raw) {
  try {
    const url = new URL(raw, 'https://duckduckgo.com')
    const redirected = url.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : url.href
  } catch {
    return ''
  }
}

function siteName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0]
  } catch {
    return 'source'
  }
}

function faviconFor(url) {
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return ''
  }
}

async function fetchPageText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 AI Talking Local' }, redirect: 'follow' })
  const type = response.headers.get('content-type') || ''
  if (!response.ok || !type.includes('text/html')) return null
  const html = await response.text()
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || siteName(url))
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
  const text = stripHtml(article || main || html).slice(0, 5000)
  return text ? { title, url, favicon: faviconFor(url), text } : null
}

async function runWebSearch(query) {
  const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0 AI Talking Local' } })
  if (!response.ok) throw new Error(`search failed: ${response.status}`)
  const html = await response.text()
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({ url: normalizeSearchUrl(match[1]), title: stripHtml(match[2]) })).filter((item) => item.url.startsWith('http')).slice(0, 4)
  const sources = []
  for (const item of links) {
    try {
      const page = await fetchPageText(item.url)
      if (page) sources.push({ ...page, title: page.title || item.title || siteName(item.url) })
    } catch (error) {
      logLine(`FETCH_SOURCE_ERROR url=${item.url} error=${error instanceof Error ? error.message : 'failed'}`)
    }
  }
  return { query, sources }
}

async function maybeApplyWebSearch({ res, baseUrl, headers, model, messages, options, settings }) {
  if (!options?.webSearch) return messages
  const first = await requestUpstream({ baseUrl, headers, model, messages, options, stream: false, settings, tools: [webSearchTool], forceTool: true })
  if (!first.ok) {
    const errorText = await first.text()
    logLine(`WEB_TOOL_PLAN_ERROR status=${first.status} body=${errorText.slice(0, 500)}`)
    return [{ role: 'system', content: `联网搜索规划失败：${errorText.slice(0, 300)}` }, ...messages]
  }
  const json = await first.json()
  const assistant = json.choices?.[0]?.message
  const toolCalls = assistant?.tool_calls || []
  if (!toolCalls.length) return messages
  const nextMessages = [...buildMessages(messages, options, model, settings, baseUrl), assistant]
  for (const call of toolCalls) {
    if (call.function?.name !== 'web_search') continue
    let args = {}
    try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
    const query = String(args.query || messages.at(-1)?.content || '')
    let result
    try {
      result = await runWebSearch(query)
      const publicSources = result.sources.map((source, index) => ({ id: index + 1, title: source.title, url: source.url, favicon: source.favicon }))
      writeEvent(res, { type: 'sources', sources: publicSources })
      logLine(`WEB_SEARCH query=${query} sources=${publicSources.length}`)
    } catch (error) {
      result = { query, sources: [], error: error instanceof Error ? error.message : 'search failed' }
      logLine(`WEB_SEARCH_ERROR query=${query} error=${result.error}`)
    }
    nextMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
  }
  nextMessages.push({ role: 'system', content: '你必须只依据 web_search 工具返回的 sources.text 回答。不要输出 Markdown 链接，不要在底部单独列来源。凡是来自某个来源的句子后面插入对应标记，例如【source:1】。资料不足就说资料不足。' })
  return nextMessages
}

function emitParsed(res, parsed, counters) {
  if (!parsed || parsed.done) return
  if (parsed.reasoning) {
    counters.reasoning += parsed.reasoning.length
    writeEvent(res, { type: 'reasoning', value: parsed.reasoning })
  }
  if (parsed.content) {
    counters.content += parsed.content.length
    counters.contentText = `${counters.contentText || ''}${parsed.content}`
    writeEvent(res, { type: 'content', value: parsed.content })
  }
  if (parsed.finishReason) counters.finishReason = parsed.finishReason
  if (parsed.usage) counters.usage = mergeUsage(counters.usage, parsed.usage)
}

async function streamResponse(upstream, res, counters) {
  const contentType = upstream.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    emitParsed(res, parsePayload(await upstream.json()), counters)
    return
  }

  const reader = upstream.body?.getReader()
  if (!reader) throw new Error('\u4e0a\u6e38\u63a5\u53e3\u6ca1\u6709\u8fd4\u56de\u53ef\u8bfb\u53d6\u7684\u54cd\u5e94\u4f53\u3002')
  const decoder = new TextDecoder()
  let buffered = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() || ''
    for (const line of lines) emitParsed(res, parseStreamLine(line), counters)
  }
  emitParsed(res, parseStreamLine(buffered), counters)
}

function targetCharsFromOptions(options) {
  return explicitTargetChars(options)
}

function shouldContinueUnderLength(counters, options) {
  const target = targetCharsFromOptions(options)
  return target > 0 && counters.finishReason === 'stop' && counters.content > 0 && counters.content < target * 0.8
}

function lastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function collectRecentMessages(messages, budget) {
  const recent = []
  let tokens = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role === 'system' || message.role === 'tool') continue
    const cost = messageTokens(message)
    if (tokens + cost > budget && recent.length) break
    if (cost > budget && !recent.length) {
      recent.unshift({ ...message, content: contentExcerpt(message.content, budget) })
      break
    }
    recent.unshift(message)
    tokens += cost
  }
  return recent
}

function buildContinuationMessages(sourceMessages, generatedText, remainingChars, targetChars, contextWindow) {
  const originalUserIndex = lastUserIndex(sourceMessages)
  const originalUser = originalUserIndex >= 0 ? sourceMessages[originalUserIndex] : sourceMessages.at(-1)
  const beforeOriginal = originalUserIndex >= 0 ? sourceMessages.slice(0, originalUserIndex) : sourceMessages.slice(0, -1)
  const outputBudget = outputBudgetForTarget(targetChars, contextWindow)
  const lightweightBudget = Math.max(1536, Math.min(Math.floor(outputBudget * 0.75), Math.floor(contextWindow * 0.1)))
  const longTermBudget = Math.max(160, Math.floor(lightweightBudget * 0.18))
  const summaryBudget = Math.max(240, Math.floor(lightweightBudget * 0.24))
  const styleBudget = Math.max(160, Math.floor(lightweightBudget * 0.18))
  const recentBudget = Math.max(512, lightweightBudget - longTermBudget - summaryBudget - styleBudget)
  const recent = collectRecentMessages(beforeOriginal, recentBudget)
  const older = beforeOriginal.slice(0, Math.max(0, beforeOriginal.length - recent.length))
  const longTerm = buildLongTermMemory(older, longTermBudget)
  const summary = buildPlotSummary(older, summaryBudget)
  const style = buildStyleAnchor(older, styleBudget)
  const completedPart = trimToTokenBudget(generatedText || '', Math.max(800, Math.floor(outputBudget * 0.5)))

  const messages = [
    { role: 'system', content: contextPrompt(targetChars) },
    {
      role: 'system',
      content: [
        '\u8fd9\u662f\u4e00\u6b21\u6b20\u957f\u81ea\u52a8\u7eed\u5199\u8bf7\u6c42\u3002\u539f\u59cb user message \u4ecd\u7136\u662f\u5f53\u524d\u4efb\u52a1\u7684\u6838\u5fc3\u8981\u6c42\uff1b\u7b2c\u4e00\u6bb5 assistant \u5185\u5bb9\u53ea\u662f\u5df2\u7ecf\u5b8c\u6210\u7684\u90e8\u5206\uff0c\u4e0d\u662f\u65b0\u7684\u4efb\u52a1\u8981\u6c42\u3002',
        '\u539f\u7528\u6237\u8981\u6c42\u4e2d\u7684\u6240\u6709\u9650\u5236\u3001\u5267\u60c5\u70b9\u3001\u4eba\u7269\u884c\u4e3a\u3001\u7981\u6b62\u4e8b\u9879\u3001\u8be6\u7ec6\u7a0b\u5ea6\u548c\u98ce\u683c\u8981\u6c42\u90fd\u7ee7\u7eed\u5b8c\u5168\u751f\u6548\u3002',
        '\u7eed\u5199\u6307\u4ee4\u53ea\u8d1f\u8d23\u8bf4\u660e\u4ece\u54ea\u91cc\u63a5\u7740\u5199\u3001\u4e0d\u8981\u91cd\u590d\u548c\u8fd8\u9700\u8981\u8865\u591a\u5c11\u7bc7\u5e45\uff1b\u5b83\u4e0d\u80fd\u53d6\u4ee3\u539f\u59cb\u7528\u6237\u8981\u6c42\u3002',
      ].join('')
    },
  ]
  if (longTerm) messages.push({ role: 'system', content: '\u957f\u671f\u91cd\u8981\u8bbe\u5b9a\u3001\u4eba\u7269\u5173\u7cfb\u3001\u4e16\u754c\u89c2\u548c\u4f0f\u7b14\uff1a\n' + longTerm })
  if (summary) messages.push({ role: 'system', content: '\u8f83\u65e9\u5185\u5bb9\u538b\u7f29\u6458\u8981\uff1a\n' + summary })
  if (style) messages.push({ role: 'system', content: '\u98ce\u683c\u951a\u70b9\uff0c\u4fdd\u6301\u53d9\u4e8b\u5bc6\u5ea6\u3001\u8868\u8fbe\u65b9\u5f0f\u3001\u8282\u594f\u548c\u4eba\u7269\u8868\u73b0\uff0c\u4f46\u4e0d\u8981\u590d\u8ff0\u539f\u6587\uff1a\n' + style })
  messages.push(...recent)
  if (originalUser) {
    messages.push({
      role: 'user',
      content: '\u539f\u59cb\u7528\u6237\u8981\u6c42\uff08\u8fd9\u662f\u5f53\u524d\u4efb\u52a1\u7684\u6838\u5fc3\uff0c\u6240\u6709\u9650\u5236\u7ee7\u7eed\u751f\u6548\uff09\uff1a\n' + String(originalUser.content || '')
    })
  }
  messages.push({ role: 'assistant', content: completedPart })
  messages.push({
    role: 'user',
    content: [
      '\u4e0a\u4e00\u6bb5\u5df2\u7ecf\u6b63\u5e38\u505c\u6b62\uff0c\u4f46\u8ddd\u79bb\u672c\u8f6e\u76ee\u6807\u7bc7\u5e45 ' + targetChars + ' \u4e2a\u4e2d\u6587\u5b57\u7b26\u8fd8\u5dee\u7ea6 ' + remainingChars + ' \u4e2a\u4e2d\u6587\u5b57\u7b26\u3002',
      '\u8bf7\u4ece\u4e0a\u4e00\u6bb5\u6700\u540e\u4e00\u53e5\u4e4b\u540e\u81ea\u7136\u7ee7\u7eed\uff0c\u4e0d\u8981\u91cd\u590d\u5df2\u5199\u5185\u5bb9\uff0c\u4e0d\u8981\u4ece\u5934\u5f00\u59cb\uff0c\u4e0d\u8981\u603b\u7ed3\u3002',
      '\u7ee7\u7eed\u4e25\u683c\u5b8c\u6210\u539f\u59cb\u7528\u6237\u8981\u6c42\uff0c\u53ea\u8865\u8db3\u5269\u4f59\u5185\u5bb9\uff0c\u8ba9\u5408\u5e76\u540e\u7684\u6574\u4f53\u56de\u7b54\u63a5\u8fd1\u76ee\u6807\u7bc7\u5e45\u3002',
    ].join('')
  })
  return { messages, outputBudget, diagnostics: { mode: 'continuation-lite', contextWindow, outputBudget, managedTokens: messagesTokens(messages), recentTokens: messagesTokens(recent), summaryTokens: estimateTokens(summary), longTermTokens: estimateTokens(longTerm), styleTokens: estimateTokens(style), originalMessages: sourceMessages.length, managedMessages: messages.length } }
}

function buildContinuationPayload({ model, sourceMessages, generatedText, remainingChars, targetChars, options, settings, baseUrl, stream, includeUsage }) {
  const contextWindow = inferContextWindow(model, settings, baseUrl)
  const managed = buildContinuationMessages(sourceMessages, generatedText, remainingChars, targetChars, contextWindow)
  const payload = { model, messages: managed.messages, stream, max_tokens: managed.outputBudget }
  payload.__diagnostics = managed.diagnostics
  if (stream && includeUsage) payload.stream_options = { include_usage: true }
  if (isDeepSeek(settings, baseUrl)) {
    payload.thinking = { type: options?.deepThink ? 'enabled' : 'disabled' }
    if (options?.deepThink) payload.reasoning_effort = thinkingEffort(options?.thinkingLevel)
  }
  return payload
}

async function runContinuationGuard({ res, baseUrl, headers, model, finalMessages, options, settings, counters }) {
  const maxContinuations = 1
  let continuations = 0
  for (let attempt = 0; attempt < maxContinuations && shouldContinueUnderLength(counters, options); attempt += 1) {
    const target = targetCharsFromOptions(options)
    const remaining = Math.max(0, Math.ceil(target - counters.content))
    const payload = buildContinuationPayload({
      model,
      sourceMessages: finalMessages,
      generatedText: counters.contentText || '',
      remainingChars: remaining,
      targetChars: target,
      options: { ...options, webSearch: false },
      includeUsage: true,
      stream: true,
      settings,
      baseUrl,
    })
    const diagnostics = payload.__diagnostics
    delete payload.__diagnostics
    logLine(`CONTINUATION attempt=${attempt + 1} previousVisibleChars=${counters.content} targetChars=${target} remainingChars=${remaining} mode=${diagnostics.mode} outputBudget=${diagnostics.outputBudget} managedTokens=${diagnostics.managedTokens} recentTokens=${diagnostics.recentTokens || 0} summaryTokens=${diagnostics.summaryTokens || 0} longTermTokens=${diagnostics.longTermTokens || 0} styleTokens=${diagnostics.styleTokens || 0} messages=${diagnostics.originalMessages}->${diagnostics.managedMessages}`)

    counters.finishReason = ''
    let upstream = await fetch(chatEndpoint(baseUrl), { method: 'POST', headers, body: JSON.stringify(payload) })
    if (!upstream.ok && [400, 404, 422].includes(upstream.status)) {
      delete payload.stream_options
      upstream = await fetch(chatEndpoint(baseUrl), { method: 'POST', headers, body: JSON.stringify(payload) })
    }
    if (!upstream.ok) {
      const errorText = await upstream.text()
      logLine(`CONTINUATION_ERROR status=${upstream.status} body=${errorText.slice(0, 500)}`)
      break
    }
    await streamResponse(upstream, res, counters)
    continuations += 1
  }
  return continuations
}

async function handleChat(req, res) {
  try {
    const body = JSON.parse(await readBody(req))
    const { settings, messages, options } = body
    logLine(`POST /api/chat model=${settings?.model || ''} baseUrl=${settings?.baseUrl || ''} messages=${Array.isArray(messages) ? messages.length : 'bad'} deepThink=${Boolean(options?.deepThink)} webSearch=${Boolean(options?.webSearch)}`)
    const baseUrl = normalizeBaseUrl(settings?.baseUrl)
    const model = settings?.model
    if (!baseUrl || !model || !Array.isArray(messages)) {
      sendJson(res, 400, { error: '缺少 Base URL、模型或消息。' })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' })
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
    const finalMessages = await maybeApplyWebSearch({ res, baseUrl, headers, model, messages, options, settings })
    let upstream = await requestUpstream({ baseUrl, headers, model, messages: finalMessages, options: { ...options, webSearch: false }, includeUsage: true, stream: true, settings })
    if (!upstream.ok && [400, 404, 422].includes(upstream.status)) upstream = await requestUpstream({ baseUrl, headers, model, messages: finalMessages, options: { ...options, webSearch: false }, includeUsage: false, stream: true, settings })
    if (!upstream.ok) {
      const errorText = await upstream.text()
      logLine(`UPSTREAM_ERROR status=${upstream.status} body=${errorText.slice(0, 500)}`)
      writeEvent(res, { type: 'error', message: errorText || `上游接口错误：${upstream.status}` })
      writeEvent(res, { type: 'done' })
      res.end()
      return
    }
    const counters = { content: 0, contentText: '', reasoning: 0, usage: null, finishReason: '' }
    try {
      await streamResponse(upstream, res, counters)
    } catch (error) {
      const message = error instanceof Error ? error.message : '\u4e0a\u6e38\u63a5\u53e3\u6ca1\u6709\u8fd4\u56de\u53ef\u8bfb\u53d6\u7684\u54cd\u5e94\u4f53\u3002'
      writeEvent(res, { type: 'error', message })
      writeEvent(res, { type: 'done' })
      res.end()
      return
    }

    const continuations = await runContinuationGuard({ res, baseUrl, headers, model, finalMessages, options, settings, counters })
    if (counters.usage) writeEvent(res, { type: 'usage', usage: counters.usage })
    if (counters.usage) logLine(`USAGE input=${counters.usage.prompt} output=${counters.usage.completion} total=${counters.usage.total} visibleChars=${counters.content} reasoningChars=${counters.reasoning} finish_reason=${counters.finishReason || ''} continuations=${continuations}`)
    if (!counters.content) writeEvent(res, { type: 'error', message: '\u4e0a\u6e38\u63a5\u53e3\u6ca1\u6709\u8fd4\u56de\u6b63\u6587\u5185\u5bb9\u3002\u5df2\u5199\u5165 chat-debug.log\u3002' })
    writeEvent(res, { type: 'done' })
    res.end()
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地中转服务异常'
    logLine(`LOCAL_ERROR ${message}`)
    if (!res.headersSent) sendJson(res, 500, { error: message })
    else {
      writeEvent(res, { type: 'error', message })
      writeEvent(res, { type: 'done' })
      res.end()
    }
  }
}

function serveStatic(req, res) {
  const requestedPath = decodeURIComponent(new URL(req.url || '/', `http://${req.headers.host}`).pathname)
  const relativePath = requestedPath === '/' ? '/index.html' : requestedPath
  const filePath = normalize(join(distDir, relativePath))
  if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    const fallback = join(distDir, 'index.html')
    if (existsSync(fallback)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      createReadStream(fallback).pipe(res)
      return
    }
    sendJson(res, 404, { error: '请先运行 npm run build 生成 dist。' })
    return
  }
  res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}

createServer((req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
    res.end()
    return
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() })
    return
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    void handleChat(req, res)
    return
  }
  if (req.method === 'GET') {
    serveStatic(req, res)
    return
  }
  sendJson(res, 405, { error: 'Method not allowed' })
}).listen(port, () => {
  logLine(`SERVER_START http://localhost:${port}`)
  console.log(`AI Talking local server: http://localhost:${port}`)
})












