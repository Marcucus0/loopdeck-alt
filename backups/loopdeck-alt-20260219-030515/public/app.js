const grid = document.getElementById('grid')
const saveBtn = document.getElementById('saveBtn')
const reloadBtn = document.getElementById('reloadBtn')
const deviceState = document.getElementById('deviceState')
const lastEvent = document.getElementById('lastEvent')
const messageBox = document.getElementById('messageBox')
const appCommands = document.getElementById('appCommands')
const profileTabs = document.getElementById('profileTabs')
const profileLedColor = document.getElementById('profileLedColor')

const KEY_COUNT = 12
const PROFILE_IDS = ['home', '1', '2', '3', '4', '5', '6', '7']

let currentConfig = null
let installedApps = []
let selectedProfile = 'home'

function normalizeColor(value, fallback = '#ffffff') {
  const text = String(value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback
}

function defaultShortcuts() {
  const shortcuts = []
  for (let key = 0; key < KEY_COUNT; key += 1) {
    shortcuts.push({
      key,
      label: `Key ${key}`,
      color: '#1f2937',
      actionType: 'command',
      value: '',
      iconPath: '',
    })
  }
  return shortcuts
}

function ensureConfigShape(config) {
  const safe = config && typeof config === 'object' ? { ...config } : {}
  safe.version = 2
  safe.activeProfile = PROFILE_IDS.includes(String(safe.activeProfile)) ? String(safe.activeProfile) : 'home'
  safe.profiles = safe.profiles && typeof safe.profiles === 'object' ? { ...safe.profiles } : {}
  safe.profileColors = safe.profileColors && typeof safe.profileColors === 'object' ? { ...safe.profileColors } : {}
  for (const profile of PROFILE_IDS) {
    safe.profileColors[profile] = normalizeColor(safe.profileColors[profile], '#ffffff')
  }
  for (const profile of PROFILE_IDS) {
    const src = Array.isArray(safe.profiles[profile]) ? safe.profiles[profile] : defaultShortcuts()
    safe.profiles[profile] = [...src].sort((a, b) => Number(a.key) - Number(b.key)).map(item => ({
      key: Number(item.key),
      label: String(item.label ?? `Key ${Number(item.key)}`),
      color: String(item.color || '#1f2937'),
      actionType: item.actionType === 'url' || item.actionType === 'app' ? item.actionType : 'command',
      value: String(item.value || ''),
      iconPath: String(item.iconPath || ''),
    }))
  }
  return safe
}

function profileLabel(id) {
  return id === 'home' ? 'HOME' : id
}

function showMessage(text, type = 'ok') {
  messageBox.className = `message ${type}`
  messageBox.textContent = text
}

function clearMessage() {
  messageBox.className = 'message hidden'
  messageBox.textContent = ''
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const details = Array.isArray(data.details) ? ` ${data.details.join(' ')}` : ''
    throw new Error((data.error || `HTTP ${response.status}`) + details)
  }
  return data
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function appNameForCommand(command) {
  const hit = installedApps.find(app => app.command.toLowerCase() === String(command || '').toLowerCase())
  return hit ? hit.name : ''
}

function appHintHtml(command) {
  const name = appNameForCommand(command)
  if (!name) return ''
  return `<div class="hint">App détectée: ${escapeHtml(name)}</div>`
}

function valuePlaceholder(actionType) {
  if (actionType === 'url') return 'ex: https://google.com'
  if (actionType === 'app') return 'Recherche app installée (.lnk/.exe)'
  return 'ex: notepad.exe ou "C:\\Path\\App.exe" --arg'
}

function cardTemplate(item) {
  const isApp = item.actionType === 'app'
  const hasCustomIcon = Boolean(item.iconPath)
  return `
    <article class="card" data-key="${item.key}">
      <h3>Touche ${item.key}</h3>
      <div class="field">
        <label>Nom</label>
        <input type="text" data-field="label" value="${escapeHtml(item.label)}" maxlength="30" />
      </div>
      <div class="row">
        <div class="field" style="flex:1">
          <label>Type</label>
          <select data-field="actionType">
            <option value="command" ${item.actionType === 'command' ? 'selected' : ''}>Commande</option>
            <option value="url" ${item.actionType === 'url' ? 'selected' : ''}>URL</option>
            <option value="app" ${isApp ? 'selected' : ''}>App installée</option>
          </select>
        </div>
        <div class="field">
          <label>Couleur</label>
          <input type="color" data-field="color" value="${item.color}" />
        </div>
      </div>
      <div class="field">
        <label>Valeur</label>
        <input type="text" data-field="value" value="${escapeHtml(item.value)}" placeholder="${escapeHtml(valuePlaceholder(item.actionType))}" ${isApp ? 'list="appCommands"' : ''} />
      </div>
      <div class="row">
        <button class="icon-btn" data-action="upload-icon" data-key="${item.key}" type="button">Icône perso</button>
        <button class="ghost icon-btn" data-action="clear-icon" data-key="${item.key}" type="button" ${hasCustomIcon ? '' : 'disabled'}>Retirer</button>
      </div>
      <input type="file" accept="image/*" data-field="iconFile" data-key="${item.key}" class="hidden" />
      ${hasCustomIcon ? '<div class="hint">Icône perso active</div>' : ''}
      ${appHintHtml(item.value)}
      <button class="test-btn" data-key="${item.key}" type="button">Tester cette touche</button>
    </article>
  `
}

function renderTabs(activeProfile) {
  const html = PROFILE_IDS.map(id => {
    const selected = id === selectedProfile
    const active = id === activeProfile
    return `<button type="button" class="tab-btn ${selected ? 'selected' : ''} ${active ? 'active' : ''}" data-profile="${id}">${profileLabel(id)}</button>`
  }).join('')
  profileTabs.innerHTML = html
}

function renderConfig(config) {
  currentConfig = ensureConfigShape(config)
  if (!PROFILE_IDS.includes(selectedProfile)) selectedProfile = currentConfig.activeProfile
  const shortcuts = currentConfig.profiles[selectedProfile] || defaultShortcuts()
  renderTabs(currentConfig.activeProfile)
  profileLedColor.value = currentConfig.profileColors[selectedProfile] || '#ffffff'
  grid.innerHTML = shortcuts.map(cardTemplate).join('')
}

function refreshAppDatalist() {
  appCommands.innerHTML = ''
  for (const app of installedApps) {
    const option = document.createElement('option')
    option.value = app.command
    option.label = app.name
    appCommands.appendChild(option)
  }
}

function updateValueFieldMode(card) {
  const typeSelect = card.querySelector('[data-field="actionType"]')
  const valueInput = card.querySelector('[data-field="value"]')
  const actionType = typeSelect.value

  valueInput.placeholder = valuePlaceholder(actionType)
  if (actionType === 'app') {
    valueInput.setAttribute('list', 'appCommands')
  } else {
    valueInput.removeAttribute('list')
  }
}

function collectShortcutsFromUi() {
  const cards = [...grid.querySelectorAll('.card')]
  if (cards.length !== KEY_COUNT) {
    throw new Error(`Nombre de cartes invalide (${cards.length}/${KEY_COUNT}).`)
  }

  return cards
    .map(card => {
      const key = Number(card.dataset.key)
      const iconPath = currentConfig?.profiles?.[selectedProfile]?.find(s => s.key === key)?.iconPath || ''
      return {
        key,
        label: card.querySelector('[data-field="label"]').value,
        actionType: card.querySelector('[data-field="actionType"]').value,
        color: card.querySelector('[data-field="color"]').value,
        value: card.querySelector('[data-field="value"]').value,
        iconPath,
      }
    })
    .sort((a, b) => a.key - b.key)
}

function collectConfigFromUi() {
  const next = ensureConfigShape(currentConfig)
  next.profiles[selectedProfile] = collectShortcutsFromUi()
  next.activeProfile = selectedProfile
  return {
    version: 2,
    activeProfile: next.activeProfile,
    profileColors: next.profileColors,
    profiles: next.profiles,
  }
}

function stashSelectedProfileFromUi() {
  if (!currentConfig) return
  const cards = [...grid.querySelectorAll('.card')]
  if (cards.length !== KEY_COUNT) return
  try {
    currentConfig.profiles[selectedProfile] = collectShortcutsFromUi()
  } catch {
    // Ignore temporary invalid UI states.
  }
}

async function loadConfig() {
  const config = await fetchJson('/api/config')
  const safe = ensureConfigShape(config)
  if (!PROFILE_IDS.includes(selectedProfile)) selectedProfile = safe.activeProfile
  renderConfig(safe)
}

async function saveConfig() {
  const payload = collectConfigFromUi()
  const saved = await fetchJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  renderConfig(saved)
}

async function setActiveProfile(profile) {
  await fetchJson('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  })
}

async function loadInstalledApps() {
  const data = await fetchJson('/api/apps')
  installedApps = Array.isArray(data.apps) ? data.apps : []
  refreshAppDatalist()
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Lecture fichier impossible'))
    reader.readAsDataURL(file)
  })
}

