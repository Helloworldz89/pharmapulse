require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { GoogleGenAI } = require('@google/genai');;
console.log('Gemini Key Loaded:', process.env.GEMINI_API_KEY ? `${process.env.GEMINI_API_KEY.slice(0, 6)}...` : 'NOT FOUND (undefined)');
// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'pharmapulse_jwt_key_2026';

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static file uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Multer Storage for Prescription Slips & User Avatars
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage });

// 2. Ensure Database Schema Exists in db.js or server.js
db.run(`
  CREATE TABLE IF NOT EXISTS customer_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    message TEXT NOT NULL,
    ai_summary TEXT,
    category TEXT,
    urgency TEXT,
    status TEXT DEFAULT 'New',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Helper to safely trigger the Google Apps Script Webhook
async function triggerAppsScriptWebhook(payload) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow' // Follow Google 302 redirects properly
    });
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      console.log('[Webhook Success]:', parsed);
    } catch {
      // Google sometimes returns HTML confirmation redirect; this prevents the JSON parse crash
      console.log('[Webhook Executed]: Dispatched successfully.');
    }
  } catch (err) {
    console.warn('[Webhook Warning]:', err.message);
  }
}

// POST: Create customer inquiry
app.post('/api/inquiries', async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  let aiSummary = 'Customer general query received.';
  let category = 'General Inquiry';
  let urgency = 'Low';

  // 1. Gemini with automatic retry for 503 spikes
  const prompt = `Analyze this customer inquiry for a pharmacy clinic. Return strictly valid JSON without markdown fences.
Keys:
- "summary": 1 concise sentence summarizing the query.
- "category": One of ["Medication Availability", "Prescription Query", "Dosage & Administration", "General"].
- "urgency": One of ["Low", "Medium", "High"].

Inquiry: "${message}"`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      });

      if (response && response.text) {
        const cleanJson = response.text.replace(/```json|```/gi, '').trim();
        const parsed = JSON.parse(cleanJson);
        if (parsed.summary) aiSummary = parsed.summary;
        if (parsed.category) category = parsed.category;
        if (parsed.urgency) urgency = parsed.urgency;
        break; // Success, exit retry loop
      }
    } catch (err) {
      if (attempt === 1) {
        // Wait 1.5 seconds and retry once
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.warn('[Gemini Warning] Summarization fallback activated:', err.message);
      }
    }
  }

  // 2. Persist to SQLite
  db.run(`
    INSERT INTO customer_inquiries (name, email, phone, message, ai_summary, category, urgency, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'New')
  `, [name, email, phone || '', message, aiSummary, category, urgency], function (dbErr) {
    if (dbErr) return res.status(500).json({ error: dbErr.message });

    const newInquiryId = this.lastID;

    // 3. Trigger Google Sheet + Auto-Acknowledgment
    triggerAppsScriptWebhook({
      name,
      email,
      phone: phone || 'N/A',
      category,
      urgency,
      summary: aiSummary,
      message
    });

    res.json({
      message: 'Inquiry saved successfully.',
      inquiryId: newInquiryId,
      ai_summary: aiSummary,
      category,
      urgency
    });
  });
});

// 4. GET: Return all Inquiries for the Dashboard Table
app.get('/api/inquiries', (req, res) => {
  db.all(`SELECT * FROM customer_inquiries ORDER BY id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 5. PUT: Mark Inquiry Status (e.g. Resolved)
app.put('/api/inquiries/:id/status', (req, res) => {
  const { status } = req.body;
  db.run(`UPDATE customer_inquiries SET status = ? WHERE id = ?`, [status, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Status updated.' });
  });
});

// DELETE: Delete an inquiry by ID
app.delete('/api/inquiries/:id', (req, res) => {
  const { id } = req.params;
  
  db.run(`DELETE FROM customer_inquiries WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error('[DB Error] Failed to delete inquiry:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    res.json({ message: 'Inquiry deleted successfully', deletedId: id });
  });
});

// 1. Ensure schema supports replies (safe migration)
db.run(`ALTER TABLE customer_inquiries ADD COLUMN reply_message TEXT`, () => {});
db.run(`ALTER TABLE customer_inquiries ADD COLUMN replied_at DATETIME`, () => {});

// 2. POST: Pharmacist Reply to Inquiry via Google Apps Script Webhook
// POST: Reply to customer inquiry
app.post('/api/inquiries/:id/reply', (req, res) => {
  const { id } = req.params;
  const { replyMessage } = req.body;

  if (!replyMessage || !replyMessage.trim()) {
    return res.status(400).json({ error: 'Reply message cannot be empty.' });
  }

  db.get(`SELECT * FROM customer_inquiries WHERE id = ?`, [id], (err, inq) => {
    if (err || !inq) return res.status(404).json({ error: 'Inquiry record not found.' });

    // Explicitly pass action: "reply" to bypass the sheet append and AI email
    triggerAppsScriptWebhook({
      action: 'reply',
      name: inq.name,
      email: inq.email,
      originalQuery: inq.message,
      replyMessage: replyMessage.trim()
    });

    const nowIso = new Date().toISOString();
    db.run(
      `UPDATE customer_inquiries SET status = 'Replied', reply_message = ?, replied_at = ? WHERE id = ?`,
      [replyMessage.trim(), nowIso, id],
      function (updErr) {
        if (updErr) return res.status(500).json({ error: updErr.message });
        res.json({ message: 'Reply recorded and email dispatched.', id });
      }
    );
  });
});

// Safely ensure new compliance columns exist in the SQLite schema
db.serialize(() => {
  const complianceCols = [
    { table: 'invoices', col: 'tender_ref', type: 'TEXT' },
    { table: 'invoices', col: 'doctor_name', type: 'TEXT' },
    { table: 'invoices', col: 'doctor_reg_no', type: 'TEXT' },
    { table: 'invoices', col: 'patient_id_ref', type: 'TEXT' },
    { table: 'invoices', col: 'rx_ref', type: 'TEXT' },
    { table: 'invoices', col: 'dispensing_pharmacist', type: 'TEXT' }
  ];

  complianceCols.forEach(({ table, col, type }) => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`, () => {
      // Ignore error if column already exists
    });
  });
});

