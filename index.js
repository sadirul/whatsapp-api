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

// Global error handlers to prevent server crashes
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error)
    // Don't exit the process, just log the error
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason)
    // Don't exit the process, just log the error
})

// Middleware with error handling
try {
    app.use(cors())
    app.use(express.json())
} catch (error) {
    console.error('❌ Middleware setup error:', error)
}

// File upload with error handling
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        try {
            // Add basic file validation
            cb(null, true)
        } catch (error) {
            console.error('❌ File filter error:', error)
            cb(error, false)
        }
    }
})

const sessions = {}
const qrCodes = {}
const initializingSessions = {}

async function loadSessions() {
    try {
        const instances = await Session.find()
        console.log(`📱 Loading ${instances.length} existing sessions...`)
        
        for (const s of instances) {
            try {
                console.log(`🔄 Initializing session: ${s.instanceKey}`)
                await initWhatsApp(s.instanceKey)
            } catch (sessionError) {
                console.error(`❌ Failed to initialize session ${s.instanceKey}:`, sessionError)
                // Continue with other sessions even if one fails
                try {
                    await Session.findOneAndUpdate(
                        { instanceKey: s.instanceKey },
                        { connected: false, qr: null, qrGeneratedAt: null }
                    )
                } catch (updateError) {
                    console.error(`❌ Failed to update session status for ${s.instanceKey}:`, updateError)
                }
            }
        }
    } catch (error) {
        console.error('❌ Error loading sessions:', error)
    }
}

