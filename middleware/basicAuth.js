
require('dotenv').config()

const USERNAME = process.env.BASIC_USER || ''
const PASSWORD = process.env.BASIC_PASS || ''

const basicAuth = (req, res, next) => {
    const authHeader = req.headers['authorization']

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp API"')
        return res.status(401).json({ success: false, message: 'Unauthorized access!' })
    }

    const base64Credentials = authHeader.split(' ')[1]
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii')
    const [username, password] = credentials.split(':')

    if (username === USERNAME && password === PASSWORD) {
        return next()
    }

    return res.status(403).json({ success: false, message: 'Unauthorized access!' })
}

module.exports = basicAuth
