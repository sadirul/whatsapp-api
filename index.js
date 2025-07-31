const express = require('express')
const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const Session = require('./models/Session')
require('./db')
const axios = require('axios')
const multer = require('multer')
const mime = require('mime-types')

const app = express()
app.use(express.json())

// Multer storage
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
})

const sessions = {}

async function loadSessions() {
    const instances = await Session.find()
    for (const s of instances) {
        await initWhatsApp(s.instanceKey)
    }
}

async function initWhatsApp(instanceKey) {
    const folder = path.join(__dirname, 'sessions', instanceKey)
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(folder)
    const sock = makeWASocket({ auth: state })

    sessions[instanceKey] = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            const qrImage = await qrcode.toDataURL(qr)
            await Session.findOneAndUpdate(
                { instanceKey },
                { qr: qrImage, qrGeneratedAt: new Date(), connected: false },
                { upsert: true }
            )
        }

        if (connection === 'open') {
            console.log(`✅ Connected: ${instanceKey}`)
            await Session.findOneAndUpdate(
                { instanceKey },
                { connected: true, qr: null },
                { upsert: true }
            )
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log(`❌ Disconnected: ${instanceKey}, reconnect: ${shouldReconnect}`)
            await Session.findOneAndUpdate({ instanceKey }, { connected: false })

            if (shouldReconnect) {
                setTimeout(() => initWhatsApp(instanceKey), 3000)
            }
        }
    })
}

async function logoutInstance(instanceKey) {
    try {
        const sock = sessions[instanceKey]
        if (sock) {
            await sock.logout()
            delete sessions[instanceKey]
        }

        const sessionPath = path.join(__dirname, 'sessions', instanceKey)
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true })
        }

        await Session.findOneAndDelete({ instanceKey })

        return {
            status: 'success',
            message: `Instance ${instanceKey} logged out and session removed.`,
        }
    } catch (error) {
        console.error(`❌ Logout failed for ${instanceKey}:`, error)
        return {
            status: 'error',
            message: 'Logout failed',
            error: error.message,
        }
    }
}

// ---------- ROUTES ----------

app.get('/start-session', async (req, res) => {
    const { instanceKey } = req.query
    if (!instanceKey) return res.status(400).json({ success: false, message: 'instanceKey is required' })

    const exists = await Session.findOne({ instanceKey })
    if (!exists) await Session.create({ instanceKey })

    await initWhatsApp(instanceKey)

    res.json({ success: true, message: `Session started for ${instanceKey}` })
})

app.get('/qr', async (req, res) => {
    const { instanceKey } = req.query
    if (!instanceKey) return res.status(400).json({ success: false, message: 'instanceKey is required' })

    const session = await Session.findOne({ instanceKey })
    if (!session) return res.status(404).json({ success: false, message: 'Instance not found' })

    if (session.connected) {
        return res.json({ success: true, message: 'Already connected to WhatsApp', connected: true })
    }

    const now = new Date()
    const qrAge = session.qrGeneratedAt ? (now - session.qrGeneratedAt) / 1000 : Infinity

    if (!session.qr || qrAge > 30) {
        return res.json({ success: false, message: 'QR expired or not available. Please restart session.', connected: false })
    }

    return res.json({
        success: true,
        qr: session.qr,
        expiresIn: 30 - Math.floor(qrAge),
        connected: false,
    })
})

app.post('/send-message', async (req, res) => {
    const { instanceKey } = req.query
    const { number, message } = req.body

    if (!instanceKey || !number || !message) {
        return res.status(400).json({ success: false, message: 'instanceKey, number, and message required' })
    }

    const sock = sessions[instanceKey]
    if (!sock) return res.status(400).json({ success: false, message: 'Session not connected' })

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
        await sock.sendMessage(jid, { text: message })
        res.json({ success: true, message: 'Message sent' })
    } catch (err) {
        console.error(err)
        res.status(500).json({ success: false, error: err.toString() })
    }
})

app.post('/send-file-url', async (req, res) => {
    const { instanceKey } = req.query
    const { number, fileUrl, caption } = req.body

    if (!instanceKey || !number || !fileUrl) {
        return res.status(400).json({ success: false, message: 'instanceKey, number, and fileUrl are required' })
    }

    const sock = sessions[instanceKey]
    if (!sock) return res.status(400).json({ success: false, message: 'Session not connected' })

    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' })
        const buffer = Buffer.from(response.data, 'binary')
        const mimeType = response.headers['content-type']
        const fileExt = mime.extension(mimeType) || 'pdf'
        const fileName = `file.${fileExt}`
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimeType,
            fileName,
            caption: caption || ''
        })

        res.json({ success: true, message: 'File sent from URL' })
    } catch (err) {
        console.error(err)
        res.status(500).json({ success: false, message: 'Failed to send file', error: err.toString() })
    }
})

app.post('/send-file', upload.single('file'), async (req, res) => {
    const { instanceKey } = req.query
    const { number, caption } = req.body
    const file = req.file

    if (!instanceKey || !number || !file) {
        return res.status(400).json({ success: false, message: 'instanceKey, number, and file are required' })
    }

    const sock = sessions[instanceKey]
    if (!sock) return res.status(400).json({ success: false, message: 'Session not connected' })

    try {
        const buffer = fs.readFileSync(file.path)
        const mimeType = file.mimetype
        const fileName = file.originalname
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimeType,
            fileName,
            caption: caption || ''
        })

        fs.unlinkSync(file.path)
        res.json({ success: true, message: 'File sent from upload' })
    } catch (err) {
        console.error(err)
        res.status(500).json({ success: false, message: 'Failed to send file', error: err.toString() })
    }
})

app.get('/logout', async (req, res) => {
    const instanceKey = req.query.instanceKey
    if (!instanceKey) {
        return res.status(400).json({ status: 'error', message: 'Missing instanceKey in query.' })
    }

    const result = await logoutInstance(instanceKey)
    res.json(result)
})

// ---------- START SERVER ----------

const PORT = 3000
app.listen(PORT, async () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`)
    await loadSessions()
})
