const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, dialog, shell, powerSaveBlocker, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const XLSX = require('xlsx')
const MqttClient = require('./src/mqtt-client')
const { autoUpdater } = require('electron-updater')

let clockWindow = null
let popupWindow = null
let historyWindow = null
let settingsWindow = null
let passwordWindow = null
let randomPickWindow = null
let updateWindow = null
let timerWindow = null
let drawWindow = null
let floatWindow = null
let examTimerWindow = null
let countdownWindows = []
let powerSaveBlockerId = null
let tray = null
let mqttClient = null
let pendingAction = null
let clockVisible = true
let floatVisible = true
let countdownVisible = true
let scheduleVisible = true
let scheduleWindows = []
let lastConnState = false
let floatZOrderTimer = null // 悬浮图标置顶定时器

const MAX_MESSAGES = 500
const COMMON_PRELOAD = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false
}
const CURRENT_VERSION = require('./package.json').version

const configPath = path.join(app.getPath('userData'), 'config.json')
const messagesPath = path.join(app.getPath('userData'), 'messages.json')
const passwordPath = path.join(app.getPath('userData'), 'password.json')
const nameListPath = path.join(app.getPath('userData'), 'namelist.json')

// 自启动：用 Electron 自带 API 写入注册表 Run 项（键名 electron.app.<应用名>）。
// 旧版在开发模式(app.getName()==='Electron')下曾写入残留项 electron.app.Electron，
// 该残留项不被勾选逻辑清除，会导致开机重复启动两个程序。切换时一并删除它。
function removeLegacyAutoLaunch() {
  if (process.platform !== 'win32') return
  try {
    require('child_process').execSync(
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "electron.app.Electron" /f',
      { windowsHide: true }
    )
  } catch (e) {}
}
function setAutoLaunch(enabled) {
  try { app.setLoginItemSettings({ openAtLogin: !!enabled, path: app.getPath('exe') }) } catch (e) {}
  removeLegacyAutoLaunch()
}

// ==================== 数据读写 ====================
function defaultCountdowns() {
  return [
    { id: 'cd_gaokao', name: '高考', month: 6, day: 7, autoYear: true, enabled: true, color: '#dc2626' },
    { id: 'cd_zhongkao', name: '中考', month: 6, day: 22, autoYear: true, enabled: true, color: '#2563eb' }
  ]
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      var cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (cfg.pickMin === undefined) cfg.pickMin = 1
      if (cfg.pickMax === undefined) cfg.pickMax = 50
      if (cfg.pickCount === undefined) cfg.pickCount = 1
      if (cfg.pickUnique === undefined) cfg.pickUnique = true
      if (cfg.pickSound === undefined) cfg.pickSound = true
      if (cfg.countdownVisible === undefined) cfg.countdownVisible = true
  if (cfg.autoLaunch === undefined) cfg.autoLaunch = true
      if (cfg.scheduleShowWeekend === undefined) cfg.scheduleShowWeekend = true
      if (!Array.isArray(cfg.countdowns)) cfg.countdowns = defaultCountdowns()
      return cfg
    }
  } catch (e) {}
  return {
    productId: '', deviceName: '', deviceKey: '',
    muteSlots: [
      { id: 'default_1', start: '12:00', end: '13:30', label: '午休' },
      { id: 'default_2', start: '22:00', end: '07:00', label: '夜间' }
    ],
    fontSize: 72, volume: 80, voiceEnabled: true,
    pickMin: 1, pickMax: 50, pickCount: 1, pickUnique: true, pickSound: true,
    clockVisible: true, floatVisible: true,
    countdownVisible: true, scheduleVisible: true, scheduleMode: 'week', scheduleShowWeekend: true, autoLaunch: true, countdowns: defaultCountdowns()
  }
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function loadMessages() {
  try {
    if (fs.existsSync(messagesPath)) {
      return JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
    }
  } catch (e) {}
  return []
}

function saveMessages(messages) {
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(0, MAX_MESSAGES)
  }
  try {
    fs.writeFileSync(messagesPath, JSON.stringify(messages), 'utf8')
  } catch (e) {
    console.error('保存消息失败:', e.message)
  }
}

function loadPassword() {
  try {
    if (fs.existsSync(passwordPath)) {
      return JSON.parse(fs.readFileSync(passwordPath, 'utf8'))
    }
  } catch (e) {}
  return { password: '1234', hint: '默认密码' }
}

function savePasswordData(data) {
  fs.writeFileSync(passwordPath, JSON.stringify(data, null, 2))
}

function loadNameList() {
  try {
    if (fs.existsSync(nameListPath)) {
      return JSON.parse(fs.readFileSync(nameListPath, 'utf8'))
    }
  } catch (e) {}
  return []
}

function saveNameList(names) {
  fs.writeFileSync(nameListPath, JSON.stringify(names, null, 2))
}

function clearNameList() {
  if (fs.existsSync(nameListPath)) {
    fs.unlinkSync(nameListPath)
  }
}

// ==================== 悬浮图标/时钟状态持久化 ====================
function saveFloatState() {
  var config = loadConfig()
  config.clockVisible = clockVisible
  config.floatVisible = floatVisible
  config.countdownVisible = countdownVisible
  config.scheduleVisible = scheduleVisible
  saveConfig(config)
}


function loadFloatState() {
  var config = loadConfig()
  clockVisible = config.clockVisible !== false
  floatVisible = config.floatVisible !== false
  countdownVisible = config.countdownVisible !== false
  scheduleVisible = config.scheduleVisible !== false
  if (!clockVisible && clockWindow && !clockWindow.isDestroyed()) {
    clockWindow.hide()
  }
  if (!floatVisible && floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.hide()
  }
  if (!countdownVisible) {
    countdownWindows.forEach(function (w) { try { if (!w.isDestroyed()) w.hide() } catch (e) {} })
  }
}


// ==================== 静音检测 ====================
function isMuted(config) {
  if (!config.muteSlots || config.muteSlots.length === 0) return false
  var now = new Date()
  var nowMin = now.getHours() * 60 + now.getMinutes()
  for (var i = 0; i < config.muteSlots.length; i++) {
    var slot = config.muteSlots[i]
    if (!slot.start || !slot.end) continue
    var startParts = slot.start.split(':')
    var endParts = slot.end.split(':')
    var startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1])
    var endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1])
    if (startMin <= endMin) {
      if (nowMin >= startMin && nowMin < endMin) return true
    } else {
      if (nowMin >= startMin || nowMin < endMin) return true
    }
  }
  return false
}

// ==================== 自动更新（electron-updater + GitHub Releases） ====================
var _updateDownloaded = false
var _manualCheck = false
var _autoUpdaterReady = false

// GitHub 主站在国内被墙（net::ERR_CONNECTION_TIMED_OUT），故不走 github provider，
// 改走国内加速镜像的 generic 通道：镜像 + "/latest.yml"、"镜像 + 文件名" 即可。
// releases/latest/download 是 GitHub 的“永远指向最新版本资产”稳定路径，发新版无需改代码。
var UPDATE_DL_BASE = 'https://github.com/Makerlei/msgterminalpc-releases/releases/latest/download'
var UPDATE_MIRRORS = [
  'https://ghfast.top/' + UPDATE_DL_BASE,
  'https://gh-proxy.com/' + UPDATE_DL_BASE,
  'https://ghproxy.net/' + UPDATE_DL_BASE,
  UPDATE_DL_BASE // 最后兜底：直连 GitHub（挂了代理/VPN 时可用）
]
var _updateMirrorIdx = 0

// 托盘气泡提示（Windows）；无托盘/其他平台时静默
function notifyTray(title, body) {
  try {
    if (tray && tray.displayBalloon) {
      tray.displayBalloon({ title: title, content: body })
    }
  } catch (e) {}
}

