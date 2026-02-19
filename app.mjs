import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { discover } from 'loupedeck'
import { Jimp, ResizeStrategy } from 'jimp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = 3210
const PUBLIC_DIR = path.join(__dirname, 'public')
const CONFIG_DIR = path.join(__dirname, 'config')
const CONFIG_PATH = path.join(CONFIG_DIR, 'shortcuts.json')
const ICONS_DIR = path.join(CONFIG_DIR, 'icons')
const KEY_COUNT = 12
const CONFIG_VERSION = 2
const KEY_DEBOUNCE_MS = 250
const PROFILE_IDS = ['home', '1', '2', '3', '4', '5', '6', '7']
const BOTTOM_BUTTON_TO_PROFILE = {
  0: 'home',
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
}
const PROFILE_TO_BOTTOM_BUTTON = {
  home: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
}

const state = {
  device: null,
  connected: false,
  connecting: false,
  lastEvent: '',
  warnings: [],
  keyLastPressedAt: new Map(),
  logoCache: new Map(),
  appIconCache: new Map(),
  customIconCache: new Map(),
  appCatalog: null,
  appCatalogAt: 0,
  configCache: null,
  configMtimeMs: 0,
}

function isProfileId(value) {
  return PROFILE_IDS.includes(String(value))
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function defaultProfileColors() {
  const colors = {}
  for (const id of PROFILE_IDS) colors[id] = '#ffffff'
  return colors
}

function defaultShortcuts() {
  const shortcuts = []
  for (let key = 0; key < KEY_COUNT; key += 1) {
    shortcuts.push({
      key,
      label: `Key ${key}`,
      color: '#000000',
      actionType: 'command',
      value: '',
      iconPath: '',
    })
  }
  return shortcuts
}

function defaultConfig() {
  const profiles = {}
  for (const id of PROFILE_IDS) {
    profiles[id] = defaultShortcuts()
  }
  return {
    version: CONFIG_VERSION,
    activeProfile: 'home',
    profileColors: defaultProfileColors(),
    profiles,
  }
}

function setLastEvent(text) {
  state.lastEvent = `[${new Date().toLocaleTimeString()}] ${text}`
  console.log(state.lastEvent)
}

function normalizeHexColor(value) {
  const text = String(value ?? '').trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) return '#000000'
  return text.toLowerCase()
}

function normalizeHexColorWithFallback(value, fallback) {
  const text = String(value ?? '').trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) return fallback
  return text.toLowerCase()
}

function sanitizeLabel(value, key) {
  return String(value ?? `Key ${key}`).trim().slice(0, 30)
}

function sanitizeValue(value) {
  return String(value ?? '').trim()
}

function normalizeActionType(value) {
  const type = String(value ?? '').trim().toLowerCase()
  if (type === 'url') return 'url'
  if (type === 'app') return 'app'
  if (type === 'macro') return 'macro'
  if (type === 'paste_text') return 'paste_text'
  return 'command'
}

function sanitizeIconPath(value) {
  const text = String(value ?? '').trim().replaceAll('\\', '/')
  if (!text) return ''
  if (!text.startsWith('config/icons/')) return ''
  if (text.includes('..')) return ''
  if (!/\.(png|jpg|jpeg|webp)$/i.test(text)) return ''
  return text
}

function isValidShortcutShape(item) {
  return item && typeof item === 'object'
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeShortcutsLenient(rawList, issues, profileId) {
  const result = defaultShortcuts()
  if (!Array.isArray(rawList)) {
    issues.push(`Profil ${profileId}: raccourcis invalides, defaults appliqués.`)
    return result
  }

  const seen = new Set()
  for (const raw of rawList) {
    if (!isValidShortcutShape(raw)) {
      issues.push(`Profil ${profileId}: un raccourci invalide a été ignoré.`)
      continue
    }

    const key = Number(raw.key)
    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) {
      issues.push(`Profil ${profileId}: key invalide (${String(raw.key)}) ignorée.`)
      continue
    }

    if (seen.has(key)) {
      issues.push(`Profil ${profileId}: doublon key ${key}, entrée ignorée.`)
      continue
    }

    result[key] = {
      key,
      label: sanitizeLabel(raw.label, key),
      color: normalizeHexColor(raw.color),
      actionType: normalizeActionType(raw.actionType),
      value: sanitizeValue(raw.value),
      iconPath: sanitizeIconPath(raw.iconPath),
    }
    seen.add(key)
  }

  return result
}

function normalizeConfigLenient(input) {
  const base = defaultConfig()
  const issues = []

  if (!input || typeof input !== 'object') {
    issues.push('Config absente ou invalide, defaults appliqués.')
    return { config: base, issues }
  }

  if (Array.isArray(input.shortcuts)) {
    issues.push('Migration config v1 -> v2 appliquée (profil HOME).')
    base.profiles.home = normalizeShortcutsLenient(input.shortcuts, issues, 'home')
    return { config: base, issues }
  }

  if (input.version !== CONFIG_VERSION) {
    issues.push(`Version de config invalide (${String(input.version)}), version ${CONFIG_VERSION} appliquée.`)
  }

  if (!input.profiles || typeof input.profiles !== 'object') {
    issues.push('profiles invalide, defaults appliqués.')
    return { config: base, issues }
  }

  base.activeProfile = isProfileId(input.activeProfile) ? String(input.activeProfile) : 'home'
  if (!isProfileId(input.activeProfile)) {
    issues.push('activeProfile invalide, profil HOME appliqué.')
  }

  if (input.profileColors && typeof input.profileColors === 'object') {
    for (const profileId of PROFILE_IDS) {
      base.profileColors[profileId] = normalizeHexColorWithFallback(input.profileColors[profileId], '#ffffff')
    }
  }

  for (const profileId of PROFILE_IDS) {
    base.profiles[profileId] = normalizeShortcutsLenient(input.profiles[profileId], issues, profileId)
  }

  return { config: base, issues }
}

