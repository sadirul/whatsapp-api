const express = require('express')
const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const Session = require('./models/Session')
require('./db')
require('dotenv').config()
const axios = require('axios')
const multer = require('multer')
const mime = require('mime-types')
const cors = require('cors')
const basicAuth = require('./middleware/basicAuth')

const app = express()
app.use(cors())
app.use(express.json())

// File upload
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
})

const sessions = {}
const qrCodes = {}
const initializingSessions = {}

async function loadSessions() {
    try {
        const instances = await Session.find()
        console.log(`📱 Loading ${instances.length} existing sessions...`)
        for (const s of instances) {
            console.log(`🔄 Initializing session: ${s.instanceKey}`)
            await initWhatsApp(s.instanceKey)
        }
    } catch (error) {
        console.error('❌ Error loading sessions:', error)
    }
}

async function initWhatsApp(instanceKey) {
    try {
        if (sessions[instanceKey] || initializingSessions[instanceKey]) {
            console.log(`⚠️ Session ${instanceKey} already exists or is initializing.`)
            return sessions[instanceKey]
        }

        initializingSessions[instanceKey] = true

        const folder = path.join(__dirname, 'sessions', instanceKey)
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true })
        }

        const { state, saveCreds } = await useMultiFileAuthState(folder)

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp API', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
        })

        sessions[instanceKey] = sock

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            try {
                if (qr) {
                    console.log(`📸 New QR generated at ${new Date().toISOString()} for ${instanceKey}`)
                    const qrImage = await qrcode.toDataURL(qr)

                    qrCodes[instanceKey] = {
                        qr: qrImage,
                        generatedAt: new Date()
                    }

                    await Session.findOneAndUpdate(
                        { instanceKey },
                        {
                            qr: qrImage,
                            qrGeneratedAt: new Date(),
                            connected: false
                        },
                        { upsert: true }
                    )
                }

                if (connection === 'open') {
                    console.log(`✅ Connected: ${instanceKey}`)
                    delete qrCodes[instanceKey]

                    await Session.findOneAndUpdate(
                        { instanceKey },
                        {
                            connected: true,
                            qr: null,
                            qrGeneratedAt: null,
                            lastConnected: new Date()
                        },
                        { upsert: true }
                    )
                }

                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
                    console.log(`❌ Disconnected: ${instanceKey}, reconnect: ${shouldReconnect}`)

                    delete sessions[instanceKey]
                    delete qrCodes[instanceKey]

                    await Session.findOneAndUpdate(
                        { instanceKey },
                        {
                            connected: false,
                            qr: null,
                            qrGeneratedAt: null
                        }
                    )

                    if (shouldReconnect) {
                        console.log(`🔄 Reconnecting ${instanceKey} in 5 seconds...`)
                        setTimeout(() => {
                            initWhatsApp(instanceKey)
                        }, 5000)
                    } else {
                        console.log(`🚫 ${instanceKey} logged out`)
                        const sessionPath = path.join(__dirname, 'sessions', instanceKey)
                        if (fs.existsSync(sessionPath)) {
                            fs.rmSync(sessionPath, { recursive: true, force: true })
                        }
                        await Session.findOneAndDelete({ instanceKey })
                    }
                }
            } catch (error) {
                console.error(`❌ Connection update error for ${instanceKey}:`, error)
            }
        })

        return sock
    } catch (error) {
        console.error(`❌ Failed to initialize WhatsApp for ${instanceKey}:`, error)
        throw error
    } finally {
        delete initializingSessions[instanceKey]
    }
}

async function logoutInstance(instanceKey) {
    try {
        console.log(`🔄 Logging out instance: ${instanceKey}`)
        const sock = sessions[instanceKey]
        if (sock) await sock.logout()

        delete sessions[instanceKey]
        delete qrCodes[instanceKey]

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

app.use(basicAuth)

app.get('/start-session', async (req, res) => {
    try {
        const { instanceKey } = req.query
        if (!instanceKey) {
            return res.status(400).json({ success: false, message: 'instanceKey is required' })
        }

        if (sessions[instanceKey]) {
            const sessionData = await Session.findOne({ instanceKey })
            if (sessionData && sessionData.connected) {
                return res.json({
                    success: true,
                    message: `Session ${instanceKey} is already connected`,
                    connected: true
                })
            }
        }

        if (initializingSessions[instanceKey]) {
            return res.json({
                success: true,
                message: `Session ${instanceKey} is currently initializing...`,
                connected: false
            })
        }

        await Session.findOneAndUpdate(
            { instanceKey },
            { instanceKey, connected: false, qr: null, qrGeneratedAt: null },
            { upsert: true }
        )

        await initWhatsApp(instanceKey)

        res.json({
            success: true,
            message: `Session started for ${instanceKey}. Please scan QR code.`,
            connected: false
        })
    } catch (error) {
        console.error('❌ Start session error:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to start session',
            error: error.message
        })
    }
})

app.get('/qr', async (req, res) => {
    try {
        const { instanceKey } = req.query
        if (!instanceKey) {
            return res.status(400).json({ success: false, message: 'instanceKey is required' })
        }

        const session = await Session.findOne({ instanceKey })
        const sock = sessions[instanceKey]

        if (session && session.connected && sock) {
            return res.json({
                success: true,
                message: 'Already connected to WhatsApp',
                connected: true
            })
        }

        let qrData = qrCodes[instanceKey]

        if (!qrData && session?.qr && session?.qrGeneratedAt) {
            qrData = {
                qr: session.qr,
                generatedAt: session.qrGeneratedAt
            }
        }

        if (!qrData) {
            return res.json({
                success: false,
                message: 'No QR code available. Please start the session first.',
                connected: false,
                needsRestart: true
            })
        }

        const now = new Date()
        const qrAge = (now - new Date(qrData.generatedAt)) / 1000

        if (qrAge > 60) {
            delete qrCodes[instanceKey]
            await Session.findOneAndUpdate({ instanceKey }, { qr: null, qrGeneratedAt: null })

            return res.json({
                success: false,
                message: 'QR code expired. Please restart the session.',
                connected: false,
                needsRestart: true
            })
        }

        return res.json({
            success: true,
            qr: qrData.qr,
            expiresIn: Math.max(0, 60 - Math.floor(qrAge)),
            connected: false,
        })

    } catch (error) {
        console.error('❌ QR fetch error:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to fetch QR code',
            error: error.message
        })
    }
})