// 初始化自动更新（幂等：事件只接线一次）；公开 releases 仓库免 token
function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[autoUpdater] 开发模式跳过自动更新')
    return
  }
  if (!_autoUpdaterReady) {
    _autoUpdaterReady = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // 镜像站不一定支持 Range 断点/差分下载，强制整包下载更稳
    autoUpdater.disableDifferentialDownload = true
    autoUpdater.on('update-available', function (info) {
      console.log('[autoUpdater] 发现新版本', info.version)
      notifyTray('消息终端', '发现新版本 v' + info.version + '，正在后台下载…')
    })
    autoUpdater.on('update-downloaded', function (info) {
      _updateDownloaded = true
      console.log('[autoUpdater] 下载完成', info.version)
      notifyTray('消息终端', '新版本 v' + info.version + ' 已下载，点击“立即更新”重启升级')
      var notes = (info.releaseNotes || info.releaseName || '').toString()
      showUpdateWindow(info.version, notes)
    })
    autoUpdater.on('update-not-available', function () {
      if (_manualCheck) {
        _manualCheck = false
        dialog.showMessageBox({ type: 'info', title: '检查更新', message: '当前已是最新版本 v' + CURRENT_VERSION, buttons: ['确定'] })
      }
    })
    autoUpdater.on('error', function (err) {
      var msg = (err && err.message) || String(err)
      console.error('[autoUpdater] 错误(源#' + (_updateMirrorIdx + 1) + '):', msg)
      // 还有备用源且尚未下载成功 → 自动切下一个源重试
      if (!_updateDownloaded && _updateMirrorIdx < UPDATE_MIRRORS.length - 1) {
        var next = _updateMirrorIdx + 1
        console.log('[autoUpdater] 切换备用更新源 #' + (next + 1))
        setTimeout(function () {
          applyUpdateFeed(next)
          autoUpdater.checkForUpdates().catch(function () {})
        }, 600)
        return
      }
      if (_manualCheck) {
        _manualCheck = false
        dialog.showMessageBox({ type: 'error', title: '检查更新', message: '检查更新失败：' + msg + '\n\n所有更新源均不可用，请检查网络后再试。', buttons: ['确定'] })
      }
    })
  }
  checkWithFallback()
}

// 按顺序尝试更新源：#1 起，失败在 error 回调里切换到下一个
function applyUpdateFeed(idx) {
  _updateMirrorIdx = idx
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_MIRRORS[idx] })
    console.log('[autoUpdater] 当前更新源 #' + (idx + 1) + ': ' + UPDATE_MIRRORS[idx])
  } catch (e) {
    console.error('[autoUpdater] setFeedURL 失败:', e && e.message)
  }
}

function checkWithFallback() {
  applyUpdateFeed(0)
  autoUpdater.checkForUpdates().catch(function () {})
}

// ==================== 密码验证窗口 ====================
function showPasswordDialog(callback) {
  if (passwordWindow && !passwordWindow.isDestroyed()) {
    passwordWindow.focus()
    return
  }
  var { width, height } = screen.getPrimaryDisplay().workAreaSize
  passwordWindow = new BrowserWindow({
    width: 340,
    height: 360,
    x: Math.floor((width - 340) / 2),
    y: Math.floor((height - 360) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: COMMON_PRELOAD
  })
  passwordWindow.loadFile('src/password.html')
  passwordWindow.setAlwaysOnTop(true, 'screen-saver')
  passwordWindow.on('closed', () => { passwordWindow = null })
  pendingAction = callback
}

// ==================== 桌面挂件自愈 & 桌面层注入 ====================
// 透明窗口的渲染进程 / GPU 进程崩溃后，窗口还在但页面空白，看上去就是"挂件不见了"。
// 休眠唤醒、锁屏解锁也常触发，重载一次即可恢复。
function armWidgetRecovery(win) {
  if (!win) return
  win.webContents.on('render-process-gone', () => {
    setTimeout(() => {
      var role = win.__role
      if (role === 'clock') {
        if (!clockWindow || clockWindow.isDestroyed()) createClockWindow()
        else { try { clockWindow.webContents.reload() } catch (e) {} }
      } else if (role === 'countdown') {
        if (win && !win.isDestroyed()) { try { win.webContents.reload() } catch (e) {} }
        else { createCountdownWindows() }
      } else if (win && !win.isDestroyed()) {
        try { win.webContents.reload() } catch (e) {}
      }
    }, 800)
  })
}

// ---- 桌面壁纸层注入：把挂件挂到桌面图标层(WorkerW)之下 ----
// 显示桌面(Win+D)时桌面层被抬到最前 -> 挂件浮在桌面之上可见；
// 平时桌面层在最底 -> 挂件被任意普通窗口正常盖住；鼠标穿透不受影响。
let desktopLayerEnabled = true // 若真机黑屏/异常，改 false（或 config 加 desktopLayer:false）即降级为非置顶
let desktopLayerTimer = null

function getHwndDecimal(win) {
  try {
    var buf = win.getNativeWindowHandle()
    return buf.readBigUInt64LE(0).toString()
  } catch (e) { return '0' }
}

function getInjectScriptPath() {
  // 打包后 ps1 必须放在 asar 之外(extraResources)，否则 PowerShell -File 读不到 asar 内虚拟路径
  if (app.isPackaged) return path.join(process.resourcesPath, 'inject-desktop.ps1')
  return path.join(__dirname, 'inject-desktop.ps1')
}

function injectToDesktopLayer(win) {
  if (!win || win.isDestroyed() || !desktopLayerEnabled) return
  var hwnd = getHwndDecimal(win)
  if (hwnd === '0') return
  var script = getInjectScriptPath()
  // 等窗口真正建好、样式就绪再注入。仅开发模式(err)写诊断日志；正式版零文件 I/O，利于长期后台精简
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    require('child_process').execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', script, hwnd
    ], { windowsHide: true, timeout: 20000 }, (err) => {
      if (err && !app.isPackaged) {
        try { fs.appendFileSync(path.join(__dirname, 'inject-call.log'),
          '[' + new Date().toISOString() + '] EXEC_ERROR: ' + err.message + '\n') } catch (e) {}
      }
    })
  }, 1200)
}

// 资源管理器重启 / 桌面重建后，WorkerW 会重新生成，需重新注入（每 15 秒补一次）
function startDesktopLayerWatchdog() {
  if (desktopLayerTimer) return
  desktopLayerTimer = setInterval(() => {
    try {
      if (desktopLayerEnabled) {
        if (clockWindow && !clockWindow.isDestroyed()) injectToDesktopLayer(clockWindow)
        countdownWindows.forEach(function (w) { if (w && !w.isDestroyed()) injectToDesktopLayer(w) })
      }
    } catch (e) {}
  }, 15000)
}

// 息屏/锁屏唤醒后恢复挂件。关键：必须尊重上次的显隐状态，
// 不能像旧版那样无条件 showInactive()，否则用户隐藏的窗口会被强行显示、
// 且托盘菜单对号与实际显示脱节（破坏"保持上次状态"）。
function recoverWidget(which) {
  if (which === 'clock') {
    if (!clockWindow || clockWindow.isDestroyed()) createClockWindow() // 窗口没了先重建
    if (!clockWindow) return
    if (clockVisible) {
      clockWindow.showInactive()
      clockWindow.webContents.reload()
      if (desktopLayerEnabled) injectToDesktopLayer(clockWindow)
    } else {
      clockWindow.webContents.reload()
    }
  } else {
    if (countdownWindows.length === 0) createCountdownWindows()
    countdownWindows.forEach(function (w) {
      if (!w || w.isDestroyed()) return
      w.webContents.reload()
      if (countdownVisible) {
        w.showInactive()
        if (desktopLayerEnabled) injectToDesktopLayer(w)
      }
    })
  }
}

function recoverAllWidgets() {
  setTimeout(() => {
    recoverWidget('clock')
    recoverWidget('countdown')
  }, 1200)
}


