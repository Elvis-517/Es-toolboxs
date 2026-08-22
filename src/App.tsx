import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import './App.css'

type Provider = {
  id: string
  name: string
  baseUrl: string
  model: string
  note: string
}

type Role = 'user' | 'assistant'
type ResponseLengthMode = 'auto' | 'brief' | 'standard' | 'detailed' | 'custom'

type Citation = {
  id: number
  title: string
  url: string
  favicon: string
}

type TokenUsage = {
  prompt: number
  completion: number
  total: number
  source?: 'api' | 'estimate'
}

type MessageVariant = {
  content: string
  createdAt: string
  completedAt?: string
  interrupted?: boolean
  reasoning?: string
  tokenUsage?: TokenUsage
  citations?: Citation[]
  deepThink?: boolean
  webSearch?: boolean
  tail?: Message[]
}

type Message = {
  id: string
  role: Role
  content: string
  createdAt: string
  completedAt?: string
  interrupted?: boolean
  reasoning?: string
  tokenUsage?: TokenUsage
  citations?: Citation[]
  deepThink?: boolean
  webSearch?: boolean
  branchIndex?: number
  branchTotal?: number
  variants?: MessageVariant[]
}

type Conversation = {
  id: string
  title: string
  messages: Message[]
  updatedAt: string
  responseLengthMode?: ResponseLengthMode
  targetChars?: number
}

type McpServer = {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  endpoint: string
  enabled: boolean
}

type ThemeSettings = {
  mode: 'system' | 'light' | 'dark'
  backgroundColor: string
  backgroundImage: string
  backgroundImageName: string
  backgroundOpacity: number
  backgroundBlur: number
  backgroundScope: 'global' | 'chat'
  hoverBackgroundColor: string
  panelGlassBlur: number
  bubbleGlassBlur: number
  composerGlassBlur: number
  sidebarGlassBlur: number
  hoverGlassBlur: number
  fontSize: number
  showAvatars: boolean
  textColor: string
  assistantBubbleColor: string
  assistantBubbleOpacity: number
  userBubbleColor: string
  userBubbleOpacity: number
  reasoningTextColor: string
  reasoningBackgroundColor: string
  reasoningBackgroundOpacity: number
  tokenTextColor: string
  tokenBackgroundColor: string
  tokenBackgroundOpacity: number
}

type Settings = {
  userName: string
  providerId: string
  providerName: string
  baseUrl: string
  apiKey: string
  model: string
  defaultDeepThink: boolean
  defaultWebSearch: boolean
  theme: ThemeSettings
  mcpServers: McpServer[]
}

type Backup = {
  version: number
  exportedAt: string
  settings: Settings
  conversations: Conversation[]
}

type StreamEvent = {
  type: 'content' | 'reasoning' | 'usage' | 'sources' | 'done' | 'error'
  value?: string
  usage?: TokenUsage
  sources?: Citation[]
  message?: string
}

const providers: Provider[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', note: '官方接口' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', note: '支持思考模型' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', note: '聚合多模型' },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', note: '本机模型' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '', note: '手动填写 API 商家' },
]

const defaultSettings: Settings = {
  userName: '我',
  providerId: providers[0].id,
  providerName: providers[0].name,
  baseUrl: providers[0].baseUrl,
  apiKey: '',
  model: providers[0].model,
  defaultDeepThink: false,
  defaultWebSearch: false,
  theme: {
    mode: 'system',
    backgroundColor: '#f7f7f4',
    backgroundImage: '',
    backgroundImageName: '',
    backgroundOpacity: 92,
    backgroundBlur: 0,
    backgroundScope: 'chat',
    hoverBackgroundColor: '#ececec',
    panelGlassBlur: 16,
    bubbleGlassBlur: 0,
    composerGlassBlur: 18,
    sidebarGlassBlur: 10,
    hoverGlassBlur: 6,
    fontSize: 16,
    showAvatars: true,
    textColor: '#202123',
    assistantBubbleColor: '#ffffff',
    assistantBubbleOpacity: 0,
    userBubbleColor: '#e8f8f2',
    userBubbleOpacity: 92,
    reasoningTextColor: '#5f6672',
    reasoningBackgroundColor: '#ffffff',
    reasoningBackgroundOpacity: 62,
    tokenTextColor: '#6f737a',
    tokenBackgroundColor: '#ffffff',
    tokenBackgroundOpacity: 0,
  },
  mcpServers: [],
}

const storageKey = 'ai-talking-state-v1'

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function nowIso() {
  return new Date().toISOString()
}

function createConversation(): Conversation {
  return { id: createId(), title: '\u65b0\u5bf9\u8bdd', messages: [], updatedAt: nowIso(), responseLengthMode: 'auto', targetChars: 3000 }
}

function normalizeConversation(conversation: Conversation): Conversation {
  return { responseLengthMode: 'auto', targetChars: 3000, ...conversation }
}

function normalizeSettings(settings?: Partial<Settings>): Settings {
  return {
    ...defaultSettings,
    ...settings,
    theme: { ...defaultSettings.theme, ...settings?.theme },
    mcpServers: settings?.mcpServers || [],
  }
}

function loadState(): { settings: Settings; conversations: Conversation[]; activeId: string } {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) throw new Error('empty')
    const parsed = JSON.parse(raw) as Partial<Backup> & { activeId?: string }
    const conversations = parsed.conversations?.length ? parsed.conversations.map((conversation) => normalizeConversation(conversation as Conversation)) : [createConversation()]
    return { settings: normalizeSettings(parsed.settings), conversations, activeId: parsed.activeId || conversations[0].id }
  } catch {
    const first = createConversation()
    return { settings: defaultSettings, conversations: [first], activeId: first.id }
  }
}

function getTitleFromMessage(content: string) {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, 20) : '新对话'
}