// JWT Token Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

// Admin Clearance Verification Middleware
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.role || !req.user.role.includes('Super Admin')) {
    return res.status(403).json({ error: 'Clearance denied. Requires Super Admin clearance.' });
  }
  next();
}

/* =========================================================================
   AUTH & RECOVERY ENDPOINTS
   ========================================================================= */

// Staff Sign-in
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  db.get(`SELECT * FROM staff WHERE LOWER(email) = LOWER(?)`, [email], (err, staff) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!staff) return res.status(404).json({ error: 'No account registered with this email.' });
    if (!staff.active) return res.status(403).json({ error: 'Account suspended by administration.' });

    const passwordMatch = bcrypt.compareSync(password, staff.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid password credentials.' });

    const token = jwt.sign(
      { id: staff.id, name: staff.name, email: staff.email, role: staff.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Authentication successful',
      token,
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        avatar_url: staff.avatar_url,
        isSuperAdmin: staff.role.includes('Super Admin')
      }
    });
  });
});

// Registration: Save Avatar path to SQLite
app.post('/api/auth/register', upload.single('avatar'), (req, res) => {
  const { name, email, license, role, password, phone, security_q, security_a } = req.body;

  if (!name || !email || !license || !role || !password) {
    return res.status(400).json({ error: 'All required fields (*) must be provided.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const avatarUrl = req.file ? `/uploads/${req.file.filename}` : null;

  db.run(`
    INSERT INTO staff (id, name, email, role, password, phone, security_question, security_answer, avatar_url, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `, [license, name, email, role, hashedPassword, phone || '', security_q || '', security_a || '', avatarUrl], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Account with this email or License ID already exists.' });
      }
      return res.status(500).json({ error: err.message });
    }
    res.status(201).json({ message: 'Staff account successfully created.' });
  });
});