function validateShortcutArrayStrict(rawList, profileId, errors) {
  if (!Array.isArray(rawList)) {
    errors.push(`profiles.${profileId} doit être un tableau.`)
    return null
  }

  if (rawList.length !== KEY_COUNT) {
    errors.push(`profiles.${profileId} doit contenir exactement ${KEY_COUNT} éléments.`)
  }

  const seenKeys = new Set()
  rawList.forEach((item, index) => {
    if (!isValidShortcutShape(item)) {
      errors.push(`profiles.${profileId}[${index}] doit être un objet.`)
      return
    }

    const key = Number(item.key)
    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) {
      errors.push(`profiles.${profileId}[${index}].key doit être un entier entre 0 et ${KEY_COUNT - 1}.`)
    } else if (seenKeys.has(key)) {
      errors.push(`profiles.${profileId} contient un doublon de key ${key}.`)
    } else {
      seenKeys.add(key)
    }

    if (typeof item.label !== 'string' || item.label.trim().length === 0 || item.label.length > 30) {
      errors.push(`profiles.${profileId}[${index}].label doit être une string de 1 à 30 caractères.`)
    }

    if (typeof item.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item.color)) {
      errors.push(`profiles.${profileId}[${index}].color doit respecter #RRGGBB.`)
    }

    if (!['command', 'url', 'app', 'macro', 'paste_text'].includes(item.actionType)) {
      errors.push(`profiles.${profileId}[${index}].actionType doit être "command", "url", "app", "macro" ou "paste_text".`)
    }

    if (typeof item.value !== 'string') {
      errors.push(`profiles.${profileId}[${index}].value doit être une string.`)
    }

    if (item.iconPath !== undefined && typeof item.iconPath !== 'string') {
      errors.push(`profiles.${profileId}[${index}].iconPath doit être une string.`)
    }
  })

  for (let key = 0; key < KEY_COUNT; key += 1) {
    if (!seenKeys.has(key)) errors.push(`profiles.${profileId} doit contenir key ${key}.`)
  }

  return rawList
    .map(item => ({
      key: Number(item.key),
      label: sanitizeLabel(item.label, Number(item.key)),
      color: normalizeHexColor(item.color),
      actionType: normalizeActionType(item.actionType),
      value: sanitizeValue(item.value),
      iconPath: sanitizeIconPath(item.iconPath),
    }))
    .sort((a, b) => a.key - b.key)
}

function validateConfigStrict(input) {
  const errors = []

  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['Payload JSON invalide.'] }
  }

  if (input.version !== CONFIG_VERSION) {
    errors.push(`version doit être ${CONFIG_VERSION}.`)
  }

  if (!isProfileId(input.activeProfile)) {
    errors.push(`activeProfile doit être l'un de: ${PROFILE_IDS.join(', ')}.`)
  }

  if (!input.profiles || typeof input.profiles !== 'object') {
    errors.push('profiles doit être un objet.')
  }

  const normalizedProfileColors = defaultProfileColors()
  if (input.profileColors !== undefined) {
    if (!input.profileColors || typeof input.profileColors !== 'object') {
      errors.push('profileColors doit être un objet.')
    } else {
      for (const profileId of PROFILE_IDS) {
        const value = input.profileColors[profileId]
        if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
          errors.push(`profileColors.${profileId} doit respecter #RRGGBB.`)
        } else {
          normalizedProfileColors[profileId] = normalizeHexColorWithFallback(value, '#ffffff')
        }
      }
    }
  }

  const normalizedProfiles = {}
  for (const profileId of PROFILE_IDS) {
    const normalized = validateShortcutArrayStrict(input?.profiles?.[profileId], profileId, errors)
    if (normalized) normalizedProfiles[profileId] = normalized
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      activeProfile: input.activeProfile,
      profileColors: normalizedProfileColors,
      profiles: normalizedProfiles,
    },
  }
}

async function ensureConfigFile() {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.mkdir(ICONS_DIR, { recursive: true })
  try {
    await fs.access(CONFIG_PATH)
  } catch {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), 'utf-8')
  }
}

async function refreshConfigMtime() {
  try {
    const stat = await fs.stat(CONFIG_PATH)
    state.configMtimeMs = stat.mtimeMs || Date.now()
  } catch {
    state.configMtimeMs = Date.now()
  }
}

async function isConfigCacheFresh() {
  if (!state.configCache) return false
  try {
    const stat = await fs.stat(CONFIG_PATH)
    return Math.abs((stat.mtimeMs || 0) - (state.configMtimeMs || 0)) < 1
  } catch {
    return false
  }
}

function setConfigCache(config) {
  state.configCache = deepClone(config)
}