// ==================== 时钟窗口 ====================
// 以 1920 宽（逻辑像素）为基准，按桌面宽度比例缩放悬浮窗，保证不同分辨率下占比一致
function widgetScale() {
  var d = screen.getPrimaryDisplay().workArea
  var s = d.width / 1920
  if (s < 0.6) s = 0.6
  if (s > 3) s = 3
  return s
}

function clockBounds() {
  var d = screen.getPrimaryDisplay().workArea
  var s = widgetScale()
  var w = Math.round(400 * s)
  var h = Math.round(280 * s)
  return { x: d.x + d.width - w - 20, y: d.y + 20, width: w, height: h }
}

function relayoutClock() {
  if (!clockWindow || clockWindow.isDestroyed()) return
  clockWindow.setBounds(clockBounds())
  try { clockWindow.webContents.setZoomFactor(widgetScale()) } catch (e) {}
}

function createClockWindow() {
  if (clockWindow && !clockWindow.isDestroyed()) return
  var cb = clockBounds()
  clockWindow = new BrowserWindow({
    width: cb.width,
    height: cb.height,
    x: cb.x,
    y: cb.y,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: Object.assign({}, COMMON_PRELOAD, { backgroundThrottling: false })
  })
  clockWindow.__role = 'clock'
  clockWindow.loadFile('src/clock.html')
  clockWindow.setIgnoreMouseEvents(true, { forward: true })
  clockWindow.setVisibleOnAllWorkspaces(true)
  clockWindow.webContents.on('did-finish-load', () => {
    // 页面就绪后再申一次穿透，确保桌面图标点击、框选不受影响
    clockWindow.setIgnoreMouseEvents(true, { forward: true })
    try { clockWindow.webContents.setZoomFactor(widgetScale()) } catch (e) {}
    if (mqttClient) {
      clockWindow.webContents.send('connection-status', mqttClient.isConnected)
    }
  })
  clockWindow.on('closed', () => { clockWindow = null })
  armWidgetRecovery(clockWindow)
  injectToDesktopLayer(clockWindow)
  if (!clockVisible) clockWindow.hide() // 尊重保存的隐藏状态；重建场景也按此显隐
}

function toggleClock() {
  clockVisible = !clockVisible
  if (!clockWindow || clockWindow.isDestroyed()) {
    createClockWindow() // 内部按 clockVisible 决定初始显隐，重建后自动挂桌面层
  } else if (clockVisible) {
    clockWindow.showInactive()
  } else {
    clockWindow.hide()
  }
  saveFloatState()
  updateTrayMenu()
}

// ==================== 课程表（透明穿透常驻展示） ====================
const schedulePath = path.join(app.getPath('userData'), 'schedule.json')

// 早读 / 午读 / 晚自习：老模板或自建表里可能没有，读取与导入时自动补齐
var SPECIAL_SECTIONS = [
  { name: '早读', start: '07:30', end: '07:55' },
  { name: '午读', start: '12:40', end: '13:10' },
  { name: '晚自习', start: '19:00', end: '21:00' }
]

function secName(s) {
  return String((s && s.name) || '').replace(/\s+/g, '')
}

// 时间统一为 HH:MM（补零），非法返回 ''；否则高亮的字符串比较会错乱（如 7:30 > 08:00）
function normTime(t) {
  var m = /^(\d{1,2})[:：](\d{1,2})$/.exec(String(t == null ? '' : t).trim())
  if (!m) return ''
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10)
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return ''
  return (h < 10 ? '0' + h : String(h)) + ':' + (mi < 10 ? '0' + mi : String(mi))
}

function normalizeSchedule(data) {
  if (!data || !Array.isArray(data.sections)) return data
  var secs = data.sections.filter(function (s) { return s && secName(s) }).map(function (s) {
    return { name: String(s.name || '').trim(), start: normTime(s.start), end: normTime(s.end) }
  })
  var grid = (data.grid || []).slice(0, secs.length).map(function (row) {
    var r = Array.isArray(row) ? row.slice(0, 7) : []
    while (r.length < 7) r.push('')
    return r.map(function (v) { return v == null ? '' : String(v) })
  })
  while (grid.length < secs.length) grid.push(['', '', '', '', '', '', ''])

  function has(name) {
    for (var i = 0; i < secs.length; i++) if (secName(secs[i]) === name) return true
    return false
  }
  function idxOf(re) {
    for (var i = 0; i < secs.length; i++) if (re.test(secName(secs[i]))) return i
    return -1
  }
  function insertAt(pos, spec) {
    secs.splice(pos, 0, { name: spec.name, start: spec.start, end: spec.end })
    grid.splice(pos, 0, ['', '', '', '', '', '', ''])
  }

  // 早读 → 最前
  if (!has('早读')) insertAt(0, SPECIAL_SECTIONS[0])
  // 午读 → 第5节前（即第4节与第5节之间）
  if (!has('午读')) {
    var i5 = idxOf(/^第\s*5\s*节$/)
    var i4 = idxOf(/^第\s*4\s*节$/)
    var posMid = i5 >= 0 ? i5 : (i4 >= 0 ? i4 + 1 : secs.length)
    insertAt(posMid, SPECIAL_SECTIONS[1])
  }
  // 晚自习 → 最后
  if (!has('晚自习')) insertAt(secs.length, SPECIAL_SECTIONS[2])

  return { sections: secs, grid: grid, updatedAt: data.updatedAt || '' }
}

function loadSchedule() {
  try {
    if (fs.existsSync(schedulePath)) {
      return normalizeSchedule(JSON.parse(fs.readFileSync(schedulePath, 'utf8')))
    }
  } catch (e) {}
  return null
}
function saveSchedule(data) {
  fs.writeFileSync(schedulePath, JSON.stringify(normalizeSchedule(data), null, 2))
}

// 整周模式：靠右下角（任务栏以内），窗口尺寸为原来的 2/3，配合页面内自动缩字号保证完整显示
function scheduleWeekBounds() {
  var d = screen.getPrimaryDisplay().workAreaSize
  var ww = Math.min(667, Math.round(d.width * 0.413))
  var wh = Math.min(453, Math.round(d.height * 0.493))
  var margin = 12
  return {
    x: Math.max(0, d.width - ww - margin),
    y: Math.max(0, d.height - wh - margin),
    width: ww, height: wh
  }
}

// 估算文本像素宽度（按实际字号 fs 计算）
function textWidthPx(fs, str) {
  var w = 0
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i)
    var code = str.charCodeAt(i)
    if (code >= 0x2e80) w += fs          // 中日韩全角
    else if (/[A-Za-z0-9]/.test(ch)) w += fs * 0.56
    else if (ch === ' ') w += fs * 0.28
    else w += fs * 0.5
  }
  return w
}

// 当天模式的整列排布：用「任务栏以内的可用高度」自适应，节次多时自动压行高/间距，保证不出屏
function scheduleDayLayout(n) {
  var d = screen.getPrimaryDisplay().workArea
  var cb = clockBounds()
  var s = widgetScale()
  var gap = Math.max(4, Math.round(9 * s))
  var rowH = Math.round(54 * s)
  var top = cb.y + cb.height + Math.max(6, Math.round(10 * s))
  var bottomMargin = Math.round(10 * s)
  var avail = (d.y + d.height) - bottomMargin - top
  if (n > 0) {
    var total = n * rowH + (n - 1) * gap
    if (total > avail) {
      var k = avail / total
      rowH = Math.max(Math.round(26 * s), Math.floor(rowH * k))
      gap = Math.max(2, Math.floor(gap * k))
      total = n * rowH + (n - 1) * gap
      if (total > avail) rowH = Math.max(20, Math.floor((avail - (n - 1) * gap) / n))
    }
  }
  var fs = Math.round(rowH * 0.40)
  if (fs < 11) fs = 11
  if (fs > 34) fs = 34
  return { top: top, gap: gap, rowH: rowH, fs: fs, s: s }
}