// =========================================================================
// RECOVERY INITIATE (Fixed Phone Number Sanitization & Security Matching)
// =========================================================================
app.post('/api/auth/recover-initiate', (req, res) => {
  const { channel, identifier, secAnswer } = req.body;

  if (!identifier || !identifier.trim()) {
    return res.status(400).json({ error: 'Please enter your registered identifier.' });
  }

  const rawId = identifier.trim();
  // Strip spaces, dashes, parentheses, and plus signs for phone comparison
  const cleanDigits = rawId.replace(/\D/g, '');

  let query = '';
  let params = [];

  if (channel === 'phone') {
    query = `
      SELECT id, name, email, phone, license, 
             security_question,
             security_answer,
             security_question AS sec_q,
             security_answer AS sec_a
      FROM staff 
      WHERE phone = ? 
         OR REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
      LIMIT 1
    `;
    params = [rawId, `%${rawId.replace(/\D/g, '')}%`];
  } else if (channel === 'question') {
    query = `
      SELECT id, name, email, phone, license, 
             security_question,
             security_answer,
             security_question AS sec_q,
             security_answer AS sec_a
      FROM staff 
      WHERE LOWER(email) = LOWER(?) 
         OR LOWER(license) = LOWER(?)
         OR LOWER(id) = LOWER(?)
      LIMIT 1
    `;
    params = [rawId, rawId, rawId];
  } else {
    // Email channel
    query = `
      SELECT id, name, email, phone, license, 
             security_question,
             security_answer,
             security_question AS sec_q,
             security_answer AS sec_a
      FROM staff 
      WHERE LOWER(email) = LOWER(?)
      LIMIT 1
    `;
    params = [rawId];
  }

  db.get(query, params, async (err, staff) => {
    if (err) {
      console.error('[Recovery DB Error]:', err.message);
      return res.status(500).json({ error: 'Database verification failed: ' + err.message });
    }

    if (!staff) {
      if (channel === 'phone') {
        return res.status(404).json({ error: `No staff record found registered with phone: "${rawId}"` });
      }
      if (channel === 'question') {
        return res.status(404).json({ error: `Staff ID or Email "${rawId}" was not found.` });
      }
      return res.status(404).json({ error: 'Staff account not found.' });
    }

    // ----------------------------------------------------
    // CHANNEL 1: SECURITY Q&A
    // ----------------------------------------------------
    if (channel === 'question') {
      const storedAnswer = (staff.security_answer || '').trim().toLowerCase();
      const providedAnswer = (secAnswer || '').trim().toLowerCase();

      if (!storedAnswer) {
        return res.status(400).json({ error: 'No security question is configured for this account. Please use Email recovery.' });
      }

      if (providedAnswer !== storedAnswer) {
        return res.status(400).json({ error: 'Incorrect security answer. Please check spelling.' });
      }

      return res.json({
        status: 'verified',
        userId: staff.id,
        message: 'Security challenge confirmed.'
      });
    }

    // ----------------------------------------------------
    // CHANNELS 2 & 3: EMAIL & PHONE SMS
    // ----------------------------------------------------
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    db.run(
      `UPDATE staff SET reset_token = ?, reset_expires = ? WHERE id = ?`,
      [resetCode, expiresAt, staff.id],
      async (updErr) => {
        if (updErr) {
          return res.status(500).json({ error: 'Failed to record OTP verification code.' });
        }

        console.log(`\n================ RECOVERY CODE DISPATCH ================`);
        console.log(`Staff Member : ${staff.name} (ID: ${staff.id})`);
        console.log(`Channel      : ${channel.toUpperCase()}`);
        console.log(`Target Phone : ${staff.phone || 'N/A'}`);
        console.log(`Target Email : ${staff.email}`);
        console.log(`OTP Code     : ${resetCode}`);
        console.log(`========================================================\n`);

        // Send Email via Webhook if configured
        if (process.env.GOOGLE_SHEET_WEBHOOK_URL && staff.email) {
          try {
            await fetch(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'reply',
                name: staff.name,
                email: staff.email,
                originalQuery: `Password Recovery (${channel === 'phone' ? 'Phone SMS' : 'Email'})`,
                replyMessage: `Hello ${staff.name},\n\nYour PharmaPulse recovery authorization code is: ${resetCode}\n\nThis verification code expires in 15 minutes.`
              }),
              redirect: 'follow'
            });
          } catch (mailErr) {
            console.warn('[Webhook Mail Warning]:', mailErr.message);
          }
        }

        const msg = channel === 'phone'
          ? `SMS OTP generated for ${staff.name} (Also sent to registered email ${staff.email.replace(/(.{2})(.*)(?=@)/, '$1***')}). Check server terminal if testing locally.`
          : `Recovery code emailed to ${staff.email}.`;

        res.json({
          status: 'sent',
          userId: staff.id,
          message: msg
        });
      }
    );
  });
});

// =========================================================================
// 2. VERIFY TOKEN & RESET PASSWORD (Step 2)
// =========================================================================
app.post('/api/auth/recover-verify-reset', async (req, res) => {
  const { userId, channel, tokenOrAnswer, newPassword } = req.body;

  if (!userId || !newPassword || newPassword.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  db.get(`SELECT id, reset_token, reset_expires FROM staff WHERE id = ?`, [userId], async (err, staff) => {
    if (err || !staff) {
      return res.status(404).json({ error: 'Staff account not found.' });
    }

    // If channel was email/phone, check OTP validity
    if (channel !== 'question') {
      const now = new Date().toISOString();
      if (!staff.reset_token || staff.reset_token !== tokenOrAnswer.trim() || staff.reset_expires < now) {
        return res.status(400).json({ error: 'Invalid or expired OTP code.' });
      }
    }

    // Hash the new password with bcrypt/bcryptjs
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword.trim(), salt);

    db.run(
      `UPDATE staff SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?`,
      [hashedPassword, staff.id],
      (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ error: 'Failed to update password.' });
        }
        res.json({ message: 'Password reset successfully! You can now log in.' });
      }
    );
  });
});