async function readConfig() {
  await ensureConfigFile()
  if (await isConfigCacheFresh()) return deepClone(state.configCache)

  let raw
  try {
    raw = await fs.readFile(CONFIG_PATH, 'utf-8')
  } catch {
    const config = defaultConfig()
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    state.warnings = ['Impossible de lire la config, defaults restaurés.']
    setLastEvent(state.warnings[0])
    setConfigCache(config)
    await refreshConfigMtime()
    return deepClone(config)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const config = defaultConfig()
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    state.warnings = ['JSON de config invalide, defaults restaurés.']
    setLastEvent(state.warnings[0])
    setConfigCache(config)
    await refreshConfigMtime()
    return deepClone(config)
  }

  const { config, issues } = normalizeConfigLenient(parsed)
  state.warnings = issues

  if (issues.length > 0) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    setLastEvent(`Config corrigée automatiquement (${issues.length} avertissement(s)).`)
  }

  setConfigCache(config)
  await refreshConfigMtime()
  return deepClone(config)
}

async function writeConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  setConfigCache(config)
  await refreshConfigMtime()
}

async function getCurrentConfig() {
  if (state.configCache) return deepClone(state.configCache)
  return readConfig()
}

function hexToRgb565(hexColor) {
  const hex = normalizeHexColor(hexColor).slice(1)
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const r5 = (r >> 3) & 0x1f
  const g6 = (g >> 2) & 0x3f
  const b5 = (b >> 3) & 0x1f
  return (r5 << 11) | (g6 << 5) | b5
}

function hexToRgb(hexColor) {
  const hex = normalizeHexColor(hexColor).slice(1)
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

function makeSolidBuffer(size, rgb565) {
  const pixels = size * size
  const buffer = Buffer.alloc(pixels * 2)
  for (let i = 0; i < pixels; i += 1) {
    buffer.writeUInt16LE(rgb565, i * 2)
  }
  return buffer
}

function rgbTo565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

function overlayLogoOnBuffer(baseBuffer, keySize, logoImage, bgColor) {
  const x0 = Math.floor((keySize - logoImage.bitmap.width) / 2)
  const y0 = Math.floor((keySize - logoImage.bitmap.height) / 2)

  for (let y = 0; y < logoImage.bitmap.height; y += 1) {
    const dstY = y0 + y
    if (dstY < 0 || dstY >= keySize) continue

    for (let x = 0; x < logoImage.bitmap.width; x += 1) {
      const dstX = x0 + x
      if (dstX < 0 || dstX >= keySize) continue

      const srcOffset = (y * logoImage.bitmap.width + x) * 4
      const lr = logoImage.bitmap.data[srcOffset]
      const lg = logoImage.bitmap.data[srcOffset + 1]
      const lb = logoImage.bitmap.data[srcOffset + 2]
      const la = logoImage.bitmap.data[srcOffset + 3]
      if (la === 0) continue

      const alpha = la / 255
      const r = Math.round(lr * alpha + bgColor.r * (1 - alpha))
      const g = Math.round(lg * alpha + bgColor.g * (1 - alpha))
      const b = Math.round(lb * alpha + bgColor.b * (1 - alpha))

      const pixelIndex = dstY * keySize + dstX
      baseBuffer.writeUInt16LE(rgbTo565(r, g, b), pixelIndex * 2)
    }
  }
}

function makeBufferFromRgba(image, width, height) {
  const pixels = width * height
  const buffer = Buffer.alloc(pixels * 2)

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4
    const r = image.bitmap.data[offset]
    const g = image.bitmap.data[offset + 1]
    const b = image.bitmap.data[offset + 2]
    const rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    buffer.writeUInt16LE(rgb565, i * 2)
  }

  return buffer
}

function getDomainFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function resolveIconAbsolutePath(iconPath) {
  const clean = sanitizeIconPath(iconPath)
  if (!clean) return ''
  const absolute = path.join(__dirname, clean)
  if (!absolute.startsWith(ICONS_DIR)) return ''
  return absolute
}

async function loadCustomIconImage(iconPath, keySize) {
  const clean = sanitizeIconPath(iconPath)
  if (!clean) return null

  const cacheKey = `${clean}@${keySize}`
  if (state.customIconCache.has(cacheKey)) {
    const cached = state.customIconCache.get(cacheKey)
    return cached ? cached.clone() : null
  }

  const absolute = resolveIconAbsolutePath(clean)
  if (!absolute) {
    state.customIconCache.set(cacheKey, null)
    return null
  }

  try {
    const image = await Jimp.read(absolute)
    const targetSize = Math.max(24, Math.floor(keySize * 0.62))
    image.scaleToFit({
      w: targetSize,
      h: targetSize,
      mode: ResizeStrategy.BILINEAR,
    })
    state.customIconCache.set(cacheKey, image.clone())
    return image
  } catch {
    state.customIconCache.set(cacheKey, null)
    return null
  }
}

async function loadLogoImageForUrl(urlValue, keySize) {
  const domain = getDomainFromUrl(urlValue)
  if (!domain) return null

  const cacheKey = `${domain}@${keySize}`
  if (state.logoCache.has(cacheKey)) {
    const cached = state.logoCache.get(cacheKey)
    return cached ? cached.clone() : null
  }

  const sources = [
    `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`,
    `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(`https://${domain}`)}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://logo.clearbit.com/${domain}`,
  ]

  async function fetchLogoImage(url) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const data = Buffer.from(await response.arrayBuffer())
      return Jimp.read(data)
    } finally {
      clearTimeout(timeout)
    }
  }

  for (const source of sources) {
    try {
      const image = await fetchLogoImage(source)
      const targetSize = Math.max(20, Math.floor(keySize * 0.58))
      image.scaleToFit({ w: targetSize, h: targetSize })
      state.logoCache.set(cacheKey, image.clone())
      return image
    } catch {
      // Try next source
    }
  }

  state.logoCache.set(cacheKey, null)
  return null
}