// 当天模式：每个节次一个独立小窗口，整列统一宽度（取所有节次中最长标签所需宽度），右对齐时钟右边缘向下排
function scheduleItemBounds(i, layout) {
  var cb = clockBounds()
  var data = loadSchedule()
  var secs = (data && data.sections) || []
  var grid = (data && data.grid) || []
  var L = layout || scheduleDayLayout(secs.length)
  var pad = Math.max(8, Math.round(L.fs * 0.7))
  // 整列统一宽度：遍历所有节次，取「节次名 + 本周最长课名」中最宽的一个
  var colW = Math.max(70, Math.round(80 * L.s))
  for (var j = 0; j < secs.length; j++) {
    var lbl = String((secs[j] || {}).name || '')
    var courses = grid[j] || []
    var longest = ''
    for (var k = 0; k < courses.length; k++) {
      var v = String(courses[k] == null ? '' : courses[k])
      if (textWidthPx(L.fs, v) > textWidthPx(L.fs, longest)) longest = v
    }
    if (longest) lbl += ' ' + longest
    var wpx = Math.ceil(textWidthPx(L.fs, lbl)) + pad * 2 + 6
    if (wpx > colW) colW = wpx
  }
  if (colW > cb.width) colW = cb.width
  var wpx2 = Math.round(colW)
  return { x: cb.x + cb.width - wpx2, y: L.top + i * (L.rowH + L.gap), width: wpx2, height: L.rowH }
}

function destroyScheduleWindows() {
  if (scheduleWindows && scheduleWindows.length) {
    scheduleWindows.forEach(function (w) { try { if (!w.isDestroyed()) w.destroy() } catch (e) {} })
  }
  scheduleWindows = []
}

function createScheduleWindows() {
  destroyScheduleWindows()
  var cfg = loadConfig()
  var mode = cfg.scheduleMode === 'day' ? 'day' : 'week'
  if (mode === 'week') {
    var b = scheduleWeekBounds()
    var w = new BrowserWindow({
      width: b.width, height: b.height, x: b.x, y: b.y,
      transparent: true, frame: false, alwaysOnTop: false, skipTaskbar: true,
      resizable: false, focusable: false, hasShadow: false,
      webPreferences: Object.assign({}, COMMON_PRELOAD, { backgroundThrottling: false })
    })
    w.__role = 'schedule'
    w.loadFile('src/schedule.html')
    w.setIgnoreMouseEvents(true, { forward: true })
    w.setVisibleOnAllWorkspaces(true)
    w.webContents.on('did-finish-load', () => { w.setIgnoreMouseEvents(true, { forward: true }) })
    w.on('closed', () => { removeScheduleWindow(w) })
    armWidgetRecovery(w)
    injectToDesktopLayer(w)
    if (!scheduleVisible) w.hide()
    scheduleWindows.push(w)
    return
  }
  // day 模式：每节次一个小窗口，挂在时钟下方右侧、逐个向下排
  var data = loadSchedule()
  var secs = (data && data.sections) || []
  // 隐藏周六周日时，今天正好是周末就不显示当天课表
  var dIdx = (new Date().getDay() + 6) % 7 // 周一=0 ... 周日=6
  if (cfg.scheduleShowWeekend === false && dIdx >= 5) return
  var L = scheduleDayLayout(secs.length)
  for (var i = 0; i < secs.length; i++) {
    var bb = scheduleItemBounds(i, L)
    var w2 = new BrowserWindow({
      width: bb.width, height: bb.height, x: bb.x, y: bb.y,
      transparent: true, frame: false, alwaysOnTop: false, skipTaskbar: true,
      resizable: false, focusable: false, hasShadow: false,
      webPreferences: Object.assign({}, COMMON_PRELOAD, { backgroundThrottling: false })
    })
    w2.__role = 'schedule-item'
    w2.__idx = i
    // 字号由主进程算好后传给页面，不再使用 zoomFactor（zoom 曾导致各窗口字号忽大忽小、文字被省略号截断）
    w2.loadFile('src/schedule-item.html', { search: '?i=' + i + '&fs=' + L.fs + '&h=' + L.rowH })
    w2.setIgnoreMouseEvents(true, { forward: true })
    w2.setVisibleOnAllWorkspaces(true)
    w2.webContents.on('did-finish-load', () => {
      w2.setIgnoreMouseEvents(true, { forward: true })
    })
    w2.on('closed', () => { removeScheduleWindow(w2) })
    armWidgetRecovery(w2)
    injectToDesktopLayer(w2)
    if (!scheduleVisible) w2.hide()
    scheduleWindows.push(w2)
  }
}

function removeScheduleWindow(w) {
  var idx = scheduleWindows.indexOf(w)
  if (idx >= 0) scheduleWindows.splice(idx, 1)
}

function toggleSchedule() {
  scheduleVisible = !scheduleVisible
  if (scheduleWindows.length === 0) {
    createScheduleWindows()
  } else if (scheduleVisible) {
    scheduleWindows.forEach(function (w) { if (!w.isDestroyed()) w.showInactive() })
  } else {
    scheduleWindows.forEach(function (w) { if (!w.isDestroyed()) w.hide() })
  }
  saveFloatState()
  updateTrayMenu()
}

// ==================== 桌面倒计时 ====================
function getCountdownList() {
  var cfg = loadConfig()
  var list = Array.isArray(cfg.countdowns) ? cfg.countdowns : defaultCountdowns()
  return list.filter(function (it) { return it && it.enabled !== false })
}

// 每个倒计时一个独立窗口：位于时钟左侧、与时钟同尺寸，多个时依次向左排（k=0 紧邻时钟，k 越大越靠左）
function countdownItemBounds(k) {
  var cb = clockBounds()
  var s = widgetScale()
  var gap = Math.round(20 * s)
  var w = cb.width
  var h = cb.height
  var x = cb.x - (k + 1) * (w + gap)
  return { x: x, y: cb.y, width: w, height: h }
}

function relayoutCountdown() {
  countdownWindows.forEach(function (w, k) {
    if (!w || w.isDestroyed()) return
    w.setBounds(countdownItemBounds(k))
    try { w.webContents.setZoomFactor(widgetScale()) } catch (e) {}
  })
}

// 显示器变化后重排课程表窗口（整周单窗 / 当天每节小窗）
function relayoutSchedule() {
  var cfg = loadConfig()
  var mode = cfg.scheduleMode === 'day' ? 'day' : 'week'
  if (mode === 'week') {
    scheduleWindows.forEach(function (w) {
      if (w && !w.isDestroyed() && w.__role === 'schedule') w.setBounds(scheduleWeekBounds())
    })
    return
  }
  // 当天模式：行高、字号、宽度都随屏幕变，重建最稳
  createScheduleWindows()
}

function destroyCountdownWindows() {
  countdownWindows.forEach(function (w) { try { if (!w.isDestroyed()) w.destroy() } catch (e) {} })
  countdownWindows = []
}

function removeCountdownWindow(w) {
  var idx = countdownWindows.indexOf(w)
  if (idx >= 0) countdownWindows.splice(idx, 1)
}

// 每个倒计时单独一个窗口，加载 src/countdown.html?i=k，页面只渲染第 k 条
function createCountdownWindows() {
  destroyCountdownWindows()
  var list = getCountdownList()
  for (var k = 0; k < list.length; k++) {
    var b = countdownItemBounds(k)
    var w = new BrowserWindow({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      transparent: true,
      frame: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: Object.assign({}, COMMON_PRELOAD, { backgroundThrottling: false })
    })
    w.__role = 'countdown'
    w.__idx = k
    w.loadFile('src/countdown.html', { search: '?i=' + k })
    w.setIgnoreMouseEvents(true, { forward: true })
    w.setVisibleOnAllWorkspaces(true)
    w.webContents.on('did-finish-load', () => {
      w.setIgnoreMouseEvents(true, { forward: true })
      // 与时钟一致：页面就绪后按屏幕比例整体缩放，保证不同分辨率下与时钟同尺寸
      try { w.webContents.setZoomFactor(widgetScale()) } catch (e) {}
    })
    w.on('closed', () => { removeCountdownWindow(w) })
    armWidgetRecovery(w)
    injectToDesktopLayer(w)
    if (!countdownVisible) w.hide()
    countdownWindows.push(w)
  }
}