app.post('/send-message', async (req, res) => {
    try {
        const { instanceKey } = req.query
        const { number, message } = req.body

        if (!instanceKey || !number || !message) {
            return res.status(400).json({
                success: false,
                message: 'instanceKey, number, and message are required'
            })
        }

        const sock = sessions[instanceKey]
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'Session not connected. Please scan QR code first.'
            })
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
        await sock.sendMessage(jid, { text: message })

        res.json({ success: true, message: 'Message sent successfully' })
    } catch (error) {
        console.error('❌ Send message error:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        })
    }
})
app.post('/send-file-url', async (req, res) => {
    try {
        const { instanceKey } = req.query
        const { number, fileUrl, caption, fileName: customFileName } = req.body

        if (!instanceKey || !number || !fileUrl) {
            return res.status(400).json({
                success: false,
                message: 'instanceKey, number, and fileUrl are required'
            })
        }

        const sock = sessions[instanceKey]
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'Session not connected. Please scan QR code first.'
            })
        }

        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000 // 30 second timeout
        })

        const buffer = Buffer.from(response.data, 'binary')
        const mimeType = response.headers['content-type'] || 'application/octet-stream'
        const fileExt = mime.extension(mimeType) || 'pdf'
        const fileName = customFileName || `file.${fileExt}`

        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimeType,
            fileName,
            caption: caption || ''
        })

        res.json({
            success: true,
            message: 'File sent successfully from URL'
        })

    } catch (error) {
        console.error('❌ Send file URL error:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to send file from URL',
            error: error.message
        })
    }
})

app.post('/send-file', upload.single('file'), async (req, res) => {
    try {
        const { instanceKey } = req.query
        const { number, caption } = req.body
        const file = req.file

        if (!instanceKey || !number || !file) {
            return res.status(400).json({
                success: false,
                message: 'instanceKey, number, and file are required'
            })
        }

        const sock = sessions[instanceKey]
        if (!sock) {
            // Clean up uploaded file
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path)
            }
            return res.status(400).json({
                success: false,
                message: 'Session not connected. Please scan QR code first.'
            })
        }

        const buffer = fs.readFileSync(file.path)
        const mimeType = file.mimetype || 'application/octet-stream'
        const fileName = file.originalname || 'file'
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimeType,
            fileName,
            caption: caption || ''
        })

        // Clean up uploaded file
        fs.unlinkSync(file.path)

        res.json({
            success: true,
            message: 'File sent successfully from upload'
        })

    } catch (error) {
        console.error('❌ Send file upload error:', error)

        // Clean up uploaded file in case of error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path)
        }

        res.status(500).json({
            success: false,
            message: 'Failed to send file',
            error: error.message
        })
    }
})


app.get('/logout', async (req, res) => {
    try {
        const { instanceKey } = req.query
        if (!instanceKey) {
            return res.status(400).json({
                status: 'error',
                message: 'Missing instanceKey in query.'
            })
        }

        const result = await logoutInstance(instanceKey)
        res.json(result)
    } catch (error) {
        console.error('❌ Logout error:', error)
        res.status(500).json({
            status: 'error',
            message: 'Failed to logout',
            error: error.message
        })
    }
})

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: Object.keys(sessions).length
    })
})

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
    console.log(`🚀 WhatsApp API Server running at http://localhost:${PORT}`)
    console.log(`📱 Starting to load existing sessions...`)
    try {
        await loadSessions()
        console.log(`✅ All sessions loaded successfully`)
    } catch (error) {
        console.error('❌ Error loading sessions on startup:', error)
    }
})

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...')
    process.exit(0)
})

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...')
    process.exit(0)
})
