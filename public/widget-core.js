export const KEY_COUNT = 12
export const PROFILE_IDS = ['home', '1', '2', '3', '4', '5', '6', '7']
export const PROFILE_LABELS = { home: 'HOME', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7' }

export const TEMPLATE_DEFS = [
  { id: 'url', label: 'URL', defaultColor: '#000000', placeholder: 'ex: https://google.com' },
  { id: 'command', label: 'Commande', defaultColor: '#000000', placeholder: 'ex: notepad.exe ou "C:\\Path\\App.exe" --arg' },
  { id: 'app', label: 'App installee', defaultColor: '#000000', placeholder: 'Recherche app installee (.lnk/.exe)' },
  { id: 'app_volume', label: 'Mixer app', defaultColor: '#000000', placeholder: 'App cible (ex: spotify.exe ou chemin .exe/.lnk)' },
  { id: 'key_press', label: 'Inserer une touche', defaultColor: '#000000', placeholder: 'ex: F1, DELETE, !, a, 5' },
  { id: 'multi_action', label: 'Multi-action', defaultColor: '#000000', placeholder: '' },
  { id: 'macro', label: 'Macro', defaultColor: '#000000', placeholder: 'ex: abc123' },
  { id: 'paste_text', label: 'Coller texte', defaultColor: '#000000', placeholder: 'Texte a coller via clavier' },
]

export function templateById(id) {
  return TEMPLATE_DEFS.find(t => t.id === id) || null
}

export function templateLabel(templateId) {
  return templateById(templateId)?.label || templateId
}

export function actionTypeLabel(type) {
  if (type === 'url') return 'URL'
  if (type === 'app') return 'APP'
  if (type === 'app_volume') return 'VOL'
  if (type === 'key_press') return 'KEY'
  if (type === 'multi_action') return 'MULTI'
  if (type === 'macro') return 'MACRO'
  if (type === 'paste_text') return 'TEXT'
  return 'CMD'
}

export function normalizeColor(value, fallback = '#000000') {
  const text = String(value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback
}

export function normalizeActionType(value) {
  const t = String(value || '').trim().toLowerCase()
  if (t === 'url') return 'url'
  if (t === 'app') return 'app'
  if (t === 'app_volume') return 'app_volume'
  if (t === 'key_press') return 'key_press'
  if (t === 'multi_action') return 'multi_action'
  if (t === 'macro') return 'macro'
  if (t === 'paste_text') return 'paste_text'
  return 'command'
}

export function clampDelayMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 120
  return Math.max(0, Math.min(10000, Math.round(n)))
}

export function parseMacroValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return { keys: '', delayMs: 120 }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return {
        keys: String(parsed.keys ?? parsed.text ?? ''),
        delayMs: clampDelayMs(parsed.delayMs),
      }
    }
  } catch {
    // plain fallback
  }
  return { keys: raw, delayMs: 120 }
}

export function buildMacroValue(keys, delayMs) {
  return JSON.stringify({
    keys: String(keys || ''),
    delayMs: clampDelayMs(delayMs),
  })
}

export function parsePasteTextValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return { text: '' }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return {
        text: String(parsed.text ?? parsed.keys ?? ''),
      }
    }
  } catch {
    // plain fallback
  }
  return { text: String(value || '') }
}

export function parseMultiActionValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return { steps: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
      const steps = parsed.steps
        .filter(step => step && typeof step === 'object')
        .map(step => ({
          name: String(step.name || step.label || '').slice(0, 30),
          actionType: normalizeActionType(step.actionType),
          value: String(step.value || ''),
        }))
        .filter(step => step.actionType !== 'multi_action')
      return { steps }
    }
  } catch {
    // ignore
  }
  return { steps: [] }
}

export function buildMultiActionValue(steps) {
  const safeSteps = Array.isArray(steps)
    ? steps
        .filter(step => step && typeof step === 'object')
        .map(step => ({
          name: String(step.name || '').slice(0, 30),
          actionType: normalizeActionType(step.actionType),
          value: String(step.value || ''),
        }))
        .filter(step => step.actionType !== 'multi_action')
    : []

  return JSON.stringify({ steps: safeSteps })
}

export function profileLabel(id) {
  return PROFILE_LABELS[id] || id
}

export function defaultShortcut(key) {
  return {
    key,
    label: `Key ${key}`,
    color: '#000000',
    actionType: 'command',
    value: '',
    iconPath: '',
  }
}

export function defaultConfig() {
  const profileColors = {}
  const profiles = {}
  for (const profile of PROFILE_IDS) {
    profileColors[profile] = '#ffffff'
    profiles[profile] = Array.from({ length: KEY_COUNT }, (_, key) => defaultShortcut(key))
  }
  return {
    version: 2,
    activeProfile: 'home',
    profileColors,
    profiles,
  }
}

export function hasMeaningfulShortcut(item) {
  const key = Number(item.key)
  const isDefaultLabel = String(item.label || '').trim().toLowerCase() === `key ${key}`
  return Boolean(item.value || item.iconPath || !isDefaultLabel)
}

export function ensureConfigShape(config) {
  const safe = config && typeof config === 'object' ? { ...config } : {}
  safe.version = 2
  safe.activeProfile = PROFILE_IDS.includes(String(safe.activeProfile)) ? String(safe.activeProfile) : 'home'
  safe.profileColors = safe.profileColors && typeof safe.profileColors === 'object' ? { ...safe.profileColors } : {}
  safe.profiles = safe.profiles && typeof safe.profiles === 'object' ? { ...safe.profiles } : {}

  for (const profile of PROFILE_IDS) {
    safe.profileColors[profile] = normalizeColor(safe.profileColors[profile], '#ffffff')
    const src = Array.isArray(safe.profiles[profile]) ? safe.profiles[profile] : []
    const sorted = [...src].sort((a, b) => Number(a.key) - Number(b.key))
    const out = []
    for (let key = 0; key < KEY_COUNT; key += 1) {
      const item = sorted.find(s => Number(s.key) === key)
      if (!item) {
        out.push(defaultShortcut(key))
        continue
      }
      out.push({
        key,
        label: String(item.label || `Key ${key}`).slice(0, 30),
        color: normalizeColor(item.color),
        actionType: normalizeActionType(item.actionType),
        value: String(item.value || ''),
        iconPath: String(item.iconPath || ''),
      })
    }
    safe.profiles[profile] = out
  }

  return safe
}