async function initWhatsApp(instanceKey) {
    try {
        if (!instanceKey) {
            throw new Error('instanceKey is required')
        }

        if (sessions[instanceKey] || initializingSessions[instanceKey]) {
            console.log(`⚠️ Session ${instanceKey} already exists or is initializing.`)
            return sessions[instanceKey]
        }

        initializingSessions[instanceKey] = true

        const folder = path.join(__dirname, 'sessions', instanceKey)
        
        try {
            if (!fs.existsSync(folder)) {
                fs.mkdirSync(folder, { recursive: true })
            }
        } catch (fsError) {
            console.error(`❌ Failed to create session folder for ${instanceKey}:`, fsError)
            throw fsError
        }

        let state, saveCreds
        try {
            const authResult = await useMultiFileAuthState(folder)
            state = authResult.state
            saveCreds = authResult.saveCreds
        } catch (authError) {
            console.error(`❌ Failed to initialize auth state for ${instanceKey}:`, authError)
            throw authError
        }

        let sock
        try {
            sock = makeWASocket({
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
        } catch (socketError) {
            console.error(`❌ Failed to create WhatsApp socket for ${instanceKey}:`, socketError)
            throw socketError
        }

        sessions[instanceKey] = sock

        // Wrap event handlers in try-catch
        try {
            sock.ev.on('creds.update', (creds) => {
                try {
                    saveCreds()
                } catch (credsError) {
                    console.error(`❌ Failed to save credentials for ${instanceKey}:`, credsError)
                }
            })
        } catch (eventError) {
            console.error(`❌ Failed to setup creds.update event for ${instanceKey}:`, eventError)
        }

        try {
            sock.ev.on('connection.update', async (update) => {
                try {
                    const { connection, lastDisconnect, qr } = update

                    if (qr) {
                        try {
                            console.log(`📸 New QR generated at ${new Date().toISOString()} for ${instanceKey}`)
                            const qrImage = await qrcode.toDataURL(qr)

                            qrCodes[instanceKey] = {
                                qr: qrImage,
                                generatedAt: new Date()
                            }

                            try {
                                await Session.findOneAndUpdate(
                                    { instanceKey },
                                    {
                                        qr: qrImage,
                                        qrGeneratedAt: new Date(),
                                        connected: false
                                    },
                                    { upsert: true }
                                )
                            } catch (dbError) {
                                console.error(`❌ Failed to update QR in database for ${instanceKey}:`, dbError)
                            }
                        } catch (qrError) {
                            console.error(`❌ Failed to generate QR code for ${instanceKey}:`, qrError)
                        }
                    }

                    if (connection === 'open') {
                        try {
                            console.log(`✅ Connected: ${instanceKey}`)
                            delete qrCodes[instanceKey]

                            try {
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
                            } catch (dbError) {
                                console.error(`❌ Failed to update connection status in database for ${instanceKey}:`, dbError)
                            }
                        } catch (connectionError) {
                            console.error(`❌ Error handling connection open for ${instanceKey}:`, connectionError)
                        }
                    }

                    if (connection === 'close') {
                        try {
                            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
                            console.log(`❌ Disconnected: ${instanceKey}, reconnect: ${shouldReconnect}`)

                            delete sessions[instanceKey]
                            delete qrCodes[instanceKey]

                            try {
                                await Session.findOneAndUpdate(
                                    { instanceKey },
                                    {
                                        connected: false,
                                        qr: null,
                                        qrGeneratedAt: null
                                    }
                                )
                            } catch (dbError) {
                                console.error(`❌ Failed to update disconnection status in database for ${instanceKey}:`, dbError)
                            }

                            if (shouldReconnect) {
                                console.log(`🔄 Reconnecting ${instanceKey} in 5 seconds...`)
                                setTimeout(() => {
                                    try {
                                        initWhatsApp(instanceKey)
                                    } catch (reconnectError) {
                                        console.error(`❌ Failed to reconnect ${instanceKey}:`, reconnectError)
                                    }
                                }, 5000)
                            } else {
                                try {
                                    console.log(`🚫 ${instanceKey} logged out`)
                                    const sessionPath = path.join(__dirname, 'sessions', instanceKey)
                                    if (fs.existsSync(sessionPath)) {
                                        fs.rmSync(sessionPath, { recursive: true, force: true })
                                    }
                                    await Session.findOneAndDelete({ instanceKey })
                                } catch (cleanupError) {
                                    console.error(`❌ Failed to cleanup session ${instanceKey}:`, cleanupError)
                                }
                            }
                        } catch (disconnectionError) {
                            console.error(`❌ Error handling connection close for ${instanceKey}:`, disconnectionError)
                        }
                    }
                } catch (updateError) {
                    console.error(`❌ Connection update error for ${instanceKey}:`, updateError)
                }
            })
        } catch (eventError) {
            console.error(`❌ Failed to setup connection.update event for ${instanceKey}:`, eventError)
        }

        return sock
    } catch (error) {
        console.error(`❌ Failed to initialize WhatsApp for ${instanceKey}:`, error)
        try {
            delete sessions[instanceKey]
            delete qrCodes[instanceKey]
        } catch (cleanupError) {
            console.error(`❌ Failed to cleanup failed session ${instanceKey}:`, cleanupError)
        }
        throw error
    } finally {
        try {
            delete initializingSessions[instanceKey]
        } catch (finallyError) {
            console.error(`❌ Error in finally block for ${instanceKey}:`, finallyError)
        }
    }
}

async function logoutInstance(instanceKey) {
    try {
        if (!instanceKey) {
            return {
                status: 'error',
                message: 'instanceKey is required',
            }
        }

        console.log(`🔄 Logging out instance: ${instanceKey}`)
        
        try {
            const sock = sessions[instanceKey]
            if (sock) {
                await sock.logout()
            }
        } catch (logoutError) {
            console.error(`❌ Failed to logout socket for ${instanceKey}:`, logoutError)
        }

        try {
            delete sessions[instanceKey]
            delete qrCodes[instanceKey]
        } catch (deleteError) {
            console.error(`❌ Failed to delete session references for ${instanceKey}:`, deleteError)
        }

        try {
            const sessionPath = path.join(__dirname, 'sessions', instanceKey)
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true })
            }
        } catch (fsError) {
            console.error(`❌ Failed to remove session files for ${instanceKey}:`, fsError)
        }

        try {
            await Session.findOneAndDelete({ instanceKey })
        } catch (dbError) {
            console.error(`❌ Failed to delete session from database for ${instanceKey}:`, dbError)
        }

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

// Apply basic auth with error handling
try {
    app.use(basicAuth)
} catch (authError) {
    console.error('❌ Basic auth middleware error:', authError)
}

app.get('/start-session', async (req, res) => {
    try {
        const { instanceKey } = req.query
        
        if (!instanceKey) {
            return res.status(400).json({ 
                success: false, 
                message: 'instanceKey is required' 
            })
        }

        // Check if session already exists and is connected
        try {
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
        } catch (checkError) {
            console.error(`❌ Error checking existing session for ${instanceKey}:`, checkError)
        }

        if (initializingSessions[instanceKey]) {
            return res.json({
                success: true,
                message: `Session ${instanceKey} is currently initializing...`,
                connected: false
            })
        }

        try {
            await Session.findOneAndUpdate(
                { instanceKey },
                { instanceKey, connected: false, qr: null, qrGeneratedAt: null },
                { upsert: true }
            )
        } catch (dbError) {
            console.error(`❌ Failed to update session in database for ${instanceKey}:`, dbError)
        }

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
            return res.status(400).json({ 
                success: false, 
                message: 'instanceKey is required' 
            })
        }

        let session, sock
        try {
            session = await Session.findOne({ instanceKey })
            sock = sessions[instanceKey]
        } catch (dbError) {
            console.error(`❌ Failed to fetch session data for ${instanceKey}:`, dbError)
        }

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

        try {
            const now = new Date()
            const qrAge = (now - new Date(qrData.generatedAt)) / 1000

            if (qrAge > 60) {
                try {
                    delete qrCodes[instanceKey]
                    await Session.findOneAndUpdate({ instanceKey }, { qr: null, qrGeneratedAt: null })
                } catch (cleanupError) {
                    console.error(`❌ Failed to cleanup expired QR for ${instanceKey}:`, cleanupError)
                }

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
        } catch (qrProcessError) {
            console.error(`❌ Error processing QR data for ${instanceKey}:`, qrProcessError)
            return res.json({
                success: false,
                message: 'Error processing QR code',
                connected: false,
                needsRestart: true
            })
        }

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

        try {
            const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
            await sock.sendMessage(jid, { text: message })

            res.json({ success: true, message: 'Message sent successfully' })
        } catch (sendError) {
            console.error(`❌ Failed to send message for ${instanceKey}:`, sendError)
            res.status(500).json({
                success: false,
                message: 'Failed to send message to WhatsApp',
                error: sendError.message
            })
        }
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

        let response, buffer, mimeType, fileName
        try {
            response = await axios.get(fileUrl, {
                responseType: 'arraybuffer',
                timeout: 30000, // 30 second timeout
                maxContentLength: 50 * 1024 * 1024 // 50MB max
            })

            buffer = Buffer.from(response.data, 'binary')
            mimeType = response.headers['content-type'] || 'application/octet-stream'
            const fileExt = mime.extension(mimeType) || 'pdf'
            fileName = customFileName || `file.${fileExt}`
        } catch (downloadError) {
            console.error(`❌ Failed to download file from URL for ${instanceKey}:`, downloadError)
            return res.status(500).json({
                success: false,
                message: 'Failed to download file from URL',
                error: downloadError.message
            })
        }

        try {
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
        } catch (sendError) {
            console.error(`❌ Failed to send file to WhatsApp for ${instanceKey}:`, sendError)
            res.status(500).json({
                success: false,
                message: 'Failed to send file to WhatsApp',
                error: sendError.message
            })
        }

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
    let filePath = null
    try {
        const { instanceKey } = req.query
        const { number, caption } = req.body
        const file = req.file

        if (!instanceKey || !number || !file) {
            if (file && file.path) {
                try {
                    fs.unlinkSync(file.path)
                } catch (unlinkError) {
                    console.error(`❌ Failed to cleanup file ${file.path}:`, unlinkError)
                }
            }
            return res.status(400).json({
                success: false,
                message: 'instanceKey, number, and file are required'
            })
        }

        filePath = file.path
        const sock = sessions[instanceKey]
        if (!sock) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath)
                }
            } catch (unlinkError) {
                console.error(`❌ Failed to cleanup file ${filePath}:`, unlinkError)
            }
            return res.status(400).json({
                success: false,
                message: 'Session not connected. Please scan QR code first.'
            })
        }

        let buffer
        try {
            buffer = fs.readFileSync(filePath)
        } catch (readError) {
            console.error(`❌ Failed to read uploaded file ${filePath}:`, readError)
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath)
                }
            } catch (unlinkError) {
                console.error(`❌ Failed to cleanup file ${filePath}:`, unlinkError)
            }
            return res.status(500).json({
                success: false,
                message: 'Failed to read uploaded file',
                error: readError.message
            })
        }

        try {
            const mimeType = file.mimetype || 'application/octet-stream'
            const fileName = file.originalname || 'file'
            const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

            await sock.sendMessage(jid, {
                document: buffer,
                mimetype: mimeType,
                fileName,
                caption: caption || ''
            })

            res.json({
                success: true,
                message: 'File sent successfully from upload'
            })
        } catch (sendError) {
            console.error(`❌ Failed to send uploaded file for ${instanceKey}:`, sendError)
            res.status(500).json({
                success: false,
                message: 'Failed to send file to WhatsApp',
                error: sendError.message
            })
        }

    } catch (error) {
        console.error('❌ Send file upload error:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to send file',
            error: error.message
        })
    } finally {
        // Clean up uploaded file in finally block
        try {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
            }
        } catch (cleanupError) {
            console.error(`❌ Failed to cleanup file in finally block ${filePath}:`, cleanupError)
        }
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
    try {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeSessions: Object.keys(sessions).length
        })
    } catch (error) {
        console.error('❌ Health check error:', error)
        res.status(500).json({
            status: 'error',
            message: 'Health check failed',
            error: error.message
        })
    }
})

// Global error handler middleware
app.use((error, req, res, next) => {
    console.error('🚨 Express error handler:', error)
    
    // Handle multer errors
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 50MB.'
            })
        }
    }
    
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
    })
})

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    })
})

const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
    try {
        console.log(`🚀 WhatsApp API Server running at http://localhost:${PORT}`)
        console.log(`📱 Starting to load existing sessions...`)
        
        try {
            await loadSessions()
            console.log(`✅ All sessions loaded successfully`)
        } catch (loadError) {
            console.error('❌ Error loading sessions on startup:', loadError)
        }
    } catch (startupError) {
        console.error('❌ Server startup error:', startupError)
    }
})

process.on('SIGTERM', () => {
    try {
        console.log('🛑 SIGTERM received, shutting down gracefully...')
        // Add cleanup logic here if needed
        process.exit(0)
    } catch (error) {
        console.error('❌ Error during SIGTERM handling:', error)
        process.exit(1)
    }
})

process.on('SIGINT', () => {
    try {
        console.log('🛑 SIGINT received, shutting down gracefully...')
        // Add cleanup logic here if needed
        process.exit(0)
    } catch (error) {
        console.error('❌ Error during SIGINT handling:', error)
        process.exit(1)
    }
})