// 倒计时增删改后：重建全部窗口（数量/顺序可能变化），并尊重显隐状态
function refreshCountdown() {
  createCountdownWindows()
}

function toggleCountdown() {
  countdownVisible = !countdownVisible
  if (countdownWindows.length === 0) {
    createCountdownWindows()
  } else if (countdownVisible) {
    countdownWindows.forEach(function (w) { try { w.showInactive() } catch (e) {} })
  } else {
    countdownWindows.forEach(function (w) { try { w.hide() } catch (e) {} })
  }
  saveFloatState()
  updateTrayMenu()
}


// ==================== 弹窗 ====================
function createPopupWindow(msg) {
  var { width, height } = screen.getPrimaryDisplay().workAreaSize
  popupWindow = new BrowserWindow({
    width: 480,
    height: 320,
    x: Math.floor((width - 480) / 2),
    y: Math.floor((height - 320) / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: COMMON_PRELOAD
  })
  popupWindow.loadFile('src/popup.html')
  popupWindow.setAlwaysOnTop(true, 'screen-saver')
  popupWindow.once('ready-to-show', () => {
    popupWindow.show()
    popupWindow.focus()
    if (msg) {
      setTimeout(() => {
        popupWindow.webContents.send('new-message', msg)
      }, 200)
    }
  })
  popupWindow.on('closed', () => { popupWindow = null })
}

function createHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus()
    return
  }
  var { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  var winW = 560
  var winH = Math.min(600, sh - 40)
  historyWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.floor((sw - winW) / 2),
    y: Math.floor((sh - winH) / 2),
    title: '历史消息',
    backgroundColor: '#f1f5f9',
    frame: false,
    resizable: true,
    webPreferences: COMMON_PRELOAD
  })
  historyWindow.loadFile('src/history.html')
  historyWindow.on('closed', () => { historyWindow = null })
}

function createSettingsWindow(initialTab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  var { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  var winW = 660
  var winH = Math.min(580, sh - 40)
  settingsWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.floor((sw - winW) / 2),
    y: Math.floor((sh - winH) / 2),
    title: '设置',
    backgroundColor: '#f1f5f9',
    frame: false,
    resizable: false,
    webPreferences: COMMON_PRELOAD
  })
  var search = (initialTab && typeof initialTab === 'string') ? ('?tab=' + encodeURIComponent(initialTab)) : ''
  settingsWindow.loadFile('src/settings.html', { search: search })
  settingsWindow.on('closed', () => { settingsWindow = null })
}

// ==================== 更新提示窗口 ====================
function showUpdateWindow(newVersion, changelog) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus()
    return
  }
  var { width, height } = screen.getPrimaryDisplay().workAreaSize
  updateWindow = new BrowserWindow({
    width: 380,
    height: 320,
    x: Math.floor((width - 380) / 2),
    y: Math.floor((height - 320) / 2),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: COMMON_PRELOAD
  })
  updateWindow.loadFile('src/update.html')
  updateWindow.setAlwaysOnTop(true, 'screen-saver')
  updateWindow.once('ready-to-show', () => {
    updateWindow.webContents.send('update-info', {
      currentVersion: CURRENT_VERSION,
      newVersion: newVersion,
      changelog: changelog || '修复已知问题，优化性能'
    })
  })
  updateWindow.on('closed', () => { updateWindow = null })
}

// ==================== 随机点名窗口 ====================
function createRandomPickWindow() {
  if (randomPickWindow && !randomPickWindow.isDestroyed()) {
    randomPickWindow.focus()
    return
  }
  var { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  var k = widgetScale() * 1.12
  var winW = Math.round(420 * k)
  var winH = Math.round(580 * k)

  randomPickWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.floor((sw - winW) / 2),
    y: Math.floor((sh - winH) / 2),
    title: '随机点名',
    backgroundColor: '#f0f2f5',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: COMMON_PRELOAD
  })
  randomPickWindow.loadFile('src/randompick.html')
  randomPickWindow.setAlwaysOnTop(true, 'pop-up-menu')
  randomPickWindow.webContents.on('did-finish-load', () => {
    try { randomPickWindow.webContents.setZoomFactor(widgetScale() * 1.12) } catch (e) {}
  })
  randomPickWindow.on('closed', () => { randomPickWindow = null })
}

// ==================== 计时器窗口 ====================
function createTimerWindow() {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.focus()
    return
  }
  var { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  var k = widgetScale() * 1.12
  var winW = Math.round(580 * k)
  var winH = Math.round(620 * k)
  timerWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.floor((sw - winW) / 2),
    y: Math.floor((sh - winH) / 2),
    title: '计时器',
    backgroundColor: '#0f172a',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: COMMON_PRELOAD
  })
  timerWindow.loadFile('src/timer.html')
  timerWindow.setAlwaysOnTop(true, 'pop-up-menu')
  timerWindow.webContents.on('did-finish-load', () => {
    try { timerWindow.webContents.setZoomFactor(widgetScale() * 1.12) } catch (e) {}
  })
  timerWindow.on('closed', () => { timerWindow = null })
}

// ==================== 绘图窗口（全屏覆盖） ====================
function createDrawWindow() {
  if (drawWindow && !drawWindow.isDestroyed()) {
    drawWindow.focus()
    return
  }
  var { width, height } = screen.getPrimaryDisplay().workAreaSize
  drawWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: COMMON_PRELOAD
  })
  drawWindow.setAlwaysOnTop(true, 'pop-up-menu')
  drawWindow.loadFile('src/draw.html')
  drawWindow.once('ready-to-show', () => {
    drawWindow.show()
    drawWindow.focus()
  })
  drawWindow.on('closed', () => { drawWindow = null })
}

// ==================== 考试计时窗口 ====================
function createExamTimerWindow() {
  if (examTimerWindow && !examTimerWindow.isDestroyed()) {
    examTimerWindow.focus()
    return
  }
  var primary = screen.getPrimaryDisplay()
  var b = primary.bounds
  examTimerWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    title: '考试计时',
    backgroundColor: '#0f172a',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    focusable: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: Object.assign({}, COMMON_PRELOAD, { backgroundThrottling: false })
  })
  examTimerWindow.loadFile('src/examtimer.html')
  examTimerWindow.setAlwaysOnTop(true, 'screen-saver')
  examTimerWindow.once('ready-to-show', () => {
    examTimerWindow.showInactive()
    examTimerWindow.setAlwaysOnTop(true, 'screen-saver')
    setTimeout(() => {
      if (examTimerWindow && !examTimerWindow.isDestroyed()) {
        examTimerWindow.focus()
        examTimerWindow.setAlwaysOnTop(true, 'screen-saver')
      }
    }, 100)
    setTimeout(() => {
      if (examTimerWindow && !examTimerWindow.isDestroyed()) {
        examTimerWindow.focus()
      }
    }, 500)
  })
  examTimerWindow.on('closed', () => { examTimerWindow = null })
}