async function drawFromConfig(config) {
  if (!state.device || !state.connected) return
  const activeProfile = isProfileId(config?.activeProfile) ? config.activeProfile : 'home'
  const profileShortcuts = Array.isArray(config?.profiles?.[activeProfile]) ? config.profiles[activeProfile] : defaultShortcuts()
  try {
    await state.device.setBrightness(1).catch(() => {})
    const keySize = state.device.keySize

    // Pass 1: render all key backgrounds immediately.
    for (const item of profileShortcuts) {
      const color = hexToRgb565(item.color)
      const buffer = makeSolidBuffer(keySize, color)
      try {
        await state.device.drawKey(item.key, buffer)
      } catch (error) {
        setLastEvent(`Rendu fond key ${item.key} ignoré: ${error.message}`)
      }
    }

    // Pass 2: overlay URL logos and app icons asynchronously.
    const iconKeys = profileShortcuts.filter(item => item.value)
    await Promise.allSettled(
      iconKeys.map(async item => {
        const bg = hexToRgb(item.color)
        let iconImage = null

        if (item.iconPath) {
          iconImage = await loadCustomIconImage(item.iconPath, keySize)
        } else if (item.actionType === 'url' && isValidHttpUrl(item.value)) {
          iconImage = await loadLogoImageForUrl(item.value, keySize)
        } else if (item.actionType === 'command' || item.actionType === 'app') {
          iconImage = await loadAppIconImageForCommand(item.value, keySize)
        }

        if (!iconImage) return

        const base = makeSolidBuffer(keySize, hexToRgb565(item.color))
        overlayLogoOnBuffer(base, keySize, iconImage, bg)
        await state.device.drawKey(item.key, base)
      }),
    )

    await applyBottomButtonLeds(config)
  } catch (error) {
    setLastEvent(`Erreur de rendu Loupedeck: ${error.message}`)
  }
}

function getProfileLedColor(config, profileId) {
  return normalizeHexColorWithFallback(config?.profileColors?.[profileId], '#ffffff')
}

async function applyBottomButtonLeds(config) {
  if (!state.device || !state.connected || typeof state.device.setButtonColor !== 'function') return
  const activeProfile = isProfileId(config?.activeProfile) ? config.activeProfile : 'home'
  const activeColor = getProfileLedColor(config, activeProfile)

  const tasks = PROFILE_IDS.map(profileId => {
    const buttonId = PROFILE_TO_BOTTOM_BUTTON[profileId]
    if (!Number.isInteger(buttonId)) return Promise.resolve()
    const color = profileId === activeProfile ? activeColor : '#000000'
    return state.device.setButtonColor({ id: buttonId, color }).catch(() => {})
  })

  await Promise.allSettled(tasks)
}

function profileLabel(profileId) {
  return profileId === 'home' ? 'HOME' : profileId
}

function tokenizeCommandLine(commandLine) {
  const input = String(commandLine ?? '').trim()
  if (!input) return []

  const tokens = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]

    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    if (ch === '\\' && i + 1 < input.length && input[i + 1] === '"') {
      current += '"'
      i += 1
      continue
    }

    current += ch
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}

function runExecFile(file, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 6 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || '').trim() || error.message))
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

function parseJsonSafe(raw, fallback = null) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function parseDataUrlImage(dataUrl) {
  const text = String(dataUrl || '')
  const match = text.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  return {
    mime: match[1].toLowerCase(),
    data: Buffer.from(match[2], 'base64'),
  }
}

async function saveCustomIconForKey(key, dataUrl) {
  const parsed = parseDataUrlImage(dataUrl)
  if (!parsed) {
    throw new Error('Format image invalide (data URL attendu).')
  }

  const allowedMime = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
  if (!allowedMime.has(parsed.mime)) {
    throw new Error('Type image non supporté (png, jpg, webp).')
  }

  const image = await Jimp.read(parsed.data)
  image.scaleToFit({
    w: 128,
    h: 128,
    mode: ResizeStrategy.BILINEAR,
  })

  const fileName = `key-${key}-${Date.now()}.png`
  const relativePath = `config/icons/${fileName}`
  const absolutePath = path.join(ICONS_DIR, fileName)
  await image.write(absolutePath)
  return relativePath
}

function buildAppDiscoveryScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$appsByName = @{}

function Normalize-Cmd([string]$cmd) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return '' }
  $x = $cmd.Trim()
  if ($x.Contains(',')) { $x = $x.Split(',')[0] }
  $x = $x.Trim('"').Trim()
  return $x
}

function Is-BaseWindowsApp([string]$name, [string]$publisher, [string]$cmd, [string]$source) {
  $n = ($name + ' ' + $publisher).ToLower()
  if ($source -eq 'registry' -and $n -match 'microsoft') { return $true }
  if ($n -match 'windows defender|windows update|edgewebview|webview2|xbox|onenote|onedrive|cortana|runtime|redistributable') { return $true }
  if ($name -match 'Windows Tools|Accessoires Windows|Administrative Tools|Démarrage|Startup') { return $true }
  if (($cmd.ToLower() -notmatch '\\.lnk$') -and $cmd.ToLower().StartsWith($env:WINDIR.ToLower())) { return $true }
  return $false
}