function formatTime(value?: string) {
  if (!value) return '--:--'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function thinkingLabel(value: number) {
  if (value < 30) return 'low'
  if (value < 60) return 'mid'
  if (value < 85) return 'high'
  return 'max'
}
function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function conversationTimeGroup(value: string) {
  const days = Math.floor((startOfLocalDay(new Date()) - startOfLocalDay(new Date(value))) / 86400000)
  if (days <= 0) return 'Today'
  if (days <= 7) return '7 days'
  if (days <= 30) return '30 days'
  return 'Earlier'
}

function groupConversationsByTime(items: Conversation[]) {
  const groups: { label: string; items: Conversation[] }[] = []
  for (const conversation of items) {
    const label = conversationTimeGroup(conversation.updatedAt)
    let group = groups.find((item) => item.label === label)
    if (!group) {
      group = { label, items: [] }
      groups.push(group)
    }
    group.items.push(conversation)
  }
  return groups
}

function messageToVariant(message: Message): MessageVariant {
  return {
    content: message.content,
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    interrupted: message.interrupted,
    reasoning: message.reasoning,
    tokenUsage: message.tokenUsage,
    citations: message.citations,
    deepThink: message.deepThink,
    webSearch: message.webSearch,
  }
}

function messageVariants(message: Message) {
  return message.variants?.length ? message.variants : [messageToVariant(message)]
}

function applyMessageVariant(message: Message, variant: MessageVariant, index: number, total: number): Message {
  return {
    ...message,
    content: variant.content,
    createdAt: variant.createdAt,
    completedAt: variant.completedAt,
    interrupted: variant.interrupted,
    reasoning: variant.reasoning,
    tokenUsage: variant.tokenUsage,
    citations: variant.citations,
    deepThink: variant.deepThink,
    webSearch: variant.webSearch,
    branchIndex: index,
    branchTotal: total,
    variants: message.variants,
  }
}

function syncCurrentVariant(message: Message): Message {
  if (message.role !== 'assistant' || !message.branchTotal || message.branchTotal <= 1) return message
  const variants = messageVariants(message)
  const index = Math.min(Math.max(message.branchIndex || variants.length, 1), Math.max(message.branchTotal, variants.length))
  const nextVariants = [...variants]
  nextVariants[index - 1] = messageToVariant(message)
  return { ...message, variants: nextVariants, branchIndex: index, branchTotal: Math.max(message.branchTotal, nextVariants.length) }
}

function syncUserBranch(message: Message, tail: Message[]): Message {
  if (message.role !== 'user') return message
  const variants = messageVariants(message)
  const index = Math.min(Math.max(message.branchIndex || variants.length || 1, 1), Math.max(message.branchTotal || 1, variants.length || 1))
  const nextVariants = [...variants]
  nextVariants[index - 1] = { ...messageToVariant(message), tail }
  return { ...message, variants: nextVariants, branchIndex: index, branchTotal: Math.max(message.branchTotal || 1, nextVariants.length) }
}


function estimateTokens(text: string) {
  const normalized = text.trim()
  if (!normalized) return 0
  const cjk = (normalized.match(/[\\u4e00-\\u9fff]/g) || []).length
  const nonCjk = normalized.replace(/[\\u4e00-\\u9fff]/g, '')
  return Math.max(1, Math.ceil(cjk * 1.05 + nonCjk.length / 3.8))
}

function IconButton({ label, active, disabled, children, onClick }: {
  label: string
  active?: boolean
  disabled?: boolean
  children: string
  onClick?: () => void
}) {
  return (
    <button className={`icon-button ${active ? 'active' : ''}`} type="button" disabled={disabled} onClick={onClick} aria-label={label}>
      <span aria-hidden="true">{children}</span>
      <em>{label}</em>
    </button>
  )
}

function sourceLabel(source: Citation) {
  try {
    const host = new URL(source.url).hostname.replace(/^www\./, '')
    return source.title?.split(/[|\-–—]/)[0].trim().slice(0, 16) || host.split('.')[0]
  } catch {
    return source.title?.slice(0, 16) || '来源'
  }
}

function CitationChip({ source }: { source: Citation }) {
  return (
    <a className="citation-chip" href={source.url} target="_blank" rel="noreferrer" title={`${source.title}\n${source.url}`}>
      {source.favicon ? <img src={source.favicon} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <span>•</span>}
      <b>{sourceLabel(source)}</b>
    </a>
  )
}

function renderInline(text: string, citations: Citation[]) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|【source:\d+】)/g).filter(Boolean)
  return parts.map((part, index) => {
    const citationMatch = part.match(/^【source:(\d+)】$/)
    if (citationMatch) {
      const source = citations.find((item) => item.id === Number(citationMatch[1]))
      return source ? <CitationChip key={`${part}-${index}`} source={source} /> : null
    }
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <strong key={index}>{part.slice(2, -2)}</strong>
    return <span key={index}>{part}</span>
  })
}

