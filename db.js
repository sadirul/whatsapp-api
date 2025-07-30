const mongoose = require('mongoose')

mongoose.connect('mongodb+srv://sadirulislam786:81450574%40hkrMDB@cluster0.shf7fjd.mongodb.net/whatsapp_nodejs', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})

mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected')
})

module.exports = mongoose