// ==================== 悬浮工具栏（核心修复版） ====================
function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.focus()
    return
  }
  var { width, height } = screen.getPrimaryDisplay().workAreaSize
  floatWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    webPreferences: COMMON_PRELOAD
  })
  floatWindow.loadFile('src/float.html')
  floatWindow.setIgnoreMouseEvents(false)

  // ✅ 1. 窗口渲染完成后，使用最高优先级 pop-up-menu 层级
  floatWindow.once('ready-to-show', () => {
    floatWindow.setAlwaysOnTop(true, 'pop-up-menu')
    floatWindow.setVisibleOnAllWorkspaces(true)
    startFloatZOrderTimer() // ✅ 2. 启动定时轮询强制置顶
  })

  // ✅ 3. 失焦瞬间强制拉回顶层，对抗 UWP 抢占
  floatWindow.on('blur', () => {
    setTimeout(() => {
      if (floatWindow && !floatWindow.isDestroyed() && floatVisible) {
        if (examTimerWindow && !examTimerWindow.isDestroyed()) return
        floatWindow.setAlwaysOnTop(true, 'pop-up-menu')
      }
    }, 50)
  })

  floatWindow.on('closed', () => {
    floatWindow = null
    stopFloatZOrderTimer()
  })
}

// ✅ 启动置顶定时器（每 3 秒强制声明一次最高层级，CPU 占用极低且无闪烁）
function startFloatZOrderTimer() {
  stopFloatZOrderTimer()
  floatZOrderTimer = setInterval(() => {
    if (!floatWindow || floatWindow.isDestroyed() || !floatVisible) {
      stopFloatZOrderTimer()
      return
    }
    if (examTimerWindow && !examTimerWindow.isDestroyed()) return
    floatWindow.setAlwaysOnTop(true, 'pop-up-menu')
  }, 3000)
}

function stopFloatZOrderTimer() {
  if (floatZOrderTimer) {
    clearInterval(floatZOrderTimer)
    floatZOrderTimer = null
  }
}

function toggleFloat() {
  if (!floatWindow || floatWindow.isDestroyed()) return
  if (floatVisible) {
    floatWindow.hide()
    floatVisible = false
    stopFloatZOrderTimer() // 隐藏时停止轮询
  } else {
    floatWindow.show()
    floatWindow.setAlwaysOnTop(true, 'pop-up-menu')
    floatVisible = true
    startFloatZOrderTimer() // 显示时立即置顶并启动轮询
  }
  saveFloatState()
  updateTrayMenu()
}

// ==================== 系统托盘 ====================
function createTray() {
  var iconPath = path.join(__dirname, 'assets', 'icon.png')
  var icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
  } else {
    icon = nativeImage.createFromBuffer(Buffer.alloc(0))
  }
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('消息终端 v' + CURRENT_VERSION)
  updateTrayMenu()
  tray.on('click', () => tray.popUpContextMenu())
}

function updateTrayMenu(connected) {
  if (connected !== undefined) {
    if (connected === lastConnState) return
    lastConnState = connected
  }
  var connState = connected !== undefined ? connected : (mqttClient && mqttClient.isConnected)
  var menu = Menu.buildFromTemplate([
    { label: connState ? '● 已连接' : '○ 未连接', enabled: false },
    { label: clockVisible ? '时钟 ✓' : '时钟', click: () => toggleClock() },
    { label: countdownVisible ? '倒计时 ✓' : '倒计时', click: () => toggleCountdown() },
    { label: scheduleVisible ? '课程表 ✓' : '课程表', click: () => toggleSchedule() },
    { type: 'separator' },
    { label: '查看历史消息', click: () => createHistoryWindow() },
    { label: '随机点名', click: () => createRandomPickWindow() },
    { label: '计时器', click: () => createTimerWindow() },
    { label: '考试计时', click: () => createExamTimerWindow() },
    { label: '绘图工具', click: () => createDrawWindow() },
    { type: 'separator' },
    { label: floatVisible ? '悬浮图标 ✓' : '悬浮图标', click: () => toggleFloat() },
    { type: 'separator' },
    { label: '设置', click: () => {
      showPasswordDialog(() => {
        createSettingsWindow()
      })
    }},
    { label: '退出', click: () => {
      showPasswordDialog(() => {
        app.quit()
      })
    }}
  ])
  if (tray) {
    tray.setContextMenu(menu)
    tray.setToolTip('消息终端 v' + CURRENT_VERSION + ' - ' + (connState ? '已连接' : '未连接'))
  }
}

// ==================== 手动检查更新（托盘菜单触发） ====================
function checkForUpdate() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: '检查更新', message: '开发模式无法检查更新', buttons: ['确定'] })
    return
  }
  _manualCheck = true
  initAutoUpdater() // 幂等：已接线则只检查，未接线则接线并查
}

// ==================== MQTT ====================
function startMqtt() {
  var config = loadConfig()
  if (!config.productId || !config.deviceName || !config.deviceKey) {
    return
  }
  mqttClient = new MqttClient()
  mqttClient.onConnection = (connected) => {
    updateTrayMenu(connected)
    if (clockWindow && !clockWindow.isDestroyed()) {
      clockWindow.webContents.send('connection-status', connected)
    }
  }
  mqttClient.onMessage = (msg) => {
    try {
      // 远程指令：手机端发 {"cmd":"update"} 立即检查并安装更新
      if (msg && msg.cmd === 'update') {
        initAutoUpdater()
        return
      }
      var cfg = loadConfig()
      msg.voiceEnabled = cfg.voiceEnabled !== false
      msg.isMuted = isMuted(cfg)
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.webContents.send('new-message', msg)
        popupWindow.show()
        popupWindow.focus()
      } else {
        createPopupWindow(msg)
      }
      // 文件IO放到setTimeout中，避免阻塞主线程
      setTimeout(function() {
        try {
          var msgs = loadMessages()
          msgs.unshift(msg)
          saveMessages(msgs)
        } catch (e) {}
      }, 100)
    } catch (e) {
      console.error('处理消息异常:', e.message)
    }
  }
  mqttClient.connect(config)
}

// ==================== IPC ====================
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (e, config) => {
  var prev = loadConfig()
  var prevWeekend = prev.scheduleShowWeekend !== false
  var newWeekend = config.scheduleShowWeekend !== false
  saveConfig(config)
  if (mqttClient) mqttClient.disconnect()
  startMqtt()
  if (prevWeekend !== newWeekend) {
    // 周末显示设置变化：整周列数变化 / 当天模式整组窗口可能出现或消失，直接重建
    destroyScheduleWindows()
    createScheduleWindows()
  } else {
    // 课程表内容变化：推给周表窗口立即重渲染，不等 30 秒轮询
    scheduleWindows.forEach(function (w) { try { if (!w.isDestroyed() && w.__role === 'schedule') w.webContents.send('schedule-refresh') } catch (err) {} })
  }
  return true
})
ipcMain.handle('save-countdown', (e, list) => {
  var cfg = loadConfig()
  var next = Array.isArray(list) ? list : []
  var prev = Array.isArray(cfg.countdowns) ? cfg.countdowns : []
  var prevEnabled = prev.filter(function (it) { return it && it.enabled !== false })
  var nextEnabled = next.filter(function (it) { return it && it.enabled !== false })
  var changed = JSON.stringify(prevEnabled) !== JSON.stringify(nextEnabled)
  cfg.countdowns = next
  saveConfig(cfg)
  if (!changed) return true // 内容没变：什么都不做，避免每次保存设置都闪烁
  if (prevEnabled.length === nextEnabled.length) {
    // 数量不变：窗口原地刷新内容（不销毁重建，避免闪烁）
    countdownWindows.forEach(function (w) { try { if (!w.isDestroyed()) w.webContents.send('countdown-refresh') } catch (err) {} })
  } else {
    refreshCountdown()
  }
  return true
})
ipcMain.handle('check-for-update', () => { checkForUpdate(); return true })
ipcMain.handle('save-pick-settings', (e, settings) => {
  var config = loadConfig()
  config.pickMin = settings.pickMin
  config.pickMax = settings.pickMax
  config.pickCount = settings.pickCount
  config.pickUnique = settings.pickUnique
  config.pickSound = settings.pickSound
  saveConfig(config)
  return true
})
ipcMain.handle('get-messages', () => loadMessages())
ipcMain.handle('save-messages', (e, messages) => { saveMessages(messages); return true })
ipcMain.handle('delete-message', (e, msgId) => {
  var msgs = loadMessages()
  msgs = msgs.filter(m => m.id !== msgId)
  saveMessages(msgs)
  return msgs
})
ipcMain.handle('clear-messages', () => { saveMessages([]); return true })
ipcMain.handle('get-app-version', () => CURRENT_VERSION)
ipcMain.handle('install-update', () => {
  if (_updateDownloaded) {
    autoUpdater.quitAndInstall()
  } else {
    notifyTray('消息终端', '新版本仍在下载中，完成后会自动提示')
  }
  return true
})
ipcMain.on('close-update', () => {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close()
})