function RenderMarkdown({ content, citations = [] }: { content: string; citations?: Citation[] }) {
  const cleaned = content.replace(/^\s*(---|\*\*\*)\s*$/gm, '<hr>')
  const blocks = cleaned.split(/(```[\s\S]*?```)/g).filter(Boolean)
  const hasInlineCitation = /【source:\d+】/.test(content)

  return (
    <div className="markdown-body">
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const code = block.replace(/^```\w*\n?/, '').replace(/```$/, '')
          return <pre key={blockIndex}><code>{code}</code></pre>
        }

        const lines = block.split(/\n+/).filter((line) => line.trim())
        const nodes = []
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i].trim()
          if (line === '<hr>') {
            nodes.push(<hr key={`${blockIndex}-${i}`} />)
            continue
          }
          const heading = line.match(/^(#{1,3})\s+(.+)$/)
          if (heading) {
            const level = heading[1].length
            const inline = renderInline(heading[2], citations)
            nodes.push(level === 1 ? <h1 key={`${blockIndex}-${i}`}>{inline}</h1> : level === 2 ? <h2 key={`${blockIndex}-${i}`}>{inline}</h2> : <h3 key={`${blockIndex}-${i}`}>{inline}</h3>)
            continue
          }
          if (/^[-*]\s+/.test(line)) {
            const items = []
            while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
              items.push(<li key={`${blockIndex}-li-${i}`}>{renderInline(lines[i].trim().replace(/^[-*]\s+/, ''), citations)}</li>)
              i += 1
            }
            i -= 1
            nodes.push(<ul key={`${blockIndex}-ul-${i}`}>{items}</ul>)
            continue
          }
          const fallbackCites = !hasInlineCitation && citations.length && blockIndex === 0 && nodes.length === 0 ? citations.slice(0, 3) : []
          nodes.push(<p key={`${blockIndex}-${i}`}>{renderInline(line, citations)} {fallbackCites.map((source) => <CitationChip key={source.id} source={source} />)}</p>)
        }
        return <div key={blockIndex}>{nodes}</div>
      })}
    </div>
  )
}
function TokenChart({ conversations }: { conversations: Conversation[] }) {
  const allRecords = conversations
    .flatMap((conversation) => conversation.messages.filter((message) => message.role === 'assistant' && message.tokenUsage))
    .map((message, index) => ({
      id: message.id,
      label: formatTime(message.completedAt || message.createdAt),
      prompt: message.tokenUsage?.prompt || 0,
      completion: message.tokenUsage?.completion || 0,
      total: message.tokenUsage?.total || 0,
      index,
    }))
  const records = allRecords.slice(-15).map((item, index) => ({ ...item, index }))
  const totalTokens = allRecords.reduce((sum, item) => sum + item.total, 0)
  const promptTokens = allRecords.reduce((sum, item) => sum + item.prompt, 0)
  const completionTokens = allRecords.reduce((sum, item) => sum + item.completion, 0)
  const max = Math.max(100, ...records.map((item) => item.total))
  const width = 760
  const height = 260
  const chartTop = 30
  const chartBottom = 210
  const chartLeft = 54
  const chartRight = 730
  const chartHeight = chartBottom - chartTop
  const chartWidth = chartRight - chartLeft
  const path = records
    .map((item) => {
      const x = records.length === 1 ? chartLeft + chartWidth / 2 : chartLeft + (item.index / (records.length - 1)) * chartWidth
      const y = chartBottom - (item.total / max) * chartHeight
      return `${item.index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')

  if (records.length === 0) {
    return <p className="muted">暂无 token 记录。AI 回复后会显示最近 15 组趋势，总统计会保留全部历史。</p>
  }

  return (
    <div className="token-dashboard">
      <div className="token-stats">
        <div><span>Total</span><strong>{totalTokens} tks</strong></div>
        <div><span>Input</span><strong>{promptTokens} tks</strong></div>
        <div><span>Output</span><strong>{completionTokens} tks</strong></div>
        <div><span>趋势</span><strong>{records.length} / {allRecords.length} 组</strong></div>
      </div>

      <div className="token-legend"><span><i />Input</span><span><b />Output</span></div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="token 消耗折线图">
          <path className="chart-grid" d={`M${chartLeft} ${chartTop} H${chartRight} M${chartLeft} ${chartTop + chartHeight / 2} H${chartRight} M${chartLeft} ${chartBottom} H${chartRight}`} />
          <path className="chart-axis" d={`M${chartLeft} ${chartTop} V${chartBottom} H${chartRight}`} />
          <text x="8" y={chartTop + 4}>{max}</text>
          <text x="18" y={chartTop + chartHeight / 2 + 4}>{Math.round(max / 2)}</text>
          <text x="28" y={chartBottom + 4}>0</text>
          <path className="chart-line" d={path} />
          {records.map((item) => {
            const x = records.length === 1 ? chartLeft + chartWidth / 2 : chartLeft + (item.index / (records.length - 1)) * chartWidth
            const y = chartBottom - (item.total / max) * chartHeight
            return (
              <g key={item.id}>
                <circle cx={x} cy={y} r="4.5" />
                <text className="point-label" x={x} y={y - 10}>{item.total}</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="token-rows">
        {records.slice(-8).reverse().map((item) => (
          <div className="token-row" key={item.id}>
            <span>{item.label}</span>
            <div><i style={{ width: `${Math.max(4, (item.prompt / max) * 100)}%` }} /><b style={{ width: `${Math.max(4, (item.completion / max) * 100)}%` }} /></div>
            <strong>{item.total} tks</strong>
          </div>
        ))}
      </div>
    </div>
  )
}
function App() {
  const initial = useMemo(() => loadState(), [])
  const [settings, setSettings] = useState<Settings>(initial.settings)
  const [conversations, setConversations] = useState<Conversation[]>(initial.conversations.map(normalizeConversation))
  const [activeId, setActiveId] = useState(initial.activeId)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [deepThink, setDeepThink] = useState(initial.settings.defaultDeepThink)
  const [thinkingLevel, setThinkingLevel] = useState(65)
  const [webSearch, setWebSearch] = useState(initial.settings.defaultWebSearch)
  const [notice, setNotice] = useState('')
  const [threadMenu, setThreadMenu] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [autoFollow, setAutoFollow] = useState(true)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  const [activeUserMessageId, setActiveUserMessageId] = useState<string | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const userMessageRefs = useRef<Map<string, HTMLElement>>(new Map())
  const autoFollowRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const backgroundInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const activeConversation = conversations.find((item) => item.id === activeId) || conversations[0]
  const conversationGroups = groupConversationsByTime(conversations)
  const lastMessageContent = activeConversation?.messages.at(-1)?.content || ''
  const userNavigatorMessages = useMemo(() => activeConversation?.messages.filter((message) => message.role === 'user') || [], [activeConversation?.messages])
  const setTheme = useCallback((patch: Partial<ThemeSettings>) => {
    setSettings((current) => ({ ...current, theme: { ...current.theme, ...patch } }))
  }, [])
  const themeStyle = {
    '--user-bg': settings.theme.backgroundColor,
    '--user-bg-image': settings.theme.backgroundImage ? `url("${settings.theme.backgroundImage}")` : 'none',
    '--user-bg-alpha': settings.theme.backgroundOpacity / 100,
    '--bg-image-blur': `${settings.theme.backgroundBlur}px`,
    '--nav-hover-bg': settings.theme.hoverBackgroundColor,
    '--panel-glass-blur': `${settings.theme.panelGlassBlur}px`,
    '--bubble-glass-blur': `${settings.theme.bubbleGlassBlur}px`,
    '--composer-glass-blur': `${settings.theme.composerGlassBlur}px`,
    '--sidebar-glass-blur': `${settings.theme.sidebarGlassBlur}px`,
    '--sidebar-glass-alpha': `${Math.max(46, 86 - settings.theme.sidebarGlassBlur)}%`,
    '--hover-glass-blur': `${settings.theme.hoverGlassBlur}px`,
    '--chat-font-size': `${settings.theme.fontSize}px`,
    '--custom-ink': settings.theme.textColor,
    '--assistant-bubble': settings.theme.assistantBubbleColor,
    '--assistant-bubble-alpha': `${settings.theme.assistantBubbleOpacity}%`,
    '--user-bubble': settings.theme.userBubbleColor,
    '--user-bubble-alpha': `${settings.theme.userBubbleOpacity}%`,
    '--reasoning-ink': settings.theme.reasoningTextColor,
    '--reasoning-bg': settings.theme.reasoningBackgroundColor,
    '--reasoning-bg-alpha': `${settings.theme.reasoningBackgroundOpacity}%`,
    '--token-ink': settings.theme.tokenTextColor,
    '--token-bg': settings.theme.tokenBackgroundColor,
    '--token-bg-alpha': `${settings.theme.tokenBackgroundOpacity}%`,
  } as CSSProperties

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ settings, conversations, activeId }))
  }, [settings, conversations, activeId])

  const resizeComposer = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const styles = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 22
    const paddingY = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const maxHeight = Math.round(lineHeight * 8 + paddingY)
    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resizeComposer()
  }, [draft, resizeComposer, settings.theme.fontSize])

  const setAutoFollowMode = useCallback((value: boolean) => {
    autoFollowRef.current = value
    setAutoFollow(value)
    setShowJumpLatest(!value)
  }, [])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    programmaticScrollRef.current = true
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    setAutoFollowMode(true)
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, 180)
  }, [setAutoFollowMode])

  const updateActiveUserFromScroll = useCallback(() => {
    const container = messagesRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    let nextActive = userNavigatorMessages.at(-1)?.id || null
    for (const message of userNavigatorMessages) {
      const node = userMessageRefs.current.get(message.id)
      if (!node) continue
      const top = node.getBoundingClientRect().top - containerTop
      if (top <= 120) nextActive = message.id
      else break
    }
    setActiveUserMessageId(nextActive)
  }, [userNavigatorMessages])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesRef.current
    if (!container) return
    updateActiveUserFromScroll()
    if (programmaticScrollRef.current) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    setAutoFollowMode(distance < 96)
  }, [setAutoFollowMode, updateActiveUserFromScroll])

  useEffect(() => {
    if (autoFollowRef.current) scrollToLatest('auto')
  }, [activeConversation?.messages.length, lastMessageContent, isSending, scrollToLatest])

  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      const id = visible?.target.getAttribute('data-message-id')
      if (id) setActiveUserMessageId(id)
    }, { root: container, threshold: [0.2, 0.6] })
    userNavigatorMessages.forEach((message) => {
      const node = userMessageRefs.current.get(message.id)
      if (node) observer.observe(node)
    })
    updateActiveUserFromScroll()
    return () => observer.disconnect()
  }, [activeConversation?.id, userNavigatorMessages, updateActiveUserFromScroll])

  const setUserMessageRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) userMessageRefs.current.set(id, node)
    else userMessageRefs.current.delete(id)
  }, [])

  function jumpToUserMessage(id: string) {
    const node = userMessageRefs.current.get(id)
    if (!node) return
    programmaticScrollRef.current = true
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveUserMessageId(id)
    setAutoFollowMode(false)
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, 220)
  }

  useEffect(() => {
    if (!threadMenu) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.thread-menu, .thread-dots')) return
      setThreadMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThreadMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [threadMenu])



  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((items) =>
      items.map((item) => (item.id === id ? updater(item) : item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  }

  function setConversationLength(patch: Partial<Pick<Conversation, 'responseLengthMode' | 'targetChars'>>) {
    if (!activeConversation) return
    updateConversation(activeConversation.id, (conversation) => ({ ...conversation, ...patch, updatedAt: nowIso() }))
  }

  function buildChatOptions() {
    const mode = activeConversation?.responseLengthMode || 'auto'
    const target = Math.max(300, Number(activeConversation?.targetChars || 3000))
    return {
      deepThink,
      webSearch,
      thinkingLevel,
      responseLengthMode: mode,
      ...(mode === 'custom' ? { targetChars: target, maxChars: target, targetCharsExplicit: true } : {}),
    }
  }

  function startNewConversation() {
    const next = createConversation()
    setConversations((items) => [next, ...items])
    setActiveId(next.id)
    setView('chat')
  }

  function renameConversation(id: string) {
    const current = conversations.find((item) => item.id === id)
    const title = window.prompt('重命名对话', current?.title || '')?.trim()
    if (!title) return
    updateConversation(id, (conversation) => ({ ...conversation, title, updatedAt: nowIso() }))
  }

  function deleteConversation(id: string) {
    const current = conversations.find((item) => item.id === id)
    if (!window.confirm(`删除「${current?.title || '这个对话'}」？`)) return
    setConversations((items) => {
      const next = items.filter((item) => item.id !== id)
      if (!next.length) {
        const fresh = createConversation()
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeId) setActiveId(next[0].id)
      return next
    })
  }

  function chooseProvider(providerId: string) {
    const provider = providers.find((item) => item.id === providerId) || providers[0]
    setSettings((current) => ({
      ...current,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
    }))
  }

  function addMcpServer() {
    setSettings((current) => ({
      ...current,
      mcpServers: [...current.mcpServers, { id: createId(), name: 'MCP ??', transport: 'http', endpoint: '', enabled: true }],
    }))
  }

  function updateMcpServer(id: string, patch: Partial<McpServer>) {
    setSettings((current) => ({
      ...current,
      mcpServers: current.mcpServers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
    }))
  }

  function removeMcpServer(id: string) {
    setSettings((current) => ({ ...current, mcpServers: current.mcpServers.filter((server) => server.id !== id) }))
  }

  function stopGeneration() {
    abortControllerRef.current?.abort()
  }

  function applyStreamEvent(event: StreamEvent, conversationId: string, assistantId: string, promptTokens: number, interrupted = false) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (message.id !== assistantId) return message
        if (event.type === 'content') return { ...message, content: `${message.content}${event.value || ''}` }
        if (event.type === 'reasoning') return { ...message, reasoning: `${message.reasoning || ''}${event.value || ''}` }
        if (event.type === 'usage' && event.usage?.total) return { ...message, tokenUsage: { ...event.usage, source: 'api' } }
        if (event.type === 'sources' && event.sources) return { ...message, citations: event.sources }
        if (event.type === 'done') {
          const completion = estimateTokens(`${message.reasoning || ''}\n${message.content}`)
          const completedMessage = {
            ...message,
            completedAt: message.completedAt || nowIso(),
            interrupted: message.interrupted || interrupted,
            tokenUsage: message.tokenUsage || (completion > 0 ? { prompt: promptTokens, completion, total: promptTokens + completion, source: 'estimate' } : undefined),
          }
          return syncCurrentVariant(completedMessage)
        }
        if (event.type === 'error') return { ...message, content: `请求出错：${event.message || '未知错误'}` }
        return message
      }),
      updatedAt: nowIso(),
    }))
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || isSending || !activeConversation) return
    if (!settings.baseUrl || !settings.model) {
      setNotice('请先在设置里选择商家并填写模型。')
      setView('settings')
      return
    }

    const userMessage: Message = { id: createId(), role: 'user', content, createdAt: nowIso(), deepThink, webSearch, branchIndex: 1, branchTotal: 1 }
    const assistantMessage: Message = { id: createId(), role: 'assistant', content: '', reasoning: '', createdAt: nowIso(), deepThink, webSearch, branchIndex: 1, branchTotal: 1 }
    const conversationId = activeConversation.id
    const history = [...activeConversation.messages, userMessage]
    const messagesForApi = history.map(({ role, content: text }) => ({ role, content: text }))
    const promptTokens = estimateTokens(history.map((message) => message.content).join('\n'))

    setDraft('')
    setNotice('')
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length ? conversation.title : getTitleFromMessage(content),
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: nowIso(),
    }))
    setAutoFollowMode(true)
    window.setTimeout(() => scrollToLatest('auto'), 0)
    setIsSending(true)

    try {
      const controller = new AbortController()
      abortControllerRef.current = controller
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ settings, messages: messagesForApi, options: buildChatOptions() }),
      })

      if (!response.ok || !response.body) {
        const errorText = await response.text()
        throw new Error(errorText || `请求失败：${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line) as StreamEvent
            applyStreamEvent(parsed, conversationId, assistantMessage.id, promptTokens)
          } catch {
            continue
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        applyStreamEvent({ type: 'content', value: '\n\n[已停止]' }, conversationId, assistantMessage.id, promptTokens)
      } else {
        applyStreamEvent({ type: 'error', message: error instanceof Error ? error.message : '未知错误' }, conversationId, assistantMessage.id, promptTokens)
      }
    } finally {
      applyStreamEvent({ type: 'done' }, conversationId, assistantMessage.id, promptTokens, abortControllerRef.current?.signal.aborted || false)
      abortControllerRef.current = null
      setIsSending(false)
    }
  }
  function switchUserBranch(messageId: string, direction: -1 | 1) {
    if (!activeConversation || isSending) return
    updateConversation(activeConversation.id, (conversation) => {
      const index = conversation.messages.findIndex((message) => message.id === messageId)
      const message = conversation.messages[index]
      if (index < 0 || !message || message.role !== 'user') return conversation
      const synced = syncUserBranch(message, conversation.messages.slice(index + 1))
      const variants = messageVariants(synced)
      if (variants.length <= 1) return conversation
      const current = Math.min(Math.max(synced.branchIndex || 1, 1), variants.length)
      const next = ((current - 1 + direction + variants.length) % variants.length) + 1
      const variant = variants[next - 1]
      const nextUser = applyMessageVariant({ ...synced, variants }, variant, next, variants.length)
      return {
        ...conversation,
        messages: [...conversation.messages.slice(0, index), nextUser, ...(variant.tail || [])],
        updatedAt: nowIso(),
      }
    })
  }

  function startEditingUserMessage(message: Message) {
    if (isSending) return
    setEditingUserId(message.id)
    setEditingDraft(message.content)
  }

  async function submitUserEdit(messageId: string) {
    if (isSending || !activeConversation) return
    const content = editingDraft.trim()
    if (!content) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId)
    const currentUser = activeConversation.messages[index]
    if (index < 0 || !currentUser || currentUser.role !== 'user') return
    const syncedUser = syncUserBranch(currentUser, activeConversation.messages.slice(index + 1))
    const previousVariants = messageVariants(syncedUser)
    const nextBranchTotal = previousVariants.length + 1
    const userMessage: Message = { ...syncedUser, content, createdAt: nowIso(), branchIndex: nextBranchTotal, branchTotal: nextBranchTotal, variants: previousVariants }
    const assistantMessage: Message = { id: createId(), role: 'assistant', content: '', reasoning: '', createdAt: nowIso(), deepThink, webSearch, branchIndex: 1, branchTotal: 1 }
    const history = [...activeConversation.messages.slice(0, index), userMessage]
    const messagesForApi = history.map(({ role, content: text }) => ({ role, content: text }))
    const promptTokens = estimateTokens(history.map((message) => message.content).join('\n'))
    const conversationId = activeConversation.id
    setEditingUserId(null)
    setEditingDraft('')
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: [...conversation.messages.slice(0, index), userMessage, assistantMessage],
      updatedAt: nowIso(),
    }))
    setAutoFollowMode(true)
    window.setTimeout(() => scrollToLatest('auto'), 0)
    setIsSending(true)
    try {
      const controller = new AbortController()
      abortControllerRef.current = controller
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ settings, messages: messagesForApi, options: buildChatOptions() }),
      })
      if (!response.ok || !response.body) throw new Error(await response.text() || `请求失败：${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as StreamEvent
          applyStreamEvent(parsed, conversationId, assistantMessage.id, promptTokens)
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') applyStreamEvent({ type: 'content', value: '\n\n[已停止]' }, conversationId, assistantMessage.id, promptTokens)
      else applyStreamEvent({ type: 'error', message: error instanceof Error ? error.message : '未知错误' }, conversationId, assistantMessage.id, promptTokens)
    } finally {
      applyStreamEvent({ type: 'done' }, conversationId, assistantMessage.id, promptTokens, abortControllerRef.current?.signal.aborted || false)
      abortControllerRef.current = null
      setIsSending(false)
    }
  }
  function switchMessageBranch(messageId: string, direction: -1 | 1) {
    if (!activeConversation || isSending) return
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (message.id !== messageId || message.role !== 'assistant') return message
        const variants = messageVariants(syncCurrentVariant(message))
        if (variants.length <= 1) return message
        const current = Math.min(Math.max(message.branchIndex || 1, 1), variants.length)
        const next = ((current - 1 + direction + variants.length) % variants.length) + 1
        return applyMessageVariant({ ...message, variants }, variants[next - 1], next, variants.length)
      }),
      updatedAt: nowIso(),
    }))
  }
  async function retryMessage(messageId: string) {
    if (isSending || !activeConversation) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId)
    const previousUser = [...activeConversation.messages.slice(0, index)].reverse().find((message) => message.role === 'user')
    if (!previousUser) return
    const oldAssistant = syncCurrentVariant(activeConversation.messages[index])
    const previousVariants = messageVariants(oldAssistant)
    const nextBranchTotal = previousVariants.length + 1
    const assistantMessage: Message = { id: createId(), role: 'assistant', content: '', reasoning: '', createdAt: nowIso(), deepThink, webSearch, branchIndex: nextBranchTotal, branchTotal: nextBranchTotal, variants: previousVariants }
    const history = activeConversation.messages.slice(0, index).filter((message) => message.role !== 'assistant' || message.content.trim())
    const messagesForApi = history.map(({ role, content: text }) => ({ role, content: text }))
    const promptTokens = estimateTokens(history.map((message) => message.content).join('\n'))
    const conversationId = activeConversation.id

    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: [...conversation.messages.slice(0, index), assistantMessage, ...conversation.messages.slice(index + 1)],
      updatedAt: nowIso(),
    }))
    setIsSending(true)

    try {
      const controller = new AbortController()
      abortControllerRef.current = controller
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ settings, messages: messagesForApi, options: buildChatOptions() }),
      })
      if (!response.ok || !response.body) throw new Error(await response.text() || `请求失败：${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as StreamEvent
          applyStreamEvent(parsed, conversationId, assistantMessage.id, promptTokens)
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') applyStreamEvent({ type: 'content', value: '\n\n[已停止]' }, conversationId, assistantMessage.id, promptTokens)
      else applyStreamEvent({ type: 'error', message: error instanceof Error ? error.message : '未知错误' }, conversationId, assistantMessage.id, promptTokens)
    } finally {
      applyStreamEvent({ type: 'done' }, conversationId, assistantMessage.id, promptTokens, abortControllerRef.current?.signal.aborted || false)
      abortControllerRef.current = null
      setIsSending(false)
    }
  }
  function exportBackup() {
    const backup: Backup = { version: 1, exportedAt: nowIso(), settings, conversations }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `ai-talking-backup-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function importBackground(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      setSettings((current) => ({
        ...current,
        theme: { ...current.theme, backgroundImage: String(reader.result || ''), backgroundImageName: file.name },
      }))
    }
    reader.readAsDataURL(file)
  }

  async function importBackup(file: File) {
    try {
      const backup = JSON.parse(await file.text()) as Backup
      if (!backup.settings || !Array.isArray(backup.conversations)) throw new Error('备份格式不正确')
      const importedConversations = backup.conversations.length ? backup.conversations.map((conversation) => normalizeConversation(conversation as Conversation)) : [createConversation()]
      setSettings(normalizeSettings(backup.settings))
      setConversations(importedConversations)
      setActiveId(importedConversations[0].id)
      setNotice('备份已导入。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '未知错误')
    }
  }

  return (
    <main className={`shell theme-${settings.theme.mode} bg-${settings.theme.backgroundScope} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${settings.theme.showAvatars ? 'avatars-visible' : 'avatars-hidden'}`} style={themeStyle}>
      <aside className="rail" aria-label="主导航">
        <div className="brand">A</div>
        <IconButton label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} active={!sidebarCollapsed} onClick={() => setSidebarCollapsed((value) => !value)}>≡</IconButton>
        <IconButton label="新对话" onClick={startNewConversation}>+</IconButton>
        <IconButton label="设置" active={view === 'settings'} onClick={() => setView('settings')}>⚙</IconButton>
      </aside>

      <section className="conversation-list" aria-label="对话列表">
        <div className="list-header">
          <strong>AI Talking</strong>
        </div>
        <div className="provider-card">
          <span>{settings.providerName}</span>
          <small>{settings.model || '未设置模型'}</small>
        </div>
        <div className="threads">
          {conversationGroups.map((group) => (
            <section className="thread-group" key={group.label}>
              <h3>{group.label}</h3>
              {group.items.map((conversation) => (
                <div
                  className={`thread ${conversation.id === activeId ? 'selected' : ''} ${threadMenu === conversation.id ? 'menu-open' : ''}`}
                  key={conversation.id}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setThreadMenu(conversation.id)
                  }}
                >
                  <button
                    className="thread-main"
                    type="button"
                    onClick={() => {
                      setActiveId(conversation.id)
                      setView('chat')
                      setThreadMenu(null)
                    }}
                  >
                    <span>{conversation.title}</span>
                    <small>{conversation.messages.at(-1)?.content.slice(0, 34) || '暂无消息'}</small>
                  </button>
                  <button
                    className="thread-dots"
                    type="button"
                    aria-label="更多操作"
                    title="重命名 / 删除"
                    onClick={(event) => {
                      event.stopPropagation()
                      setThreadMenu((current) => (current === conversation.id ? null : conversation.id))
                    }}
                  >
                    ⋯
                  </button>
                  {threadMenu === conversation.id && (
                    <div className="thread-menu inline" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                      <button type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); renameConversation(conversation.id); setThreadMenu(null) }}>重命名</button>
                      <button className="danger" type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); deleteConversation(conversation.id); setThreadMenu(null) }}>删除</button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </section>

      {view === 'chat' ? (
        <section className="chat-pane">
          <header className="chat-header">
            <div>
              <h1>{activeConversation?.title || '新对话'}</h1>
              <p>{settings.providerName} / {settings.model || '未设置模型'}</p>
            </div>
          </header>

          <div className={`messages ${autoFollow ? 'is-following' : 'is-paused'}`} ref={messagesRef} onScroll={handleMessagesScroll}>
            {!activeConversation?.messages.length && (
              <div className="empty-state">
                <h2>开始新的对话</h2>
                <p>输入内容后开始聊天，AI 会被要求控制在 3000 字以内。</p>
              </div>
            )}
            {activeConversation?.messages.map((message, index) => (
              <article className={`message ${message.role}`} key={message.id} ref={message.role === 'user' ? (node) => setUserMessageRef(message.id, node) : undefined} data-message-id={message.id}>
                {settings.theme.showAvatars && <div className="avatar">{message.role === 'user' ? settings.userName.slice(0, 1) || '?' : 'AI'}</div>}
                <div className="message-main">
                  {(message.deepThink || message.webSearch || message.reasoning) && message.role === 'assistant' && (
                    <section className="reasoning">
                      <header>{message.webSearch ? '搜索 / 思考' : '思考过程'}</header>
                      <div>{message.reasoning || (isSending && index === activeConversation.messages.length - 1 ? '正在整理思考过程...' : '暂无思考内容')}</div>
                    </section>
                  )}
                  {message.role === 'user' && editingUserId === message.id ? (
                    <form className="edit-message" onSubmit={(event) => { event.preventDefault(); submitUserEdit(message.id) }}>
                      <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} autoFocus />
                      <div><button type="button" onClick={() => { setEditingUserId(null); setEditingDraft('') }}>取消</button><button type="submit" disabled={!editingDraft.trim()}>提交</button></div>
                    </form>
                  ) : (
                    <div className="bubble"><RenderMarkdown content={message.content || (isSending && index === activeConversation.messages.length - 1 ? '生成中...' : '')} citations={message.citations} /></div>
                  )}
                  {message.role === 'user' && (
                    <div className="user-actions">
                      <span>{formatTime(message.createdAt)}</span>
                      <button type="button" aria-label="编辑" onClick={() => startEditingUserMessage(message)}>✎</button>
                      {(message.branchTotal || 1) > 1 && (
                        <span className="branch-chip">
                          <button type="button" disabled={isSending} onClick={() => switchUserBranch(message.id, -1)}>‹</button>
                          <b>{message.branchIndex || 1}/{message.branchTotal || 1}</b>
                          <button type="button" disabled={isSending} onClick={() => switchUserBranch(message.id, 1)}>›</button>
                        </span>
                      )}
                    </div>
                  )}
                  {message.role === 'assistant' && (message.completedAt || isSending) && (
                    <div className="meta-line">
                      <span>{message.tokenUsage ? `Input ${message.tokenUsage.prompt} tokens / Output ${message.tokenUsage.completion} tokens / Total ${message.tokenUsage.total} tokens` : 'tokens 统计中'}</span>
                      <span>时间 {message.completedAt ? formatTime(message.completedAt) : formatTime(nowIso())}</span>
                      {message.interrupted && <span>已中断</span>}
                      {message.completedAt && (
                        <span className="branch-chip">
                          <button type="button" disabled={(message.branchTotal || 1) <= 1 || isSending} onClick={() => switchMessageBranch(message.id, -1)}>&lt;</button>
                          <b>{message.branchIndex || 1}/{message.branchTotal || 1}</b>
                          <button type="button" disabled={(message.branchTotal || 1) <= 1 || isSending} onClick={() => switchMessageBranch(message.id, 1)}>&gt;</button>
                        </span>
                      )}
                      {message.completedAt && <button type="button" onClick={() => retryMessage(message.id)}>Retry</button>}
                    </div>
                  )}
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div>

          {userNavigatorMessages.length > 0 && (
            <nav className="message-navigator" aria-label="Conversation Message Navigator">
              {userNavigatorMessages.map((message) => (
                <button
                  className={message.id === activeUserMessageId ? 'active' : ''}
                  key={message.id}
                  type="button"
                  title={message.content}
                  onClick={() => jumpToUserMessage(message.id)}
                >
                  <span>{message.content}</span>
                </button>
              ))}
            </nav>
          )}

          {showJumpLatest && (
            <button className="jump-latest" type="button" onClick={() => scrollToLatest()}>
              ↓ 回到最新消息
            </button>
          )}

          <form className="composer" onSubmit={sendMessage}>
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="给 AI 发送消息"
            />
            <div className="composer-bar">
              <div className="tool-group">
                <IconButton label="深度思考" active={deepThink} disabled={isSending} onClick={() => setDeepThink((value) => !value)}>T</IconButton>
                <IconButton label="联网搜索" active={webSearch} disabled={isSending} onClick={() => setWebSearch((value) => !value)}>⌕</IconButton>
                <label className="length-control" title="auto: no fixed target; custom enables continuation guard">
                  <span>{'\u957f\u5ea6'}</span>
                  <select value={activeConversation?.responseLengthMode || 'auto'} disabled={isSending} onChange={(event) => setConversationLength({ responseLengthMode: event.target.value as ResponseLengthMode })}>
                    <option value="auto">{'\u81ea\u52a8'}</option>
                    <option value="brief">{'\u7b80\u77ed'}</option>
                    <option value="standard">{'\u6807\u51c6'}</option>
                    <option value="detailed">{'\u8be6\u7ec6'}</option>
                    <option value="custom">{'\u81ea\u5b9a\u4e49'}</option>
                  </select>
                </label>
                {(activeConversation?.responseLengthMode || 'auto') === 'custom' && (
                  <label className="target-chars" title="custom target chars enables under-length continuation">
                    <span>{'\u76ee\u6807\u5b57\u6570'}</span>
                    <input type="number" min="300" max="12000" step="100" value={activeConversation?.targetChars || 3000} disabled={isSending} onChange={(event) => setConversationLength({ targetChars: Number(event.target.value) })} />
                  </label>
                )}
                {deepThink && (
                  <label className="thinking-slider" title="越靠右思考越强，token 消耗越高">
                    <span>Thinking</span>
                    <input type="range" min="1" max="100" value={thinkingLevel} disabled={isSending} onChange={(event) => setThinkingLevel(Number(event.target.value))} />
                    <b>{thinkingLabel(thinkingLevel)}</b>
                  </label>
                )}
                <IconButton label="清空输入" disabled={isSending || !draft} onClick={() => setDraft('')}>×</IconButton>
              </div>
              <button className={`send-button ${isSending ? 'stop' : ''}`} type={isSending ? 'button' : 'submit'} disabled={!isSending && !draft.trim()} aria-label={isSending ? '停止生成' : '发送'} onClick={isSending ? stopGeneration : undefined}>{isSending ? <span className="stop-mark" /> : <span className="send-mark">↑</span>}</button>
            </div>
          </form>
        </section>
      ) : (
        <section className="settings-pane">
          <header className="settings-header">
            <h1>设置</h1>
            <p>管理 API、模型、主题和备份。</p>
          </header>

          {notice && <div className="notice">{notice}</div>}

          <section className="panel">
            <div className="section-title"><h2>接口</h2><p>选择商家或手动填写 Base URL。</p></div>
            <div className="settings-grid">
              <label><span>你的名字</span><input value={settings.userName} onChange={(event) => setSettings({ ...settings, userName: event.target.value })} /></label>
              <div className="provider-picker">
                <span>商家</span>
                <div>
                  {providers.map((provider) => (
                    <button className={settings.providerId === provider.id ? 'selected' : ''} key={provider.id} type="button" onClick={() => chooseProvider(provider.id)}>
                      <strong>{provider.name}</strong>
                      <small>{provider.note}</small>
                    </button>
                  ))}
                </div>
              </div>
              <label><span>Base URL</span><input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value, providerId: 'custom', providerName: '自定义' })} /></label>
              <label><span>模型</span><input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label>
              <label className="wide"><span>API Key</span><input type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} placeholder="只保存在本地浏览器" /></label>
            </div>
          </section>

          <section className="panel settings-section theme-section">
            <div className="section-title"><h2>主题与颜色</h2><p>控制应用的基础颜色、模式和 Hover 状态。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>颜色模式</span><select value={settings.theme.mode} onChange={(event) => setTheme({ mode: event.target.value as ThemeSettings['mode'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label><span>背景颜色</span><input type="color" value={settings.theme.backgroundColor} onChange={(event) => setTheme({ backgroundColor: event.target.value })} /></label>
              <label><span>字体颜色</span><input type="color" value={settings.theme.textColor} onChange={(event) => setTheme({ textColor: event.target.value })} /></label>
              <label><span>左侧 Hover 背景</span><input type="color" value={settings.theme.hoverBackgroundColor} onChange={(event) => setTheme({ hoverBackgroundColor: event.target.value })} /></label>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="section-title"><h2>背景</h2><p>透明度、图片模糊和应用范围彼此独立。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>背景应用范围</span><select value={settings.theme.backgroundScope} onChange={(event) => setTheme({ backgroundScope: event.target.value as ThemeSettings['backgroundScope'] })}><option value="global">全局</option><option value="chat">仅聊天区域</option></select></label>
              <label><span>背景图片透明度 {settings.theme.backgroundOpacity}%</span><input type="range" min="0" max="100" value={settings.theme.backgroundOpacity} onChange={(event) => setTheme({ backgroundOpacity: Number(event.target.value) })} /></label>
              <label><span>背景图片模糊 {settings.theme.backgroundBlur}px</span><input type="range" min="0" max="30" value={settings.theme.backgroundBlur} onChange={(event) => setTheme({ backgroundBlur: Number(event.target.value) })} /></label>
              <div className="background-upload wide">
                <span>背景图片</span>
                <div>
                  <button className="plain-action" type="button" onClick={() => backgroundInputRef.current?.click()}>{settings.theme.backgroundImage ? `已选择：${settings.theme.backgroundImageName || '背景图片'}` : '选择背景图片'}</button>
                  {settings.theme.backgroundImage && <button className="plain-action" type="button" onClick={() => setTheme({ backgroundImage: '', backgroundImageName: '' })}>清除背景图</button>}
                </div>
                <input ref={backgroundInputRef} type="file" accept="image/*" hidden onChange={(event) => event.target.files?.[0] && importBackground(event.target.files[0])} />
              </div>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="section-title"><h2>界面与毛玻璃</h2><p>只调整 UI 的 backdrop blur，不影响背景图片本身。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>面板毛玻璃 {settings.theme.panelGlassBlur}px</span><input type="range" min="0" max="40" value={settings.theme.panelGlassBlur} onChange={(event) => setTheme({ panelGlassBlur: Number(event.target.value) })} /></label>
              <label><span>聊天气泡毛玻璃 {settings.theme.bubbleGlassBlur}px</span><input type="range" min="0" max="40" value={settings.theme.bubbleGlassBlur} onChange={(event) => setTheme({ bubbleGlassBlur: Number(event.target.value) })} /></label>
              <label><span>输入框毛玻璃 {settings.theme.composerGlassBlur}px</span><input type="range" min="0" max="40" value={settings.theme.composerGlassBlur} onChange={(event) => setTheme({ composerGlassBlur: Number(event.target.value) })} /></label>
              <label><span>左侧栏毛玻璃 {settings.theme.sidebarGlassBlur}px</span><input type="range" min="0" max="40" value={settings.theme.sidebarGlassBlur} onChange={(event) => setTheme({ sidebarGlassBlur: Number(event.target.value) })} /></label>
              <label><span>Hover / 选中毛玻璃 {settings.theme.hoverGlassBlur}px</span><input type="range" min="0" max="40" value={settings.theme.hoverGlassBlur} onChange={(event) => setTheme({ hoverGlassBlur: Number(event.target.value) })} /></label>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="section-title"><h2>聊天气泡</h2><p>分别调整用户和 AI 消息的颜色与透明度。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>用户气泡</span><input type="color" value={settings.theme.userBubbleColor} onChange={(event) => setTheme({ userBubbleColor: event.target.value })} /></label>
              <label><span>用户气泡透明度 {settings.theme.userBubbleOpacity}%</span><input type="range" min="0" max="100" value={settings.theme.userBubbleOpacity} onChange={(event) => setTheme({ userBubbleOpacity: Number(event.target.value) })} /></label>
              <label><span>AI 气泡</span><input type="color" value={settings.theme.assistantBubbleColor === 'transparent' ? '#ffffff' : settings.theme.assistantBubbleColor} onChange={(event) => setTheme({ assistantBubbleColor: event.target.value })} /></label>
              <label><span>AI 气泡透明度 {settings.theme.assistantBubbleOpacity}%</span><input type="range" min="0" max="100" value={settings.theme.assistantBubbleOpacity} onChange={(event) => setTheme({ assistantBubbleOpacity: Number(event.target.value) })} /></label>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="section-title"><h2>搜索 / 思考 与 Token</h2><p>调整推理区和 Token 信息气泡的文字、背景和透明度。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>思考文字</span><input type="color" value={settings.theme.reasoningTextColor} onChange={(event) => setTheme({ reasoningTextColor: event.target.value })} /></label>
              <label><span>思考背景</span><input type="color" value={settings.theme.reasoningBackgroundColor} onChange={(event) => setTheme({ reasoningBackgroundColor: event.target.value })} /></label>
              <label><span>思考背景透明度 {settings.theme.reasoningBackgroundOpacity}%</span><input type="range" min="0" max="100" value={settings.theme.reasoningBackgroundOpacity} onChange={(event) => setTheme({ reasoningBackgroundOpacity: Number(event.target.value) })} /></label>
              <label><span>Token 文字</span><input type="color" value={settings.theme.tokenTextColor} onChange={(event) => setTheme({ tokenTextColor: event.target.value })} /></label>
              <label><span>Token 气泡</span><input type="color" value={settings.theme.tokenBackgroundColor} onChange={(event) => setTheme({ tokenBackgroundColor: event.target.value })} /></label>
              <label><span>Token 气泡透明度 {settings.theme.tokenBackgroundOpacity}%</span><input type="range" min="0" max="100" value={settings.theme.tokenBackgroundOpacity} onChange={(event) => setTheme({ tokenBackgroundOpacity: Number(event.target.value) })} /></label>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="section-title"><h2>文字与默认聊天</h2><p>设置字号和新对话默认工具开关。</p></div>
            <div className="settings-grid theme-grid">
              <label><span>字体大小 {settings.theme.fontSize}px</span><input type="range" min="13" max="22" value={settings.theme.fontSize} onChange={(event) => setTheme({ fontSize: Number(event.target.value) })} /></label>
              <label><span>显示头像</span><input type="checkbox" checked={settings.theme.showAvatars} onChange={(event) => setTheme({ showAvatars: event.target.checked })} /></label>

              <label><span>默认深度思考</span><input type="checkbox" checked={settings.defaultDeepThink} onChange={(event) => setSettings({ ...settings, defaultDeepThink: event.target.checked })} /></label>
              <label><span>默认联网搜索</span><input type="checkbox" checked={settings.defaultWebSearch} onChange={(event) => setSettings({ ...settings, defaultWebSearch: event.target.checked })} /></label>
            </div>
          </section>

          <section className="panel settings-section preview-section">
            <div className="section-title"><h2>实时预览</h2><p>单独展示背景、气泡、思考区和 Token 样式。</p></div>
            <div className="theme-preview" aria-label="外观预览">
              <div className="preview-title">当前外观</div>
              <section className="preview-reasoning">
                <header>搜索 / 思考</header>
                <p>这里会显示推理、搜索整理过程。文字、背景、透明度和毛玻璃会跟随设置变化。</p>
              </section>
              <div className="preview-ai">这是 AI 回复示例，Markdown、引用和正文会使用当前字体颜色。</div>
              <div className="preview-token">Input 128 tks / Output 256 tks / Total 384 tks · 12:30:05</div>
              <div className="preview-user">这是你的消息气泡示例。</div>
            </div>
          </section>

          <section className="panel token-panel">
            <div className="section-title"><h2>Token 消耗</h2><p>优先使用接口返回的 usage；没有 usage 时显示本地估算。</p></div>
            <TokenChart conversations={conversations} />
          </section>

          <section className="panel">
            <div className="panel-title"><div><h2>MCP 链接</h2><p>暂时保留配置，不参与联网搜索。</p></div><IconButton label="添加 MCP" onClick={addMcpServer}>+</IconButton></div>
            <div className="mcp-list">
              {settings.mcpServers.length === 0 && <p className="muted">暂无 MCP 链接</p>}
              {settings.mcpServers.map((server) => (
                <div className="mcp-row" key={server.id}>
                  <input value={server.name} onChange={(event) => updateMcpServer(server.id, { name: event.target.value })} />
                  <select value={server.transport} onChange={(event) => updateMcpServer(server.id, { transport: event.target.value as McpServer['transport'] })}><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select>
                  <input value={server.endpoint} onChange={(event) => updateMcpServer(server.id, { endpoint: event.target.value })} placeholder="URL 或命令" />
                  <label className="toggle"><input type="checkbox" checked={server.enabled} onChange={(event) => updateMcpServer(server.id, { enabled: event.target.checked })} />启用</label>
                  <IconButton label="删除" onClick={() => removeMcpServer(server.id)}>×</IconButton>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-title"><div><h2>备份</h2><p>导出或导入设置、对话和 MCP 配置。</p></div><div className="actions"><IconButton label="导出 JSON" onClick={exportBackup}>↓</IconButton><IconButton label="导入 JSON" onClick={() => fileInputRef.current?.click()}>↑</IconButton><input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(event) => event.target.files?.[0] && importBackup(event.target.files[0])} /></div></div>
          </section>
        </section>
      )}
    </main>
  )
}

export default App






























