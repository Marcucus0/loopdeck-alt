import {
  KEY_COUNT,
  PROFILE_IDS,
  TEMPLATE_DEFS,
  actionTypeLabel,
  buildMacroValue,
  clampDelayMs,
  defaultConfig,
  defaultShortcut,
  ensureConfigShape,
  hasMeaningfulShortcut,
  normalizeActionType,
  normalizeColor,
  parseMacroValue,
  parsePasteTextValue,
  profileLabel,
  templateById,
  templateLabel,
} from './widget-core.js'
const keyGrid = document.getElementById('keyGrid')
const profileButtons = document.getElementById('profileButtons')
const widgetList = document.getElementById('widgetList')
const searchInput = document.getElementById('searchInput')
const serverBadge = document.getElementById('serverBadge')
const deviceBadge = document.getElementById('deviceBadge')
const eventLine = document.getElementById('eventLine')
const messageBox = document.getElementById('messageBox')
const saveBtn = document.getElementById('saveBtn')
const reloadBtn = document.getElementById('reloadBtn')
const menuBtn = document.getElementById('menuBtn')
const configMenu = document.getElementById('configMenu')
const importConfigBtn = document.getElementById('importConfigBtn')
const exportConfigBtn = document.getElementById('exportConfigBtn')
const resetConfigBtn = document.getElementById('resetConfigBtn')
const widgetContextMenu = document.getElementById('widgetContextMenu')
const ctxCloneBtn = document.getElementById('ctxCloneBtn')
const ctxDeleteBtn = document.getElementById('ctxDeleteBtn')

const editorTitle = document.getElementById('editorTitle')
const widgetNameInput = document.getElementById('widgetNameInput')
const widgetTemplateInput = document.getElementById('widgetTemplateInput')
const colorInput = document.getElementById('colorInput')
const valueLabel = document.getElementById('valueLabel')
const valueInput = document.getElementById('valueInput')
const macroDelayField = document.getElementById('macroDelayField')
const delayLabel = document.getElementById('delayLabel')
const macroDelayInput = document.getElementById('macroDelayInput')
const appHint = document.getElementById('appHint')
const iconHint = document.getElementById('iconHint')
const testBtn = document.getElementById('testBtn')
const uploadIconBtn = document.getElementById('uploadIconBtn')
const clearIconBtn = document.getElementById('clearIconBtn')
const iconFileInput = document.getElementById('iconFileInput')
const importConfigInput = document.getElementById('importConfigInput')
const appCommands = document.getElementById('appCommands')

const createWidgetBtn = document.getElementById('createWidgetBtn')
const createModal = document.getElementById('createModal')
const templateList = document.getElementById('templateList')
const createNameInput = document.getElementById('createNameInput')
const cancelCreateBtn = document.getElementById('cancelCreateBtn')
const confirmCreateBtn = document.getElementById('confirmCreateBtn')

const WIDGET_STATE_STORAGE_KEY = 'loopdeck_widget_state_v1'

const state = {
  currentConfig: null,
  selectedProfile: 'home',
  selectedKey: 0,
  widgetsByProfile: {},
  assignmentsByProfile: {},
  selectedWidgetId: null,
  draggingWidgetId: null,
  draggingSourceKey: null,
  installedApps: [],
  filteredApps: [],
  searchQuery: '',
  serverOnline: false,
  deviceConnected: false,
  lastEvent: '-',
  createDraft: {
    templateId: '',
    name: '',
  },
  menuOpen: false,
  contextWidgetId: null,
  autoSaveTimer: null,
  saveInFlight: false,
  saveQueued: false,
}


function createStorageSnapshot() {
  const widgetsByProfile = {}
  const assignmentsByProfile = {}
  for (const profile of PROFILE_IDS) {
    widgetsByProfile[profile] = widgetsForProfile(profile).map(widget => ({
      id: String(widget.id || ''),
      name: String(widget.name || '').slice(0, 30),
      actionType: normalizeActionType(widget.actionType),
      color: normalizeColor(widget.color),
      value: String(widget.value || ''),
      delayMs: clampDelayMs(widget.delayMs),
      iconPath: String(widget.iconPath || ''),
    }))
    assignmentsByProfile[profile] = Array.from({ length: KEY_COUNT }, (_, key) => {
      const wid = assignmentsForProfile(profile)[key]
      return typeof wid === 'string' ? wid : null
    })
  }
  return { widgetsByProfile, assignmentsByProfile }
}

function persistWidgetState() {
  try {
    localStorage.setItem(WIDGET_STATE_STORAGE_KEY, JSON.stringify(createStorageSnapshot()))
  } catch {
    // Ignore storage errors
  }
}

