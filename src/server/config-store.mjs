export function normalizeActionType(value) {
  const type = String(value ?? '').trim().toLowerCase()
  if (type === 'url') return 'url'
  if (type === 'app') return 'app'
  if (type === 'app_volume') return 'app_volume'
  if (type === 'key_press') return 'key_press'
  if (type === 'multi_action') return 'multi_action'
  if (type === 'macro') return 'macro'
  if (type === 'paste_text') return 'paste_text'
  return 'command'
}

export function isValidHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
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

export function sanitizeIconPath(value) {
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

function defaultProfileColors(profileIds) {
  const colors = {}
  for (const id of profileIds) colors[id] = '#ffffff'
  return colors
}

function defaultShortcuts(keyCount) {
  const shortcuts = []
  for (let key = 0; key < keyCount; key += 1) {
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

export function defaultConfig(profileIds, keyCount, configVersion) {
  const profiles = {}
  for (const id of profileIds) {
    profiles[id] = defaultShortcuts(keyCount)
  }
  return {
    version: configVersion,
    activeProfile: 'home',
    profileColors: defaultProfileColors(profileIds),
    profiles,
  }
}

function isProfileId(profileIds, value) {
  return profileIds.includes(String(value))
}

function normalizeShortcutsLenient(rawList, issues, profileId, keyCount) {
  const result = defaultShortcuts(keyCount)
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
    if (!Number.isInteger(key) || key < 0 || key >= keyCount) {
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

function normalizeConfigLenient(input, { keyCount, profileIds, configVersion }) {
  const base = defaultConfig(profileIds, keyCount, configVersion)
  const issues = []

  if (!input || typeof input !== 'object') {
    issues.push('Config absente ou invalide, defaults appliqués.')
    return { config: base, issues }
  }

  if (Array.isArray(input.shortcuts)) {
    issues.push('Migration config v1 -> v2 appliquée (profil HOME).')
    base.profiles.home = normalizeShortcutsLenient(input.shortcuts, issues, 'home', keyCount)
    return { config: base, issues }
  }

  if (input.version !== configVersion) {
    issues.push(`Version de config invalide (${String(input.version)}), version ${configVersion} appliquée.`)
  }

  if (!input.profiles || typeof input.profiles !== 'object') {
    issues.push('profiles invalide, defaults appliqués.')
    return { config: base, issues }
  }

  base.activeProfile = isProfileId(profileIds, input.activeProfile) ? String(input.activeProfile) : 'home'
  if (!isProfileId(profileIds, input.activeProfile)) {
    issues.push('activeProfile invalide, profil HOME appliqué.')
  }

  if (input.profileColors && typeof input.profileColors === 'object') {
    for (const profileId of profileIds) {
      base.profileColors[profileId] = normalizeHexColorWithFallback(input.profileColors[profileId], '#ffffff')
    }
  }

  for (const profileId of profileIds) {
    base.profiles[profileId] = normalizeShortcutsLenient(input.profiles[profileId], issues, profileId, keyCount)
  }

  return { config: base, issues }
}

function validateShortcutArrayStrict(rawList, profileId, errors, { keyCount }) {
  if (!Array.isArray(rawList)) {
    errors.push(`profiles.${profileId} doit être un tableau.`)
    return null
  }

  if (rawList.length !== keyCount) {
    errors.push(`profiles.${profileId} doit contenir exactement ${keyCount} éléments.`)
  }

  const seenKeys = new Set()
  rawList.forEach((item, index) => {
    if (!isValidShortcutShape(item)) {
      errors.push(`profiles.${profileId}[${index}] doit être un objet.`)
      return
    }

    const key = Number(item.key)
    if (!Number.isInteger(key) || key < 0 || key >= keyCount) {
      errors.push(`profiles.${profileId}[${index}].key doit être un entier entre 0 et ${keyCount - 1}.`)
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

    if (!['command', 'url', 'app', 'app_volume', 'key_press', 'multi_action', 'macro', 'paste_text'].includes(item.actionType)) {
      errors.push(
        `profiles.${profileId}[${index}].actionType doit être "command", "url", "app", "app_volume", "key_press", "multi_action", "macro" ou "paste_text".`,
      )
    }

    if (typeof item.value !== 'string') {
      errors.push(`profiles.${profileId}[${index}].value doit être une string.`)
    }

    if (item.iconPath !== undefined && typeof item.iconPath !== 'string') {
      errors.push(`profiles.${profileId}[${index}].iconPath doit être une string.`)
    }
  })

  for (let key = 0; key < keyCount; key += 1) {
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

export function validateConfigStrict(input, { keyCount, profileIds, configVersion }) {
  const errors = []

  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['Payload JSON invalide.'] }
  }

  if (input.version !== configVersion) {
    errors.push(`version doit être ${configVersion}.`)
  }

  if (!isProfileId(profileIds, input.activeProfile)) {
    errors.push(`activeProfile doit être l'un de: ${profileIds.join(', ')}.`)
  }

  if (!input.profiles || typeof input.profiles !== 'object') {
    errors.push('profiles doit être un objet.')
  }

  const normalizedProfileColors = defaultProfileColors(profileIds)
  if (input.profileColors !== undefined) {
    if (!input.profileColors || typeof input.profileColors !== 'object') {
      errors.push('profileColors doit être un objet.')
    } else {
      for (const profileId of profileIds) {
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
  for (const profileId of profileIds) {
    const normalized = validateShortcutArrayStrict(input?.profiles?.[profileId], profileId, errors, { keyCount })
    if (normalized) normalizedProfiles[profileId] = normalized
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      version: configVersion,
      activeProfile: input.activeProfile,
      profileColors: normalizedProfileColors,
      profiles: normalizedProfiles,
    },
  }
}

export function createConfigStore({ fs, configDir, iconsDir, configPath, keyCount, profileIds, configVersion }) {
  const cache = {
    config: null,
    mtimeMs: 0,
  }

  async function refreshConfigMtime() {
    try {
      const stats = await fs.stat(configPath)
      cache.mtimeMs = stats.mtimeMs
    } catch {
      cache.mtimeMs = 0
    }
  }

  async function isConfigCacheFresh() {
    if (!cache.config) return false
    try {
      const stats = await fs.stat(configPath)
      return stats.mtimeMs === cache.mtimeMs
    } catch {
      return false
    }
  }

  function setConfigCache(config) {
    cache.config = deepClone(config)
  }

  async function ensureConfigFile() {
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(iconsDir, { recursive: true })
    try {
      await fs.access(configPath)
    } catch {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig(profileIds, keyCount, configVersion), null, 2), 'utf-8')
    }
  }

  async function readConfig() {
    if (await isConfigCacheFresh()) {
      return deepClone(cache.config)
    }

    let raw
    try {
      raw = await fs.readFile(configPath, 'utf-8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const cfg = defaultConfig(profileIds, keyCount, configVersion)
        await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
        setConfigCache(cfg)
        await refreshConfigMtime()
        return { config: deepClone(cfg), warnings: ['Config absente, defaults créés.'] }
      }
      throw error
    }

    const parsed = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    })()
    const normalized = normalizeConfigLenient(parsed, { keyCount, profileIds, configVersion })

    if (normalized.issues.length > 0) {
      await fs.writeFile(configPath, JSON.stringify(normalized.config, null, 2), 'utf-8')
    }

    setConfigCache(normalized.config)
    await refreshConfigMtime()
    return { config: deepClone(normalized.config), warnings: normalized.issues }
  }

  async function writeConfig(config) {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    setConfigCache(config)
    await refreshConfigMtime()
  }

  async function getCurrentConfig() {
    if (cache.config && (await isConfigCacheFresh())) return deepClone(cache.config)
    const result = await readConfig()
    return result.config
  }

  return { ensureConfigFile, readConfig, writeConfig, getCurrentConfig }
}