function Is-InterestingApp([string]$name, [string]$cmd) {
  $n = $name.ToLower()
  $c = $cmd.ToLower().Trim('"')
  $file = [System.IO.Path]::GetFileName($c).ToLower()

  if ($n -match 'uninstall|désinstaller|desinstaller|updater|update|helper|service|crash|report|diagnostic|setup|installer') { return $false }
  if ($file -match '^unins[0-9]*\\.exe$|uninstall|setup|installer|updater|update|helper|service|crash') { return $false }
  if ($c -match '\\\\uninstall(ers)?\\\\|\\\\installer\\\\|\\\\setup\\\\') { return $false }
  return $true
}

function Add-App([string]$name, [string]$cmd, [string]$publisher, [string]$source) {
  if ([string]::IsNullOrWhiteSpace($name)) { return }
  $norm = Normalize-Cmd $cmd
  if ([string]::IsNullOrWhiteSpace($norm)) { return }
  if ($norm -notmatch '\\.(exe|lnk)$') { return }
  if (Is-BaseWindowsApp $name $publisher $norm $source) { return }
  if (-not (Is-InterestingApp $name $norm)) { return }
  if ($norm.Contains(' ')) { $norm = '"' + $norm + '"' }

  $key = $name.Trim().ToLower()
  $priority = if ($norm.ToLower().EndsWith('.lnk"') -or $norm.ToLower().EndsWith('.lnk')) { 2 } else { 1 }

  $candidate = [PSCustomObject]@{
    name = $name.Trim()
    command = $norm
    source = $source
    priority = $priority
  }

  if (-not $appsByName.ContainsKey($key)) {
    $appsByName[$key] = $candidate
    return
  }

  if ($candidate.priority -gt $appsByName[$key].priority) {
    $appsByName[$key] = $candidate
  }
}

$regPaths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

foreach ($path in $regPaths) {
  Get-ItemProperty $path | ForEach-Object {
    $name = $_.DisplayName
    $publisher = $_.Publisher
    $cmd = Normalize-Cmd $_.DisplayIcon
    if ([string]::IsNullOrWhiteSpace($cmd)) {
      $u = Normalize-Cmd $_.UninstallString
      if ($u -match '\\.exe$') { $cmd = $u }
    }
    Add-App $name $cmd $publisher 'registry'
  }
}

$shortcutRoots = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
)
$wsh = New-Object -ComObject WScript.Shell
foreach ($root in $shortcutRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -Filter *.lnk | ForEach-Object {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    Add-App $name $_.FullName '' 'startmenu'
  }
}

$appsByName.Values | Sort-Object name | Select-Object name, command | ConvertTo-Json -Compress
`
}

async function listInstalledApps() {
  const now = Date.now()
  if (state.appCatalog && now - state.appCatalogAt < 60_000) {
    return state.appCatalog
  }

  if (process.platform !== 'win32') {
    state.appCatalog = []
    state.appCatalogAt = now
    return state.appCatalog
  }

  try {
    const raw = await runExecFile('powershell', ['-NoProfile', '-Command', buildAppDiscoveryScript()], 15_000)
    const parsed = parseJsonSafe(raw, [])
    const list = Array.isArray(parsed) ? parsed : []
    state.appCatalog = list
      .filter(item => item && typeof item.name === 'string' && typeof item.command === 'string')
      .map(item => ({ name: item.name.trim(), command: item.command.trim() }))
      .filter(item => item.name && item.command)
    state.appCatalogAt = now
    return state.appCatalog
  } catch (error) {
    setLastEvent(`Scan apps échoué: ${error.message}`)
    state.appCatalog = []
    state.appCatalogAt = now
    return state.appCatalog
  }
}

function escapePsSingleQuoted(value) {
  return String(value).replaceAll("'", "''")
}

async function resolveCommandExecutablePath(commandValue) {
  const tokens = tokenizeCommandLine(commandValue)
  if (tokens.length === 0) return ''
  const executable = tokens[0]

  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.lnk')) {
    const psPath = escapePsSingleQuoted(executable)
    const script = `
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut('${psPath}')
$target = $sc.TargetPath
if ($target) { $target }
`
    try {
      const target = await runExecFile('powershell', ['-NoProfile', '-Command', script], 3000)
      if (target) return target
    } catch {
      return executable
    }
  }

  const looksLikePath = executable.includes('\\') || executable.includes('/') || executable.includes(':')
  if (looksLikePath) return executable
  if (process.platform !== 'win32') return executable

  try {
    const found = await runExecFile('where.exe', [executable], 2500)
    const first = found.split(/\r?\n/).find(Boolean)
    return first || executable
  } catch {
    return executable
  }
}

async function loadAppIconImageForCommand(commandValue, keySize) {
  if (process.platform !== 'win32') return null
  const exePath = await resolveCommandExecutablePath(commandValue)
  if (!exePath) return null

  const cacheKey = `${exePath.toLowerCase()}@${keySize}`
  if (state.appIconCache.has(cacheKey)) {
    const cached = state.appIconCache.get(cacheKey)
    return cached ? cached.clone() : null
  }

  const psPath = escapePsSingleQuoted(exePath)
  const script = `