function readWidgetStateFromStorage() {
  try {
    const raw = localStorage.getItem(WIDGET_STATE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function mergeWidgetStateWithStorage() {
  const stored = readWidgetStateFromStorage()
  if (!stored || typeof stored !== 'object') return

  for (const profile of PROFILE_IDS) {
    const serverWidgets = widgetsForProfile(profile)
    const serverAssignments = assignmentsForProfile(profile)
    const localWidgetsRaw = Array.isArray(stored.widgetsByProfile?.[profile]) ? stored.widgetsByProfile[profile] : []
    const localAssignmentsRaw = Array.isArray(stored.assignmentsByProfile?.[profile]) ? stored.assignmentsByProfile[profile] : []

    const byId = new Map()
    for (const widget of serverWidgets) byId.set(widget.id, widget)

    const localById = new Map()
    for (const raw of localWidgetsRaw) {
      if (!raw || typeof raw !== 'object') continue
      const id = String(raw.id || '')
      if (!id) continue
      const actionType = normalizeActionType(raw.actionType)
      const parsedMacro = actionType === 'macro' ? parseMacroValue(raw.value) : null
      const parsedPaste = actionType === 'paste_text' ? parsePasteTextValue(raw.value) : null
      localById.set(id, {
        id,
        name: String(raw.name || 'Widget').slice(0, 30),
        actionType,
        color: normalizeColor(raw.color),
        value: parsedMacro ? parsedMacro.keys : parsedPaste ? parsedPaste.text : String(raw.value || ''),
        delayMs: parsedMacro ? parsedMacro.delayMs : clampDelayMs(raw.delayMs),
        iconPath: String(raw.iconPath || ''),
      })
    }

    const mergedAssignments = Array(KEY_COUNT).fill(null)
    for (let key = 0; key < KEY_COUNT; key += 1) {
      const localId = typeof localAssignmentsRaw[key] === 'string' ? localAssignmentsRaw[key] : null
      const serverId = typeof serverAssignments[key] === 'string' ? serverAssignments[key] : null

      // If local remembers a specific widget ID on this key, keep that ID
      // and fold server-rendered data into it to avoid duplicates on reload.
      if (localId && localById.has(localId)) {
        const localWidget = localById.get(localId)
        if (serverId && byId.has(serverId)) {
          const serverWidget = byId.get(serverId)
          byId.delete(serverId)
          byId.set(localId, { ...localWidget, ...serverWidget, id: localId })
        } else if (!byId.has(localId)) {
          byId.set(localId, localWidget)
        }
        mergedAssignments[key] = localId
        continue
      }

      if (serverId && byId.has(serverId)) {
        mergedAssignments[key] = serverId
      }
    }

    // Add local unassigned widgets that do not exist server-side.
    for (const [localId, localWidget] of localById.entries()) {
      if (!byId.has(localId)) {
        byId.set(localId, localWidget)
      }
    }

    const mergedWidgets = Array.from(byId.values())

    state.widgetsByProfile[profile] = mergedWidgets
    state.assignmentsByProfile[profile] = mergedAssignments
  }
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

function widgetsForProfile(profile = state.selectedProfile) {
  if (!Array.isArray(state.widgetsByProfile[profile])) state.widgetsByProfile[profile] = []
  return state.widgetsByProfile[profile]
}

function assignmentsForProfile(profile = state.selectedProfile) {
  if (!Array.isArray(state.assignmentsByProfile[profile])) {
    state.assignmentsByProfile[profile] = Array(KEY_COUNT).fill(null)
  }
  return state.assignmentsByProfile[profile]
}

function widgetById(widgetId, profile = state.selectedProfile) {
  return widgetsForProfile(profile).find(w => w.id === widgetId) || null
}

function getProfileShortcuts(profile = state.selectedProfile) {
  return state.currentConfig?.profiles?.[profile] || []
}

function rebuildWidgetsFromConfig() {
  state.widgetsByProfile = {}
  state.assignmentsByProfile = {}

  for (const profile of PROFILE_IDS) {
    const widgets = []
    const assignments = Array(KEY_COUNT).fill(null)
    const shortcuts = getProfileShortcuts(profile)

    for (let key = 0; key < KEY_COUNT; key += 1) {
      const item = shortcuts[key] || defaultShortcut(key)
      if (!hasMeaningfulShortcut(item)) continue

      const actionType = normalizeActionType(item.actionType)
      const parsedMacro = actionType === 'macro' ? parseMacroValue(item.value) : null
      const parsedPaste = actionType === 'paste_text' ? parsePasteTextValue(item.value) : null
      const wid = `${profile}-k${key}`
      widgets.push({
        id: wid,
        name: item.label || `Key ${key}`,
        actionType,
        color: normalizeColor(item.color),
        value: parsedMacro ? parsedMacro.keys : parsedPaste ? parsedPaste.text : String(item.value || ''),
        delayMs: parsedMacro ? parsedMacro.delayMs : 120,
        iconPath: String(item.iconPath || ''),
      })
      assignments[key] = wid
    }

    state.widgetsByProfile[profile] = widgets
    state.assignmentsByProfile[profile] = assignments
  }

  const selectedExists = widgetById(state.selectedWidgetId)
  if (!selectedExists) {
    state.selectedWidgetId = widgetsForProfile()[0]?.id || null
  }
}

function syncConfigFromWidgets(profile = state.selectedProfile) {
  const shortcuts = getProfileShortcuts(profile)
  const widgets = widgetsForProfile(profile)
  const assignments = assignmentsForProfile(profile)

  for (let key = 0; key < KEY_COUNT; key += 1) {
    const wid = assignments[key]
    const widget = widgets.find(w => w.id === wid)
    if (!widget) {
      shortcuts[key] = defaultShortcut(key)
      continue
    }

    shortcuts[key] = {
      key,
      label: widget.name.slice(0, 30) || `Key ${key}`,
      color: normalizeColor(widget.color),
      actionType: normalizeActionType(widget.actionType),
      value:
        normalizeActionType(widget.actionType) === 'macro'
          ? buildMacroValue(widget.value, widget.delayMs)
          : String(widget.value || ''),
      iconPath: String(widget.iconPath || ''),
    }
  }
}

function syncAllProfilesFromWidgets() {
  for (const profile of PROFILE_IDS) {
    syncConfigFromWidgets(profile)
  }
}

function updateWidgetProfileAssignments(widgetId) {
  const assignments = assignmentsForProfile()
  const keys = []
  for (let key = 0; key < KEY_COUNT; key += 1) {
    if (assignments[key] === widgetId) keys.push(key)
  }
  return keys
}

function renderProfileButtons() {
  profileButtons.innerHTML = ''
  for (const profile of PROFILE_IDS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'profile-btn'
    btn.dataset.profile = profile
    btn.textContent = profileLabel(profile)
    if (profile === state.selectedProfile) btn.classList.add('selected')
    if (profile === state.currentConfig?.activeProfile) btn.classList.add('active')
    profileButtons.appendChild(btn)
  }
}

function renderKeyGrid() {
  const assignments = assignmentsForProfile()
  keyGrid.innerHTML = ''

  for (let key = 0; key < KEY_COUNT; key += 1) {
    const widget = widgetById(assignments[key])

    const slot = document.createElement('div')
    slot.className = 'key-slot'
    slot.dataset.key = String(key)
    slot.setAttribute('role', 'button')
    slot.setAttribute('tabindex', '0')

    if (!widget) {
      slot.classList.add('empty')
      slot.style.background = '#000000'
      slot.draggable = false
      slot.textContent = '+'
    } else {
      slot.style.background = normalizeColor(widget.color)
      slot.draggable = true

      const top = document.createElement('div')
      top.className = 'slot-type'
      top.textContent = actionTypeLabel(widget.actionType)

      const label = document.createElement('div')
      label.className = 'slot-label'
      label.textContent = widget.name || `Key ${key}`

      const meta = document.createElement('div')
      meta.className = 'slot-meta'

      const left = document.createElement('span')
      left.textContent = widget.value ? widget.value.slice(0, 14) : '-'

      const right = document.createElement('span')
      right.className = 'slot-badge'
      right.textContent = widget.iconPath ? 'ICON' : ''
      if (!widget.iconPath) right.classList.add('hidden')

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'slot-unassign'
      removeBtn.dataset.action = 'unassign-widget'
      removeBtn.dataset.key = String(key)
      removeBtn.setAttribute('aria-label', `Desaffecter le widget de la touche ${key}`)
      removeBtn.textContent = 'x'

      meta.append(left, right)
      slot.append(top, label, meta, removeBtn)
    }

    if (key === state.selectedKey) slot.classList.add('selected')
    keyGrid.appendChild(slot)
  }
}

function renderWidgetList() {
  const query = state.searchQuery.trim().toLowerCase()
  const widgets = widgetsForProfile().filter(widget => {
    if (!query) return true
    return widget.name.toLowerCase().includes(query) || templateLabel(widget.actionType).toLowerCase().includes(query)
  })

  widgetList.innerHTML = ''

  if (widgets.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hint'
    empty.textContent = 'Aucun widget cree pour ce profil.'
    widgetList.appendChild(empty)
    return
  }

  for (const widget of widgets) {
    const card = document.createElement('article')
    card.className = 'widget-card'
    card.dataset.widgetId = widget.id
    card.draggable = true
    if (widget.id === state.selectedWidgetId) card.classList.add('selected')

    const dot = document.createElement('span')
    dot.className = 'widget-dot'
    dot.style.background = normalizeColor(widget.color)

    const name = document.createElement('div')
    name.className = 'widget-name'
    name.textContent = widget.name

    const badge = document.createElement('span')
    badge.className = 'widget-template'
    badge.textContent = templateLabel(widget.actionType)

    card.append(dot, name, badge)
    widgetList.appendChild(card)
  }
}

function refreshAppDatalist() {
  appCommands.innerHTML = ''
  const query = state.searchQuery.trim().toLowerCase()
  const list = query
    ? state.installedApps.filter(app => app.name.toLowerCase().includes(query) || app.command.toLowerCase().includes(query))
    : state.installedApps

  state.filteredApps = list
  for (const app of list.slice(0, 150)) {
    const option = document.createElement('option')
    option.value = app.command
    option.label = app.name
    appCommands.appendChild(option)
  }
}

function renderEditor() {
  const widget = widgetById(state.selectedWidgetId)
  const enabled = Boolean(widget)

  widgetNameInput.disabled = !enabled
  colorInput.disabled = !enabled
  valueInput.disabled = !enabled
  testBtn.disabled = !enabled
  uploadIconBtn.disabled = !enabled
  clearIconBtn.disabled = !enabled

  if (!widget) {
    editorTitle.textContent = 'Widget'
    widgetNameInput.value = ''
    widgetTemplateInput.value = ''
    colorInput.value = '#000000'
    valueLabel.textContent = 'Valeur'
    valueInput.value = ''
    valueInput.placeholder = ''
    valueInput.removeAttribute('list')
    if (delayLabel) delayLabel.textContent = 'Temps entre touches (ms)'
    macroDelayField.classList.add('hidden')
    macroDelayInput.value = '120'
    macroDelayInput.disabled = true
    appHint.textContent = ''
    iconHint.textContent = ''
    return
  }

  const actionType = normalizeActionType(widget.actionType)
  const isMacro = actionType === 'macro'
  const isPasteText = actionType === 'paste_text'
  editorTitle.textContent = `Widget: ${widget.name}`
  widgetNameInput.value = widget.name
  widgetTemplateInput.value = templateLabel(actionType)
  colorInput.value = normalizeColor(widget.color)
  valueInput.value = widget.value

  const template = templateById(actionType)
  valueInput.placeholder = template?.placeholder || ''
  valueLabel.textContent = isMacro ? 'Touches a presser' : isPasteText ? 'Texte a coller' : 'Valeur'
  if (delayLabel) delayLabel.textContent = 'Temps entre touches (ms)'
  macroDelayField.classList.toggle('hidden', !isMacro)
  macroDelayInput.disabled = !isMacro
  macroDelayInput.value = String(clampDelayMs(widget.delayMs))

  if (actionType === 'app') {
    valueInput.setAttribute('list', 'appCommands')
    const hit = state.installedApps.find(app => app.command.toLowerCase() === widget.value.toLowerCase())
    appHint.textContent = hit ? `App detectee: ${hit.name}` : `Apps disponibles: ${state.filteredApps.length || state.installedApps.length}`
  } else if (isMacro) {
    valueInput.removeAttribute('list')
    appHint.textContent = `Macro: ${Array.from(widget.value || '').length} touche(s), ${clampDelayMs(widget.delayMs)} ms entre chaque.`
  } else if (isPasteText) {
    valueInput.removeAttribute('list')
    appHint.textContent = `Texte: ${Array.from(widget.value || '').length} caractere(s).`
  } else {
    valueInput.removeAttribute('list')
    appHint.textContent = ''
  }

  const boundKeys = updateWidgetProfileAssignments(widget.id)
  iconHint.textContent = widget.iconPath
    ? `Icone perso active. Touche(s) liee(s): ${boundKeys.length ? boundKeys.join(', ') : 'aucune'}`
    : `Aucune icone perso. Touche(s) liee(s): ${boundKeys.length ? boundKeys.join(', ') : 'aucune'}`

  clearIconBtn.disabled = !widget.iconPath
}

function renderStatus() {
  serverBadge.textContent = state.serverOnline ? 'Serveur en ligne' : 'Serveur hors ligne'
  serverBadge.classList.toggle('online', state.serverOnline)
  serverBadge.classList.toggle('offline', !state.serverOnline)

  deviceBadge.textContent = state.deviceConnected ? 'Appareil connecte' : 'Appareil deconnecte'
  deviceBadge.classList.toggle('online', state.deviceConnected)
  deviceBadge.classList.toggle('offline', !state.deviceConnected)

  eventLine.textContent = `Dernier evenement: ${state.lastEvent || '-'} | Profil actif: ${profileLabel(state.currentConfig?.activeProfile || state.selectedProfile)}`
}

function renderTemplateButtons() {
  templateList.innerHTML = ''
  for (const template of TEMPLATE_DEFS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'template-btn'
    btn.dataset.templateId = template.id
    btn.textContent = template.label
    if (template.id === state.createDraft.templateId) btn.classList.add('selected')
    templateList.appendChild(btn)
  }
}

function refreshCreateState() {
  const valid = Boolean(state.createDraft.templateId && state.createDraft.name.trim())
  confirmCreateBtn.disabled = !valid
}

function openCreateModal() {
  state.createDraft = { templateId: '', name: '' }
  createNameInput.value = ''
  renderTemplateButtons()
  refreshCreateState()
  createModal.classList.remove('hidden')
}

function closeCreateModal() {
  createModal.classList.add('hidden')
}

function createWidgetFromDraft() {
  const template = templateById(state.createDraft.templateId)
  if (!template) return null

  const name = state.createDraft.name.trim()
  if (!name) return null

  const id = `${state.selectedProfile}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
  return {
    id,
    name: name.slice(0, 30),
    actionType: template.id,
    color: template.defaultColor,
    value: '',
    delayMs: 120,
    iconPath: '',
  }
}

function assignWidgetToSelectedKey(widgetId) {
  const assignments = assignmentsForProfile()
  assignments[state.selectedKey] = widgetId
  syncConfigFromWidgets(state.selectedProfile)
}

function assignWidgetToKey(key, widgetId) {
  if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) return
  if (!widgetById(widgetId)) return
  const assignments = assignmentsForProfile()
  assignments[key] = widgetId
  syncConfigFromWidgets(state.selectedProfile)
  persistWidgetState()
  scheduleAutoSave()
}

function updateSelectedWidget(patch) {
  const widgets = widgetsForProfile()
  const idx = widgets.findIndex(w => w.id === state.selectedWidgetId)
  if (idx < 0) return
  widgets[idx] = { ...widgets[idx], ...patch }
  syncConfigFromWidgets(state.selectedProfile)
  persistWidgetState()
  scheduleAutoSave()
}

async function loadInstalledApps() {
  const data = await fetchJson('/api/apps')
  state.installedApps = Array.isArray(data.apps) ? data.apps : []
}

async function loadConfig() {
  const cfg = await fetchJson('/api/config')
  state.currentConfig = ensureConfigShape(cfg)
  if (!PROFILE_IDS.includes(state.selectedProfile)) state.selectedProfile = state.currentConfig.activeProfile
  rebuildWidgetsFromConfig()
  mergeWidgetStateWithStorage()
  persistWidgetState()
  if (!state.selectedWidgetId) state.selectedWidgetId = widgetsForProfile()[0]?.id || null
}

async function saveConfig() {
  syncAllProfilesFromWidgets()
  const payload = ensureConfigShape(state.currentConfig)
  const saved = await fetchJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  state.currentConfig = ensureConfigShape(saved)
  persistWidgetState()
}

async function flushAutoSave() {
  if (state.saveInFlight) {
    state.saveQueued = true
    return
  }

  state.saveInFlight = true
  try {
    await saveConfig()
  } catch (error) {
    showMessage(`Erreur auto-save: ${error.message}`, 'error')
  } finally {
    state.saveInFlight = false
    if (state.saveQueued) {
      state.saveQueued = false
      scheduleAutoSave(true)
    }
  }
}

function scheduleAutoSave(immediate = false) {
  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer)
    state.autoSaveTimer = null
  }

  if (immediate) {
    flushAutoSave().catch(() => {})
    return
  }

  state.autoSaveTimer = setTimeout(() => {
    state.autoSaveTimer = null
    flushAutoSave().catch(() => {})
  }, 550)
}

async function setActiveProfile(profile) {
  if (!PROFILE_IDS.includes(profile)) return
  state.selectedProfile = profile
  state.currentConfig.activeProfile = profile

  if (!widgetsForProfile(profile).length) {
    state.selectedWidgetId = null
  } else if (!widgetById(state.selectedWidgetId, profile)) {
    state.selectedWidgetId = widgetsForProfile(profile)[0].id
  }

  renderAll()

  await fetchJson('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  }).catch(() => {})
}

async function triggerSelectedWidget() {
  const widget = widgetById(state.selectedWidgetId)
  if (!widget) throw new Error('Aucun widget selectionne.')

  const assignments = assignmentsForProfile()
  const key = assignments.findIndex(id => id === widget.id)
  if (key < 0) throw new Error('Affecte ce widget a une touche avant test.')

  return fetchJson('/api/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: state.selectedProfile }),
  })
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Lecture fichier impossible'))
    reader.readAsDataURL(file)
  })
}

async function uploadIconForSelectedWidget(file) {
  const widget = widgetById(state.selectedWidgetId)
  if (!widget) throw new Error('Aucun widget selectionne.')

  const boundKeys = updateWidgetProfileAssignments(widget.id)
  if (!boundKeys.length) throw new Error('Affecte le widget a une touche avant upload icone.')

  const dataUrl = await readFileAsDataUrl(file)
  const key = boundKeys[0]
  const result = await fetchJson('/api/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: state.selectedProfile, dataUrl }),
  })

  updateSelectedWidget({ iconPath: String(result.iconPath || '') })
  syncConfigFromWidgets(state.selectedProfile)
}

async function clearIconForSelectedWidget() {
  const widget = widgetById(state.selectedWidgetId)
  if (!widget) throw new Error('Aucun widget selectionne.')

  const boundKeys = updateWidgetProfileAssignments(widget.id)
  if (!boundKeys.length) {
    updateSelectedWidget({ iconPath: '' })
    return
  }

  const key = boundKeys[0]
  await fetchJson('/api/icon', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, profile: state.selectedProfile }),
  })

  updateSelectedWidget({ iconPath: '' })
  syncConfigFromWidgets(state.selectedProfile)
}

function renderAll() {
  renderProfileButtons()
  refreshAppDatalist()
  renderWidgetList()
  renderKeyGrid()
  renderEditor()
  renderStatus()
}

function setMenuOpen(open) {
  state.menuOpen = Boolean(open)
  configMenu.classList.toggle('hidden', !state.menuOpen)
}

function setWidgetContextMenu(open, x = 0, y = 0, widgetId = null) {
  state.contextWidgetId = open ? widgetId : null
  if (!open) {
    widgetContextMenu.classList.add('hidden')
    return
  }
  widgetContextMenu.style.left = `${Math.max(8, x)}px`
  widgetContextMenu.style.top = `${Math.max(8, y)}px`
  widgetContextMenu.classList.remove('hidden')
}

function downloadJsonFile(fileName, content) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Lecture fichier impossible'))
    reader.readAsText(file, 'utf-8')
  })
}

function deleteWidget(widgetId) {
  if (!widgetId) return
  const widgets = widgetsForProfile()
  const nextWidgets = widgets.filter(w => w.id !== widgetId)
  state.widgetsByProfile[state.selectedProfile] = nextWidgets

  const assignments = assignmentsForProfile()
  for (let key = 0; key < KEY_COUNT; key += 1) {
    if (assignments[key] === widgetId) assignments[key] = null
  }

  if (state.selectedWidgetId === widgetId) {
    state.selectedWidgetId = nextWidgets[0]?.id || null
  }

  syncConfigFromWidgets(state.selectedProfile)
  persistWidgetState()
  scheduleAutoSave()
}

function attachEvents() {
  profileButtons.addEventListener('click', event => {
    const btn = event.target.closest('button[data-profile]')
    if (!btn) return
    clearMessage()
    setActiveProfile(btn.dataset.profile).catch(() => {})
  })

  keyGrid.addEventListener('click', event => {
    const unassignBtn = event.target.closest('button[data-action="unassign-widget"]')
    if (unassignBtn) {
      const key = Number(unassignBtn.dataset.key)
      const assignments = assignmentsForProfile()
      if (Number.isInteger(key) && key >= 0 && key < KEY_COUNT) {
        assignments[key] = null
        syncConfigFromWidgets(state.selectedProfile)
        persistWidgetState()
        scheduleAutoSave()
        renderKeyGrid()
        renderEditor()
        showMessage(`Touche ${key}: widget desaffecte.`, 'ok')
      }
      return
    }

    const slot = event.target.closest('.key-slot')
    if (!slot) return
    state.selectedKey = Number(slot.dataset.key)
    const assigned = assignmentsForProfile()[state.selectedKey]
    if (assigned) state.selectedWidgetId = assigned
    renderKeyGrid()
    renderWidgetList()
    renderEditor()
  })

  widgetList.addEventListener('click', event => {
    const card = event.target.closest('.widget-card')
    if (!card) return
    state.selectedWidgetId = card.dataset.widgetId
    renderWidgetList()
    renderEditor()
  })

  widgetList.addEventListener('contextmenu', event => {
    const card = event.target.closest('.widget-card')
    if (!card) return
    event.preventDefault()
    const wid = card.dataset.widgetId
    if (!wid) return
    setWidgetContextMenu(true, event.clientX, event.clientY, wid)
  })

  widgetList.addEventListener('dragstart', event => {
    const card = event.target.closest('.widget-card')
    if (!card) return
    const widgetId = card.dataset.widgetId
    if (!widgetId) return
    state.draggingWidgetId = widgetId
    state.draggingSourceKey = null
    event.dataTransfer.setData('text/widget-id', widgetId)
    event.dataTransfer.setData('text/plain', widgetId)
    event.dataTransfer.effectAllowed = 'copy'
  })

  widgetList.addEventListener('dragend', () => {
    state.draggingWidgetId = null
    for (const slot of keyGrid.querySelectorAll('.drag-over')) slot.classList.remove('drag-over')
  })

  keyGrid.addEventListener('dragover', event => {
    const slot = event.target.closest('.key-slot')
    if (!slot) return
    event.preventDefault()
    event.dataTransfer.dropEffect = Number.isInteger(state.draggingSourceKey) ? 'move' : 'copy'
  })

  keyGrid.addEventListener('dragstart', event => {
    const slot = event.target.closest('.key-slot')
    if (!slot) return
    const key = Number(slot.dataset.key)
    if (!Number.isInteger(key) || key < 0 || key >= KEY_COUNT) return
    const widgetId = assignmentsForProfile()[key]
    if (!widgetId) return

    state.draggingWidgetId = widgetId
    state.draggingSourceKey = key
    event.dataTransfer.setData('text/widget-id', widgetId)
    event.dataTransfer.setData('text/source-key', String(key))
    event.dataTransfer.setData('text/plain', widgetId)
    event.dataTransfer.effectAllowed = 'move'
  })

  keyGrid.addEventListener('dragend', () => {
    state.draggingWidgetId = null
    state.draggingSourceKey = null
    for (const slot of keyGrid.querySelectorAll('.drag-over')) slot.classList.remove('drag-over')
  })

  keyGrid.addEventListener('dragenter', event => {
    const slot = event.target.closest('.key-slot')
    if (!slot) return
    slot.classList.add('drag-over')
  })

  keyGrid.addEventListener('dragleave', event => {
    const slot = event.target.closest('.key-slot')
    if (!slot) return
    if (slot.contains(event.relatedTarget)) return
    slot.classList.remove('drag-over')
  })

  keyGrid.addEventListener('drop', event => {
    const slot = event.target.closest('.key-slot')
    if (!slot) return
    event.preventDefault()
    slot.classList.remove('drag-over')

    const key = Number(slot.dataset.key)
    const wid = event.dataTransfer.getData('text/widget-id') || event.dataTransfer.getData('text/plain') || state.draggingWidgetId
    const sourceKeyRaw = event.dataTransfer.getData('text/source-key')
    const sourceKey =
      sourceKeyRaw !== '' ? Number(sourceKeyRaw) : Number.isInteger(state.draggingSourceKey) ? state.draggingSourceKey : null
    if (!wid) return

    if (Number.isInteger(sourceKey) && sourceKey >= 0 && sourceKey < KEY_COUNT && sourceKey !== key) {
      const assignments = assignmentsForProfile()
      assignments[sourceKey] = null
    }

    assignWidgetToKey(key, wid)
    state.selectedKey = key
    state.selectedWidgetId = wid
    state.draggingWidgetId = null
    state.draggingSourceKey = null
    renderAll()
    showMessage(`Touche ${key}: widget affecte.`, 'ok')
  })

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value || ''
    renderWidgetList()
    refreshAppDatalist()
    renderEditor()
  })

  widgetNameInput.addEventListener('input', () => {
    updateSelectedWidget({ name: widgetNameInput.value.slice(0, 30) })
    renderWidgetList()
    renderKeyGrid()
    renderEditor()
  })

  colorInput.addEventListener('input', () => {
    updateSelectedWidget({ color: normalizeColor(colorInput.value) })
    renderWidgetList()
    renderKeyGrid()
  })

  valueInput.addEventListener('input', () => {
    updateSelectedWidget({ value: valueInput.value })
    renderKeyGrid()
    renderEditor()
  })

  macroDelayInput.addEventListener('input', () => {
    updateSelectedWidget({ delayMs: clampDelayMs(macroDelayInput.value) })
    renderEditor()
  })

  testBtn.addEventListener('click', async () => {
    try {
      clearMessage()
      const result = await triggerSelectedWidget()
      if (result.ok) showMessage('Test widget: action executee.', 'ok')
      else showMessage(`Test widget: ${result.reason || 'non executee'}`, 'error')
    } catch (error) {
      showMessage(`Erreur test: ${error.message}`, 'error')
    }
  })

  saveBtn.addEventListener('click', async () => {
    try {
      clearMessage()
      await flushAutoSave()
      showMessage(`Config sauvegardee (${profileLabel(state.selectedProfile)}).`, 'ok')
    } catch (error) {
      showMessage(`Erreur sauvegarde: ${error.message}`, 'error')
    }
  })

  reloadBtn.addEventListener('click', async () => {
    try {
      clearMessage()
      await loadConfig()
      renderAll()
      showMessage('Config rechargee.', 'ok')
    } catch (error) {
      showMessage(`Erreur reload: ${error.message}`, 'error')
    }
  })

  uploadIconBtn.addEventListener('click', () => {
    iconFileInput.click()
  })

  iconFileInput.addEventListener('change', async () => {
    const file = iconFileInput.files?.[0]
    if (!file) return
    try {
      clearMessage()
      await uploadIconForSelectedWidget(file)
      renderAll()
      showMessage('Icone perso appliquee sur widget.', 'ok')
    } catch (error) {
      showMessage(`Erreur upload icone: ${error.message}`, 'error')
    } finally {
      iconFileInput.value = ''
    }
  })

  clearIconBtn.addEventListener('click', async () => {
    try {
      clearMessage()
      await clearIconForSelectedWidget()
      renderAll()
      showMessage('Icone retiree du widget.', 'ok')
    } catch (error) {
      showMessage(`Erreur retrait icone: ${error.message}`, 'error')
    }
  })

  createWidgetBtn.addEventListener('click', () => {
    openCreateModal()
  })

  menuBtn.addEventListener('click', event => {
    event.stopPropagation()
    setMenuOpen(!state.menuOpen)
  })

  exportConfigBtn.addEventListener('click', () => {
    try {
      syncAllProfilesFromWidgets()
      const payload = ensureConfigShape(state.currentConfig)
      const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
      downloadJsonFile(`loopdeck-config-${stamp}.json`, JSON.stringify(payload, null, 2))
      setMenuOpen(false)
      showMessage('Config exportee.', 'ok')
    } catch (error) {
      showMessage(`Erreur export: ${error.message}`, 'error')
    }
  })

  importConfigBtn.addEventListener('click', () => {
    importConfigInput.click()
  })

  importConfigInput.addEventListener('change', async () => {
    const file = importConfigInput.files?.[0]
    if (!file) return

    try {
      clearMessage()
      const raw = await readFileAsText(file)
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('JSON invalide.')
      }

      // Import strategy: hard reset -> apply imported config.
      // Also clear local widget cache to avoid stale merge artifacts.
      if (state.autoSaveTimer) {
        clearTimeout(state.autoSaveTimer)
        state.autoSaveTimer = null
      }
      state.saveQueued = false
      state.saveInFlight = false
      localStorage.removeItem(WIDGET_STATE_STORAGE_KEY)

      await fetchJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defaultConfig()),
      })

      const saved = await fetchJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })

      state.currentConfig = ensureConfigShape(saved)
      state.selectedProfile = state.currentConfig.activeProfile || 'home'
      state.selectedKey = 0
      rebuildWidgetsFromConfig()
      persistWidgetState()
      if (!state.selectedWidgetId) state.selectedWidgetId = widgetsForProfile()[0]?.id || null

      await setActiveProfile(state.selectedProfile)
      renderAll()
      setMenuOpen(false)
      showMessage('Config importee.', 'ok')
    } catch (error) {
      showMessage(`Erreur import: ${error.message}`, 'error')
    } finally {
      importConfigInput.value = ''
    }
  })

  resetConfigBtn.addEventListener('click', async () => {
    const ok = window.confirm('Remettre toute la config a defaut ?')
    if (!ok) return
    try {
      clearMessage()
      state.currentConfig = ensureConfigShape(defaultConfig())
      state.selectedProfile = 'home'
      state.selectedKey = 0
      state.selectedWidgetId = null
      rebuildWidgetsFromConfig()
      persistWidgetState()
      await saveConfig()
      await setActiveProfile('home')
      renderAll()
      setMenuOpen(false)
      showMessage('Config remise a defaut.', 'ok')
    } catch (error) {
      showMessage(`Erreur reset: ${error.message}`, 'error')
    }
  })

  templateList.addEventListener('click', event => {
    const btn = event.target.closest('button[data-template-id]')
    if (!btn) return
    state.createDraft.templateId = btn.dataset.templateId
    renderTemplateButtons()
    refreshCreateState()
  })

  createNameInput.addEventListener('input', () => {
    state.createDraft.name = createNameInput.value || ''
    refreshCreateState()
  })

  cancelCreateBtn.addEventListener('click', () => {
    closeCreateModal()
  })

  confirmCreateBtn.addEventListener('click', () => {
    const created = createWidgetFromDraft()
    if (!created) return

    widgetsForProfile().push(created)
    state.selectedWidgetId = created.id

    closeCreateModal()
    persistWidgetState()
    scheduleAutoSave()
    renderAll()
    showMessage(`Widget cree: ${created.name}`, 'ok')
  })

  createModal.addEventListener('click', event => {
    if (event.target === createModal) closeCreateModal()
  })

  ctxCloneBtn.addEventListener('click', () => {
    const source = widgetById(state.contextWidgetId)
    if (!source) {
      setWidgetContextMenu(false)
      return
    }
    const clone = {
      ...source,
      id: `${state.selectedProfile}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      name: `${source.name} (copy)`.slice(0, 30),
      iconPath: '',
    }
    widgetsForProfile().push(clone)
    state.selectedWidgetId = clone.id
    syncConfigFromWidgets(state.selectedProfile)
    persistWidgetState()
    scheduleAutoSave()
    setWidgetContextMenu(false)
    renderAll()
    showMessage('Widget clone.', 'ok')
  })

  ctxDeleteBtn.addEventListener('click', () => {
    const wid = state.contextWidgetId
    if (!wid) {
      setWidgetContextMenu(false)
      return
    }
    deleteWidget(wid)
    setWidgetContextMenu(false)
    renderAll()
    showMessage('Widget supprime.', 'ok')
  })

  document.addEventListener('click', event => {
    if (!state.menuOpen) return
    if (configMenu.contains(event.target) || menuBtn.contains(event.target)) return
    setMenuOpen(false)
  })

  document.addEventListener(
    'pointerdown',
    event => {
      if (widgetContextMenu.classList.contains('hidden')) return
      if (widgetContextMenu.contains(event.target)) return
      setWidgetContextMenu(false)
    },
    true,
  )

  document.addEventListener(
    'contextmenu',
    event => {
      if (widgetContextMenu.classList.contains('hidden')) return
      const card = event.target.closest('.widget-card')
      const insideMenu = widgetContextMenu.contains(event.target)
      if (!card && !insideMenu) {
        setWidgetContextMenu(false)
      }
    },
    true,
  )

  window.addEventListener('blur', () => {
    setWidgetContextMenu(false)
  })
}

async function refreshStatus() {
  try {
    const status = await fetchJson('/api/status')
    state.serverOnline = true
    state.deviceConnected = Boolean(status.connected)
    state.lastEvent = status.lastEvent || '-'

    if (PROFILE_IDS.includes(status.activeProfile) && status.activeProfile !== state.currentConfig.activeProfile) {
      state.currentConfig.activeProfile = status.activeProfile
      state.selectedProfile = status.activeProfile

      if (!widgetById(state.selectedWidgetId)) {
        state.selectedWidgetId = widgetsForProfile()[0]?.id || null
      }

      renderAll()
    }
  } catch {
    state.serverOnline = false
    state.deviceConnected = false
  }

  renderStatus()
}

async function bootstrap() {
  try {
    await Promise.all([loadInstalledApps(), loadConfig()])
    state.serverOnline = true
  } catch (error) {
    showMessage(`Mode degrade: ${error.message}`, 'error')
    state.currentConfig = ensureConfigShape(null)
    rebuildWidgetsFromConfig()
    mergeWidgetStateWithStorage()
    persistWidgetState()
    state.serverOnline = false
  }

  state.selectedProfile = state.currentConfig.activeProfile || 'home'
  if (!state.selectedWidgetId) state.selectedWidgetId = widgetsForProfile()[0]?.id || null

  attachEvents()
  renderAll()

  refreshStatus().catch(() => {})
  setInterval(() => {
    refreshStatus().catch(() => {})
  }, 2000)
}

bootstrap().catch(error => {
  showMessage(`Erreur init: ${error.message}`, 'error')
})

