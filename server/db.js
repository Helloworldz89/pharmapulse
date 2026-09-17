const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');


const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite:', err.message);
  } else {
    console.log('Connected to SQLite Database (database.sqlite)');
  }
});

// Run queries synchronously during setup
db.serialize(() => {


  // Foreign keys enabled
  db.run(`PRAGMA foreign_keys = ON;`);

  // Database initialization in server.js
db.serialize(() => {
  // 1. Ensure staff table exists with full schema
  db.run(`
    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      password TEXT NOT NULL,
      license TEXT,
      phone TEXT,
      security_question TEXT,
      security_answer TEXT,
      avatar_url TEXT,
      reset_token TEXT,
      reset_expires DATETIME,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Fallback migrations (safe to run if table already existed without these columns)
  db.run(`ALTER TABLE staff ADD COLUMN license TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN phone TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN security_question TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN security_answer TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN avatar_url TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN reset_token TEXT`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN reset_expires DATETIME`, () => {});
  db.run(`ALTER TABLE staff ADD COLUMN active INTEGER DEFAULT 1`, () => {});
});

 // Ensure clinic_profile table schema includes upi_id
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS clinic_profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      name TEXT NOT NULL,
      dl TEXT,
      gst TEXT,
      address TEXT,
      tax_rate REAL DEFAULT 5.0,
      upi_id TEXT DEFAULT 'pharmapulse@icici'
    )
  `);

  // Ensure row 1 exists
  db.get(`SELECT * FROM clinic_profile WHERE id = 1`, (err, row) => {
    if (!row) {
      db.run(`
        INSERT INTO clinic_profile (id, name, dl, gst, address, tax_rate, upi_id)
        VALUES (1, 'PharmaPulse Clinic & Dispensary', 'DL-20B/84920', '07AAAAA0000A1Z5', 'Health City, Medical Enclave, New Delhi', 5.0, '9661368481@slc')
      `);
    }
  });

  // Alter table migration in case database.sqlite already has clinic_profile without upi_id
  db.run(`ALTER TABLE clinic_profile ADD COLUMN upi_id TEXT DEFAULT 'pharmapulse@icici'`, (err) => {
    // Ignore error if column already exists
  });
});

  // 3. Medicines / Inventory
  db.run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      indications TEXT NOT NULL,
      exp TEXT NOT NULL,
      base_price REAL NOT NULL,
      stock INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);

  // 4. Prescriptions (Rx) Pipeline
  db.run(`
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      patient TEXT NOT NULL,
      demo TEXT NOT NULL,
      doctor TEXT NOT NULL,
      date TEXT NOT NULL,
      drug_name TEXT NOT NULL,
      status TEXT NOT NULL,
      image_url TEXT NOT NULL,
      doc_reg TEXT,
      dosage TEXT,
      pharmacist_note TEXT,
      bin TEXT,
      batch TEXT,
      seal TEXT,
      collector TEXT,
      id_ref TEXT,
      pay_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.serialize(() => {
  db.run(`ALTER TABLE prescriptions ADD COLUMN medicines TEXT`, () => {});
  db.run(`ALTER TABLE prescriptions ADD COLUMN items TEXT`, () => {});
});

  // 5. Suppliers Directory
  db.run(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      gstin TEXT NOT NULL,
      active_orders INTEGER DEFAULT 0
    )
  `);

  // 6. Purchase Orders (PO)
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      distributor TEXT NOT NULL,
      date TEXT NOT NULL,
      med_name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      base_cost REAL NOT NULL,
      status TEXT NOT NULL
    )
  `);

  // 7. Invoices & Sales Ledger
  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      customer TEXT NOT NULL,
      phone TEXT,
      tender TEXT NOT NULL,
      subtotal REAL NOT NULL,
      base_tax REAL NOT NULL,
      base_total REAL NOT NULL,
      is_controlled INTEGER DEFAULT 0,
      items_dispensed TEXT NOT NULL
    )
  `);

  // SEED INITIAL DEMO DATA
  // Default Admin User: kundankumar.kk570@gmail.com / admin123
  const hashedAdminPass = bcrypt.hashSync('admin123', 10);
  db.run(`
    INSERT OR IGNORE INTO staff (id, name, email, role, password, active)
    VALUES ('PH-9661', 'Kundan Kumar', 'kundankumar.kk570@gmail.com', 'Super Admin / Pharmacist', ?, 1)
  `, [hashedAdminPass]);

  // Initial Medicines
  const seedMeds = [
    ['MED-1', 'Augmentin 625 Duo', 'Amoxicillin + Clavulanic Acid', 'Antibiotic', 'Rx', 'Bacterial infections', '2026-12', 220.00, 112, 'Optimal'],
    ['MED-2', 'Dolo 650mg', 'Paracetamol', 'Analgesic', 'OTC', 'Fever & mild pain relief', '2028-03', 35.00, 118, 'Optimal'],
    ['MED-3', 'Glimepiride 2mg', 'Glimepiride', 'Antidiabetic', 'Rx', 'Type 2 diabetes blood glucose regulation', '2027-11', 95.00, 90, 'Optimal'],
    ['MED-4', 'Lipitor 20mg', 'Atorvastatin Calcium', 'Antibiotic', 'OTC', 'Fever & lipid control', '2026-12', 12.00, 50, 'Optimal'],
    ['MED-5', 'Pantocid 40mg', 'Pantoprazole', 'Antacid', 'OTC', 'Acidity, GERD & stomach ulcer treatment', '2027-05', 145.00, 148, 'Optimal']
  ];

  seedMeds.forEach(m => {
    db.run(`
      INSERT OR IGNORE INTO inventory (id, name, salt, category, type, indications, exp, base_price, stock, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, m);
  });

  // Initial Supplier & PO
  db.run(`
    INSERT OR IGNORE INTO suppliers (id, name, contact, phone, email, gstin, active_orders)
    VALUES ('SUP-101', 'PharmaMed Wholesale Corp', 'Anil Gupta', '+91 98110 00000', 'orders@pharmamed.com', '07AAACP9999P1Z3', 1)
  `);

  db.run(`
    INSERT OR IGNORE INTO purchase_orders (id, distributor, date, med_name, qty, base_cost, status)
    VALUES ('PO-6931', 'PharmaMed Wholesale Corp', '2026-09-11', 'Augmentin 625 Duo', 50, 425.00, 'Received')
  `);
});
// Seed initial retail invoices so Gross Sales displays live revenue
  db.run(`
    INSERT OR IGNORE INTO invoices (id, timestamp, customer, phone, tender, subtotal, base_tax, base_total, is_controlled, items_dispensed)
    VALUES 
    ('INV-882101', '2026-09-14 10:15:00', 'Walk-in Customer', '+91 9876500000', 'UPI / QR', 220.00, 11.00, 231.00, 1, 'Augmentin 625 Duo (1)'),
    ('INV-882102', '2026-09-14 11:30:00', 'Dr. Sarah Connor', '+91 9811122233', 'Cash', 70.00, 3.50, 73.50, 0, 'Dolo 650mg (2)'),
    ('INV-882103', '2026-09-14 14:45:00', 'Michael Scott', '+91 9822233344', 'Card', 145.00, 7.25, 152.25, 0, 'Pantocid 40mg (1)')
  `);
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



module.exports = db;