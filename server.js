const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;
const MONGO_URI = 'mongodb://localhost:27017/nonprofitDB';
const SECRET_KEY = 'your_secure_secret_key';

// Multer Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'proof' ? 'uploads/ngo/' : 'uploads/donations/';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname === 'proof' ? 'ngo-' : 'donation-';
    cb(null, `${prefix}${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ✅ Fixed Mongoose Connection (removed deprecated options)
mongoose.connect(MONGO_URI, {
  
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => {
  console.error('❌ MongoDB Connection Error:', err);
  process.exit(1);
});

// SCHEMAS
const userSchema = new mongoose.Schema({
  organizationName: { type: String, required: true, minlength: 3 },
  email: {
    type: String,
    required: true,
    unique: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email']
  },
  password: { type: String, required: true, minlength: 6 },
  yearOfEstablishment: {
    type: Number,
    required: true,
    min: 1900,
    max: new Date().getFullYear()
  },
  phone: {
    type: String,
    required: true,
    validate: {
      validator: v => /\d{10}/.test(v),
      message: props => `${props.value} is not a valid phone number!`
    }
  },
  proofDocument: { type: String, required: true },
  role: { type: String, enum: ['donor', 'nonprofit'], default: 'nonprofit' }
});

const donationSchema = new mongoose.Schema({
  itemType: { type: String, enum: ['money', 'food', 'clothes', 'household'], required: true },
  amount: {
    type: Number,
    required: function() { return this.itemType === 'money'; },
    min: 1
  },
  donorName: { type: String, required: true, minlength: 3 },
  location: { type: String, required: true },
  email: {
    type: String,
    required: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email']
  },
  phoneNumber: {
    type: String,
    required: true,
    validate: {
      validator: v => /\d{10}/.test(v),
      message: props => `${props.value} is not a valid phone number!`
    }
  },
  itemDescription: { type: String },
  itemCondition: { type: String },
  itemImage: { type: String },
  donorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Donation = mongoose.model('Donation', donationSchema);

// AUTH MIDDLEWARE
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication token required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const verified = jwt.verify(token, SECRET_KEY);
    req.user = verified;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

// ERROR HANDLING
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  const statusCode = err.name === 'ValidationError' ? 400 :
                     (err.name === 'MongoError' && err.code === 11000) ? 400 : 500;
  const message = err.name === 'ValidationError' ? Object.values(err.errors).map(e => e.message).join(', ') :
                  (err.code === 11000 ? 'Duplicate field value entered' : 'Internal server error');

  res.status(statusCode).json({ success: false, error: message });
});

// ROUTES

// Register NGO
app.post('/create-account', upload.single('proof'), async (req, res, next) => {
  try {
    const { organization_name, email, password, year_of_build, phone } = req.body;

    if (!req.file) return res.status(400).json({ success: false, error: 'Proof document required' });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ success: false, error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      organizationName: organization_name,
      email,
      password: hashedPassword,
      yearOfEstablishment: Number(year_of_build),
      phone,
      proofDocument: req.file.path,
      role: 'nonprofit'
    });

    await newUser.save();
    res.status(201).json({ success: true, message: 'Account created', userId: newUser._id });

  } catch (err) {
    next(err);
  }
});

// Login
app.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id, role: user.role }, SECRET_KEY, { expiresIn: '1h' });

    res.json({ success: true, token, user: { id: user._id, name: user.organizationName, role: user.role } });
  } catch (err) {
    next(err);
  }
});

// Submit Donation
app.post('/api/donations', authenticate, upload.single('itemImage'), async (req, res, next) => {
  try {
    const { itemType, donorName, location, email, phoneNumber, amount } = req.body;

    if (itemType === 'money' && !amount) {
      return res.status(400).json({ success: false, error: 'Amount is required for monetary donations' });
    }

    if (itemType !== 'money') {
      if (!req.body.itemDescription || !req.body.itemCondition || !req.file) {
        return res.status(400).json({ success: false, error: 'All item details and image are required' });
      }
    }

    const newDonation = new Donation({
      itemType,
      amount: itemType === 'money' ? Number(amount) : null,
      donorName,
      location,
      email,
      phoneNumber,
      itemDescription: req.body.itemDescription,
      itemCondition: req.body.itemCondition,
      itemImage: req.file?.path,
      donorId: req.user.userId
    });

    await newDonation.save();
    res.status(201).json({ success: true, message: 'Donation submitted', donationId: newDonation._id });

  } catch (err) {
    next(err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 File uploads directory: ${path.resolve(process.cwd(), 'uploads')}`);
});