Add-Type -AssemblyName System.Drawing
$path='${psPath}'
if (-not (Test-Path $path)) { exit 1 }
$icon=[System.Drawing.Icon]::ExtractAssociatedIcon($path)
if ($null -eq $icon) { exit 1 }
$bmp=$icon.ToBitmap()
$ms=New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
$bmp.Dispose()
$icon.Dispose()
`

  try {
    const base64 = await runExecFile('powershell', ['-NoProfile', '-Command', script], 4500)
    if (!base64) {
      state.appIconCache.set(cacheKey, null)
      return null
    }
    const image = await Jimp.read(Buffer.from(base64, 'base64'))
    const maxSize = Math.max(24, Math.floor(keySize * 0.61))
    const srcMax = Math.max(image.bitmap.width, image.bitmap.height)

    if (srcMax < maxSize) {
      const factor = Math.max(1, Math.ceil((maxSize * 0.9) / srcMax))
      if (factor > 1) {
        image.resize({
          w: image.bitmap.width * factor,
          h: image.bitmap.height * factor,
          mode: ResizeStrategy.NEAREST_NEIGHBOR,
        })
      }
    }

    if (image.bitmap.width > maxSize || image.bitmap.height > maxSize) {
      image.scaleToFit({
        w: maxSize,
        h: maxSize,
        mode: ResizeStrategy.NEAREST_NEIGHBOR,
      })
    }
    state.appIconCache.set(cacheKey, image.clone())
    return image
  } catch {
    state.appIconCache.set(cacheKey, null)
    return null
  }
}

function openUrl(value) {
  if (!isValidHttpUrl(value)) {
    return { ok: false, reason: 'URL invalide (http/https uniquement).' }
  }

  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Ouverture URL supportée uniquement sur Windows.' }
  }

  try {
    const child = spawn('cmd', ['/c', 'start', '', value], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    child.on('error', () => {})
    child.unref()
    return { ok: true, message: `URL ouverte: ${value}` }
  } catch (error) {
    return { ok: false, reason: `Échec ouverture URL: ${error.message}` }
  }
}

function escapeForSendKeys(text) {
  return String(text || '')
    .replaceAll('\r', '')
    .replaceAll('\n', '{ENTER}')
    .replace(/[+^%~(){}\[\]]/g, match => `{${match}}`)
}

function clampMacroDelay(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 120
  return Math.max(0, Math.min(10_000, Math.round(n)))
}

function parseMacroValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return { keys: '', delayMs: 120 }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const keys = String(parsed.keys ?? parsed.text ?? '')
      const delayMs = clampMacroDelay(parsed.delayMs)
      return { keys, delayMs }
    }
  } catch {
    // Fallback to plain text mode
  }
  return { keys: raw, delayMs: 120 }
}

function parsePasteTextValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return { text: '' }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const text = String(parsed.text ?? parsed.keys ?? '')
      return { text }
    }
  } catch {
    // Fallback to plain text mode
  }
  return { text: String(value || '') }
}

async function runPowerShellKeyboardScript(script, message, timeoutMs = 8000) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Entrée clavier supportée uniquement sur Windows.' }
  }

  const encoded = Buffer.from(String(script || ''), 'utf16le').toString('base64')
  try {
    await runExecFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      timeoutMs,
    )
    return { ok: true, message }
  } catch (error) {
    return { ok: false, reason: `Échec script clavier: ${error.message}` }
  }
}

async function runMacro(value) {
  const parsed = parseMacroValue(value)
  const keys = Array.from(parsed.keys || '')
  if (keys.length === 0) {
    return { ok: false, reason: 'Macro vide (aucune touche).' }
  }

  const tokens = keys.map(ch => `'${escapePsSingleQuoted(escapeForSendKeys(ch))}'`).join(', ')
  const delayMs = clampMacroDelay(parsed.delayMs)
  const script = `
$ws = New-Object -ComObject WScript.Shell
$keys = @(${tokens})
Start-Sleep -Milliseconds 80
foreach ($k in $keys) {
  $ws.SendKeys($k)
  Start-Sleep -Milliseconds ${delayMs}
}
`
  const timeout = Math.max(3000, 1500 + keys.length * (delayMs + 20))
  return runPowerShellKeyboardScript(script, `Macro lancée (${keys.length} touche(s), ${delayMs} ms)`, timeout)
}

async function runPasteText(value) {
  const parsed = parsePasteTextValue(value)
  const text = String(parsed.text || '')
  if (!text.trim()) {
    return { ok: false, reason: 'Texte à coller vide.' }
  }

  const sendKeysText = escapeForSendKeys(text)
  const script = `
