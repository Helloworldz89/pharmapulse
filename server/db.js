const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const bcrypt = require('bcryptjs');

let dbUrl = process.env.TURSO_DATABASE_URL || '';
if (dbUrl.startsWith('libsql://')) {
  dbUrl = dbUrl.replace('libsql://', 'https://');
}

const token = process.env.TURSO_AUTH_TOKEN;

if (!dbUrl || !token) {
  console.error('FATAL: TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing in server/.env');
  process.exit(1);
}

// Low-level HTTP pipeline runner via Node's native fetch
async function executeTurso(sql, args = []) {
  const formattedArgs = args.map(arg => {
    if (arg === null || arg === undefined) return { type: 'null' };
    if (typeof arg === 'number') {
      return Number.isInteger(arg) ? { type: 'integer', value: String(arg) } : { type: 'float', value: arg };
    }
    return { type: 'text', value: String(arg) };
  });

  const response = await fetch(`${dbUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          type: 'execute',
          stmt: {
            sql,
            args: formattedArgs
          }
        },
        { type: 'close' }
      ]
    })
  });

  const resData = await response.json();

  if (!response.ok || (resData.results && resData.results[0].type === 'error')) {
    const errorMsg = resData.results?.[0]?.error?.message || response.statusText;
    throw new Error(errorMsg);
  }

  const result = resData.results[0].response.result;
  const cols = (result.cols || []).map(c => c.name);
  const rows = (result.rows || []).map(row => {
    const obj = {};
    row.forEach((val, idx) => {
      obj[cols[idx]] = val.value !== undefined ? val.value : null;
    });
    return obj;
  });

  return {
    rows,
    rowsAffected: result.affected_row_count,
    lastInsertRowid: result.last_insert_rowid
  };
}

console.log('Connected to Turso via pure HTTP pipeline (zero packages needed)');

// Drop-in compatibility wrapper mirroring sqlite3 (run, get, all, serialize)
const db = {
  run(sql, params = [], callback = () => {}) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    executeTurso(sql, params)
      .then(res => callback.call({ lastID: Number(res.lastInsertRowid || 0), changes: res.rowsAffected }, null))
      .catch(err => {
        console.error('DB Run Error:', err.message, '\nQuery:', sql);
        callback(err);
      });
  },

  get(sql, params = [], callback = () => {}) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    executeTurso(sql, params)
      .then(res => callback(null, res.rows.length > 0 ? res.rows[0] : null))
      .catch(err => {
        console.error('DB Get Error:', err.message, '\nQuery:', sql);
        callback(err, null);
      });
  },

  all(sql, params = [], callback = () => {}) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    executeTurso(sql, params)
      .then(res => callback(null, res.rows || []))
      .catch(err => {
        console.error('DB All Error:', err.message, '\nQuery:', sql);
        callback(err, []);
      });
  },

  serialize(fn) {
    if (typeof fn === 'function') fn();
  }
};

async function initDatabase() {
  try {
    // 1. Staff Table
    await executeTurso(`
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

   const staffMigrations = [
      'ALTER TABLE staff ADD COLUMN security_question TEXT',
      'ALTER TABLE staff ADD COLUMN security_answer TEXT',
      'ALTER TABLE staff ADD COLUMN sec_q TEXT',
      'ALTER TABLE staff ADD COLUMN sec_a TEXT',
      'ALTER TABLE staff ADD COLUMN reset_token TEXT',
      'ALTER TABLE staff ADD COLUMN reset_expires DATETIME',
      'ALTER TABLE staff ADD COLUMN license TEXT',
      'ALTER TABLE staff ADD COLUMN phone TEXT',
      'ALTER TABLE staff ADD COLUMN avatar_url TEXT',
      'ALTER TABLE staff ADD COLUMN active INTEGER DEFAULT 1'
    ];

    for (const sql of staffMigrations) {
      try {
        await executeTurso(sql);
      } catch (e) {
        // Safe to ignore if column already exists
      }
    }

    // 3. Clinic Profile
    await executeTurso(`
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

    // 4. Inventory
    await executeTurso(`
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

    // 5. Prescriptions
    await executeTurso(`
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
        medicines TEXT,
        items TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 6. Suppliers
    await executeTurso(`
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

    // 7. Purchase Orders
    await executeTurso(`
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

    // 8. Invoices
    await executeTurso(`
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

    // 9. Customer Inquiries
    await executeTurso(`
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

    // Clinic profile default seed check
    const profileRes = await executeTurso('SELECT * FROM clinic_profile WHERE id = 1');
    if (!profileRes.rows || profileRes.rows.length === 0) {
      await executeTurso(
        `INSERT INTO clinic_profile (id, name, dl, gst, address, tax_rate, upi_id)
         VALUES (1, 'PharmaPulse Clinic & Dispensary', 'DL-20B/84920', '07AAAAA0000A1Z5', 'Health City, Medical Enclave, New Delhi', 5.0, '9661368481@slc')`
      );
    }

    // Default admin seed
    const hashedAdminPass = bcrypt.hashSync('admin123', 10);
    await executeTurso(
      `INSERT OR IGNORE INTO staff (id, name, email, role, password, active)
       VALUES ('PH-9661', 'Kundan Kumar', 'kundankumar.kk570@gmail.com', 'Super Admin / Pharmacist', ?, 1)`,
      [hashedAdminPass]
    );

    // Initial Medicines seed
    const seedMeds = [
      ['MED-1', 'Augmentin 625 Duo', 'Amoxicillin + Clavulanic Acid', 'Antibiotic', 'Rx', 'Bacterial infections', '2026-12', 220.00, 112, 'Optimal'],
      ['MED-2', 'Dolo 650mg', 'Paracetamol', 'Analgesic', 'OTC', 'Fever & mild pain relief', '2028-03', 35.00, 118, 'Optimal'],
      ['MED-3', 'Glimepiride 2mg', 'Glimepiride', 'Antidiabetic', 'Rx', 'Type 2 diabetes blood glucose regulation', '2027-11', 95.00, 90, 'Optimal'],
      ['MED-4', 'Lipitor 20mg', 'Atorvastatin Calcium', 'Antibiotic', 'OTC', 'Fever & lipid control', '2026-12', 12.00, 50, 'Optimal'],
      ['MED-5', 'Pantocid 40mg', 'Pantoprazole', 'Antacid', 'OTC', 'Acidity, GERD & stomach ulcer treatment', '2027-05', 145.00, 148, 'Optimal']
    ];

    for (const m of seedMeds) {
      await executeTurso(
        `INSERT OR IGNORE INTO inventory (id, name, salt, category, type, indications, exp, base_price, stock, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m
      );
    }

    console.log('Turso cloud database connected and tables initialized.');
  } catch (err) {
    console.error('Error initializing database tables:', err.message);
  }
}

initDatabase();

module.exports = db;