ipcMain.handle('verify-password', (e, inputPwd) => {
  var pwd = loadPassword()
  if (inputPwd === pwd.password) {
    if (pendingAction) {
      pendingAction()
      pendingAction = null
    }
    return true
  }
  return false
})

ipcMain.handle('get-password-hint', () => {
  var pwd = loadPassword()
  return pwd.hint || '未设置提示'
})

ipcMain.handle('force-reset-password', (e, code) => {
  if (code === '67005608') {
    savePasswordData({ password: '1234', hint: '默认密码' })
    if (pendingAction) {
      pendingAction()
      pendingAction = null
    }
    return { ok: true, msg: '密码已重置为 1234' }
  }
  return { ok: false, msg: '验证码错误' }
})

ipcMain.handle('change-password', (e, oldPwd, newPwd, hint) => {
  var pwd = loadPassword()
  if (oldPwd !== pwd.password) return { ok: false, msg: '旧密码错误' }
  if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新密码至少4位' }
  savePasswordData({ password: newPwd, hint: hint || '' })
  return { ok: true, msg: '密码修改成功' }
})

ipcMain.handle('get-auto-launch', () => {
  var settings = app.getLoginItemSettings()
  return settings.openAtLogin
})

ipcMain.handle('set-auto-launch', (e, enabled) => {
  setAutoLaunch(enabled)
  var c = loadConfig()
  c.autoLaunch = enabled
  saveConfig(c)
  return true
})

ipcMain.handle('load-name-list', () => loadNameList())
ipcMain.handle('save-name-list', (e, names) => {
  saveNameList(names)
  return true
})
ipcMain.handle('clear-name-list', () => {
  clearNameList()
  return true
})

ipcMain.on('import-excel', async (e) => {
  var result = await dialog.showOpenDialog(randomPickWindow, {
    title: '选择Excel文件',
    filters: [{ name: 'Excel文件', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile']
  })
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      var workbook = XLSX.readFile(result.filePaths[0])
      var sheetName = workbook.SheetNames[0]
      var sheet = workbook.Sheets[sheetName]
      var data = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      var names = []
      for (var i = 0; i < data.length; i++) {
        for (var j = 0; j < data[i].length; j++) {
          var val = String(data[i][j]).trim()
          if (val && val !== '姓名' && val !== '名字' && val !== 'name' && val !== 'Name') {
            names.push(val)
          }
        }
      }
      if (names.length > 0) saveNameList(names)
      if (randomPickWindow && !randomPickWindow.isDestroyed()) {
        randomPickWindow.webContents.send('import-result', names)
      }
    } catch (err) {
      console.error('Excel导入失败:', err)
      if (randomPickWindow && !randomPickWindow.isDestroyed()) {
        randomPickWindow.webContents.send('import-result', [])
      }
    }
  }
})

// ==================== 课程表 IPC ====================
ipcMain.on('open-schedule', () => toggleSchedule())
ipcMain.handle('load-schedule', () => loadSchedule())
ipcMain.handle('save-schedule', (e, data) => {
  saveSchedule(data)
  try { if (loadConfig().scheduleMode === 'day') createScheduleWindows() } catch (err) {}
  return true
})

ipcMain.on('import-schedule-excel', async (e) => {
  var win = (settingsWindow && !settingsWindow.isDestroyed()) ? settingsWindow
    : ((scheduleWindows && scheduleWindows.length && !scheduleWindows[0].isDestroyed()) ? scheduleWindows[0] : null)
  var result = await dialog.showOpenDialog(win || BrowserWindow.getFocusedWindow() || null, {
    title: '选择课程表 Excel',
    filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile']
  })
  if (!result || result.canceled || !result.filePaths || !result.filePaths.length) {
    if (win) win.webContents.send('schedule-import-result', { ok: false, canceled: true })
    return
  }
  try {
    var wb = XLSX.readFile(result.filePaths[0])
    var sheet = wb.Sheets[wb.SheetNames[0]]
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
    var sections = []
    var grid = []
    var reTime = /(\d{1,2}[:：]\d{1,2})\s*[-~～至到—–]\s*(\d{1,2}[:：]\d{1,2})/
    var headRe = /^(节次|时间|时段|课程)/
    var noTimeRows = []
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (!row || row.length === 0) continue
      var c0 = String(row[0] == null ? '' : row[0]).trim()
      if (!c0) continue
      var tail = row.slice(1).map(function (x) { return String(x == null ? '' : x).trim() }).join('')
      if (headRe.test(c0) && /周|星期|一|二|三|四|五|六|日/.test(tail)) continue
      var m = c0.match(reTime)
      var start = '', end = '', name = c0
      if (m) {
        start = normTime(m[1])
        end = normTime(m[2])
        if (start && end) {
          // 去掉时间后清理名称尾部残留（冒号/括号/标点），保证「早读：07:30-07:55」也能归一为「早读」
          name = c0.replace(reTime, '').replace(/\(\s*\)\s*$/, '').replace(/[\s:：、,，.。;；]+$/, '').trim() || c0
        } else {
          start = ''; end = ''
        }
      }
      if (!start || !end) noTimeRows.push(name || ('第' + (i + 1) + '行'))
      var courses = []
      for (var j = 1; j <= 7; j++) {
        var v = row[j] == null ? '' : String(row[j]).trim()
        courses.push(v)
      }
      sections.push({ name: name, start: start, end: end })
      grid.push(courses)
    }
    if (sections.length === 0) {
      if (win) win.webContents.send('schedule-import-result', { ok: false, msg: '未识别到有效课程数据，请检查模板格式（首列应为节次/时间）' })
      return
    }
    var data = normalizeSchedule({ sections: sections, grid: grid })
    saveSchedule(data)
    var warn = noTimeRows.length ? ('以下节次未识别到时间（格式如 早读 07:30-07:55）：' + noTimeRows.join('、')) : ''
    if (win) win.webContents.send('schedule-import-result', { ok: true, count: data.sections.length, warn: warn, data: data })
    // 重建窗口：节次数变了、每节课名宽度也变了
    var cfgNow = loadConfig()
    if (cfgNow.scheduleMode === 'day') {
      createScheduleWindows()
    } else {
      scheduleWindows.forEach(function (w) { if (!w.isDestroyed()) w.webContents.send('schedule-refresh') })
    }
  } catch (err) {
    console.error('课程表导入失败:', err)
    if (win) win.webContents.send('schedule-import-result', { ok: false, msg: '解析失败：' + err.message })
  }
})

