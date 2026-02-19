import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { discover } from 'loupedeck'
import { Jimp, ResizeStrategy } from 'jimp'
import {
  createConfigStore,
  isValidHttpUrl,
  normalizeActionType,
  sanitizeIconPath,
  validateConfigStrict,
} from './server/config-store.mjs'
import { createKeyboardActionExecutor } from './server/keyboard-actions.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = 3210
const ROOT_DIR = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT_DIR, 'public')
const CONFIG_DIR = path.join(ROOT_DIR, 'config')
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
const MIXER_KNOB_IDS = ['knobTL', 'knobCL', 'knobBL', 'knobTR', 'knobCR', 'knobBR']
const MIXER_STEP_PER_TICK = 0.03

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
  volumeAdjustTimers: new Map(),
  volumeAdjustDeltas: new Map(),
}

const isProfileId = value => PROFILE_IDS.includes(String(value))

const configStore = createConfigStore({
  fs,
  configDir: CONFIG_DIR,
  iconsDir: ICONS_DIR,
  configPath: CONFIG_PATH,
  keyCount: KEY_COUNT,
  profileIds: PROFILE_IDS,
  configVersion: CONFIG_VERSION,
})

const ensureConfigFile = configStore.ensureConfigFile
const readConfig = configStore.readConfig
const writeConfig = configStore.writeConfig
const getCurrentConfig = configStore.getCurrentConfig

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

function emptyShortcuts() {
  return Array.from({ length: KEY_COUNT }, (_, key) => ({
    key,
    label: `Key ${key}`,
    color: '#000000',
    actionType: 'command',
    value: '',
    iconPath: '',
  }))
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
  const profileShortcuts = Array.isArray(config?.profiles?.[activeProfile]) ? config.profiles[activeProfile] : emptyShortcuts()
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
        } else if (item.actionType === 'command' || item.actionType === 'app' || item.actionType === 'app_volume') {
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

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function normalizeMixerTarget(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const firstToken = tokenizeCommandLine(raw)[0] || raw
  const unquoted = firstToken.replace(/^"+|"+$/g, '').trim()
  if (!unquoted) return ''

  const fileName = path.basename(unquoted).toLowerCase()
  if (fileName.endsWith('.lnk')) return fileName.replace(/\.lnk$/i, '')
  if (fileName.endsWith('.exe')) return fileName.replace(/\.exe$/i, '')

  if (fileName.includes('.') || fileName.includes('\\') || fileName.includes('/')) {
    return path.parse(fileName).name.toLowerCase()
  }

  return unquoted.toLowerCase()
}

function getMixerAssignments(config) {
  const activeProfile = isProfileId(config?.activeProfile) ? config.activeProfile : 'home'
  const shortcuts = Array.isArray(config?.profiles?.[activeProfile]) ? config.profiles[activeProfile] : []
  const mixerItems = shortcuts
    .filter(item => normalizeActionType(item?.actionType) === 'app_volume')
    .map(item => ({
      key: Number(item?.key),
      label: String(item?.label || ''),
      target: normalizeMixerTarget(item?.value),
    }))
    .filter(item => Number.isInteger(item.key) && item.target)
    .sort((a, b) => a.key - b.key)

  const out = new Map()
  for (let i = 0; i < MIXER_KNOB_IDS.length && i < mixerItems.length; i += 1) {
    out.set(MIXER_KNOB_IDS[i], mixerItems[i])
  }
  return out
}

function buildVolumeAdjustScript() {
  return `
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][double]$Step
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out object ppInterface);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int NotImpl1();
  int NotImpl2();
  int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  int GetCount(out int SessionCount);
  int GetSession(int SessionCount, out IAudioSessionControl Session);
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int NotImpl0();
  int NotImpl1();
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, Guid EventContext);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, Guid EventContext);
  int GetGroupingParam(out Guid pRetVal);
  int SetGroupingParam(Guid Override, Guid EventContext);
  int NotImpl2();
  int NotImpl3();
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int GetProcessId(out uint pRetVal);
  int IsSystemSoundsSession();
  int SetDuckingPreference(bool optOut);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  int SetMasterVolume(float fLevel, ref Guid EventContext);
  int GetMasterVolume(out float pfLevel);
  int SetMute(bool bMute, ref Guid EventContext);
  int GetMute(out bool pbMute);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {
}
"@

$targetToken = $Target.Trim().Trim('"').ToLower()
if ([string]::IsNullOrWhiteSpace($targetToken)) {
  throw "Target vide"
}

$step = [Math]::Max(-1.0, [Math]::Min(1.0, $Step))
$deviceEnumerator = [IMMDeviceEnumerator](New-Object MMDeviceEnumeratorComObject)
$device = $null
[void]$deviceEnumerator.GetDefaultAudioEndpoint([EDataFlow]::eRender, [ERole]::eMultimedia, [ref]$device)

$iid = [Guid]::Parse("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")
$managerObj = $null
[void]$device.Activate([ref]$iid, 23, [IntPtr]::Zero, [ref]$managerObj)
$manager = [IAudioSessionManager2]$managerObj

$sessions = $null
[void]$manager.GetSessionEnumerator([ref]$sessions)
$count = 0
[void]$sessions.GetCount([ref]$count)

$changed = 0
$lastPercent = -1

for ($i = 0; $i -lt $count; $i++) {
  $control = $null
  [void]$sessions.GetSession($i, [ref]$control)
  if ($null -eq $control) { continue }

  $control2 = [IAudioSessionControl2]$control
  $pid = 0
  [void]$control2.GetProcessId([ref]$pid)
  if ($pid -le 0) { continue }

  $procName = ''
  try {
    $procName = [System.Diagnostics.Process]::GetProcessById([int]$pid).ProcessName.ToLower()
  } catch {
    continue
  }

  if ($procName -ne $targetToken -and -not $procName.Contains($targetToken) -and -not $targetToken.Contains($procName)) {
    continue
  }

  $volume = [ISimpleAudioVolume]$control
  $current = 0.0
  [void]$volume.GetMasterVolume([ref]$current)
  $next = [Math]::Max(0.0, [Math]::Min(1.0, $current + $step))
  $ctx = [Guid]::Empty
  [void]$volume.SetMasterVolume([float]$next, [ref]$ctx)
  $changed += 1
  $lastPercent = [int][Math]::Round($next * 100.0)
}

if ($changed -eq 0) {
  [Console]::Out.WriteLine('{\"ok\":false,\"reason\":\"App non trouvee ou non en lecture audio.\"}')
} else {
  [Console]::Out.WriteLine('{\"ok\":true,\"sessions\":' + $changed + ',\"volume\":' + $lastPercent + '}')
}
`
}

async function adjustAppVolume(target, delta) {
  if (process.platform !== 'win32') return { ok: false, reason: 'Mixer app supporte uniquement sur Windows.' }
  const token = normalizeMixerTarget(target)
  if (!token) return { ok: false, reason: 'Cible mixer invalide.' }
  const step = clamp01(Math.abs(Number(delta) || 0)) * Math.sign(Number(delta) || 0)
  if (!step) return { ok: false, reason: 'Delta mixer nul.' }

  const script = buildVolumeAdjustScript()
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  try {
    const output = await runExecFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded, '-Target', token, '-Step', String(step)],
      4500,
    )
    return parseJsonSafe(output, { ok: false, reason: 'Reponse mixer invalide.' })
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

async function queueAppVolumeAdjustment(knobId, assignment, delta) {
  const prevDelta = state.volumeAdjustDeltas.get(knobId) || 0
  state.volumeAdjustDeltas.set(knobId, prevDelta + delta)
  if (state.volumeAdjustTimers.has(knobId)) return

  const timer = setTimeout(async () => {
    state.volumeAdjustTimers.delete(knobId)
    const pending = state.volumeAdjustDeltas.get(knobId) || 0
    state.volumeAdjustDeltas.delete(knobId)
    if (!pending) return

    const totalStep = Math.max(-0.24, Math.min(0.24, pending * MIXER_STEP_PER_TICK))
    const result = await adjustAppVolume(assignment.target, totalStep)
    if (!result?.ok) {
      setLastEvent(`[MIX] ${assignment.label || assignment.target}: ${result?.reason || 'erreur volume'}`)
      return
    }

    const volumeText = Number.isFinite(result.volume) ? ` (${result.volume}%)` : ''
    setLastEvent(`[MIX] ${assignment.label || assignment.target}${volumeText}`)
  }, 80)

  state.volumeAdjustTimers.set(knobId, timer)
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)

    Promise.resolve(promise)
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(error => {
        clearTimeout(timer)
        reject(error)
      })
  })
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