// Ensure upi_id column exists at boot
db.run(`ALTER TABLE clinic_profile ADD COLUMN upi_id TEXT DEFAULT '9661368481@slc'`, (err) => {
  // Ignored if column already exists
});

// GET Clinic Settings
app.get('/api/settings/profile', (req, res) => {
  db.get(`SELECT * FROM clinic_profile WHERE id = 1`, (err, profile) => {
    if (err) {
      console.error('Error fetching settings:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(profile || {
      id: 1,
      name: 'PharmaPulse Clinic & Dispensary',
      dl: 'DL-20B/84920',
      gst: '07AAAAA0000A1Z5',
      address: 'Health City, Medical Enclave, New Delhi',
      tax_rate: 5.0,
      upi_id: '9661368481@slc'
    });
  });
});

// PUT Clinic Settings (Permits Super Admin OR Dispensary Officers to update UPI)
app.put('/api/settings/profile', authenticateToken, (req, res) => {
  // Check permission: allow Super Admin or Pharmacist roles
  const userRole = req.user && req.user.role ? req.user.role : '';
  const isAuthorized = userRole.includes('Super Admin') || userRole.includes('Pharmacist');

  if (!isAuthorized) {
    return res.status(403).json({ error: 'Clearance denied. Only Administrators or Pharmacists can modify merchant profile.' });
  }

  const { name, dl, gst, address, tax_rate, upi_id } = req.body;
  const targetUpi = (upi_id && upi_id.trim()) ? upi_id.trim() : '9661368481@slc';

  console.log(`[SETTINGS UPDATE] Saving UPI ID: "${targetUpi}" for clinic "${name}"`);

  db.run(`
    UPDATE clinic_profile
    SET name = ?, dl = ?, gst = ?, address = ?, tax_rate = ?, upi_id = ?
    WHERE id = 1
  `, [name, dl, gst, address, Number(tax_rate) || 5.0, targetUpi], function(err) {
    if (err) {
      console.error('[DATABASE ERROR] Failed to save UPI ID to clinic_profile:', err.message);
      return res.status(500).json({ error: err.message });
    }

    console.log(`[SETTINGS SUCCESS] Successfully updated row. Rows affected: ${this.changes}`);
    res.json({
      message: 'Dispensary merchant profile and UPI ID updated successfully.',
      upi_id: targetUpi
    });
  });
});
/* =========================================================================
   STAFF MANAGEMENT (SUPER ADMIN RESTRICTED / SELF-EDIT)
   ========================================================================= */

app.get('/api/staff', authenticateToken, (req, res) => {
  db.all(`SELECT id, name, email, role, phone, active, avatar_url, created_at FROM staff`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Update Staff (Settings): Save all columns, password, and Avatar image
app.put('/api/staff/:id', authenticateToken, upload.single('avatar'), (req, res) => {
  const staffId = req.params.id;
  const isSelf = req.user.id === staffId;
  const isAdmin = req.user.role && req.user.role.includes('Super Admin');

  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'Clearance denied. Staff can only edit their own profile.' });
  }

  const { 
    name, 
    email, 
    role, 
    active, 
    password, 
    license, 
    phone, 
    security_question, 
    security_answer 
  } = req.body;

  const newAvatarUrl = req.file ? `/uploads/${req.file.filename}` : null;

  db.get(`SELECT * FROM staff WHERE id = ?`, [staffId], (err, staff) => {
    if (err || !staff) return res.status(404).json({ error: 'Staff account not found.' });

    // Clearance-aware assignments
    const finalRole = isAdmin && role ? role : staff.role;
    const finalActive = isAdmin && active !== undefined 
      ? (active === 'true' || active === 1 || active === '1' ? 1 : 0) 
      : staff.active;

    // Password hashing (if updated)
    const finalPassword = password && password.trim().length >= 6 
      ? bcrypt.hashSync(password.trim(), 10) 
      : staff.password;

    // Avatar URL fallback
    const finalAvatar = newAvatarUrl || staff.avatar_url;

    // Fallbacks for profile & recovery parameters
    const finalLicense = license !== undefined ? license.trim() : staff.license;
    const finalPhone = phone !== undefined ? phone.trim() : staff.phone;
    const finalSecQ = security_question !== undefined ? security_question.trim() : staff.security_question;
    const finalSecA = security_answer !== undefined ? security_answer.trim() : staff.security_answer;

    db.run(`
      UPDATE staff 
      SET name = ?, 
          email = ?, 
          role = ?, 
          active = ?, 
          password = ?, 
          avatar_url = ?, 
          license = ?, 
          phone = ?, 
          security_question = ?, 
          security_answer = ?
      WHERE id = ?
    `, [
      name ? name.trim() : staff.name,
      email ? email.trim() : staff.email,
      finalRole,
      finalActive,
      finalPassword,
      finalAvatar,
      finalLicense,
      finalPhone,
      finalSecQ,
      finalSecA,
      staffId
    ], function(updateErr) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      res.json({
        message: 'Staff account successfully updated.',
        avatar_url: finalAvatar
      });
    });
  });
});