ipcMain.on('download-schedule-template', async (e) => {
  var win = (settingsWindow && !settingsWindow.isDestroyed()) ? settingsWindow : null
  var defaults = ['早读 07:30-07:55', '第1节 08:00-08:45', '第2节 08:55-09:40', '第3节 10:00-10:45', '第4节 10:55-11:40', '午读 12:40-13:10', '第5节 14:00-14:45', '第6节 14:55-15:40', '第7节 15:50-16:35', '第8节 16:45-17:30', '晚自习 19:00-21:00']
  var aoa = [['节次', '周一', '周二', '周三', '周四', '周五', '周六', '周日']]
  defaults.forEach(function (s) { aoa.push([s, '', '', '', '', '', '', '']) })
  var ws = XLSX.utils.aoa_to_sheet(aoa)
  var wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '课程表')
  var out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  var res = await dialog.showSaveDialog(win || null, { title: '保存课程表模板', defaultPath: '课程表模板.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
  if (res && !res.canceled && res.filePath) {
    fs.writeFileSync(res.filePath, out)
    if (win) win.webContents.send('schedule-template-saved', { ok: true, path: res.filePath })
  }
})

ipcMain.on('export-schedule-check', async (e, data) => {
  var win = (settingsWindow && !settingsWindow.isDestroyed()) ? settingsWindow : null
  var aoa = [['节次', '周一', '周二', '周三', '周四', '周五', '周六', '周日']]
  var secs = (data && data.sections) || []
  var g = (data && data.grid) || []
  for (var i = 0; i < secs.length; i++) {
    var r = [secs[i].name + (secs[i].start ? (' ' + secs[i].start + '-' + secs[i].end) : '')]
    var c = g[i] || []
    for (var j = 0; j < 7; j++) r.push(c[j] || '')
    aoa.push(r)
  }
  var ws = XLSX.utils.aoa_to_sheet(aoa)
  var wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '课程表')
  var out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  var res = await dialog.showSaveDialog(win || null, { title: '导出课程表核对', defaultPath: '课程表核对.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
  if (res && !res.canceled && res.filePath) {
    fs.writeFileSync(res.filePath, out)
    if (win) win.webContents.send('schedule-export-saved', { ok: true, path: res.filePath })
  }
})

ipcMain.on('apply-schedule-mode', (e, mode) => {
  var cfg = loadConfig()
  cfg.scheduleMode = (mode === 'day') ? 'day' : 'week'
  saveConfig(cfg)
  // 无论当前显隐都重建，保证窗口数组与新模式一致（隐藏状态下重建为隐藏窗口）
  destroyScheduleWindows()
  createScheduleWindows()
})

// 窗口操作
ipcMain.on('close-password', () => {
  pendingAction = null
  if (passwordWindow && !passwordWindow.isDestroyed()) {
    passwordWindow.close()
    passwordWindow = null
  }
})
ipcMain.on('cancel-password', () => {
  pendingAction = null
  if (passwordWindow && !passwordWindow.isDestroyed()) {
    passwordWindow.close()
    passwordWindow = null
  }
})
ipcMain.on('show-popup', (e, msg) => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('new-message', msg)
    popupWindow.show()
    popupWindow.focus()
  } else {
    createPopupWindow(msg)
  }
})
ipcMain.on('close-popup', () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close()
    popupWindow = null
  }
})
ipcMain.on('close-update', () => {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.close()
    updateWindow = null
  }
})
ipcMain.on('open-update-url', (e, url) => {
  if (url) shell.openExternal(url)
})
ipcMain.on('update-tray', (e, connected) => updateTrayMenu(connected))
ipcMain.on('minimize-history', () => {
  if (historyWindow && !historyWindow.isDestroyed()) historyWindow.minimize()
})
ipcMain.on('close-history', () => {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.close()
    historyWindow = null
  }
})
ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close()
    settingsWindow = null
  }
})
ipcMain.on('close-random-pick', () => {
  if (randomPickWindow && !randomPickWindow.isDestroyed()) {
    randomPickWindow.close()
    randomPickWindow = null
  }
})
ipcMain.on('minimize-random-pick', () => {
  if (randomPickWindow && !randomPickWindow.isDestroyed()) {
    randomPickWindow.minimize()
  }
})
ipcMain.on('open-timer', () => createTimerWindow())
ipcMain.on('open-draw', () => createDrawWindow())
ipcMain.on('open-random-pick', () => createRandomPickWindow())
ipcMain.on('close-timer', () => {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.close()
    timerWindow = null
  }
})
ipcMain.on('minimize-timer', () => {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.minimize()
  }
})
ipcMain.on('close-draw', () => {
  if (drawWindow && !drawWindow.isDestroyed()) {
    drawWindow.close()
    drawWindow = null
  }
})
ipcMain.on('set-draw-click-through', (e, enabled) => {
  if (drawWindow && !drawWindow.isDestroyed()) {
    if (enabled) {
      drawWindow.setIgnoreMouseEvents(true, { forward: true })
    } else {
      drawWindow.setIgnoreMouseEvents(false)
    }
  }
})

ipcMain.on('close-float', () => {
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.close()
    floatWindow = null
  }
})

ipcMain.on('open-exam-timer', () => createExamTimerWindow())
ipcMain.on('close-exam-timer', () => {
  if (examTimerWindow && !examTimerWindow.isDestroyed()) {
    examTimerWindow.close()
    examTimerWindow = null
  }
})
ipcMain.on('minimize-exam-timer', () => {
  if (examTimerWindow && !examTimerWindow.isDestroyed()) {
    examTimerWindow.minimize()
  }
})

ipcMain.on('start-prevent-sleep', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) return
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
})
ipcMain.on('stop-prevent-sleep', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    powerSaveBlockerId = null
  }
})

ipcMain.on('set-float-click-through', (e, enabled) => {
  if (floatWindow && !floatWindow.isDestroyed()) {
    if (enabled) {
      floatWindow.setIgnoreMouseEvents(true, { forward: true })
    } else {
      floatWindow.setIgnoreMouseEvents(false)
    }
    // ✅ 切换穿透属性后强制重新置顶
    setTimeout(() => {
      if (floatWindow && !floatWindow.isDestroyed() && floatVisible) {
        if (examTimerWindow && !examTimerWindow.isDestroyed()) return
        floatWindow.setAlwaysOnTop(true, 'pop-up-menu')
      }
    }, 50)
  }
})

// ==================== 启动 ====================
app.whenReady().then(() => {
  if (!app.isPackaged) { try { fs.appendFileSync(path.join(__dirname, 'app-start.log'), '[' + new Date().toISOString() + '] APP_START desktopLayerEnabled=' + desktopLayerEnabled + '\n') } catch (e) {} }
  var cfg = loadConfig()
  createTray()
  createClockWindow()
  createCountdownWindows()
  createFloatWindow()
  loadFloatState()
  createScheduleWindows()
  startMqtt()
  desktopLayerEnabled = cfg.desktopLayer !== false
  startDesktopLayerWatchdog()

  // 默认开机自启动（仅打包版；config.autoLaunch 为 false 时尊重用户关闭）
  if (app.isPackaged) {
    try { setAutoLaunch(cfg.autoLaunch !== false) } catch (e) {}
  }

  // 启动后自动检查更新（GitHub Releases，公开仓库免 token）
  initAutoUpdater()

  // screen 模块必须在 app ready 之后才能访问，放在这里注册
  screen.on('display-metrics-changed', relayoutAllWidgets)
  screen.on('display-added', relayoutAllWidgets)
  screen.on('display-removed', relayoutAllWidgets)

  // GPU 进程崩溃后透明窗口可能不再渲染，重载一次就能回来
  app.on('child-process-gone', (e, details) => {
    if (details.type === 'GPU') recoverAllWidgets()
  })
  // 休眠唤醒、锁屏解锁后挂件常常不刷新
  // 长时间待机/锁屏恢复后，mqtt.js 内置重连可能彻底卡死（须重启程序才恢复）。
  // 系统恢复时主动强制重建 MQTT 连接（仅在离线时），作为兜底。
  function onSystemResume() {
    recoverAllWidgets()
    if (mqttClient && !mqttClient.isConnected) mqttClient.reconnect()
  }
  powerMonitor.on('resume', onSystemResume)
  powerMonitor.on('unlock-screen', onSystemResume)
})

// 显示器变化（接投影仪、拔副屏、改分辨率）后重新摆放桌面挂件，
// 否则窗口会滞留在屏幕外，表现就是"时钟不显示了"
function relayoutAllWidgets() {
  try {
    relayoutClock()
    relayoutCountdown()
    relayoutSchedule()
  } catch (e) {}
}

app.on('window-all-closed', (e) => { e.preventDefault() })
