const mqtt = require('mqtt')
const crypto = require('crypto')

class MqttClient {
  constructor() {
    this.client = null
    this.isConnected = false
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.reconnectDelay = 3000
    this.maxReconnectDelay = 30000
    this.onMessage = null
    this.onConnection = null
    this._bindMethods()
  }

  _bindMethods() {
    this.startHeartbeat = this.startHeartbeat.bind(this)
    this.stopHeartbeat = this.stopHeartbeat.bind(this)
    this.handleMessage = this.handleMessage.bind(this)
    this.sendAck = this.sendAck.bind(this)
  }

  generateToken(productId, deviceName, deviceKey) {
    const et = Math.floor(Date.now() / 1000) + 86400
    const res = 'products/' + productId + '/devices/' + deviceName
    const version = '2018-10-31'
    const signStr = et + '\nmd5\n' + res + '\n' + version
    const key = Buffer.from(deviceKey, 'base64')
    const hmac = crypto.createHmac('md5', key)
    hmac.update(signStr, 'utf8')
    const sign = hmac.digest('base64')
    return 'version=' + version + '&res=' + encodeURIComponent(res) + '&et=' + et + '&method=md5&sign=' + encodeURIComponent(sign)
  }

  connect(config) {
    const self = this
    self.config = config

    if (self.client) {
      try { self.client.end(true) } catch (e) {}
      self.client = null
    }
    self.isConnected = false

    if (!config || !config.productId || !config.deviceName || !config.deviceKey) {
      console.log('配置不完整，跳过连接')
      return
    }

    const token = self.generateToken(config.productId, config.deviceName, config.deviceKey)
    const topic = '$sys/' + config.productId + '/' + config.deviceName + '/thing/property/set'

    console.log('正在连接 OneNET...')

    self.client = mqtt.connect('mqtt://mqtts.heclouds.com:1883', {
      clientId: config.deviceName,
      username: config.productId,
      password: token,
      clean: true,
      connectTimeout: 10000,
      keepalive: 60,
      reconnectPeriod: 5000,
      reschedulePings: true
    })

    self.client.on('connect', function() {
      console.log('MQTT连接成功')
      self.isConnected = true
      self.reconnectDelay = 3000
      try {
        self.client.subscribe(topic, { qos: 0 })
        console.log('已订阅: ' + topic)
      } catch (err) {
        console.error('订阅失败:', err.message)
      }
      self.startHeartbeat(config)
      if (self.onConnection) self.onConnection(true)
    })

    self.client.on('message', function(t, message) {
      self.handleMessage(message.toString(), config)
    })

    self.client.on('close', function() {
      console.log('MQTT连接关闭')
      if (self.isConnected) {
        self.isConnected = false
        self.stopHeartbeat()
        if (self.onConnection) self.onConnection(false)
      }
    })

    self.client.on('error', function(err) {
      console.error('MQTT错误:', err.message)
    })

    self.client.on('offline', function() {
      console.log('MQTT离线')
      if (self.isConnected) {
        self.isConnected = false
        self.stopHeartbeat()
        if (self.onConnection) self.onConnection(false)
      }
    })

    self.client.on('reconnect', function() {
      console.log('MQTT重连中...')
    })

    self.client.on('end', function() {
      console.log('MQTT连接结束')
      if (self.isConnected) {
        self.isConnected = false
        self.stopHeartbeat()
        if (self.onConnection) self.onConnection(false)
      }
    })
  }

  handleMessage(payload, config) {
    const self = this
    try {
      const data = JSON.parse(payload)
      const params = data.params
      if (!params) return

      let text = '', msgId = ''
      if (params.msg_text) {
        text = typeof params.msg_text === 'object' ? params.msg_text.value : params.msg_text
      }
      if (params.msg_id) {
        msgId = typeof params.msg_id === 'object' ? params.msg_id.value : params.msg_id
      }
      if (!msgId) msgId = data.id || ''

      // 用setTimeout避免在回调中直接publish导致死锁
      var replyTopic = '$sys/' + config.productId + '/' + config.deviceName + '/thing/property/set'
      var replyPayload = JSON.stringify({ id: data.id, code: 200, msg: 'success' })
      setTimeout(function() {
        try {
          if (self.client && self.isConnected) {
            self.client.publish(replyTopic, replyPayload)
          }
        } catch (e) {}
      }, 0)

      if (msgId.startsWith('ping_')) {
        console.log('收到Ping: ' + msgId)
        self.sendAck(config, msgId)
        return
      }

      if (!text) return

      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      const seconds = String(now.getSeconds()).padStart(2, '0')

      const msg = {
        id: msgId || 'msg_' + Date.now(),
        text: text,
        date: year + '-' + month + '-' + day,
        time: hours + ':' + minutes + ':' + seconds,
        timestamp: now.getTime(),
        read: false,
        readTime: null
      }

      console.log('收到消息: ' + text)
      if (self.onMessage) self.onMessage(msg)
    } catch (e) {
      console.error('消息解析失败:', e)
    }
  }

  sendAck(config, msgId) {
    const self = this
    setTimeout(function() {
      try {
        if (!self.client || !self.isConnected) return
        const nowSec = Math.floor(Date.now() / 1000)
        const topic = '$sys/' + config.productId + '/' + config.deviceName + '/thing/property/post'
        self.client.publish(topic, JSON.stringify({
          id: '' + Date.now(), version: '1.0',
          params: { ack_status: { value: nowSec }, msg_id: { value: msgId } }
        }))
      } catch (e) {}
    }, 0)
  }

  startHeartbeat(config) {
    const self = this
    self.stopHeartbeat()
    self.heartbeatTimer = setInterval(function() {
      try {
        if (self.client && self.isConnected) {
          const nowSec = Math.floor(Date.now() / 1000)
          const topic = '$sys/' + config.productId + '/' + config.deviceName + '/thing/property/post'
          self.client.publish(topic, JSON.stringify({
            id: 'hb_' + nowSec, version: '1.0',
            params: { ack_status: { value: nowSec } }
          }))
        }
      } catch (e) {
        console.error('心跳发送异常:', e.message)
      }
    }, 30000)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // 强制重建连接：先关旧连接、重新生成 token 再连。
  // 应对长时间待机/睡眠恢复后 mqtt.js 内部状态卡死、内置重连失效、token 过期。
  reconnect() {
    const self = this
    if (!self.config) return
    try { if (self.client) self.client.end(true) } catch (e) {}
    self.client = null
    self.isConnected = false
    self.connect(self.config)
  }

  disconnect() {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.client) {
      try { this.client.end(true) } catch (e) {}
      this.client = null
    }
    this.isConnected = false
  }
}

module.exports = MqttClient