// Delete Staff (Settings)
app.delete('/api/staff/:id', authenticateToken, requireAdmin, (req, res) => {
  if (req.user.id === req.params.id) {
    return res.status(400).json({ error: 'You cannot delete your own active administrator account.' });
  }
  db.run(`DELETE FROM staff WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Staff member removed from system.' });
  });
});

/* =========================================================================
   INVENTORY & STOCK CONTROL
   ========================================================================= */

app.get('/api/inventory', (req, res) => {
  db.all(`SELECT * FROM inventory ORDER BY name ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/inventory', authenticateToken, (req, res) => {
  const { name, salt, category, type, indications, exp, base_price, stock } = req.body;
  const id = 'MED-' + Date.now().toString().slice(-6);
  const status = Number(stock) < 15 ? 'Low Stock' : 'Optimal';

  db.run(`
    INSERT INTO inventory (id, name, salt, category, type, indications, exp, base_price, stock, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, salt, category, type, indications, exp, base_price, stock, status], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id, name, status, message: 'Medication added to inventory.' });
  });
});

app.put('/api/inventory/:id', authenticateToken, (req, res) => {
  const { name, salt, category, type, indications, exp, base_price, stock } = req.body;
  const status = Number(stock) < 15 ? 'Low Stock' : 'Optimal';

  db.run(`
    UPDATE inventory
    SET name = ?, salt = ?, category = ?, type = ?, indications = ?, exp = ?, base_price = ?, stock = ?, status = ?
    WHERE id = ?
  `, [name, salt, category, type, indications, exp, base_price, stock, status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Inventory record updated.' });
  });
});

app.delete('/api/inventory/:id', authenticateToken, (req, res) => {
  db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'SKU deleted from inventory.' });
  });
});

// POST: /api/prescriptions/:id/dispense
app.post('/api/prescriptions/:id/dispense', authenticateToken, (req, res) => {
  const rxId = req.params.id;
  const { batch, seal, bin, pharmacist_note } = req.body;

  db.get(`SELECT * FROM prescriptions WHERE id = ?`, [rxId], (err, rx) => {
    if (err || !rx) {
      return res.status(404).json({ error: 'Prescription record not found.' });
    }

    // 1. Extract individual medicines list
    let itemList = [];
    if (rx.medicines) {
      try {
        itemList = typeof rx.medicines === 'string' ? JSON.parse(rx.medicines) : rx.medicines;
      } catch (e) {
        itemList = [];
      }
    }

    // Fallback: If medicines JSON is empty, parse the summary string "Drug A (x5), Drug B (x2)"
    if (!itemList.length && rx.drug_name) {
      itemList = rx.drug_name.split(',').map(entry => {
        const match = entry.trim().match(/^(.*?)\s*(?:\(x(\d+)\))?$/);
        return {
          medName: match ? match[1].trim() : entry.trim(),
          quantity: match && match[2] ? parseInt(match[2], 10) : 1
        };
      });
    }

    if (!itemList.length) {
      return res.status(400).json({ error: 'No valid medication entries found on this prescription.' });
    }

    // 2. Validate stock for ALL items before deducting
    db.all(`SELECT * FROM inventory`, [], (invErr, allStock) => {
      if (invErr) {
        return res.status(500).json({ error: 'Failed to access pharmacy inventory.' });
      }

      const deductions = [];

      for (const item of itemList) {
        const searchKey = (item.sku || item.medName || item.name || '').toLowerCase().trim();
        const qtyNeeded = parseInt(item.quantity, 10) || 1;

        // Match by SKU first, or fallback to fuzzy name match
        const stockItem = allStock.find(inv => 
          (inv.sku && inv.sku.toLowerCase() === searchKey) ||
          (inv.id && inv.id.toString().toLowerCase() === searchKey) ||
          (inv.name && inv.name.toLowerCase().includes(searchKey)) ||
          (searchKey.includes(inv.name && inv.name.toLowerCase()))
        );

        if (!stockItem) {
          return res.status(400).json({
            error: `Inventory Missing: Drug "${item.medName || item.sku}" is not cataloged in inventory.`
          });
        }

        if (stockItem.stock < qtyNeeded) {
          return res.status(400).json({
            error: `Insufficient Stock for "${stockItem.name}". Required: ${qtyNeeded}, Available: ${stockItem.stock}.`
          });
        }

        deductions.push({ id: stockItem.id, newStock: stockItem.stock - qtyNeeded });
      }

      // 3. Atomically update inventory and mark prescription as Dispensed
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const updateStockStmt = db.prepare(`UPDATE inventory SET stock = ? WHERE id = ?`);
        for (const d of deductions) {
          updateStockStmt.run(d.newStock, d.id);
        }
        updateStockStmt.finalize();

        db.run(`
          UPDATE prescriptions 
          SET status = 'Dispensed',
              bin = COALESCE(?, bin),
              batch = COALESCE(?, batch),
              seal = COALESCE(?, seal),
              pharmacist_note = COALESCE(?, pharmacist_note)
          WHERE id = ?
        `, [bin || null, batch || null, seal || null, pharmacist_note || null, rxId], function (updateErr) {
          if (updateErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Failed to update prescription status.' });
          }

          db.run('COMMIT');
          res.json({
            message: 'Prescription dispensed successfully. Inventory deducted.',
            rxId
          });
        });
      });
    });
  });
});
/* =========================================================================
   POS & BILLING WITH AUTOMATIC INVENTORY DEDUCTION & AUDIT LOGGING
   ========================================================================= */

app.post('/api/pos/dispense', authenticateToken, (req, res) => {
  const { 
    customer, phone, tender, tender_ref, items, subtotal, base_tax, base_total,
    is_controlled, doctor_name, doctor_reg_no, patient_id_ref, rx_ref 
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty.' });

  const invoiceId = 'INV-' + Math.floor(100000 + Math.random() * 900000);
  const timestamp = new Date().toLocaleString();
  const itemsDispensed = items.map(i => `${i.name} (${i.qty})`).join(', ');

  // Determine if any item in cart is prescription / controlled
  const controlledFlag = is_controlled ? 1 : (items.some(i => i.type === 'Rx') ? 1 : 0);
  const tenderMethod = tender + (tender_ref ? ` (${tender_ref})` : '');
  const dispensingPharmacist = req.user ? req.user.name : 'Authorized Pharmacist';

  db.serialize(() => {
    db.run(`BEGIN TRANSACTION;`);

    for (const item of items) {
      db.run(`
        UPDATE inventory 
        SET stock = MAX(0, stock - ?),
            status = CASE WHEN (stock - ?) < 15 THEN 'Low Stock' ELSE 'Optimal' END
        WHERE id = ?
      `, [item.qty, item.qty, item.id]);
    }

    db.run(`
      INSERT INTO invoices (
        id, timestamp, customer, phone, tender, subtotal, base_tax, base_total, 
        is_controlled, items_dispensed, doctor_name, doctor_reg_no, patient_id_ref, rx_ref, tender_ref, dispensing_pharmacist
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      invoiceId, timestamp, customer || 'Walk-in Customer', phone || '', tenderMethod,
      subtotal, base_tax, base_total, controlledFlag, itemsDispensed,
      doctor_name || null, doctor_reg_no || null, patient_id_ref || null, rx_ref || null, tender_ref || null, dispensingPharmacist
    ], (err) => {
      if (err) {
        db.run(`ROLLBACK;`);
        return res.status(500).json({ error: err.message });
      }

      // If tied to an active prescription, advance it to Dispensed
      if (rx_ref) {
        db.run(`UPDATE prescriptions SET status = 'Dispensed' WHERE id = ?`, [rx_ref]);
      }

      db.run(`COMMIT;`);
      res.status(201).json({
        message: 'Order dispensed and balanced.',
        invoiceId,
        timestamp,
        customer,
        tender: tenderMethod,
        base_total
      });
    });
  });
});

