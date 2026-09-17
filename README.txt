# PharmaPulse 💊

A modern, responsive pharmacy dispensary and inventory management web application designed for streamlined prescription processing, role-based terminal access, and stock tracking.

---

## 🚀 Live Demo

- **Frontend App:** [https://pharmapulse.vercel.app](https://pharmapulse.vercel.app)
- **Backend API:** [https://pharmapulse-api.onrender.com](https://pharmapulse-api.onrender.com)

---

## 📌 Features

- **Role-Based Access Control (RBAC):** Distinct permission sets and view restrictions for dispensary staff, pharmacists, and administrators.
- **Session Persistence:** Secure JWT-based authentication stored in `localStorage` to keep operator sessions active across page refreshes.
- **Inventory & Prescriptions:** Track medicine supplies, monitor stock alerts, and log customer inquiries.
- **Prescription Attachments:** Upload prescription slips and verification files.
- **Interactive Dashboard:** Dynamic reporting metrics and activity charts for dispensary operations.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | HTML5, CSS3, JavaScript (Vanilla ES6+), DOM API |
| **Backend** | Node.js, Express.js |
| **Database** | SQLite / Turso (libSQL Cloud Database) |
| **Authentication** | JSON Web Tokens (JWT), `bcryptjs` password hashing |
| **Middleware & Tools** | `cors`, `multer`, `dotenv` |
| **Hosting** | Vercel (Frontend), Render (Backend) |

---

## 📂 Project Architecture

```text
PharmaPulse/
│
├── client/                     # Static frontend application
│   ├── index.html              # Layout, modals, forms
│   ├── script.js               # Application logic & API handlers
│   ├── style.css               # Design system & styles
│   └── assets/                 # Icons & static branding assets
│
└── server/                     # Express REST API backend
    ├── server.js               # Server entry point & API endpoints
    ├── db.js                   # Database connection & table setup
    ├── package.json            # Dependencies & start scripts
    └── uploads/                # Temporary local file storage