$ws = New-Object -ComObject WScript.Shell
$text = '${escapePsSingleQuoted(sendKeysText)}'
Start-Sleep -Milliseconds 80
$ws.SendKeys($text)
`
  const timeout = Math.max(2500, 1200 + text.length * 10)
  return runPowerShellKeyboardScript(script, 'Texte collé via entrée clavier', timeout)
}

function runCommand(value) {
  const parts = tokenizeCommandLine(value)
  if (parts.length === 0) {
    return { ok: false, reason: 'Commande vide.' }
  }

  try {
    let child
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', ...parts], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
    } else {
      const [executable, ...args] = parts
      child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      })
    }

    child.once('error', error => {
      setLastEvent(`Erreur lancement commande: ${error.message}`)
    })
    child.once('spawn', () => {
      setLastEvent(`Commande lancée: ${parts[0]}`)
    })
    child.once('exit', code => {
      if (typeof code === 'number' && code !== 0) {
        setLastEvent(`Commande terminée avec code ${code}: ${parts[0]}`)
      }
    })

    child.unref()
    return { ok: true, message: `Commande déclenchée: ${parts[0]}` }
  } catch (error) {
    return { ok: false, reason: `Échec lancement commande: ${error.message}` }
  }
}

function isDebouncedKey(key) {
  const now = Date.now()
  const previous = state.keyLastPressedAt.get(key) || 0
  if (now - previous < KEY_DEBOUNCE_MS) return true
  state.keyLastPressedAt.set(key, now)
  return false
}

async function executeShortcutByKey(key) {
  const config = await getCurrentConfig()
  const profileId = isProfileId(config.activeProfile) ? config.activeProfile : 'home'
  const shortcuts = Array.isArray(config.profiles?.[profileId]) ? config.profiles[profileId] : []
  const item = shortcuts.find(s => s.key === key)

  if (!item) {
    setLastEvent(`Key ${key}: raccourci introuvable.`)
    return { ok: false, reason: 'Shortcut not found' }
  }

  if (isDebouncedKey(key)) {
    setLastEvent(`Key ${key}: ignorée (anti double-clic).`)
    return { ok: false, reason: 'Debounced' }
  }

  if (!item.value) {
    setLastEvent(`Key ${key}: aucune action configurée.`)
    return { ok: false, reason: 'No action value' }
  }

  let result
  if (item.actionType === 'url' || isValidHttpUrl(item.value)) {
    result = openUrl(item.value)
  } else if (item.actionType === 'macro') {
    result = await runMacro(item.value)
  } else if (item.actionType === 'paste_text') {
    result = await runPasteText(item.value)
  } else {
    result = runCommand(item.value)
  }

  if (result.ok) {
    setLastEvent(`[${profileLabel(profileId)}] Key ${key}: ${result.message}`)
  } else {
    setLastEvent(`[${profileLabel(profileId)}] Key ${key}: ${result.reason}`)
  }

  return result
}

async function switchActiveProfile(profileId) {
  if (!isProfileId(profileId)) {
    return { ok: false, reason: 'Profil invalide.' }
  }

  const config = await getCurrentConfig()
  if (config.activeProfile === profileId) {
    return { ok: true, changed: false, profile: profileId }
  }

  config.activeProfile = profileId
  await writeConfig(config)
  await drawFromConfig(config)
  setLastEvent(`Profil actif: ${profileLabel(profileId)}`)
  return { ok: true, changed: true, profile: profileId }
}

async function connectLoupedeck() {
  if (state.connecting || state.connected) return

  state.connecting = true
  try {
    const device = await discover({ autoConnect: false })
    await device.connect()

    state.device = device
    state.connected = true
    setLastEvent(`Connecté: ${device.type}`)

    const triggerKey = key => {
      if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) return
      executeShortcutByKey(key).catch(error => {
        setLastEvent(`Erreur action key ${key}: ${error.message}`)
      })
    }

    // Bottom hardware buttons switch profiles only (HOME, 1..7).
    device.on('down', ({ id }) => {
      if (typeof id !== 'number') return
      const profileId = BOTTOM_BUTTON_TO_PROFILE[id]
      if (!profileId) return
      switchActiveProfile(profileId).catch(error => {
        setLastEvent(`Erreur changement profil ${profileId}: ${error.message}`)
      })
    })

    // Touch keys on center screen
    device.on('touchstart', ({ changedTouches }) => {
      if (!Array.isArray(changedTouches)) return
      for (const touch of changedTouches) {
        const key = touch?.target?.key
        if (typeof key === 'number') triggerKey(key)
      }
    })

    device.on('disconnect', error => {
      state.connected = false
      state.device = null
      setLastEvent(`Déconnecté${error ? `: ${error.message}` : ''}`)
      setTimeout(() => {
        connectLoupedeck().catch(() => {})
      }, 2000)
    })

    const config = await readConfig()
    await drawFromConfig(config)
  } catch (error) {
    state.connected = false
    state.device = null
    setLastEvent(`Connexion impossible (${error.message}), retry dans 3s`)
    setTimeout(() => {
      connectLoupedeck().catch(() => {})
    }, 3000)
  } finally {
    state.connecting = false
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 1_000_000) reject(new Error('Body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJsonOrThrow(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw new Error('JSON invalide.')
  }
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

async function handleApi(req, res) {
  if (req.url === '/api/status' && req.method === 'GET') {
    const config = await getCurrentConfig()
    sendJson(res, 200, {
      connected: state.connected,
      lastEvent: state.lastEvent,
      warnings: state.warnings,
      activeProfile: config.activeProfile,
    })
    return true
  }

  if (req.url === '/api/config' && req.method === 'GET') {
    const config = await getCurrentConfig()
    sendJson(res, 200, config)
    return true
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    const body = await readBody(req)
    const payload = parseJsonOrThrow(body)
    const check = validateConfigStrict(payload)

    if (!check.ok) {
      sendJson(res, 400, { error: 'Validation error', details: check.errors })
      return true
    }

    await writeConfig(check.config)
    state.warnings = []
    await drawFromConfig(check.config)
    sendJson(res, 200, check.config)
    return true
  }

  if (req.url === '/api/apps' && req.method === 'GET') {
    const apps = await listInstalledApps()
    sendJson(res, 200, { apps })
    return true
  }

  if (req.url === '/api/icon' && req.method === 'POST') {
    const body = await readBody(req)
    const payload = parseJsonOrThrow(body)
    const key = Number(payload.key)
    const profile = isProfileId(payload.profile) ? String(payload.profile) : null
    const dataUrl = payload.dataUrl

    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) {
      sendJson(res, 400, { error: 'Invalid key', details: [`key doit être entre 0 et ${KEY_COUNT - 1}.`] })
      return true
    }

    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
      sendJson(res, 400, { error: 'Missing dataUrl', details: ['dataUrl image requis.'] })
      return true
    }

    const config = await getCurrentConfig()
    const targetProfile = profile || config.activeProfile || 'home'
    const shortcuts = config.profiles?.[targetProfile]
    const shortcut = Array.isArray(shortcuts) ? shortcuts.find(s => s.key === key) : null
    if (!shortcut) {
      sendJson(res, 404, { error: 'Shortcut not found' })
      return true
    }

    const previous = shortcut.iconPath
    const next = await saveCustomIconForKey(`${targetProfile}-${key}`, dataUrl)
    shortcut.iconPath = next
    await writeConfig(config)

    if (previous) {
      const previousAbs = resolveIconAbsolutePath(previous)
      if (previousAbs) {
        await fs.unlink(previousAbs).catch(() => {})
      }
    }

    state.customIconCache.clear()
    await drawFromConfig(config)
    sendJson(res, 200, { ok: true, iconPath: next, profile: targetProfile })
    return true
  }

  if (req.url === '/api/icon' && req.method === 'DELETE') {
    const body = await readBody(req)
    const payload = parseJsonOrThrow(body)
    const key = Number(payload.key)
    const profile = isProfileId(payload.profile) ? String(payload.profile) : null

    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) {
      sendJson(res, 400, { error: 'Invalid key', details: [`key doit être entre 0 et ${KEY_COUNT - 1}.`] })
      return true
    }

    const config = await getCurrentConfig()
    const targetProfile = profile || config.activeProfile || 'home'
    const shortcuts = config.profiles?.[targetProfile]
    const shortcut = Array.isArray(shortcuts) ? shortcuts.find(s => s.key === key) : null
    if (!shortcut) {
      sendJson(res, 404, { error: 'Shortcut not found' })
      return true
    }

    const previous = shortcut.iconPath
    shortcut.iconPath = ''
    await writeConfig(config)

    if (previous) {
      const previousAbs = resolveIconAbsolutePath(previous)
      if (previousAbs) {
        await fs.unlink(previousAbs).catch(() => {})
      }
    }

    state.customIconCache.clear()
    await drawFromConfig(config)
    sendJson(res, 200, { ok: true, profile: targetProfile })
    return true
  }

  if (req.url === '/api/profile' && req.method === 'POST') {
    const body = await readBody(req)
    const payload = parseJsonOrThrow(body)
    const profile = String(payload.profile || '')
    if (!isProfileId(profile)) {
      sendJson(res, 400, { error: 'Invalid profile', details: [`profile doit être l'un de: ${PROFILE_IDS.join(', ')}`] })
      return true
    }
    const result = await switchActiveProfile(profile)
    sendJson(res, 200, result)
    return true
  }

  if (req.url === '/api/trigger' && req.method === 'POST') {
    const body = await readBody(req)
    const payload = parseJsonOrThrow(body)
    const key = Number(payload.key)

    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) {
      sendJson(res, 400, { error: 'Invalid key', details: [`key doit être entre 0 et ${KEY_COUNT - 1}.`] })
      return true
    }

    if (isProfileId(payload.profile)) {
      const config = await getCurrentConfig()
      if (config.activeProfile !== payload.profile) {
        config.activeProfile = payload.profile
        await writeConfig(config)
        await drawFromConfig(config)
      }
    }

    const result = await executeShortcutByKey(key)
    sendJson(res, 200, result)
    return true
  }

  return false
}

async function handleStatic(req, res) {
  const rawPath = (req.url || '/').split('?')[0]
  const reqPath = rawPath === '/' ? '/index.html' : rawPath
  const safePath = path.normalize(reqPath).replace(/^([.]{2}[/\\])+/, '')
  const filePath = path.join(PUBLIC_DIR, safePath)

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const data = await fs.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

async function start() {
  await ensureConfigFile()
  await readConfig()

  connectLoupedeck().catch(error => {
    setLastEvent(`Connexion initiale échouée: ${error.message}`)
  })

  const server = createServer(async (req, res) => {
    try {
      if ((req.url || '').startsWith('/api/')) {
        const handled = await handleApi(req, res)
        if (!handled) sendJson(res, 404, { error: 'Not found' })
        return
      }
      await handleStatic(req, res)
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })

  server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} déjà utilisé. Ferme l'autre instance (node app.mjs) puis relance.`)
      process.exit(1)
      return
    }
    console.error('Erreur serveur:', error.message)
    process.exit(1)
  })

  server.listen(PORT, () => {
    console.log(`Loopdeck app running on http://localhost:${PORT}`)
    console.log('Ferme l\'app officielle Loupedeck pour éviter les conflits.')
  })
}

start().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