/* =========================================================================
   PRESCRIPTIONS (Rx) PIPELINE
   ========================================================================= */

app.get('/api/prescriptions', (req, res) => {
  db.all(`SELECT * FROM prescriptions ORDER BY created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// POST: /api/prescriptions (Matches your exact schema)
app.post('/api/prescriptions', upload.single('slip'), (req, res) => {
  try {
    const { 
      patientName, patient,
      demographics, demo,
      doctor,
      items, medicines,
      dosage,
      doc_reg 
    } = req.body;

    const patientVal = (patientName || patient || '').trim();
    const demoVal = (demographics || demo || '').trim();
    const doctorVal = (doctor || '').trim();
    const fileUrl = req.file ? `/uploads/${req.file.filename}` : '';

    if (!patientVal || !demoVal || !doctorVal) {
      return res.status(400).json({ error: 'Patient name, demographics, and doctor are required.' });
    }

    if (!fileUrl) {
      return res.status(400).json({ error: 'Prescription image upload is required.' });
    }

    // Parse multi-medicine items array
    let medList = [];
    try {
      const raw = items || medicines;
      medList = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    } catch (e) {
      medList = [];
    }

    if (!Array.isArray(medList) || medList.length === 0) {
      return res.status(400).json({ error: 'At least one prescribed medicine must be added.' });
    }

    // Summary string for legacy drug_name column: e.g. "Amoxicillin 500mg (x2), Paracetamol (x1)"
    const drugSummary = medList.map(m => `${m.medName || m.name || m.sku} (x${m.quantity || 1})`).join(', ');
    const combinedDosage = dosage || medList.map(m => m.instructions || m.dosage || '').filter(Boolean).join(' | ');

    const rxId = 'RX-' + Math.floor(100000 + Math.random() * 900000);
    const today = new Date().toISOString().split('T')[0];

    const query = `
      INSERT INTO prescriptions (
        id, patient, demo, doctor, date, drug_name, status, image_url,
        doc_reg, dosage, medicines, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    db.run(query, [
      rxId,
      patientVal,
      demoVal,
      doctorVal,
      today,
      drugSummary,         // Fulfills drug_name NOT NULL constraint
      fileUrl,             // Fulfills image_url NOT NULL constraint
      doc_reg || null,
      combinedDosage || null,
      JSON.stringify(medList) // Full itemized breakdown
    ], function(err) {
      if (err) {
        console.error('[DB Insert Error]:', err.message);
        return res.status(500).json({ error: err.message });
      }

      res.status(201).json({
        message: 'Prescription queued successfully.',
        id: rxId,
        drug_name: drugSummary,
        image_url: fileUrl
      });
    });

  } catch (err) {
    console.error('[Prescription Upload Error]:', err);
    res.status(500).json({ error: 'Server error processing prescription upload.' });
  }
});

// ================= STAGE 2: CLINICAL AUDIT / VERIFY =================
const verifyHandler = (req, res) => {
  const { doc_reg, dosage, pharmacist_note } = req.body;
  
  db.run(`
    UPDATE prescriptions 
    SET status = 'Verified & Ready', 
        doc_reg = ?, 
        dosage = ?, 
        pharmacist_note = ?
    WHERE id = ?
  `, [doc_reg || '', dosage || '', pharmacist_note || '', req.params.id], function(err) {
    if (err) {
      console.error('Database update error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: 'Prescription verified & ready for dispensation.' });
  });
};

// Mount both routes so neither frontend call fails
app.put('/api/prescriptions/:id/verify', authenticateToken, verifyHandler);
app.put('/api/prescriptions/:id/audit', authenticateToken, verifyHandler);

// Stage 3: Packaging & Binning (Compatibility)
app.put('/api/prescriptions/:id/package', authenticateToken, (req, res) => {
  const { bin, batch, seal } = req.body;
  db.run(`
    UPDATE prescriptions 
    SET status = 'Verified & Ready', bin = ?, batch = ?, seal = ?
    WHERE id = ?
  `, [bin, batch, seal, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Prescription packaged.' });
  });
});

// Stage 4: Dispense & Signoff
app.put('/api/prescriptions/:id/dispense', authenticateToken, (req, res) => {
  const { collector, id_ref, pay_method, drug_name } = req.body;

  db.serialize(() => {
    db.run(`
      UPDATE prescriptions 
      SET status = 'Dispensed', collector = ?, id_ref = ?, pay_method = ?
      WHERE id = ?
    `, [collector, id_ref, pay_method, req.params.id]);

    if (drug_name) {
      db.run(`
        UPDATE inventory 
        SET stock = MAX(0, stock - 1),
            status = CASE WHEN (stock - 1) < 15 THEN 'Low Stock' ELSE 'Optimal' END
        WHERE name = ?
      `, [drug_name]);
    }

    res.json({ message: 'Prescription signed off and stock adjusted.' });
  });
});

app.delete('/api/prescriptions/:id', authenticateToken, (req, res) => {
  db.run(`DELETE FROM prescriptions WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Prescription record deleted.' });
  });
});

/* =========================================================================
   SUPPLIERS & PURCHASE ORDERS
   ========================================================================= */

app.get('/api/suppliers', (req, res) => {
  db.all(`SELECT * FROM suppliers ORDER BY name ASC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/suppliers', authenticateToken, (req, res) => {
  const { name, contact, phone, email, gstin } = req.body;
  const id = 'SUP-' + Math.floor(100 + Math.random() * 900);

  db.run(`
    INSERT INTO suppliers (id, name, contact, phone, email, gstin, active_orders)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `, [id, name, contact, phone, email, gstin], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id, message: 'Supplier registered.' });
  });
});

app.delete('/api/suppliers/:id', authenticateToken, (req, res) => {
  db.run(`DELETE FROM suppliers WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Supplier deleted.' });
  });
});

app.get('/api/purchase-orders', (req, res) => {
  db.all(`SELECT * FROM purchase_orders ORDER BY date DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/purchase-orders', authenticateToken, (req, res) => {
  const { distributor, med_name, qty, base_cost } = req.body;
  const id = 'PO-' + Math.floor(1000 + Math.random() * 9000);
  const date = new Date().toISOString().split('T')[0];

  db.serialize(() => {
    db.run(`
      INSERT INTO purchase_orders (id, distributor, date, med_name, qty, base_cost, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Received')
    `, [id, distributor, date, med_name, qty, base_cost]);

    db.run(`
      UPDATE inventory 
      SET stock = stock + ?,
          status = CASE WHEN (stock + ?) < 15 THEN 'Low Stock' ELSE 'Optimal' END
      WHERE name = ?
    `, [qty, qty, med_name]);

    db.run(`UPDATE suppliers SET active_orders = active_orders + 1 WHERE name = ?`, [distributor]);

    res.status(201).json({ id, message: 'PO generated and inventory updated.' });
  });
});

app.delete('/api/purchase-orders/:id', authenticateToken, (req, res) => {
  db.run(`DELETE FROM purchase_orders WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'PO deleted.' });
  });
});

/* =========================================================================
   FINANCIAL REPORTS & SYSTEM MAINTENANCE
   ========================================================================= */

app.get('/api/financials', (req, res) => {
  db.all(`SELECT * FROM invoices ORDER BY id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Full SQLite State Backup in JSON
app.get('/api/maintenance/backup', authenticateToken, requireAdmin, (req, res) => {
  const backup = {};
  db.all(`SELECT * FROM inventory`, (err, inv) => {
    backup.inventory = inv;
    db.all(`SELECT * FROM prescriptions`, (err, rx) => {
      backup.prescriptions = rx;
      db.all(`SELECT * FROM invoices`, (err, invc) => {
        backup.invoices = invc;
        db.all(`SELECT * FROM suppliers`, (err, sup) => {
          backup.suppliers = sup;
          db.all(`SELECT id, name, email, role, active, avatar_url FROM staff`, (err, st) => {
            backup.staff = st;
            res.json(backup);
          });
        });
      });
    });
  });
});

// POST: AI Chatbot Assistant for PharmaPulse
app.post('/api/chat', (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  // 1. Fetch available stock snapshot for real-time dispensary context
  db.all(`SELECT name, salt, stock, category FROM inventory WHERE stock > 0 LIMIT 40`, async (err, items) => {
    if (err) {
      console.warn('[Chat DB Warning]:', err.message);
    }

    const inventoryList = (items || []).map(i => `${i.name} (${i.salt}) - ${i.stock} in stock`).join(', ');

    const systemInstruction = `You are "PharmaPulse AI Assistant", an empathetic, accurate, and professional clinical pharmacy assistant for PharmaPulse Dispensary.
Store Context:
- Current Available Medicines in Stock: ${inventoryList || 'Standard clinical inventory available.'}
- Business Hours: Mon-Sat, 9:00 AM to 9:00 PM.
- Prescriptions: Schedule H/H1 drugs require a doctor prescription.

Guidelines:
1. Help users verify medicine availability and general wellness guidance.
2. Never prescribe medications or diagnose severe conditions.
3. Always include a brief reminder to consult a registered medical practitioner.
4. Keep answers clear, supportive, and under 3-4 sentences.`;

    try {
      // UPDATED TO gemini-3.6-flash
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: `${systemInstruction}\n\nCustomer Question: "${message.trim()}"`
      });

      const botReply = response && response.text
        ? response.text.trim()
        : "I'm available to help, but couldn't parse a response right now. Please reach out to our pharmacy counter directly.";

      res.json({ reply: botReply });
    } catch (apiErr) {
      console.error('[Gemini Chat Error]:', apiErr.message);
      // Safe fallback response so Node never crashes
      res.json({
        reply: "Our automated clinical assistant is currently synchronizing records. Please contact our pharmacist directly at the counter for urgent queries."
      });
    }
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Process Warning] Unhandled Rejection at:', promise, 'reason:', reason);
});



// Start Server
app.listen(PORT, () => {
  console.log(`PharmaPulse PMS Backend active on port ${PORT}`);
  console.log(`Live API URL: http://localhost:${PORT}`);
});