async function uploadCustomIcon(key, file) {
  const dataUrl = await readFileAsDataUrl(file)
  await fetchJson('/api/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: selectedProfile, dataUrl }),
  })
}

async function clearCustomIcon(key) {
  await fetchJson('/api/icon', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: selectedProfile }),
  })
}

async function triggerKey(key) {
  return fetchJson('/api/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: selectedProfile }),
  })
}

async function refreshStatus() {
  const status = await fetchJson('/api/status')
  deviceState.textContent = status.connected ? 'Connecté' : 'Déconnecté'
  lastEvent.textContent = status.lastEvent || '-'
  if (currentConfig && PROFILE_IDS.includes(status.activeProfile) && status.activeProfile !== currentConfig.activeProfile) {
    currentConfig.activeProfile = status.activeProfile
    renderTabs(currentConfig.activeProfile)
  }
}

saveBtn.addEventListener('click', async () => {
  try {
    clearMessage()
    await saveConfig()
    await setActiveProfile(selectedProfile)
    showMessage(`Config sauvegardée sur profil ${profileLabel(selectedProfile)}.`, 'ok')
  } catch (error) {
    showMessage(`Erreur sauvegarde: ${error.message}`, 'error')
  }
})

reloadBtn.addEventListener('click', async () => {
  try {
    clearMessage()
    await loadConfig()
    showMessage('Config rechargée.', 'ok')
  } catch (error) {
    showMessage(`Erreur chargement: ${error.message}`, 'error')
  }
})

