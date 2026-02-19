function escapePsSingleQuoted(value) {
  return String(value || '').replaceAll("'", "''")
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
    // fallback
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
    // fallback
  }
  return { text: String(value || '') }
}

function parseMultiActionValue(value, normalizeActionType) {
  const raw = String(value || '').trim()
  if (!raw) return { steps: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
      const steps = parsed.steps
        .filter(step => step && typeof step === 'object')
        .map(step => ({
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

function normalizeKeyPressToken(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  if (Array.from(raw).length === 1) {
    return escapeForSendKeys(raw)
  }

  const upper = raw.toUpperCase()
  const aliases = {
    DEL: 'DEL',
    DELETE: 'DEL',
    BACKSPACE: 'BACKSPACE',
    BS: 'BACKSPACE',
    ENTER: 'ENTER',
    RETURN: 'ENTER',
    TAB: 'TAB',
    ESC: 'ESC',
    ESCAPE: 'ESC',
    SPACE: 'SPACE',
    HOME: 'HOME',
    END: 'END',
    INSERT: 'INS',
    INS: 'INS',
    PAGEUP: 'PGUP',
    PGUP: 'PGUP',
    PAGEDOWN: 'PGDN',
    PGDN: 'PGDN',
    LEFT: 'LEFT',
    RIGHT: 'RIGHT',
    UP: 'UP',
    DOWN: 'DOWN',
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(upper)) {
    return `{${upper}}`
  }

  if (aliases[upper]) return `{${aliases[upper]}}`
  return ''
}

export function createKeyboardActionExecutor({ runExecFile, normalizeActionType, isValidHttpUrl, openUrl, runCommand }) {
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
    if (keys.length === 0) return { ok: false, reason: 'Macro vide (aucune touche).' }

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
    if (!text.trim()) return { ok: false, reason: 'Texte à coller vide.' }

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

  async function runKeyPress(value) {
    const token = normalizeKeyPressToken(value)
    if (!token) {
      return { ok: false, reason: 'Touche invalide (ex: F1, DELETE, !, a, 5).' }
    }

    const script = `
$ws = New-Object -ComObject WScript.Shell
$token = '${escapePsSingleQuoted(token)}'
Start-Sleep -Milliseconds 80
$ws.SendKeys($token)
`
    return runPowerShellKeyboardScript(script, `Touche envoyee: ${String(value || '').trim()}`, 2500)
  }

  async function runMultiAction(value, depth = 0) {
    if (depth > 3) return { ok: false, reason: 'Multi-action trop profonde.' }
    const parsed = parseMultiActionValue(value, normalizeActionType)
    const steps = Array.isArray(parsed.steps) ? parsed.steps : []
    if (!steps.length) return { ok: false, reason: 'Multi-action vide.' }

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      const result = await executeActionByType(step.actionType, step.value, depth + 1)
      if (!result.ok) {
        return { ok: false, reason: `Multi-action etape ${i + 1}: ${result.reason}` }
      }
      await new Promise(resolve => setTimeout(resolve, 40))
    }

    return { ok: true, message: `Multi-action executee (${steps.length} etape(s))` }
  }

  async function executeActionByType(actionType, value, depth = 0) {
    const type = normalizeActionType(actionType)
    if (type === 'url' || isValidHttpUrl(value)) return openUrl(value)
    if (type === 'app_volume') return { ok: true, message: 'Mixer app prêt (utilise les potards).' }
    if (type === 'key_press') return runKeyPress(value)
    if (type === 'macro') return runMacro(value)
    if (type === 'paste_text') return runPasteText(value)
    if (type === 'multi_action') return runMultiAction(value, depth + 1)
    return runCommand(value)
  }

  return { executeActionByType }
}