const { executeActionByType } = createKeyboardActionExecutor({
  runExecFile,
  normalizeActionType,
  isValidHttpUrl,
  openUrl,
  runCommand,
})

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

  const result = await executeActionByType(item.actionType, item.value, 0)

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
    const device = await withTimeout(
      discover({ autoConnect: false }),
      7000,
      'Timeout detection Loupedeck (vérifie câble/app officielle)',
    )
    await withTimeout(
      device.connect(),
      7000,
      'Timeout connexion Loupedeck (conflit probable COM/HID)',
    )

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

    // Knobs control first 6 app_volume widgets of active profile, ordered by key index.
    device.on('rotate', ({ id, delta }) => {
      const knobId = String(id || '')
      if (!MIXER_KNOB_IDS.includes(knobId)) return
      if (!Number.isInteger(delta) || delta === 0) return

      getCurrentConfig()
        .then(config => {
          const assignments = getMixerAssignments(config)
          const assignment = assignments.get(knobId)
          if (!assignment) return
          queueAppVolumeAdjustment(knobId, assignment, delta).catch(() => {})
        })
        .catch(() => {})
    })

    device.on('disconnect', error => {
      state.connected = false
      state.device = null
      for (const timer of state.volumeAdjustTimers.values()) clearTimeout(timer)
      state.volumeAdjustTimers.clear()
      state.volumeAdjustDeltas.clear()
      setLastEvent(`Déconnecté${error ? `: ${error.message}` : ''}`)
      setTimeout(() => {
        connectLoupedeck().catch(() => {})
      }, 2000)
    })

    const result = await readConfig()
    state.warnings = result.warnings || []
    await drawFromConfig(result.config)
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
    const check = validateConfigStrict(payload, {
      keyCount: KEY_COUNT,
      profileIds: PROFILE_IDS,
      configVersion: CONFIG_VERSION,
    })

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

export async function start() {
  await ensureConfigFile()
  const initial = await readConfig()
  state.warnings = initial.warnings || []

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