profileTabs.addEventListener('click', async event => {
  const tab = event.target.closest('button[data-profile]')
  if (!tab) return
  const profile = tab.dataset.profile
  if (!PROFILE_IDS.includes(profile)) return

  try {
    clearMessage()
    stashSelectedProfileFromUi()
    selectedProfile = profile
    renderConfig(currentConfig)
    await setActiveProfile(profile)
    showMessage(`Profil actif: ${profileLabel(profile)}.`, 'ok')
  } catch (error) {
    showMessage(`Erreur changement profil: ${error.message}`, 'error')
  }
})

profileLedColor.addEventListener('input', () => {
  if (!currentConfig) return
  const color = normalizeColor(profileLedColor.value, '#ffffff')
  profileLedColor.value = color
  currentConfig.profileColors[selectedProfile] = color
})

grid.addEventListener('change', event => {
  const select = event.target.closest('[data-field="actionType"]')
  if (select) {
    const card = select.closest('.card')
    if (!card) return
    updateValueFieldMode(card)
    return
  }

  const fileInput = event.target.closest('[data-field="iconFile"]')
  if (!fileInput) return
  const key = Number(fileInput.dataset.key)
  const file = fileInput.files?.[0]
  if (!file) return

  uploadCustomIcon(key, file)
    .then(() => loadConfig())
    .then(() => showMessage(`Icône perso appliquée sur la touche ${key} (${profileLabel(selectedProfile)}).`, 'ok'))
    .catch(error => showMessage(`Erreur upload icône: ${error.message}`, 'error'))
    .finally(() => {
      fileInput.value = ''
    })
})

grid.addEventListener('click', async event => {
  const uploadBtn = event.target.closest('button[data-action="upload-icon"]')
  if (uploadBtn) {
    const key = Number(uploadBtn.dataset.key)
    const input = grid.querySelector(`[data-field="iconFile"][data-key="${key}"]`)
    if (input) input.click()
    return
  }

  const clearBtn = event.target.closest('button[data-action="clear-icon"]')
  if (clearBtn) {
    const key = Number(clearBtn.dataset.key)
    try {
      clearMessage()
      await clearCustomIcon(key)
      await loadConfig()
      showMessage(`Icône perso retirée pour la touche ${key} (${profileLabel(selectedProfile)}).`, 'ok')
    } catch (error) {
      showMessage(`Erreur suppression icône: ${error.message}`, 'error')
    }
    return
  }

  const button = event.target.closest('.test-btn')
  if (!button) return

  const key = Number(button.dataset.key)
  try {
    clearMessage()
    const result = await triggerKey(key)
    if (result.ok) {
      showMessage(`Test touche ${key} (${profileLabel(selectedProfile)}): action exécutée.`, 'ok')
    } else {
      showMessage(`Test touche ${key}: ${result.reason || 'non exécutée'}`, 'error')
    }
  } catch (error) {
    showMessage(`Erreur test touche ${key}: ${error.message}`, 'error')
  }
})

async function bootstrap() {
  await Promise.all([
    loadInstalledApps().catch(() => {
      showMessage('Liste des apps indisponible pour le moment.', 'error')
    }),
    loadConfig(),
  ])
  await refreshStatus()
  setInterval(() => {
    refreshStatus().catch(() => {
      deviceState.textContent = 'Déconnecté'
      lastEvent.textContent = 'Serveur indisponible'
    })
  }, 2000)
}

bootstrap().catch(error => {
  showMessage(`Erreur initialisation: ${error.message}`, 'error')
})
