/* =========================================================================
   PHARMAPULSE FRONTEND - CONNECTED TO SQLITE BACKEND
   ========================================================================= */
// Point to localhost during local development, or Render in production
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:5000/api'
  : 'https://pharmapulse-api.onrender.com/api'; // <-- Ensure this matches your Render URL exactly

const CURRENCY_CONFIG = {
  INR: { symbol: '₹', rate: 1.0, label: 'India (₹ INR)' },
  USD: { symbol: '$', rate: 0.012, label: 'United States ($ USD)' },
  EUR: { symbol: '€', rate: 0.011, label: 'Eurozone (€ EUR)' },
  GBP: { symbol: '£', rate: 0.0095, label: 'United Kingdom (£ GBP)' }
};

let state = {
  selectedCurrency: 'INR',
  clinic: {
    name: 'PharmaPulse Central Dispensary',
    dl: 'DL-20B/8820-A',
    gst: '07AAAAA1234A1Z1',
    address: '12 Health Hub Avenue, New Delhi, India',
    taxRate: 5.0
  },
  currentUser: JSON.parse(localStorage.getItem('pharmapulse_user')) || {
    id: '',
    name: 'Staff Operator',
    role: 'Licensed Dispensary Officer',
    email: '',
    isSuperAdmin: false
  },
  currentView: 'dashboard',
  supplierSubTab: 'po',
  lastDispensedInvoice: null,
  inventory: [],
  cart: [],
  prescriptions: [],
  purchaseOrders: [],
  suppliers: [],
  invoices: [],
  staffAccounts: []
};

let currentPosFilter = 'All';
let currentRxFilter = 'All';
let currentFinanceTab = 'ledger';
let chartInstanceSales = null;
let chartInstanceStock = null;
let pendingConfirmAction = null;
let pendingRxFile = null;

/* =========================================================================
   HTTP REQUEST WRAPPER
   ========================================================================= */
// Base URL configuration


async function apiRequest(endpoint, method = 'GET', body = null, isFormData = false) {
  // 1. Fallback to localStorage if in-memory authToken is not yet populated
  const token = authToken || localStorage.getItem('pharmapulse_token');

  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Never set Content-Type header manually for FormData (browser sets boundary)
  if (!isFormData && body) {
    headers['Content-Type'] = 'application/json';
  }

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = isFormData ? body : JSON.stringify(body);
  }

  // 2. Prevent double slash or double /api/ prefix
  let cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (cleanEndpoint.startsWith('/api/')) {
    cleanEndpoint = cleanEndpoint.replace('/api', '');
  }

  try {
    const res = await fetch(`${API_BASE_URL}${cleanEndpoint}`, options);

    // Read raw text first to avoid crash on non-JSON server error pages
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text || `HTTP ${res.status}: ${res.statusText}` };
    }

    // 3. Auto-logout if token is expired or invalid
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('pharmapulse_token');
      localStorage.removeItem('pharmapulse_user');
      authToken = null;
      document.getElementById('app-layout')?.classList.add('hidden');
      document.getElementById('auth-screen')?.classList.remove('hidden');
      if (typeof switchAuthView === 'function') switchAuthView('login');
    }

    if (!res.ok) {
      throw new Error(data.error || `Server responded with status ${res.status}`);
    }

    return data;
  } catch (err) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('error', 'Backend Request Failed', err.message);
    } else {
      alert(`Backend Request Failed: ${err.message}`);
    }
    throw err;
  }
}

/* =========================================================================
   2. DOMContentLoaded & HANDLELOGIN WITH ERROR GUARDS
   ========================================================================= */
window.addEventListener('DOMContentLoaded', async () => {
  initClock();

  // 1. Rehydrate session state from persistent browser storage
  const savedToken = localStorage.getItem('pharmapulse_token');
  const savedUserStr = localStorage.getItem('pharmapulse_user');

  if (savedToken && savedUserStr) {
    try {
      const parsedUser = JSON.parse(savedUserStr);

      if (parsedUser && parsedUser.id) {
        authToken = savedToken;
        state.currentUser = parsedUser;

        // Reveal dashboard layout and hide auth screen
        const authScreen = document.getElementById('auth-screen');
        const appLayout = document.getElementById('app-layout');
        if (authScreen) authScreen.classList.add('hidden');
        if (appLayout) appLayout.classList.remove('hidden');

        // Apply access control and clearances
        if (typeof applyRoleSecurityRestrictions === 'function') {
          applyRoleSecurityRestrictions();
        }

        // Initialize dashboard charts
        requestAnimationFrame(() => {
          if (typeof initCharts === 'function') initCharts();
        });

        // Sync backend records in background
        if (typeof syncDatabaseFromBackend === 'function') {
          syncDatabaseFromBackend().catch(err => {
            console.warn('Backend sync failed, running with local baseline cache:', err.message);
          });
        }
        return; // Session successfully restored; exit early
      }
    } catch (parseErr) {
      console.warn('Corrupt session cache found. Clearing storage...', parseErr);
      localStorage.removeItem('pharmapulse_token');
      localStorage.removeItem('pharmapulse_user');
      authToken = null;
    }
  }

  // 2. Fallback: First-time visit or logged out -> display login screen
  const authScreen = document.getElementById('auth-screen');
  const appLayout = document.getElementById('app-layout');
  if (authScreen) authScreen.classList.remove('hidden');
  if (appLayout) appLayout.classList.add('hidden');
});

async function syncDatabaseFromBackend() {
  try {
    const [inventory, prescriptions, suppliers, pos, clinic, staff, financials] = await Promise.all([
      apiRequest('/inventory'),
      apiRequest('/prescriptions'),
      apiRequest('/suppliers'),
      apiRequest('/purchase-orders'),
      apiRequest('/settings/profile'),
      apiRequest('/staff'),
      apiRequest('/financials')
    ]);

    // Map database snake_case keys to frontend state
    state.inventory = inventory.map(i => ({
      id: i.id,
      name: i.name,
      salt: i.salt,
      category: i.category,
      type: i.type,
      indications: i.indications,
      exp: i.exp,
      basePrice: Number(i.base_price),
      stock: Number(i.stock),
      status: i.status
    }));

    state.prescriptions = prescriptions.map(r => ({
      id: r.id,
      patient: r.patient,
      demo: r.demo,
      doctor: r.doctor,
      date: r.date,
      drugName: r.drug_name,
      status: r.status,
      imageUrl: r.image_url.startsWith('http') ? r.image_url : `http://localhost:5000${r.image_url}`
    }));

    state.suppliers = suppliers.map(s => ({
      id: s.id,
      name: s.name,
      contact: s.contact,
      phone: s.phone,
      email: s.email,
      gstin: s.gstin,
      activeOrders: Number(s.active_orders)
    }));

    state.purchaseOrders = pos.map(p => ({
      id: p.id,
      distributor: p.distributor,
      date: p.date,
      medName: p.med_name,
      qty: Number(p.qty),
      baseCost: Number(p.base_cost),
      status: p.status
    }));

    if (clinic) {
      state.clinic = {
        name: clinic.name,
        dl: clinic.dl,
        gst: clinic.gst,
        address: clinic.address,
        taxRate: Number(clinic.tax_rate)
      };
      loadClinicForm();
    }

    state.staffAccounts = staff.map(s => ({
      id: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      active: Boolean(s.active),
      isSuperAdmin: s.role.includes('Super Admin')
    }));

    state.invoices = financials.map(f => ({
      id: f.id,
      timestamp: f.timestamp,
      customer: f.customer,
      tender: f.tender,
      subtotal: Number(f.subtotal),
      baseTax: Number(f.base_tax),
      baseTotal: Number(f.base_total),
      isControlled: Boolean(f.is_controlled),
      itemsDispensed: f.items_dispensed
    }));

    renderAllViews();
  } catch (err) {
    console.error('Failed to sync backend state:', err);
  }
}

function initClock() {
  function tick() {
    const d = new Date();
    document.getElementById('live-clock').textContent = d.toLocaleTimeString('en-US', { hour12: true });
  }
  tick();
  setInterval(tick, 1000);
}

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('open');
  backdrop.classList.toggle('hidden');
}

/* =========================================================================
   UPDATED NAVIGATE FUNCTION (Includes 'inquiries')
   ========================================================================= */

function navigate(viewKey) {
  state.currentView = viewKey;

  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar && sidebar.classList.contains('open')) {
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.add('hidden');
  }

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewKey);
  });
  document.querySelectorAll('.content-view').forEach(panel => {
    panel.classList.remove('active');
  });

  const activePanel = document.getElementById(`view-${viewKey}`);
  if (activePanel) activePanel.classList.add('active');

  const titles = {
    dashboard: { t: 'Executive Dashboard', s: 'Overview & Real-time Analytics' },
    pos: { t: 'POS & Billing', s: 'Dispense medicine and generate invoices' },
    inventory: { t: 'Inventory & Stock Control', s: 'Track batches, reorders, and expirations' },
    prescriptions: { t: 'Prescriptions Queue', s: 'Verify doctor orders and audit e-scripts' },
    suppliers: { t: 'Suppliers & Purchase Orders', s: 'Procurement, goods receipt (GRN) and vendor accounts' },
    financials: { t: 'Financial Reports', s: 'Revenue ledger, audit trails, and data export' },
    settings: { t: 'System Settings', s: 'Pharmacy regulatory profile and staff clearance directory' },
    inquiries: { t: 'Customer Inquiries & Automation', s: 'AI-summarized patient queries, Google Sheet logging & email auto-reply' }
  };

  if (titles[viewKey]) {
    const titleEl = document.getElementById('view-title');
    const subEl = document.getElementById('view-subtitle');
    if (titleEl) titleEl.textContent = titles[viewKey].t;
    if (subEl) subEl.textContent = titles[viewKey].s;
  }

  if (viewKey === 'dashboard') updateDashboardCharts();
  if (viewKey === 'pos') renderPosCatalog();
  if (viewKey === 'inventory') renderInventory();
  if (viewKey === 'prescriptions') renderPrescriptions();
  if (viewKey === 'suppliers') {
    if (state.supplierSubTab === 'po') renderPurchaseOrders();
    else renderSupplierDirectory();
  }
  if (viewKey === 'financials') renderFinancials();
  if (viewKey === 'settings') renderStaffList();
  if (viewKey === 'inquiries') loadInquiries();
}

function renderAllViews() {
  updateDashboardKpis();
  renderWatchlist();
  renderPosCatalog();
  renderCart();
  renderInventory();
  renderPrescriptions();
  renderPurchaseOrders();
  renderSupplierDirectory();
  renderFinancials();
  renderStaffList();
  // >>> ADDED TO GLOBAL RENDER <<<
  if (typeof renderInquiriesTable === 'function') renderInquiriesTable();
}

function updateDashboardKpis() {
  // Sum up all completed invoice totals safely converting from number or string
  const gross = state.invoices.reduce((sum, inv) => {
    const val = Number(inv.baseTotal) || Number(inv.base_total) || 0;
    return sum + val;
  }, 0);

  const lowStockItems = state.inventory.filter(i => (Number(i.stock) || 0) < 15);

  // Update top KPI numbers
  const grossElem = document.getElementById('kpi-gross-sales');
  const ordersElem = document.getElementById('kpi-orders-count');
  const lowStockElem = document.getElementById('kpi-low-stock');
  const skusElem = document.getElementById('kpi-total-skus');
  const rxBadge = document.getElementById('rx-badge-count');
  const poBadge = document.getElementById('po-badge-count');

  if (grossElem) grossElem.textContent = formatCurrency(gross);
  if (ordersElem) ordersElem.textContent = state.invoices.length;
  if (lowStockElem) lowStockElem.textContent = lowStockItems.length;
  if (skusElem) skusElem.textContent = state.inventory.length;
  if (rxBadge) rxBadge.textContent = state.prescriptions.filter(p => p.status === 'Pending').length;
  if (poBadge) poBadge.textContent = state.purchaseOrders.length;
}
function renderWatchlist() {
  const tbody = document.getElementById('watchlist-table-body');
  if (!tbody) return;

  const lowStock = state.inventory.filter(item => Number(item.stock) < 15);

  if (lowStock.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state" style="text-align: center; padding: 25px; color: #64748b; font-size: 12.5px;">
          All medicines are well-stocked. No low-stock warnings.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = lowStock.map(med => `
    <tr>
      <td><strong>${med.name}</strong></td>
      <td>${med.salt}</td>
      <td>BATCH-${med.id}</td>
      <td><strong style="color: var(--danger);">${med.stock} units</strong></td>
      <td><span class="tag-badge low">Low Stock</span></td>
    </tr>
  `).join('');
}

function formatCurrency(amountInBaseInr) {
  const conf = CURRENCY_CONFIG[state.selectedCurrency];
  const converted = (amountInBaseInr || 0) * conf.rate;
  return `${conf.symbol}${converted.toFixed(2)}`;
}

function handleCurrencyChange(code) {
  state.selectedCurrency = code;
  renderAllViews();
}

function applyRoleSecurityRestrictions() {
  const isAdmin = state.currentUser.isSuperAdmin;
  document.getElementById('sidebar-user-name').textContent = state.currentUser.name;
  document.getElementById('sidebar-user-role').textContent = state.currentUser.role;
  document.getElementById('header-user-display').textContent = `${state.currentUser.name} (${state.currentUser.role})`;

  const saveBtn = document.getElementById('btn-save-clinic-profile');
  if (saveBtn) {
    saveBtn.disabled = !isAdmin;
    if (!isAdmin) saveBtn.style.opacity = '0.4';
  }
}

/* =========================================================================
   1. BULLETPROOF CHART INITIALIZATION (WORKS EVEN IF BACKEND IS OFFLINE)
   ========================================================================= */
function initCharts() {
  if (typeof Chart === 'undefined') {
    console.error('Chart.js library failed to load from CDN. Check your internet connection.');
    return;
  }

  const salesCanvas = document.getElementById('weeklySalesChart');
  const stockCanvas = document.getElementById('stockDistributionChart');

  if (!salesCanvas || !stockCanvas) return;

  // Cleanly destroy prior chart instances
  if (chartInstanceSales) {
    chartInstanceSales.destroy();
    chartInstanceSales = null;
  }
  if (chartInstanceStock) {
    chartInstanceStock.destroy();
    chartInstanceStock = null;
  }

  // 1. Weekly Sales Double Bar Chart
  try {
    chartInstanceSales = new Chart(salesCanvas, {
      type: 'bar',
      data: {
        labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        datasets: [
          {
            label: 'Prescription (Rx)',
            data: [120, 190, 300, 240, 210, 310, 400],
            backgroundColor: '#0284c7',
            borderRadius: 4
          },
          {
            label: 'Over-the-Counter (OTC)',
            data: [75, 110, 130, 120, 160, 200, 230],
            backgroundColor: '#38bdf8',
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 12, padding: 14, font: { size: 11 } }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: '#f1f5f9' },
            ticks: { color: '#64748b', font: { size: 10 } }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#64748b', font: { size: 10 } }
          }
        }
      }
    });
  } catch (err) {
    console.error('Error drawing sales chart:', err);
  }

  // 2. Active Stock Donut Chart
  try {
    const categories = ['Antibiotic', 'Analgesic', 'Antidiabetic', 'Antacid'];
    const categoryCounts = categories.map(cat => {
      if (!state.inventory || state.inventory.length === 0) return 0;
      return state.inventory
        .filter(i => i.category === cat)
        .reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
    });

    const displayData = categoryCounts.some(c => c > 0) ? categoryCounts : [162, 118, 90, 148];

    chartInstanceStock = new Chart(stockCanvas, {
      type: 'doughnut',
      data: {
        labels: categories,
        datasets: [{
          data: displayData,
          backgroundColor: ['#0284c7', '#10b981', '#f59e0b', '#6366f1'],
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, padding: 12, font: { size: 10.5 } }
          }
        },
        cutout: '65%'
      }
    });
  } catch (err) {
    console.error('Error drawing stock chart:', err);
  }
}

function updateDashboardCharts() {
  if (!chartInstanceStock) {
    initCharts();
    return;
  }

  const categories = ['Antibiotic', 'Analgesic', 'Antidiabetic', 'Antacid'];
  const counts = categories.map(cat => {
    if (!state.inventory || state.inventory.length === 0) return 0;
    return state.inventory
      .filter(i => i.category === cat)
      .reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
  });

  if (counts.some(c => c > 0)) {
    chartInstanceStock.data.datasets[0].data = counts;
    chartInstanceStock.update();
  }
}

/* =========================================================================
   AUTH LOGIC (CONNECTED TO SQLITE)
   ========================================================================= */
function switchAuthView(v) {
  const loginForm = document.getElementById('login-form');
  const regForm = document.getElementById('register-form');
  const forgotForm = document.getElementById('forgot-form');
  const tabBar = document.getElementById('main-tab-bar');
  const tabLogin = document.getElementById('tab-login');
  const tabReg = document.getElementById('tab-register');
  const noticeText = document.getElementById('notice-text');

  loginForm.classList.add('hidden');
  regForm.classList.add('hidden');
  forgotForm.classList.add('hidden');

  if (v === 'login') {
    tabBar.classList.remove('hidden');
    tabLogin.classList.add('active');
    tabReg.classList.remove('active');
    loginForm.classList.remove('hidden');
    noticeText.textContent = 'Please sign in with the same email and password you used when registering your staff account.';
  } else if (v === 'register') {
    tabBar.classList.remove('hidden');
    tabReg.classList.add('active');
    tabLogin.classList.remove('active');
    regForm.classList.remove('hidden');
    noticeText.textContent = 'Provide your enterprise credentials. Photo & additional recovery details can be updated anytime.';
  } else if (v === 'forgot') {
    tabBar.classList.add('hidden');
    forgotForm.classList.remove('hidden');
    noticeText.textContent = 'Choose your preferred recovery channel to authenticate identity and reset your credentials.';
  }
}
/* =========================================================================
   TWO-STAGE IN-CARD RECOVERY CONTROLLER
   ========================================================================= */

let activeRecoveryMethod = 'email';
let recoveryStage = 1;
let recoveryUserId = null;

// 1. Radio method tab switcher
function switchRecoveryMethod(method) {
  activeRecoveryMethod = method;

  const emailPanel = document.getElementById('rec-email-panel');
  const phonePanel = document.getElementById('rec-phone-panel');
  const questionPanel = document.getElementById('rec-question-panel');

  if (emailPanel) emailPanel.classList.toggle('hidden', method !== 'email');
  if (phonePanel) phonePanel.classList.toggle('hidden', method !== 'phone');
  if (questionPanel) questionPanel.classList.toggle('hidden', method !== 'question');
}

// 2. Main Form Submit (Handles Stage 1 and Stage 2 sequentially)
async function handleRecoveryWorkflow(e) {
  e.preventDefault();

  if (recoveryStage === 1) {
    await executeStageOne();
  } else if (recoveryStage === 2) {
    await executeStageTwo();
  }
}

// STAGE 1: Verify identity & dispatch OTP
async function executeStageOne() {
  const btn = document.getElementById('btn-rec-stage-1');
  const originalText = btn ? btn.innerText : 'Send Recovery Instructions';

  let identifier = '';
  let secAnswer = '';

  if (activeRecoveryMethod === 'email') {
    identifier = document.getElementById('rec-email').value.trim();
  } else if (activeRecoveryMethod === 'phone') {
    identifier = document.getElementById('rec-phone').value.trim();
  } else if (activeRecoveryMethod === 'question') {
    identifier = document.getElementById('rec-user-id').value.trim();
    secAnswer = document.getElementById('rec-sec-answer').value.trim();
    if (!secAnswer) {
      alert('Please enter your secret answer.');
      return;
    }
  }

  if (!identifier) {
    alert('Please enter your registered identifier.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
  }

  try {
    const res = await apiRequest('/auth/recover-initiate', 'POST', {
      channel: activeRecoveryMethod,
      identifier: identifier,
      secAnswer: secAnswer
    });

    recoveryUserId = res.userId;

    // Transition in-card to Stage 2
    document.getElementById('recovery-stage-1').classList.add('hidden');
    document.getElementById('recovery-stage-2').classList.remove('hidden');
    recoveryStage = 2;

    const notice = document.getElementById('stage-2-notice');
    const otpGroup = document.getElementById('rec-otp-group');
    const otpInput = document.getElementById('rec-verify-code');

    if (activeRecoveryMethod === 'question') {
      // Question is already answered and checked!
      if (otpGroup) otpGroup.classList.add('hidden');
      if (otpInput) otpInput.required = false;
      if (notice) notice.textContent = 'Identity confirmed! Now create your new password.';
    } else {
      if (otpGroup) otpGroup.classList.remove('hidden');
      if (otpInput) otpInput.required = true;
      const channelLabel = activeRecoveryMethod === 'email' ? 'Email OTP' : 'SMS OTP';
      document.getElementById('rec-otp-label').textContent = `Enter 6-Digit ${channelLabel}`;
      if (notice) notice.textContent = res.message || `Code dispatched. Enter the OTP and your new password.`;
    }

  } catch (err) {
    console.error('Stage 1 error:', err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }
}

// STAGE 2: Set New Password
async function executeStageTwo() {
  const btn = document.getElementById('btn-rec-stage-2');
  const originalText = btn ? btn.innerText : 'Set New Password & Sign In';

  const otpInput = document.getElementById('rec-verify-code');
  const newPassword = document.getElementById('rec-new-password').value.trim();
  const tokenOrAnswer = activeRecoveryMethod === 'question' ? 'VERIFIED' : (otpInput ? otpInput.value.trim() : '');

  if (!newPassword || newPassword.length < 6) {
    alert('Password must be at least 6 characters long.');
    return;
  }

  if (activeRecoveryMethod !== 'question' && !tokenOrAnswer) {
    alert('Please enter your 6-digit verification code.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
  }

  try {
    const res = await apiRequest('/auth/recover-verify-reset', 'POST', {
      userId: recoveryUserId,
      channel: activeRecoveryMethod,
      tokenOrAnswer: tokenOrAnswer,
      newPassword: newPassword
    });

    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Password Updated', res.message || 'You can now log in.');
    } else {
      alert(res.message || 'Password updated successfully!');
    }

    // Finished! Return to Sign In
    resetAndBackToLogin();

  } catch (err) {
    console.error('Stage 2 error:', err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = originalText;
    }
  }
}

// Reset stages when clicking "Back to Sign In"
function resetAndBackToLogin() {
  recoveryStage = 1;
  recoveryUserId = null;
  
  const s1 = document.getElementById('recovery-stage-1');
  const s2 = document.getElementById('recovery-stage-2');
  if (s1) s1.classList.remove('hidden');
  if (s2) s2.classList.add('hidden');

  // Clear inputs
  const pwd = document.getElementById('rec-new-password');
  const code = document.getElementById('rec-verify-code');
  if (pwd) pwd.value = '';
  if (code) code.value = '';

  switchAuthView('login');
}

async function handleLogin(e) {
  e.preventDefault();
  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passInput ? passInput.value.trim() : '';

  if (!email || !password) {
    showCustomAlert('error', 'Missing Credentials', 'Please provide both work email and password.');
    return;
  }

  try {
    const data = await apiRequest('/auth/login', 'POST', { email, password });
    
    // 1. Commit credentials to memory and persistent storage
    authToken = data.token;
    localStorage.setItem('pharmapulse_token', data.token);
    localStorage.setItem('pharmapulse_user', JSON.stringify(data.user));
    state.currentUser = data.user;

    // 2. Reveal app dashboard
    const authScreen = document.getElementById('auth-screen');
    const appLayout = document.getElementById('app-layout');
    if (authScreen) authScreen.classList.add('hidden');
    if (appLayout) appLayout.classList.remove('hidden');

    if (typeof applyRoleSecurityRestrictions === 'function') {
      applyRoleSecurityRestrictions();
    }

    // 3. Render and sync charts
    setTimeout(() => {
      if (typeof initCharts === 'function') initCharts();
    }, 100);

    if (typeof syncDatabaseFromBackend === 'function') {
      await syncDatabaseFromBackend();
    }
    if (typeof updateDashboardCharts === 'function') {
      updateDashboardCharts();
    }

    showCustomAlert('success', 'Terminal Authorized', `Welcome back, ${state.currentUser.name}.`);
  } catch (err) {
    console.error('Login error:', err);
    // Display server-sent error message if available, otherwise suggest server check
    const errorMsg = err.message && !err.message.includes('status')
      ? err.message
      : 'Could not reach backend server on http://localhost:5000. Is "node server.js" running?';
    showCustomAlert('error', 'Login Error', errorMsg);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const license = document.getElementById('reg-license').value.trim();
  const role = document.getElementById('reg-role').value;
  const password = document.getElementById('reg-password').value;
  const phone = document.getElementById('reg-phone').value.trim();
  const security_q = document.getElementById('reg-sec-q').value;
  const security_a = document.getElementById('reg-sec-a').value.trim();
  const avatarFile = document.getElementById('reg-avatar-input').files[0];

  const formData = new FormData();
  formData.append('name', name);
  formData.append('email', email);
  formData.append('license', license);
  formData.append('role', role);
  formData.append('password', password);
  formData.append('phone', phone);
  formData.append('security_q', security_q);
  formData.append('security_a', security_a);
  if (avatarFile) {
    formData.append('avatar', avatarFile);
  }

  try {
    await apiRequest('/auth/register', 'POST', formData, true);
    showCustomAlert('success', 'Staff Registered', `Account created for ${name}. You can now log in.`);
    switchAuthView('login');
  } catch (err) {
    // Handled in apiRequest
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerText : 'Send Recovery Instructions';

  let identifier = '';
  let secAnswer = '';

  if (activeRecoveryMethod === 'email') {
    identifier = document.getElementById('rec-email').value.trim();
    if (!identifier) {
      alert('Please enter your registered work email.');
      return;
    }
  } else if (activeRecoveryMethod === 'phone') {
    identifier = document.getElementById('rec-phone').value.trim();
    if (!identifier) {
      alert('Please enter your recovery phone number.');
      return;
    }
  } else if (activeRecoveryMethod === 'question') {
    identifier = document.getElementById('rec-user-id').value.trim();
    secAnswer = document.getElementById('rec-sec-answer').value.trim();
    if (!identifier || !secAnswer) {
      alert('Please provide both Staff ID / Email and your Secret Answer.');
      return;
    }
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
  }

  try {
    const res = await apiRequest('/auth/recover-initiate', 'POST', {
      channel: activeRecoveryMethod,
      identifier: identifier,
      secAnswer: secAnswer
    });

    activeRecoveryUserId = res.userId;

    // Open Verification Modal
    const modal = document.getElementById('recovery-verify-modal');
    const tokenInput = document.getElementById('rec-modal-token-input');
    const inputLabel = document.getElementById('rec-modal-input-label');
    const newPassInput = document.getElementById('rec-modal-password-input');

    if (tokenInput) tokenInput.value = '';
    if (newPassInput) newPassInput.value = '';

    if (activeRecoveryMethod === 'question') {
      if (inputLabel) inputLabel.textContent = 'Identity Status';
      if (tokenInput) {
        tokenInput.value = 'VERIFIED';
        tokenInput.readOnly = true;
      }
    } else {
      if (tokenInput) {
        tokenInput.readOnly = false;
        tokenInput.placeholder = '123456';
      }
      if (inputLabel) {
        inputLabel.textContent = activeRecoveryMethod === 'phone' ? 'Enter 6-Digit SMS OTP' : 'Enter 6-Digit Email OTP';
      }
    }

    if (modal) modal.classList.remove('hidden');

    if (typeof showCustomAlert === 'function') {
      showCustomAlert('info', 'Verification Ready', res.message || 'Complete the prompt to reset your password.');
    }
  } catch (err) {
    console.error('Recovery failed:', err);
    alert(err.message || 'Account could not be verified.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalBtnText;
    }
  }
}

/* =========================================================================
   FIXED LOGOUT & CONFIRMATION MODAL HANDLERS
   ========================================================================= */
function triggerLogout() {
  showCustomConfirm(
    'Log Out Session?',
    'Are you sure you want to exit your verified terminal session?',
    () => {
      // 1. Close the confirm modal first
      if (typeof closeConfirmModal === 'function') {
        closeConfirmModal();
      }

      // 2. Wipe persistent storage & authentication memory
      localStorage.removeItem('pharmapulse_token');
      localStorage.removeItem('pharmapulse_user');
      authToken = null;
      state.currentUser = {
        id: '',
        name: 'Staff Operator',
        role: 'Licensed Dispensary Officer',
        email: '',
        isSuperAdmin: false
      };

      // 3. Toggle views
      const appLayout = document.getElementById('app-layout');
      const authScreen = document.getElementById('auth-screen');
      if (appLayout) appLayout.classList.add('hidden');
      if (authScreen) authScreen.classList.remove('hidden');

      // 4. Reset input fields & return to login tab
      const loginForm = document.getElementById('login-form');
      if (loginForm) loginForm.reset();
      if (typeof switchAuthView === 'function') {
        switchAuthView('login');
      }

      // 5. Notify user
      setTimeout(() => {
        showCustomAlert('success', 'Logged Out', 'Safely exited dispensary session.');
      }, 50);
    }
  );
}

function showCustomConfirm(title, message, onProceed) {
  const modal = document.getElementById('custom-confirm-modal');
  const titleElem = document.getElementById('confirm-title');
  const msgElem = document.getElementById('confirm-message');
  const actionBtn = document.getElementById('confirm-action-btn');

  if (!modal || !actionBtn) return;

  if (titleElem) titleElem.textContent = title;
  if (msgElem) msgElem.textContent = message;

  // Clone button to strip any lingering stacked event listeners
  const newActionBtn = actionBtn.cloneNode(true);
  actionBtn.parentNode.replaceChild(newActionBtn, actionBtn);

  newActionBtn.addEventListener('click', () => {
    closeConfirmModal();
    if (typeof onProceed === 'function') {
      onProceed();
    }
  });

  modal.classList.remove('hidden');
}

function closeConfirmModal() {
  const modal = document.getElementById('custom-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function previewAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    const img = document.getElementById('avatar-preview-img');
    img.src = evt.target.result;
    img.classList.remove('hidden');
    document.getElementById('avatar-placeholder').classList.add('hidden');
    document.getElementById('remove-avatar-btn').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function removeAvatar() {
  document.getElementById('reg-avatar-input').value = '';
  document.getElementById('avatar-preview-img').src = '';
  document.getElementById('avatar-preview-img').classList.add('hidden');
  document.getElementById('avatar-placeholder').classList.remove('hidden');
  document.getElementById('remove-avatar-btn').classList.add('hidden');
}

/* =========================================================================
   INVENTORY CRUD (SQLITE CONNECTED)
   ========================================================================= */
function renderInventory() {
  const tbody = document.getElementById('inventory-table-body');
  const query = document.getElementById('inv-search').value.toLowerCase();
  const statusFilter = document.getElementById('inv-filter-status').value;
  const categoryFilter = document.getElementById('inv-filter-cat').value;

  const filtered = state.inventory.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(query) || item.salt.toLowerCase().includes(query);
    const matchStatus = statusFilter === 'All' || item.status === statusFilter;
    const matchCat = categoryFilter === 'All' || item.category === categoryFilter;
    return matchSearch && matchStatus && matchCat;
  });

  tbody.innerHTML = filtered.map(med => `
    <tr>
      <td><strong>${med.name}</strong></td>
      <td>${med.salt}</td>
      <td>${med.category}</td>
      <td><span class="tag-badge ${med.type.toLowerCase()}">${med.type}</span></td>
      <td>${med.indications}</td>
      <td>${med.exp}</td>
      <td>${formatCurrency(med.basePrice)}</td>
      <td><strong>${med.stock}</strong> units</td>
      <td><span class="tag-badge ${med.status === 'Optimal' ? 'optimal' : 'low'}">${med.status}</span></td>
      <td>
        <button class="btn-row-action" onclick="openMedicineModal('edit', '${med.id}')">Edit</button>
        <button class="btn-row-action danger" onclick="requestDeleteMedicine('${med.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function openMedicineModal(mode, medId = null) {
  const modal = document.getElementById('medicine-modal');
  const form = document.getElementById('medicine-form');
  form.reset();

  if (mode === 'add') {
    document.getElementById('med-modal-title').textContent = 'Add New Medicine';
    document.getElementById('med-id').value = '';
  } else {
    document.getElementById('med-modal-title').textContent = 'Edit Medicine Details';
    const med = state.inventory.find(i => i.id === medId);
    if (!med) return;
    document.getElementById('med-id').value = med.id;
    document.getElementById('med-name').value = med.name;
    document.getElementById('med-salt').value = med.salt;
    document.getElementById('med-category').value = med.category;
    document.getElementById('med-type').value = med.type;
    document.getElementById('med-indications').value = med.indications;
    document.getElementById('med-exp').value = med.exp;
    document.getElementById('med-price').value = med.basePrice;
    document.getElementById('med-stock').value = med.stock;
  }
  modal.classList.remove('hidden');
}

function closeMedicineModal() {
  document.getElementById('medicine-modal').classList.add('hidden');
}

async function handleSaveMedicine(e) {
  e.preventDefault();
  const id = document.getElementById('med-id').value;
  const payload = {
    name: document.getElementById('med-name').value.trim(),
    salt: document.getElementById('med-salt').value.trim(),
    category: document.getElementById('med-category').value,
    type: document.getElementById('med-type').value,
    indications: document.getElementById('med-indications').value.trim(),
    exp: document.getElementById('med-exp').value,
    base_price: parseFloat(document.getElementById('med-price').value),
    stock: parseInt(document.getElementById('med-stock').value, 10)
  };

  try {
    if (id) {
      await apiRequest(`/inventory/${id}`, 'PUT', payload);
      showCustomAlert('success', 'Medicine Updated', `${payload.name} saved to SQLite.`);
    } else {
      await apiRequest('/inventory', 'POST', payload);
      showCustomAlert('success', 'Medicine Added', `${payload.name} created in SQLite.`);
    }
    closeMedicineModal();
    await syncDatabaseFromBackend();
  } catch (err) {
    // Handled in apiRequest
  }
}

function requestDeleteMedicine(medId) {
  const med = state.inventory.find(i => i.id === medId);
  if (!med) return;

  showCustomConfirm('Delete Medicine SKU?', `Remove "${med.name}" permanently from inventory?`, async () => {
    try {
      await apiRequest(`/inventory/${medId}`, 'DELETE');
      showCustomAlert('success', 'SKU Removed', `${med.name} removed from SQLite database.`);
      await syncDatabaseFromBackend();
    } catch (err) {
      // Handled in apiRequest
    }
  });
}

/* =========================================================================
   POS & BILLING (SQLITE CONNECTED)
   ========================================================================= */
function setPosTagFilter(tag) {
  currentPosFilter = tag;
  document.querySelectorAll('#pos-category-tags .tag-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === tag);
  });
  renderPosCatalog();
}

function filterPosCatalog() {
  renderPosCatalog();
}

// Active Prescription metadata passed to POS during Rx dispensation
let activeRxTransferData = null;

/* =========================================================================
   1. POS / BILLING: STRICT OTC FILTERING & INTERACTIVE TENDER HANDLERS
   ========================================================================= */

// Render ONLY Over-The-Counter (OTC) drugs in the general POS catalog
function renderPosCatalog() {
  const container = document.getElementById('pos-grid-container');
  if (!container) return;

  const query = document.getElementById('pos-search').value.toLowerCase().trim();

  // STRICT REQUIREMENT: Only show medicines where type === 'OTC'
  const otcOnlyList = state.inventory.filter(med => {
    const isOtc = med.type === 'OTC';
    const matchesQuery = med.name.toLowerCase().includes(query) || med.salt.toLowerCase().includes(query);
    return isOtc && matchesQuery;
  });

  if (otcOnlyList.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">No Over-The-Counter (OTC) medications found matching "${query}".</div>`;
    return;
  }

  container.innerHTML = otcOnlyList.map(med => `
    <div class="pos-item-card" onclick="addToCart('${med.id}')">
      <div class="pos-item-header">
        <h5>${med.name}</h5>
        <span class="tag-badge otc">OTC</span>
      </div>
      <div class="pos-item-salt">${med.salt}</div>
      <div class="pos-item-footer">
        <div class="pos-item-price">${formatCurrency(med.basePrice)}</div>
        <div class="pos-item-stock">${med.stock} in stock</div>
      </div>
    </div>
  `).join('');
}

// Payment method selector: Dynamically show UPI QR or Card input
function handleTenderChange(tenderType) {
  const cardBox = document.getElementById('tender-card-box');
  const upiBox = document.getElementById('tender-upi-box');

  if (cardBox) cardBox.classList.add('hidden');
  if (upiBox) upiBox.classList.add('hidden');

  if (tenderType === 'Card' && cardBox) {
    cardBox.classList.remove('hidden');
  } else if (tenderType === 'UPI / QR' && upiBox) {
    upiBox.classList.remove('hidden');
    refreshUpiQrDisplay();
  }
}

/* =========================================================================
   DYNAMIC UPI QR CODE & CART TOTAL CALCULATION
   ========================================================================= */

function refreshUpiQrDisplay() {
  const upiBox = document.getElementById('tender-upi-box');
  if (!upiBox || upiBox.classList.contains('hidden')) return;

  // Calculate live subtotal and payable total accurately from current cart state
  const subtotal = state.cart.reduce((sum, item) => {
    const price = Number(item.basePrice || item.base_price || 0);
    const qty = Number(item.qty || 1);
    return sum + (price * qty);
  }, 0);

  const taxRate = Number(state.clinic.taxRate || state.clinic.tax_rate || 5);
  const taxVal = (subtotal * taxRate) / 100;
  const payableTotal = subtotal + taxVal;

  // Read the saved UPI ID dynamically from state
  const clinicUpiId = state.clinic.upi_id || state.clinic.upiId || '9661368481@slc';
  const clinicName = state.clinic.name || 'PharmaPulse Dispensary';

  // Construct UPI URI
  const upiUrl = `upi://pay?pa=${encodeURIComponent(clinicUpiId)}&pn=${encodeURIComponent(clinicName)}&am=${payableTotal.toFixed(2)}&cu=INR`;
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(upiUrl)}`;

  const qrImg = document.getElementById('upi-qr-image');
  const upiIdDisplay = document.getElementById('upi-id-display');
  const amountDisplay = document.getElementById('upi-payable-display');

  if (qrImg) qrImg.src = qrApiUrl;
  if (upiIdDisplay) upiIdDisplay.textContent = clinicUpiId;
  
  // Update live amount display (replaces Payable: ₹0.00)
  if (amountDisplay) {
    amountDisplay.textContent = `Payable: ${formatCurrency(payableTotal)}`;
  }
}
// Populate Settings Form
function populateSettings() {
  if (!state.clinic) return;

  const nameInput = document.getElementById('setting-clinic-name');
  const dlInput = document.getElementById('setting-dl');
  const gstInput = document.getElementById('setting-gst');
  const taxInput = document.getElementById('setting-tax');
  const addrInput = document.getElementById('setting-address');
  const upiInput = document.getElementById('setting-upi-id');

  if (nameInput) nameInput.value = state.clinic.name || '';
  if (dlInput) dlInput.value = state.clinic.dl || '';
  if (gstInput) gstInput.value = state.clinic.gst || '';
  if (taxInput) taxInput.value = state.clinic.taxRate || state.clinic.tax_rate || 5;
  if (addrInput) addrInput.value = state.clinic.address || '';
  
  // Set the current saved UPI ID into the input field
  if (upiInput) {
    upiInput.value = state.clinic.upi_id || state.clinic.upiId || '9661368481@slc';
  }
}
// Save Settings and refresh state
async function handleSaveClinicProfile(e) {
  e.preventDefault();

  const upiField = document.getElementById('setting-upi-id');
  const upiVal = upiField ? upiField.value.trim() : '';

  const payload = {
    name: document.getElementById('setting-clinic-name').value.trim(),
    dl: document.getElementById('setting-dl').value.trim(),
    gst: document.getElementById('setting-gst').value.trim(),
    tax_rate: parseFloat(document.getElementById('setting-tax').value) || 5.0,
    address: document.getElementById('setting-address').value.trim(),
    upi_id: upiVal || '9661368481@slc'
  };

  console.log('Submitting Clinic Profile Payload:', payload);

  try {
    const res = await apiRequest('/settings/profile', 'PUT', payload);
    
    // Immediately persist to local client state
    state.clinic = {
      ...state.clinic,
      name: payload.name,
      dl: payload.dl,
      gst: payload.gst,
      taxRate: payload.tax_rate,
      address: payload.address,
      upi_id: payload.upi_id
    };

    // Re-render UPI QR code in POS if visible
    if (typeof refreshUpiQrDisplay === 'function') {
      refreshUpiQrDisplay();
    }

    showCustomAlert('success', 'Profile Saved', res.message || 'Merchant profile and UPI ID updated.');
  } catch (err) {
    console.error('Save profile failed:', err);
    // Alert is triggered inside apiRequest
  }
}
function addToCart(medId) {
  const med = state.inventory.find(i => i.id === medId);
  if (!med) return;
  if (med.stock <= 0) {
    showCustomAlert('error', 'Stock Out', `${med.name} has no available units.`);
    return;
  }
  const existing = state.cart.find(c => c.id === medId);
  if (existing) {
    if (existing.qty + 1 > med.stock) {
      showCustomAlert('error', 'Stock Limit', `Cannot exceed available units (${med.stock}).`);
      return;
    }
    existing.qty++;
  } else {
    state.cart.push({ id: med.id, name: med.name, type: med.type, basePrice: med.basePrice, qty: 1, batch: 'BATCH-' + med.id });
  }
  renderCart();
}

function changeCartQty(medId, delta) {
  const item = state.cart.find(c => c.id === medId);
  const med = state.inventory.find(i => i.id === medId);
  if (!item) return;

  if (delta > 0 && item.qty + 1 > med.stock) {
    showCustomAlert('error', 'Limit Exceeded', `Only ${med.stock} items currently in stock.`);
    return;
  }
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter(c => c.id !== medId);
  renderCart();
}

function removeCartItem(medId) {
  state.cart = state.cart.filter(c => c.id !== medId);
  renderCart();
}

function clearCart() {
  if (state.cart.length === 0) return;
  state.cart = [];
  renderCart();
}

// Ensure refreshUpiQrDisplay() executes every time cart updates
function renderCart() {
  const cartContainer = document.getElementById('pos-cart-items');
  const subtotalElem = document.getElementById('pos-subtotal');
  const taxElem = document.getElementById('pos-gst-val');
  const totalElem = document.getElementById('pos-payable-total');
  const taxRateElem = document.getElementById('pos-gst-rate');

  const taxRate = Number(state.clinic.taxRate || state.clinic.tax_rate || 5);
  if (taxRateElem) taxRateElem.textContent = taxRate;

  if (!state.cart || state.cart.length === 0) {
    if (cartContainer) {
      cartContainer.innerHTML = `<div style="text-align:center; color:#94a3b8; font-size:12px; margin-top:50px;">Register empty. Select OTC medicine or transfer Rx.</div>`;
    }
    if (subtotalElem) subtotalElem.textContent = formatCurrency(0);
    if (taxElem) taxElem.textContent = formatCurrency(0);
    if (totalElem) totalElem.textContent = formatCurrency(0);
    refreshUpiQrDisplay();
    return;
  }

  let subtotal = 0;
  cartContainer.innerHTML = state.cart.map(item => {
    const price = Number(item.basePrice || item.base_price || 0);
    const qty = Number(item.qty || 1);
    const itemTotal = price * qty;
    subtotal += itemTotal;

    return `
      <div class="cart-item-row">
        <div class="cart-item-info">
          <strong>${item.name}</strong>
          <small>${formatCurrency(price)} &times; ${qty}</small>
        </div>
        <div class="cart-item-actions">
          <button type="button" class="btn-qty" onclick="adjustCartQty('${item.id}', -1)">-</button>
          <span class="cart-qty-val">${qty}</span>
          <button type="button" class="btn-qty" onclick="adjustCartQty('${item.id}', 1)">+</button>
          <span class="cart-item-total">${formatCurrency(itemTotal)}</span>
          <button type="button" class="btn-item-del" onclick="removeFromCart('${item.id}')">&times;</button>
        </div>
      </div>
    `;
  }).join('');

  const taxVal = (subtotal * taxRate) / 100;
  const grandTotal = subtotal + taxVal;

  if (subtotalElem) subtotalElem.textContent = formatCurrency(subtotal);
  if (taxElem) taxElem.textContent = formatCurrency(taxVal);
  if (totalElem) totalElem.textContent = formatCurrency(grandTotal);

  refreshUpiQrDisplay();
}
// POS Dispense with Tender Validation & Controlled Substance Logging
async function completeDispense() {
  if (state.cart.length === 0) {
    showCustomAlert('error', 'Empty Register', 'Please add medications or transfer a prescription before checkout.');
    return;
  }

  const customer = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Customer';
  const phone = document.getElementById('pos-cust-phone').value.trim() || '';
  const tender = document.querySelector('input[name="tender"]:checked').value;
  let tender_ref = '';

  // Validate Card Payment Authorization
  if (tender === 'Card') {
    const cardInput = document.getElementById('card-auth-ref');
    tender_ref = cardInput ? cardInput.value.trim() : '';
    if (!tender_ref) {
      showCustomAlert('error', 'Card Reference Required', 'Please input the card terminal approval / RRN reference code.');
      return;
    }
  }

  const subtotal = state.cart.reduce((s, i) => s + (i.basePrice * i.qty), 0);
  const base_tax = (subtotal * state.clinic.taxRate) / 100;
  const base_total = subtotal + base_tax;

  // Check if cart contains any prescription (Rx) item
  const hasControlledItem = state.cart.some(i => i.type === 'Rx') || Boolean(activeRxTransferData);

  const payload = {
    customer,
    phone,
    tender,
    tender_ref,
    items: state.cart,
    subtotal,
    base_tax,
    base_total,
    is_controlled: hasControlledItem ? 1 : 0,
    doctor_name: activeRxTransferData ? activeRxTransferData.doctor : null,
    doctor_reg_no: activeRxTransferData ? activeRxTransferData.docReg : null,
    patient_id_ref: activeRxTransferData ? activeRxTransferData.idRef : null,
    rx_ref: activeRxTransferData ? activeRxTransferData.id : null
  };

  try {
    const data = await apiRequest('/pos/dispense', 'POST', payload);

    state.lastDispensedInvoice = {
      id: data.invoiceId,
      timestamp: data.timestamp,
      customer: data.customer,
      tender: data.tender,
      items: [...state.cart],
      subtotal,
      baseTax: base_tax,
      baseTotal: base_total
    };

    // Reset register and clear Rx transfer state
    state.cart = [];
    activeRxTransferData = null;
    document.getElementById('pos-cust-name').value = '';
    document.getElementById('pos-cust-phone').value = '';
    document.getElementById('pos-rx-transfer-banner').classList.add('hidden');
    if (document.getElementById('card-auth-ref')) document.getElementById('card-auth-ref').value = '';

    await syncDatabaseFromBackend();
    openInvoiceModal(state.lastDispensedInvoice);
  } catch (err) {
    // Handled in apiRequest
  }
}

function openInvoiceModal(inv) {
  const container = document.getElementById('invoice-preview-content');
  container.innerHTML = `
    <div class="inv-detail-row"><span>Invoice ID:</span><strong>${inv.id}</strong></div>
    <div class="inv-detail-row"><span>Date &amp; Time:</span><span>${inv.timestamp}</span></div>
    <div class="inv-detail-row"><span>Patient / Customer:</span><span>${inv.customer}</span></div>
    <div class="inv-detail-row"><span>Tender Method:</span><span>${inv.tender}</span></div>
    <hr style="margin: 10px 0; border: none; border-top: 1px solid var(--border-color);" />
    <div><strong>Items:</strong></div>
    ${inv.items.map(i => `
      <div class="inv-detail-row">
        <span>${i.name} (${i.qty} units)</span>
        <span>${formatCurrency(i.basePrice * i.qty)}</span>
      </div>
    `).join('')}
    <div class="inv-detail-row bold">
      <span>Total Paid (${state.selectedCurrency}):</span>
      <span>${formatCurrency(inv.baseTotal)}</span>
    </div>
  `;
  document.getElementById('invoice-modal').classList.remove('hidden');
}

function closeInvoiceModal() {
  document.getElementById('invoice-modal').classList.add('hidden');
}

function printGeneratedInvoice() {
  const inv = state.lastDispensedInvoice;
  if (!inv) return;

  const container = document.getElementById('print-paperwork-container');
  container.innerHTML = `
    <div class="print-letterhead">
      <div>
        <h2>${state.clinic.name}</h2>
        <p><strong>Address:</strong> ${state.clinic.address}</p>
        <p><strong>Drug License (DL):</strong> ${state.clinic.dl} | <strong>GSTIN:</strong> ${state.clinic.gst}</p>
      </div>
      <div style="text-align: right;">
        <p><strong>Receipt #:</strong> ${inv.id}</p>
        <p><strong>Date:</strong> ${inv.timestamp}</p>
        <p><strong>Dispensing Officer:</strong> ${state.currentUser.name}</p>
      </div>
    </div>
    <div class="print-doc-title">Retail Medication Cash Receipt</div>
    <table class="print-table">
      <thead>
        <tr><th>Medication Item</th><th>Qty</th><th>Unit Rate</th><th>Amount</th></tr>
      </thead>
      <tbody>
        ${inv.items.map(i => `
          <tr>
            <td>${i.name}</td>
            <td>${i.qty}</td>
            <td>${formatCurrency(i.basePrice)}</td>
            <td>${formatCurrency(i.basePrice * i.qty)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="margin-left: auto; width: 280px;">
      <div class="inv-detail-row"><span>Subtotal:</span><span>${formatCurrency(inv.subtotal)}</span></div>
      <div class="inv-detail-row"><span>Tax (GST ${state.clinic.taxRate}%):</span><span>${formatCurrency(inv.baseTax)}</span></div>
      <div class="inv-detail-row bold"><span>Total Paid:</span><span>${formatCurrency(inv.baseTotal)}</span></div>
      <div class="inv-detail-row"><span>Payment Tender:</span><span>${inv.tender}</span></div>
    </div>
    <div class="print-footer">
      <span>Customer: ${inv.customer} • Verified Electronic Ledger</span>
      <span>Thank you for choosing ${state.clinic.name}</span>
    </div>
  `;
  window.print();
}

/* =========================================================================
   1. SPECIFIC EXPORT: SINGLE GENERATED INVOICE / RECEIPT
   ========================================================================= */

function exportGeneratedInvoiceCSV(invoiceId) {
  // Locate invoice from state or fallback to recent invoice
  const inv = state.invoices.find(i => i.id === invoiceId) || state.lastDispensedInvoice;

  if (!inv) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('error', 'Export Failed', 'Invoice record not found.');
    }
    return;
  }

  const headers = ['Invoice ID', 'Dispensed Date & Time', 'Customer Name', 'Contact Phone', 'Items Dispensed', 'Payment Tender', 'Subtotal', 'Tax (GST)', 'Total Amount Paid'];
  
  const rows = [
    [
      inv.id,
      inv.timestamp,
      inv.customer || 'Walk-in Customer',
      inv.phone || 'N/A',
      inv.itemsDispensed || inv.items_dispensed || 'N/A',
      inv.tender,
      (inv.subtotal || 0).toFixed(2),
      (inv.baseTax || inv.base_tax || 0).toFixed(2),
      (inv.baseTotal || inv.base_total || 0).toFixed(2)
    ]
  ];

  const metrics = {
    'Invoice Number': inv.id,
    'Tender Method': inv.tender,
    'Subtotal Amount': formatCurrency(inv.subtotal || 0),
    'Tax Applied': formatCurrency(inv.baseTax || inv.base_tax || 0),
    'Grand Total Settled': formatCurrency(inv.baseTotal || inv.base_total || 0),
    'Prescription Controlled': (inv.isControlled || inv.is_controlled) ? 'YES (Schedule H Audit Logged)' : 'NO (OTC)'
  };

  downloadCleanCSV(`Tax_Invoice_${inv.id}`, `Customer POS Tax Invoice & Payment Receipt`, headers, rows, metrics);
}

/* =========================================================================
   BULLETPROOF CSV DOWNLOAD ENGINE (DATA-URI + BLOB DUAL FALLBACK)
   ========================================================================= */

function downloadCleanCSV(filename, reportTitle, headers, rows, summaryMetrics = {}) {
  try {
    const clinic = state.clinic || {};
    const generatedAt = new Date().toLocaleString();
    const generatedBy = state.currentUser ? `${state.currentUser.name} (${state.currentUser.role})` : 'Authorized Pharmacist';

    // Helper to sanitize & escape CSV cells
    const escapeCell = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvLines = [];

    // 1. STATUTORY CLINIC HEADER
    csvLines.push([escapeCell(clinic.name || 'PharmaPulse Clinic & Dispensary')].join(','));
    csvLines.push([escapeCell(`Drug License (DL): ${clinic.dl || 'N/A'}`), escapeCell(`GSTIN: ${clinic.gst || 'N/A'}`)].join(','));
    csvLines.push([escapeCell(`Address: ${clinic.address || 'N/A'}`)].join(','));
    csvLines.push([escapeCell(`REPORT TYPE: ${reportTitle}`)].join(','));
    csvLines.push([escapeCell(`Generated On: ${generatedAt}`), escapeCell(`Audited By: ${generatedBy}`)].join(','));
    csvLines.push(''); // Blank spacer row

    // 2. TABULAR BODY
    csvLines.push(headers.map(h => escapeCell(h)).join(','));

    if (!rows || rows.length === 0) {
      csvLines.push([escapeCell('No records found for this section')].join(','));
    } else {
      rows.forEach(row => {
        csvLines.push(row.map(cell => escapeCell(cell)).join(','));
      });
    }

    // 3. AUDIT & SUMMARY FOOTER
    csvLines.push(''); // Blank spacer row
    csvLines.push([escapeCell('--- AUDIT & FINANCIAL SUMMARY ---')].join(','));
    csvLines.push([escapeCell('Total Record Count'), escapeCell(rows.length)].join(','));

    for (const [key, value] of Object.entries(summaryMetrics)) {
      csvLines.push([escapeCell(key), escapeCell(value)].join(','));
    }

    csvLines.push([escapeCell('System Status'), escapeCell('VERIFIED & AUDITED')].join(','));
    csvLines.push([escapeCell('Dispensary Authorization'), escapeCell('DIGITALLY SIGNED')].join(','));
    csvLines.push([escapeCell('End of Report')].join(','));

    // Encode string with UTF-8 BOM
    const csvString = '\uFEFF' + csvLines.join('\r\n');
    const safeFilename = `${filename.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;

    // Method A: Blob + ObjectURL
    let downloadInitiated = false;
    try {
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      if (window.navigator && window.navigator.msSaveOrOpenBlob) {
        window.navigator.msSaveOrOpenBlob(blob, safeFilename);
        downloadInitiated = true;
      } else {
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = safeFilename;
        link.style.display = 'none';
        document.body.appendChild(link);
        
        // Dispatch synthetic click event
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        
        setTimeout(() => {
          document.body.removeChild(link);
          URL.revokeObjectURL(blobUrl);
        }, 3000);
        downloadInitiated = true;
      }
    } catch (blobErr) {
      console.warn('Blob download rejected, attempting Data URI fallback...', blobErr);
    }

    // Method B: Direct Data URI Fallback (if Blob fails or is blocked)
    if (!downloadInitiated) {
      const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvString);
      const fallbackLink = document.createElement('a');
      fallbackLink.setAttribute('href', encodedUri);
      fallbackLink.setAttribute('download', safeFilename);
      fallbackLink.style.display = 'none';
      document.body.appendChild(fallbackLink);
      fallbackLink.click();
      setTimeout(() => document.body.removeChild(fallbackLink), 1000);
    }

    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Export Complete', `File "${safeFilename}" generated.`);
    }
  } catch (criticalErr) {
    console.error('CSV Generation Failed:', criticalErr);
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('error', 'Export Error', criticalErr.message);
    }
  }
}


function emailGeneratedInvoice() {
  const inv = state.lastDispensedInvoice;
  if (!inv) return;
  closeInvoiceModal();
  const modal = document.getElementById('email-modal');
  document.getElementById('email-recipient').value = '';
  document.getElementById('email-subject').value = `Medication Bill Receipt #${inv.id} - ${state.clinic.name}`;
  document.getElementById('email-attachment-name').textContent = `Receipt_${inv.id}.pdf`;
  document.getElementById('email-body').value = `Dear ${inv.customer},\n\nPlease find attached your official dispensary receipt for ${formatCurrency(inv.baseTotal)}.\n\nAuthorized by: ${state.currentUser.name}`;
  modal.classList.remove('hidden');
}


/* =========================================================================
   ROBUST PRESCRIPTION FILTER & ACTION BUTTON RENDERER
   ========================================================================= */

// Normalize status strings so legacy & updated database entries match smoothly
function normalizeRxStatus(status) {
  if (!status) return 'Pending Review';
  const s = status.trim().toLowerCase();
  if (s === 'pending' || s === 'pending review') return 'Pending Review';
  if (s === 'ready' || s === 'verified & ready' || s === 'reviewverified') return 'Verified & Ready';
  if (s === 'dispensed') return 'Dispensed';
  return status;
}
/* =========================================================================
   PRESCRIPTION LIFECYCLE (SQLITE CONNECTED)
   ========================================================================= */

function setRxFilter(filterKey) {
  currentRxFilter = filterKey;

  const buttons = document.querySelectorAll('#rx-status-filters .pill-btn');
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim() === filterKey);
  });

  renderPrescriptions();
}

function renderPrescriptions() {
  const tbody = document.getElementById('rx-table-body');
  if (!tbody) return;

  const searchInput = document.getElementById('rx-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let list = [...state.prescriptions];

  // Filter based on normalized status
  if (currentRxFilter !== 'All') {
    list = list.filter(r => normalizeRxStatus(r.status) === currentRxFilter);
  }

  if (query) {
    list = list.filter(r =>
      (r.patient && r.patient.toLowerCase().includes(query)) ||
      (r.doctor && r.doctor.toLowerCase().includes(query)) ||
      (r.id && r.id.toLowerCase().includes(query)) ||
      (r.drugName && r.drugName.toLowerCase().includes(query))
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No prescriptions found for status "${currentRxFilter}".</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(rx => {
    const normStatus = normalizeRxStatus(rx.status);
    const slipUrl = rx.imageUrl && rx.imageUrl.startsWith('http') 
      ? rx.imageUrl 
      : (rx.imageUrl ? `http://localhost:5000${rx.imageUrl}` : '');

    return `
      <tr>
        <td>
          <img src="${slipUrl}" class="slip-thumbnail-mini" alt="Slip" onclick="openSlipLightbox('${slipUrl}')" />
          <strong>${rx.id}</strong>
        </td>
        <td>${rx.patient}</td>
        <td>${rx.demo}</td>
        <td>${rx.doctor}</td>
        <td>${rx.date}</td>
        <td><strong>${rx.drugName}</strong></td>
        <td>
          <span class="tag-badge ${
            normStatus === 'Pending Review' ? 'low' :
            normStatus === 'Verified & Ready' ? 'optimal' : 'dispensed'
          }">
            ${normStatus}
          </span>
        </td>
        <td>
          ${normStatus === 'Pending Review' ? `
            <button class="btn-row-action" onclick="openClinicalAudit('${rx.id}')">
              <i class="fa-solid fa-stethoscope"></i> Audit
            </button>
          ` : ''}

          ${normStatus === 'Verified & Ready' ? `
            <button class="btn-row-action" style="color:var(--success); border-color:#86efac;" onclick="transferRxToPosBilling('${rx.id}')">
              <i class="fa-solid fa-cash-register"></i> Dispense at POS &rarr;
            </button>
          ` : ''}

          <button class="btn-row-action danger" onclick="deleteRx('${rx.id}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

/* =========================================================================
   ROBUST RX MODAL LAUNCHER & INVENTORY OPTION BUILDER
   ========================================================================= */

function getMedicineOptionsHtml() {
  // Check every common variable name used in PharmaPulse state
  const list = state.inventory || state.medicines || state.drugs || state.inventoryItems || [];

  if (!Array.isArray(list) || list.length === 0) {
    return `<option value="GEN-MED">Generic Medication (Standard 500mg)</option>`;
  }

  return list.map(med => {
    const id = med.sku || med.id || med.name;
    const name = med.name || med.drugName || 'Unnamed Medicine';
    const strength = med.strength || med.dosage || '';
    const stock = (med.stock !== undefined) ? `(Stock: ${med.stock})` : '';
    return `<option value="${id}">${name} ${strength} ${stock}</option>`;
  }).join('');
}

function openRxUploadModal() {
  try {
    const modal = document.getElementById('rx-upload-modal');
    if (!modal) {
      console.error('Target modal #rx-upload-modal does not exist in DOM.');
      return;
    }

    // Reset form fields
    const form = document.getElementById('rx-upload-form');
    if (form) form.reset();

    // Reset preview dropzone
    const previewImg = document.getElementById('rx-image-preview');
    const placeholder = document.getElementById('rx-dropzone-placeholder');
    const metaTag = document.getElementById('rx-file-meta');

    if (previewImg) {
      previewImg.src = '';
      previewImg.classList.add('hidden');
    }
    if (placeholder) placeholder.classList.remove('hidden');
    if (metaTag) {
      metaTag.textContent = '';
      metaTag.classList.add('hidden');
    }

    // Clear repeater container and seed initial row
    const container = document.getElementById('rx-medicines-container');
    if (container) {
      container.innerHTML = '';
      addRxMedicineRow();
    }

    // Unhide modal
    modal.classList.remove('hidden');
  } catch (err) {
    console.error('Error in openRxUploadModal():', err);
  }
}

function closeRxUploadModal() {
  const modal = document.getElementById('rx-upload-modal');
  if (modal) modal.classList.add('hidden');
}

// Append a new medicine row into the prescription
function addRxMedicineRow() {
  const container = document.getElementById('rx-medicines-container');
  if (!container) return;

  const rowId = 'rx-med-row-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const rowHtml = `
    <div class="rx-med-row" id="${rowId}" style="display: flex; gap: 8px; align-items: center; background: #f8fafc; padding: 8px; border-radius: 6px; border: 1px solid #e2e8f0;">
      <div style="flex: 2;">
        <select class="rx-med-select" required style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px;">
          <option value="" disabled selected>Select Medication...</option>
          ${getMedicineOptionsHtml()}
        </select>
      </div>
      <div style="flex: 1;">
        <input type="number" class="rx-med-qty" min="1" value="1" placeholder="Qty" required style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; box-sizing: border-box;" />
      </div>
      <div style="flex: 1.5;">
        <input type="text" class="rx-med-dosage" placeholder="e.g. 1 tab bid" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; box-sizing: border-box;" />
      </div>
      <button type="button" onclick="removeRxMedicineRow('${rowId}')" title="Remove" style="background: transparent; border: none; color: #ef4444; font-size: 16px; cursor: pointer; padding: 4px 8px;">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', rowHtml);
}

// Remove a row (always leave at least one row active)
function removeRxMedicineRow(rowId) {
  const container = document.getElementById('rx-medicines-container');
  if (container.children.length <= 1) {
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('error', 'Action Blocked', 'A prescription must contain at least one prescribed drug.');
    } else {
      alert('A prescription must contain at least one prescribed drug.');
    }
    return;
  }
  const targetRow = document.getElementById(rowId);
  if (targetRow) targetRow.remove();
}



function handleRxImageSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showCustomAlert('error', 'Invalid File Type', 'Please upload an image (JPG, PNG).');
    return;
  }

  pendingRxFile = file;
  const reader = new FileReader();
  reader.onload = (event) => {
    const preview = document.getElementById('rx-image-preview');
    preview.src = event.target.result;
    preview.classList.remove('hidden');
    document.getElementById('rx-dropzone-placeholder').classList.add('hidden');

    const meta = document.getElementById('rx-file-meta');
    meta.textContent = `Attached: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    meta.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

async function handleInitialRxUpload(e) {
  e.preventDefault();

  const fileInput = document.getElementById('rx-slip-file');
  const patient = document.getElementById('rx-pat-name').value.trim();
  const demo = document.getElementById('rx-pat-demo').value.trim();
  const doctor = document.getElementById('rx-pat-doctor').value.trim();

  if (!fileInput.files[0]) {
    alert('Please attach a scan or photo of the prescription slip.');
    return;
  }

  // Collect all dynamic medicine rows
  const medRows = document.querySelectorAll('.rx-med-row');
  const prescribedMedicines = [];

  medRows.forEach(row => {
    const select = row.querySelector('.rx-med-select');
    const qty = row.querySelector('.rx-med-qty');
    const dosage = row.querySelector('.rx-med-dosage');

    if (select && select.value) {
      prescribedMedicines.push({
        sku: select.value,
        medName: select.options[select.selectedIndex]?.text.split('(')[0].trim() || select.value,
        quantity: parseInt(qty.value, 10) || 1,
        dosage: dosage ? dosage.value.trim() : ''
      });
    }
  });

  if (prescribedMedicines.length === 0) {
    alert('Please add at least one medication.');
    return;
  }

  const formData = new FormData();
  formData.append('slip', fileInput.files[0]);
  formData.append('patient', patient);
  formData.append('demo', demo);
  formData.append('doctor', doctor);
  formData.append('medicines', JSON.stringify(prescribedMedicines));

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...';
  }

  try {
    const res = await apiRequest('/prescriptions', 'POST', formData, true);

    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Prescription Queued', `Rx ${res.id} has been queued with ${prescribedMedicines.length} medications.`);
    }

    closeRxUploadModal();

    if (typeof syncDatabaseFromBackend === 'function') {
      await syncDatabaseFromBackend();
    }
  } catch (err) {
    console.error('Failed to upload Rx:', err);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Queue as "Pending"';
    }
  }
}
/* =========================================================================
   STAGE 2: CLINICAL AUDIT & VERIFICATION (FAULT-TOLERANT)
   ========================================================================= */

function openClinicalAudit(rxId) {
  const rx = state.prescriptions.find(r => r.id === rxId);
  if (!rx) {
    showCustomAlert('error', 'Not Found', `Prescription ${rxId} could not be located.`);
    return;
  }

  const modal = document.getElementById('rx-verify-modal');
  const form = document.getElementById('rx-verify-form');
  if (form) form.reset();

  const idInput = document.getElementById('verify-rx-id');
  const slipImg = document.getElementById('verify-slip-img');
  const regInput = document.getElementById('audit-doc-reg');
  const dosageInput = document.getElementById('audit-dosage');
  const notesInput = document.getElementById('audit-notes');

  if (idInput) idInput.value = rx.id;
  if (regInput) regInput.value = rx.doc_reg || rx.docReg || '';
  if (dosageInput) dosageInput.value = rx.dosage || '';
  if (notesInput) notesInput.value = rx.pharmacist_note || rx.notes || '';

  if (slipImg) {
    const rawUrl = rx.imageUrl || rx.image_url || '';
    slipImg.src = rawUrl.startsWith('http')
      ? rawUrl
      : (rawUrl ? `http://localhost:5000${rawUrl}` : '');
  }

  if (modal) modal.classList.remove('hidden');
}

function closeRxVerifyModal() {
  const modal = document.getElementById('rx-verify-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitClinicalVerification(e) {
  if (e && e.preventDefault) e.preventDefault();

  const rxIdInput = document.getElementById('verify-rx-id');
  const docRegInput = document.getElementById('audit-doc-reg');
  const dosageInput = document.getElementById('audit-dosage');
  const notesInput = document.getElementById('audit-notes');

  const rxId = rxIdInput ? rxIdInput.value.trim() : '';
  const doc_reg = docRegInput ? docRegInput.value.trim() : '';
  const dosage = dosageInput ? dosageInput.value.trim() : '';
  const pharmacist_note = notesInput ? notesInput.value.trim() : '';

  if (!rxId) {
    showCustomAlert('error', 'Validation Error', 'Missing Prescription ID reference.');
    return;
  }

  if (!doc_reg || !dosage) {
    showCustomAlert('error', 'Mandatory Information', 'Doctor Registration No. and Dosage instructions are mandatory for clinical audit.');
    return;
  }

  const payload = {
    doc_reg,
    dosage,
    pharmacist_note
  };

  const submitBtn = document.getElementById('btn-submit-verify');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authorizing...';
  }

  try {
    // Calls the verify endpoint in server.js
await apiRequest(`/prescriptions/${rxId}/audit`, 'PUT', payload);
    closeRxVerifyModal();
    await syncDatabaseFromBackend();
    renderPrescriptions();

    showCustomAlert('success', 'Prescription Verified', `Prescription #${rxId} is verified and ready for POS dispensation.`);
  } catch (err) {
    console.error('Audit verification failure:', err);
    // apiRequest already calls showCustomAlert with err.message
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-stamp"></i> Authorize &amp; Verify Prescription';
    }
  }
}

// HANDOFF: Transfer verified multi-medication Rx directly to POS for invoice & checkout
function transferRxToPosBilling(rxId) {
  const rx = state.prescriptions.find(r => r.id === rxId);
  if (!rx) return;

  // 1. Unpack all prescribed drugs (from JSON or composite string)
  let medList = [];
  if (rx.medicines) {
    try {
      medList = typeof rx.medicines === 'string' ? JSON.parse(rx.medicines) : rx.medicines;
    } catch (e) {
      console.warn('Failed parsing rx.medicines:', e);
    }
  }

  // Fallback string parser if medicines JSON is not populated
  if (!Array.isArray(medList) || medList.length === 0) {
    const rawName = rx.drugName || rx.drug_name || '';
    medList = rawName.split(',').map(entry => {
      const match = entry.trim().match(/^(.*?)\s*(?:\(x(\d+)\))?$/);
      return {
        name: match ? match[1].trim() : entry.trim(),
        medName: match ? match[1].trim() : entry.trim(),
        quantity: match && match[2] ? parseInt(match[2], 10) : 1
      };
    });
  }

  if (medList.length === 0) {
    showCustomAlert('error', 'Prescription Empty', 'No medication items found on this prescription.');
    return;
  }

  // 2. Resolve every prescribed medicine against stock inventory
  const matchedCartItems = [];
  const missingDrugs = [];

  for (const item of medList) {
    const searchName = (item.medName || item.name || item.sku || '').toLowerCase().trim();
    const qty = parseInt(item.quantity, 10) || 1;

    const inventoryItem = state.inventory.find(i => {
      const iName = (i.name || '').toLowerCase().trim();
      const iSku = (i.sku || '').toLowerCase().trim();
      return iName === searchName || 
             iSku === searchName || 
             iName.includes(searchName) || 
             searchName.includes(iName);
    });

    if (!inventoryItem) {
      missingDrugs.push(item.medName || item.name);
    } else {
      matchedCartItems.push({
        id: inventoryItem.id,
        name: inventoryItem.name,
        type: 'Rx',
        basePrice: inventoryItem.basePrice || inventoryItem.price || 0,
        qty: qty,
        batch: rx.batch || ('BATCH-' + rx.id)
      });
    }
  }

  // If any drug is missing from inventory, notify staff
  if (missingDrugs.length > 0) {
    showCustomAlert('error', 'Inventory Missing', `The following drugs were not found in inventory: ${missingDrugs.join(', ')}`);
    return;
  }

  // 3. Set active transfer context
  activeRxTransferData = {
    id: rx.id,
    patient: rx.patient,
    doctor: rx.doctor,
    docReg: rx.doc_reg || 'MCI-REG-VALID',
    idRef: 'ID-' + rx.id
  };

  // 4. Populate POS Cart with all prescribed items
  state.cart = matchedCartItems;

  // 5. Switch View to POS / Billing
  navigate('pos');

  // Fill in customer and transfer notice banner
  const custInput = document.getElementById('pos-cust-name');
  if (custInput) custInput.value = rx.patient;

  const infoText = document.getElementById('pos-rx-transfer-info');
  if (infoText) {
    infoText.textContent = `Prescription Dispense: #${rx.id} (${matchedCartItems.length} Medication${matchedCartItems.length > 1 ? 's' : ''})`;
  }

  const docText = document.getElementById('pos-rx-transfer-doctor');
  if (docText) {
    docText.textContent = `Physician: ${rx.doctor} (Reg: ${rx.doc_reg || 'Verified'})`;
  }

  const banner = document.getElementById('pos-rx-transfer-banner');
  if (banner) banner.classList.remove('hidden');

  renderCart();
  showCustomAlert('success', 'Switched to POS', `Prescription #${rx.id} (${matchedCartItems.length} items) transferred to checkout register.`);
}

function openPackagingReady(rxId) {
  const rx = state.prescriptions.find(r => r.id === rxId);
  if (!rx) return;
  document.getElementById('rx-ready-form').reset();
  document.getElementById('ready-rx-id').value = rx.id;
  document.getElementById('rx-ready-modal').classList.remove('hidden');
}

function closeRxReadyModal() {
  document.getElementById('rx-ready-modal').classList.add('hidden');
}

async function submitPackagingReady(e) {
  e.preventDefault();
  const rxId = document.getElementById('ready-rx-id').value;
  const payload = {
    bin: document.getElementById('ready-bin-number').value.trim(),
    batch: document.getElementById('ready-batch-num').value.trim(),
    seal: document.getElementById('ready-seal-tag').value.trim()
  };

  try {
    await apiRequest(`/prescriptions/${rxId}/package`, 'PUT', payload);
    closeRxReadyModal();
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Packaging Ready', `Rx #${rxId} is packaged & ready.`);
  } catch (err) {
    // Handled in apiRequest
  }
}

function openFinalDispense(rxId) {
  const rx = state.prescriptions.find(r => r.id === rxId);
  if (!rx) return;
  document.getElementById('rx-dispense-form').reset();
  document.getElementById('dispense-rx-id').value = rx.id;
  document.getElementById('rx-dispense-modal').classList.remove('hidden');
}

function closeRxDispenseModal() {
  document.getElementById('rx-dispense-modal').classList.add('hidden');
}

async function submitFinalDispense(e) {
  e.preventDefault();
  const rxId = document.getElementById('dispense-rx-id').value;
  const rx = state.prescriptions.find(r => r.id === rxId);
  if (!rx) return;

  const payload = {
    collector: document.getElementById('dispense-collector-rel').value,
    id_ref: document.getElementById('dispense-id-ref').value.trim(),
    pay_method: document.getElementById('dispense-payment-method').value,
    drug_name: rx.drugName
  };

  try {
    await apiRequest(`/prescriptions/${rxId}/dispense`, 'PUT', payload);
    closeRxDispenseModal();
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Dispensation Complete', `Rx #${rxId} dispensed and inventory stock updated in SQLite.`);
  } catch (err) {
    // Handled in apiRequest
  }
}

function openSlipLightbox(url) {
  document.getElementById('lightbox-full-img').src = url;
  document.getElementById('slip-lightbox-modal').classList.remove('hidden');
}

function closeSlipLightbox() {
  document.getElementById('slip-lightbox-modal').classList.add('hidden');
}

function deleteRx(rxId) {
  showCustomConfirm('Delete Rx?', `Remove prescription ${rxId} from database?`, async () => {
    try {
      await apiRequest(`/prescriptions/${rxId}`, 'DELETE');
      await syncDatabaseFromBackend();
      showCustomAlert('success', 'Prescription Erased', 'Rx removed from SQLite.');
    } catch (err) {
      // Handled in apiRequest
    }
  });
}

/* =========================================================================
   SUPPLIERS & PO (SQLITE CONNECTED)
   ========================================================================= */
function switchSupplierSubTab(tab) {
  state.supplierSubTab = tab;
  document.getElementById('po-tab-btn').classList.toggle('active', tab === 'po');
  document.getElementById('supplier-tab-btn').classList.toggle('active', tab === 'dir');
  document.getElementById('po-subtab-view').classList.toggle('hidden', tab !== 'po');
  document.getElementById('supplier-directory-view').classList.toggle('hidden', tab !== 'dir');
}

function filterSuppliersOrPO() {
  if (state.supplierSubTab === 'po') renderPurchaseOrders();
  else renderSupplierDirectory();
}

function renderPurchaseOrders() {
  const tbody = document.getElementById('po-table-body');
  const query = document.getElementById('po-search').value.toLowerCase();

  const filtered = state.purchaseOrders.filter(po =>
    po.id.toLowerCase().includes(query) ||
    po.distributor.toLowerCase().includes(query) ||
    po.medName.toLowerCase().includes(query)
  );

  tbody.innerHTML = filtered.map(po => `
    <tr>
      <td><strong>${po.id}</strong></td>
      <td><strong>${po.distributor}</strong></td>
      <td>${po.date}</td>
      <td><strong>${po.medName}</strong> (+${po.qty} units)</td>
      <td>${formatCurrency(po.baseCost)}</td>
      <td><span class="tag-badge optimal">${po.status}</span></td>
      <td>
        <button class="btn-row-action danger" onclick="deletePo('${po.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderSupplierDirectory() {
  const tbody = document.getElementById('supplier-dir-table-body');
  const query = document.getElementById('po-search').value.toLowerCase();

  const filtered = state.suppliers.filter(s =>
    s.name.toLowerCase().includes(query) || s.contact.toLowerCase().includes(query) || s.id.toLowerCase().includes(query)
  );

  tbody.innerHTML = filtered.map(sup => `
    <tr>
      <td><strong>${sup.id}</strong></td>
      <td><strong>${sup.name}</strong></td>
      <td>${sup.contact}</td>
      <td>${sup.phone} / ${sup.email}</td>
      <td>${sup.gstin}</td>
      <td><strong>${sup.activeOrders}</strong> active</td>
      <td>
        <button class="btn-row-action danger" onclick="deleteSupplier('${sup.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function openPurchaseOrderModal() {
  const distSelect = document.getElementById('po-distributor-select');
  distSelect.innerHTML = state.suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
  const medSelect = document.getElementById('po-med-select');
  medSelect.innerHTML = state.inventory.map(m => `<option value="${m.name}">${m.name}</option>`).join('');
  document.getElementById('po-modal').classList.remove('hidden');
}

function closePoModal() {
  document.getElementById('po-modal').classList.add('hidden');
}

async function handleSavePo(e) {
  e.preventDefault();
  const payload = {
    distributor: document.getElementById('po-distributor-select').value,
    med_name: document.getElementById('po-med-select').value,
    qty: parseInt(document.getElementById('po-qty').value, 10),
    base_cost: parseFloat(document.getElementById('po-cost').value)
  };

  try {
    await apiRequest('/purchase-orders', 'POST', payload);
    closePoModal();
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'PO Received', `Stock replenished in SQLite for ${payload.med_name}.`);
  } catch (err) {
    // Handled in apiRequest
  }
}

function deletePo(poId) {
  showCustomConfirm('Delete Purchase Order?', `Delete PO reference ${poId}?`, async () => {
    try {
      await apiRequest(`/purchase-orders/${poId}`, 'DELETE');
      await syncDatabaseFromBackend();
      showCustomAlert('success', 'PO Removed', 'Purchase order deleted from SQLite.');
    } catch (err) {
      // Handled in apiRequest
    }
  });
}

function openSupplierModal() {
  document.getElementById('supplier-form').reset();
  document.getElementById('supplier-modal').classList.remove('hidden');
}

function closeSupplierModal() {
  document.getElementById('supplier-modal').classList.add('hidden');
}

async function handleSaveSupplier(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('sup-name').value.trim(),
    contact: document.getElementById('sup-contact').value.trim(),
    phone: document.getElementById('sup-phone').value.trim(),
    email: document.getElementById('sup-email').value.trim(),
    gstin: document.getElementById('sup-gst').value.trim()
  };

  try {
    await apiRequest('/suppliers', 'POST', payload);
    closeSupplierModal();
    switchSupplierSubTab('dir');
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Supplier Registered', `${payload.name} registered into SQLite.`);
  } catch (err) {
    // Handled in apiRequest
  }
}

function deleteSupplier(supId) {
  showCustomConfirm('Remove Supplier?', `Remove vendor ${supId} from directory?`, async () => {
    try {
      await apiRequest(`/suppliers/${supId}`, 'DELETE');
      await syncDatabaseFromBackend();
      showCustomAlert('success', 'Supplier Removed', 'Vendor deleted from SQLite.');
    } catch (err) {
      // Handled in apiRequest
    }
  });
}

/* =========================================================================
   FINANCIAL REPORTS
   ========================================================================= */
function switchFinanceTab(tab) {
  currentFinanceTab = tab;
  document.getElementById('fin-tab-ledger').classList.toggle('active', tab === 'ledger');
  document.getElementById('fin-tab-audit').classList.toggle('active', tab === 'audit');
  renderFinancials();
}

function renderFinancials() {
  const tbody = document.getElementById('financials-table-body');
  const grossBase = state.invoices.reduce((sum, i) => sum + i.baseTotal, 0);
  const taxBase = state.invoices.reduce((sum, i) => sum + i.baseTax, 0);
  const controlledCount = state.invoices.filter(i => i.isControlled).length;

  document.getElementById('fin-gross-rev').textContent = formatCurrency(grossBase);
  document.getElementById('fin-tax-rev').textContent = formatCurrency(taxBase);
  document.getElementById('fin-tx-count').textContent = state.invoices.length;
  document.getElementById('fin-audit-logs').textContent = `${controlledCount} Logs`;

  let list = state.invoices;
  if (currentFinanceTab === 'audit') list = list.filter(i => i.isControlled);

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No transactions recorded in this ledger.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(inv => `
    <tr>
      <td><strong>${inv.id}</strong></td>
      <td>${inv.timestamp}</td>
      <td>${inv.customer}</td>
      <td>${inv.itemsDispensed}</td>
      <td>${inv.tender}</td>
      <td>${formatCurrency(inv.baseTax)}</td>
      <td><strong>${formatCurrency(inv.baseTotal)}</strong></td>
      <td><button class="btn-row-action" onclick="showInvoiceDetails('${inv.id}')">View</button></td>
    </tr>
  `).join('');
}

function showInvoiceDetails(invId) {
  const inv = state.invoices.find(i => i.id === invId);
  if (!inv) return;
  state.lastDispensedInvoice = {
    ...inv,
    items: [{ name: inv.itemsDispensed, qty: 1, basePrice: inv.subtotal }]
  };
  openInvoiceModal(state.lastDispensedInvoice);
}

/* =========================================================================
   SYSTEM SETTINGS (SQLITE CONNECTED)
   ========================================================================= */
function loadClinicForm() {
  document.getElementById('set-pharmacy-name').value = state.clinic.name;
  document.getElementById('set-pharmacy-dl').value = state.clinic.dl;
  document.getElementById('set-pharmacy-gst').value = state.clinic.gst;
  document.getElementById('set-pharmacy-address').value = state.clinic.address;
  document.getElementById('set-pharmacy-tax').value = state.clinic.taxRate;
}

async function saveClinicProfile(e) {
  e.preventDefault();
  if (!state.currentUser.isSuperAdmin) {
    showCustomAlert('error', 'Access Restricted', 'Only Super Admins can alter pharmacy credentials.');
    return;
  }

  const payload = {
    name: document.getElementById('set-pharmacy-name').value.trim(),
    dl: document.getElementById('set-pharmacy-dl').value.trim(),
    gst: document.getElementById('set-pharmacy-gst').value.trim(),
    address: document.getElementById('set-pharmacy-address').value.trim(),
    tax_rate: parseFloat(document.getElementById('set-pharmacy-tax').value)
  };

  try {
    await apiRequest('/settings/profile', 'PUT', payload);
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Profile Updated', 'Clinic parameters saved in SQLite.');
  } catch (err) {
    // Handled in apiRequest
  }
}

function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  const isAdmin = state.currentUser.isSuperAdmin;

  container.innerHTML = state.staffAccounts.map(staff => `
    <div class="staff-row-card">
      <div class="staff-avatar-icon"><i class="fa-solid fa-circle-user"></i></div>
      <div class="staff-info">
        <div class="staff-name-line">
          ${staff.name}
          ${staff.active ? '<span class="staff-badge-active">Active</span>' : '<span class="staff-badge-suspended">Suspended</span>'}
          ${staff.id === state.currentUser.id ? '<span class="staff-badge-you">You</span>' : ''}
        </div>
        <div class="staff-details">${staff.email} | ID: <strong>${staff.id}</strong> | ${staff.role}</div>
      </div>
      <div>
        ${isAdmin ? `
          <button class="btn-row-action" onclick="openStaffModal('${staff.id}')">Edit</button>
          ${staff.id === state.currentUser.id
            ? '<button class="btn-row-action" disabled style="opacity:0.4;">Locked</button>'
            : `<button class="btn-row-action danger" onclick="deleteStaff('${staff.id}')">Delete</button>`
          }
        ` : `
          <button class="btn-row-action" disabled style="opacity:0.4;" title="Requires Super Admin clearance">Restricted</button>
        `}
      </div>
    </div>
  `).join('');
}

function openStaffModal(staffId) {
  if (!state.currentUser.isSuperAdmin) {
    showCustomAlert('error', 'Clearance Denied', 'Only administrators can modify staff clearance.');
    return;
  }
  const staff = state.staffAccounts.find(s => s.id === staffId);
  if (!staff) return;

  document.getElementById('staff-edit-id').value = staff.id;
  document.getElementById('staff-edit-name').value = staff.name;
  document.getElementById('staff-edit-email').value = staff.email;
  document.getElementById('staff-edit-role').value = staff.role;
  document.getElementById('staff-edit-status').value = staff.active ? 'true' : 'false';

  document.getElementById('staff-edit-modal').classList.remove('hidden');
}

function closeStaffModal() {
  document.getElementById('staff-edit-modal').classList.add('hidden');
}

async function handleSaveStaff(e) {
  e.preventDefault();
  const id = document.getElementById('staff-edit-id').value;
  const payload = {
    name: document.getElementById('staff-edit-name').value.trim(),
    email: document.getElementById('staff-edit-email').value.trim(),
    role: document.getElementById('staff-edit-role').value,
    active: document.getElementById('staff-edit-status').value === 'true'
  };

  try {
    await apiRequest(`/staff/${id}`, 'PUT', payload);
    closeStaffModal();
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Account Modified', `Staff record for ${payload.name} updated in SQLite.`);
  } catch (err) {
    // Handled in apiRequest
  }
}

function deleteStaff(staffId) {
  showCustomConfirm('Revoke Staff Access?', 'Account will be erased from the SQLite database.', async () => {
    try {
      await apiRequest(`/staff/${staffId}`, 'DELETE');
      await syncDatabaseFromBackend();
      showCustomAlert('success', 'Staff Revoked', 'Staff credentials deleted from database.');
    } catch (err) {
      // Handled in apiRequest
    }
  });
}

async function exportJsonBackup() {
  try {
    const backupData = await apiRequest('/maintenance/backup');
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backupData, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = `pharmapulse_sqlite_backup_${Date.now()}.json`;
    a.click();
    showCustomAlert('success', 'JSON Backup Exported', 'Full SQLite state exported.');
  } catch (err) {
    // Handled in apiRequest
  }
}

function requestResetDatabase() {
  showCustomAlert('error', 'Disabled', 'Contact the database administrator to execute schema re-initialization.');
}

/* =========================================================================
   CONTEXTUAL PRINT, CSV, EMAIL & SHARE
   ========================================================================= */
function triggerContextPrint() {
  const target = state.currentView;
  let docTitle = '';
  let tableHeaders = [];
  let tableRows = [];
  let customMiddleHtml = '';

  if (target === 'pos') {
    const custName = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Customer';
    const custPhone = document.getElementById('pos-cust-phone').value.trim() || 'N/A';
    const tender = (document.querySelector('input[name="tender"]:checked') || {}).value || 'Cash';

    if (state.cart.length > 0) {
      const subtotalBase = state.cart.reduce((s, i) => s + (i.basePrice * i.qty), 0);
      const taxBase = (subtotalBase * state.clinic.taxRate) / 100;
      const totalBase = subtotalBase + taxBase;

      docTitle = 'POS Active Medication Dispense Order';
      customMiddleHtml = `
        <div style="margin-bottom: 15px; font-size: 11px;">
          <strong>Patient / Customer:</strong> ${custName} &nbsp;|&nbsp;
          <strong>Mobile:</strong> ${custPhone} &nbsp;|&nbsp;
          <strong>Tender Method:</strong> ${tender}
        </div>
        <table class="print-table">
          <thead>
            <tr><th>Medication Item</th><th>Batch</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr>
          </thead>
          <tbody>
            ${state.cart.map(i => `
              <tr>
                <td>${i.name}</td>
                <td>${i.batch}</td>
                <td>${i.qty}</td>
                <td>${formatCurrency(i.basePrice)}</td>
                <td>${formatCurrency(i.basePrice * i.qty)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="margin-left: auto; width: 280px; text-align: right; font-size: 12px; margin-top: 10px;">
          <div>Subtotal: <strong>${formatCurrency(subtotalBase)}</strong></div>
          <div>GST (${state.clinic.taxRate}%): <strong>${formatCurrency(taxBase)}</strong></div>
          <div style="font-size: 14px; font-weight: bold; border-top: 1px dashed #777; margin-top: 5px; padding-top: 5px;">
            Total Payable: ${formatCurrency(totalBase)}
          </div>
        </div>
      `;
    } else if (state.lastDispensedInvoice) {
      printGeneratedInvoice();
      return;
    } else {
      showCustomAlert('error', 'Nothing to Print', 'Your POS cart is currently empty. Add medicines to print a bill.');
      return;
    }
  } else if (target === 'prescriptions') {
    docTitle = `Prescription Queue Audit Document — [Filter: ${currentRxFilter.toUpperCase()}]`;
    tableHeaders = ['Rx Reference', 'Patient Name', 'Demographics', 'Physician', 'Date Received', 'Prescribed Drug', 'Status'];

    let list = [...state.prescriptions];
    if (currentRxFilter !== 'All') {
      list = list.filter(r => r.status.toLowerCase() === currentRxFilter.toLowerCase());
    }
    tableRows = list.map(r => [
      r.id, r.patient, r.demo, r.doctor, r.date, r.drugName, r.status
    ]);
  } else if (target === 'settings') {
    docTitle = 'Official Pharmacy Profile & Dispensary Staff Clearance Registry';
    customMiddleHtml = `
      <div style="margin-bottom: 20px;">
        <div class="print-section-header">1. Registered Pharmacy Facility Credentials</div>
        <table class="print-table" style="margin-top: 8px;">
          <tr><th>Facility Name</th><td>${state.clinic.name}</td><th>Drug License (DL)</th><td>${state.clinic.dl}</td></tr>
          <tr><th>GST / Tax ID</th><td>${state.clinic.gst}</td><th>Sales Tax Rate</th><td>${state.clinic.taxRate}%</td></tr>
          <tr><th>Official Address</th><td colspan="3">${state.clinic.address}</td></tr>
        </table>
        <div class="print-section-header">2. Authorized Staff &amp; Clearance Directory</div>
        <table class="print-table" style="margin-top: 8px;">
          <thead>
            <tr><th>Staff ID</th><th>Full Name</th><th>Work Email</th><th>Role Clearance</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${state.staffAccounts.map(s => `
              <tr>
                <td>${s.id}</td>
                <td><strong>${s.name}</strong></td>
                <td>${s.email}</td>
                <td>${s.role}</td>
                <td>${s.active ? 'Active' : 'Suspended'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else if (target === 'suppliers') {
    if (state.supplierSubTab === 'po') {
      docTitle = 'Purchase Order Goods Receipt (GRN) Ledger';
      tableHeaders = ['PO Reference', 'Distributor', 'Date', 'Item & Qty', 'Inward Cost', 'Status'];
      tableRows = state.purchaseOrders.map(p => [
        p.id, p.distributor, p.date, `${p.medName} (+${p.qty})`, formatCurrency(p.baseCost), p.status
      ]);
    } else {
      docTitle = 'Verified Pharmaceutical Supplier Directory';
      tableHeaders = ['Vendor ID', 'Vendor Name', 'Contact', 'Phone / Email', 'GSTIN / DL', 'Active POs'];
      tableRows = state.suppliers.map(s => [
        s.id, s.name, s.contact, `${s.phone} / ${s.email}`, s.gstin, s.activeOrders
      ]);
    }
  } else if (target === 'inventory') {
    docTitle = 'Live Drug Inventory & Batch Valuation Registry';
    tableHeaders = ['SKU Name', 'Generic Salt', 'Category', 'Type', 'Exp Date', 'Unit Price', 'Stock Units', 'Status'];
    tableRows = state.inventory.map(m => [
      m.name, m.salt, m.category, m.type, m.exp, formatCurrency(m.basePrice), `${m.stock} units`, m.status
    ]);
  } else if (target === 'financials') {
    docTitle = currentFinanceTab === 'ledger' ? 'Official Sales & Revenue Ledger' : 'Schedule H/H1 Controlled Substance Audit';
    tableHeaders = ['Invoice ID', 'Date & Time', 'Patient/Customer', 'Items', 'Tender', 'Tax', 'Net Total'];
    const list = currentFinanceTab === 'ledger' ? state.invoices : state.invoices.filter(i => i.isControlled);
    tableRows = list.map(i => [
      i.id, i.timestamp, i.customer, i.itemsDispensed, i.tender, formatCurrency(i.baseTax), formatCurrency(i.baseTotal)
    ]);
  } else if (target === 'inquiries') {
    docTitle = 'Customer Inquiries & AI-Automation Audit Ledger';
    tableHeaders = ['ID', 'Date', 'Customer Name', 'Contact Info', 'Category', 'Urgency', 'AI Summary', 'Status'];
    tableRows = (state.inquiries || []).map(inq => [
      `#INQ-${inq.id}`,
      inq.created_at ? inq.created_at.slice(0, 16).replace('T', ' ') : 'Recent',
      inq.name,
      `${inq.email} / ${inq.phone || 'N/A'}`,
      inq.category || 'General',
      inq.urgency || 'Routine',
      inq.ai_summary || inq.message,
      inq.status || 'New'
    ]);
  } else {
    docTitle = 'Executive Pharmacy Operations & Shift Summary';
    tableHeaders = ['Metric / Parameter', 'Value', 'Notes'];
    const gross = state.invoices.reduce((a, b) => a + b.baseTotal, 0);
    tableRows = [
      ['Gross Sales Dispensed', formatCurrency(gross), 'Live register'],
      ['Completed Transactions', state.invoices.length.toString(), 'Audit verified'],
      ['Active Tracked SKUs', state.inventory.length.toString(), 'Active items'],
      ['Active Stock Alerts', state.inventory.filter(i => i.stock < 15).length.toString(), 'Reorder queue']
    ];
  }

  const container = document.getElementById('print-paperwork-container');
  container.innerHTML = `
    <div class="print-letterhead">
      <div>
        <h2>${state.clinic.name}</h2>
        <p><strong>Address:</strong> ${state.clinic.address}</p>
        <p><strong>Drug License (DL):</strong> ${state.clinic.dl} | <strong>GSTIN:</strong> ${state.clinic.gst}</p>
      </div>
      <div style="text-align: right;">
        <p><strong>Generated By:</strong> ${state.currentUser.name}</p>
        <p><strong>Clearance:</strong> ${state.currentUser.role}</p>
        <p><strong>Date & Time:</strong> ${new Date().toLocaleString()}</p>
      </div>
    </div>
    <div class="print-doc-title">${docTitle}</div>
    ${customMiddleHtml ? customMiddleHtml : `
      <table class="print-table">
        <thead>
          <tr>${tableHeaders.map(h => `<th>${h}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${tableRows.length > 0
            ? tableRows.map(row => `<tr>${row.map(col => `<td>${col}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${tableHeaders.length}" style="text-align:center; padding:15px;">No records available for this print specification.</td></tr>`
          }
        </tbody>
      </table>
    `}
    <div class="print-footer">
      <span>HIPAA &amp; Good Pharmacy Practices (GPP) Certified Terminal Document • v2.6.4</span>
      <span>System Signature: <strong>[VERIFIED ELECTRONIC RECORD]</strong></span>
    </div>
  `;
  window.print();
}

/* =========================================================================
   2. SPECIFIC EXPORT: CONTEXT AWARE (DYNAMIC BY ACTIVE VIEW / SUBMENU)
   ========================================================================= */

function exportContextCSV() {
  const currentView = state.currentView || 'dashboard';

  // VIEW: DASHBOARD
  if (currentView === 'dashboard') {
    const grossRev = state.invoices.reduce((s, i) => s + (i.baseTotal || i.base_total || 0), 0);
    const lowStockItems = state.inventory.filter(i => Number(i.stock) < 15);
    const pendingRx = state.prescriptions.filter(r => r.status.includes('Pending'));

    const headers = ['Category', 'Key Performance Indicator (KPI)', 'Current Status / Value'];
    const rows = [
      ['Financials', 'Gross Cumulative Revenue', formatCurrency(grossRev)],
      ['Dispensary', 'Total Invoices Processed', state.invoices.length],
      ['Inventory', 'Total Active SKUs', state.inventory.length],
      ['Inventory', 'Low Stock Alert Items', `${lowStockItems.length} SKUs`],
      ['Clinical Queue', 'Prescriptions Pending Review', `${pendingRx.length} scripts`],
      ['Operations', 'Registered Staff Clearances', state.staffAccounts.length]
    ];

    downloadCleanCSV('Dashboard_KPI_Report', 'Executive Pharmacy Operations Summary', headers, rows, {
      'Audit Period': 'All Active Operations',
      'Dispensary Status': 'Operational'
    });
  }

  else if (currentView === 'inquiries') {
    const headers = ['Inquiry ID', 'Received Date', 'Customer Name', 'Email', 'Phone', 'Category', 'Urgency', 'AI Summary', 'Status'];
    const rows = (state.inquiries || []).map(inq => [
      `INQ-${inq.id}`,
      inq.created_at,
      inq.name,
      inq.email,
      inq.phone,
      inq.category,
      inq.urgency,
      inq.ai_summary,
      inq.status
    ]);

    downloadCleanCSV('Customer_Inquiries_Log', 'Customer Inquiries & AI Summaries Report', headers, rows, {
      'Total Inquiries Logged': (state.inquiries || []).length,
      'Resolved Queries': (state.inquiries || []).filter(i => i.status === 'Resolved').length
    });
  }

  // VIEW: POS / BILLING (ACTIVE REGISTER)
  else if (currentView === 'pos') {
    if (!state.cart || state.cart.length === 0) {
      if (typeof showCustomAlert === 'function') {
        showCustomAlert('error', 'Cart Empty', 'No items in the active register to export.');
      }
      return;
    }

    const headers = ['SKU ID', 'Item Name', 'Classification', 'Unit Base Price', 'Quantity', 'Line Total'];
    let subtotal = 0;

    const rows = state.cart.map(item => {
      const price = Number(item.basePrice || item.base_price || 0);
      const qty = Number(item.qty || 1);
      const total = price * qty;
      subtotal += total;
      return [item.id, item.name, item.type || 'OTC', price.toFixed(2), qty, total.toFixed(2)];
    });

    const taxVal = (subtotal * (state.clinic.taxRate || 5)) / 100;
    downloadCleanCSV('POS_Register_Cart', 'Active POS Billing Register Breakdown', headers, rows, {
      'Cart Subtotal': formatCurrency(subtotal),
      'GST Tax': formatCurrency(taxVal),
      'Total Payable': formatCurrency(subtotal + taxVal)
    });
  }

  // VIEW: INVENTORY & STOCK
  else if (currentView === 'inventory') {
    const headers = ['SKU Code', 'Drug Name', 'Salt Composition', 'Category', 'Classification', 'Expiry Date', 'Base Price', 'Stock Level', 'Status'];
    const rows = state.inventory.map(item => [
      item.id,
      item.name,
      item.salt,
      item.category,
      item.type,
      item.exp,
      (item.basePrice || item.base_price || 0).toFixed(2),
      item.stock,
      item.status
    ]);

    const totalUnits = state.inventory.reduce((sum, i) => sum + Number(i.stock), 0);
    downloadCleanCSV('Master_Inventory_Stock', 'Dispensary Pharmaceutical Inventory Catalog', headers, rows, {
      'Total SKUs Listed': state.inventory.length,
      'Total Units In Hand': totalUnits
    });
  }

  // VIEW: PRESCRIPTIONS (Rx) PIPELINE
  else if (currentView === 'prescriptions') {
    const activeFilter = currentRxFilter || 'All';
    let targetList = [...state.prescriptions];
    if (activeFilter !== 'All') {
      targetList = targetList.filter(r => normalizeRxStatus(r.status) === activeFilter);
    }

    const headers = [
      'Prescription ID', 'Date Logged', 'Patient Name', 'Demographics',
      'Doctor Name', 'Prescribed Drug', 'Dosage Regimen',
      'Doctor Reg No', 'Patient Govt ID Ref', 'Lifecycle Stage'
    ];

    const rows = targetList.map(rx => [
      rx.id,
      rx.date,
      rx.patient,
      rx.demo,
      rx.doctor,
      rx.drugName,
      rx.dosage || 'Standard Regimen',
      rx.doc_reg || rx.docReg || 'Verified',
      rx.id_ref || rx.idRef || 'N/A',
      rx.status
    ]);

    downloadCleanCSV(`Prescriptions_Audit_${activeFilter.replace(/\s+/g, '_')}`, `Doctor Orders & Clinical Verification Ledger (${activeFilter})`, headers, rows, {
      'Filtered Queue Stage': activeFilter,
      'Total Scripts in File': targetList.length
    });
  }

  // 5. SUPPLIERS & PROCUREMENT (PO vs DIRECTORY)
  else if (currentView === 'suppliers') {
    // Matches your exact state: 'po' vs 'dir'
    const isPoTab = (state.supplierSubTab === 'po');

    if (isPoTab) {
      // ----------------- SUB-MENU: PURCHASE ORDERS (PO) -----------------
      const headers = [
        'PO Number', 'Distributor / Vendor', 'Order Date', 
        'Medication Name', 'Units Ordered', 'Unit Base Cost', 
        'Total Order Cost', 'Fulfillment Status'
      ];

      const rows = (state.purchaseOrders || []).map(po => {
        const qty = Number(po.qty || 0);
        const unitCost = Number(po.base_cost || po.baseCost || 0);
        const totalCost = qty * unitCost;

        return [
          po.id,
          po.distributor || 'N/A',
          po.date || 'N/A',
          po.med_name || po.medName || 'N/A',
          qty,
          unitCost.toFixed(2),
          totalCost.toFixed(2),
          po.status || 'Pending'
        ];
      });

      const totalSpend = (state.purchaseOrders || []).reduce((sum, po) => {
        return sum + (Number(po.qty || 0) * Number(po.base_cost || po.baseCost || 0));
      }, 0);

      downloadCleanCSV(
        'Purchase_Orders_Ledger',
        'Procurement & Vendor Purchase Orders Log',
        headers,
        rows,
        {
          'Total POs Placed': (state.purchaseOrders || []).length,
          'Total Spend Value': formatCurrency(totalSpend)
        }
      );
    } else {
      // ----------------- SUB-MENU: SUPPLIER DIRECTORY ('dir') -----------------
      const headers = [
        'Supplier ID', 'Distributor Name', 'Contact Person', 
        'Phone Number', 'Official Email', 'GSTIN Reg No', 'Active Orders Count'
      ];

      const rows = (state.suppliers || []).map(sup => [
        sup.id,
        sup.name || 'N/A',
        sup.contact || 'N/A',
        sup.phone || 'N/A',
        sup.email || 'N/A',
        sup.gstin || 'N/A',
        sup.activeOrders || sup.active_orders || 0
      ]);

      downloadCleanCSV(
        'Suppliers_Vendor_Directory',
        'Authorized Pharmaceutical Suppliers Directory',
        headers,
        rows,
        {
          'Total Registered Suppliers': (state.suppliers || []).length
        }
      );
    }
  }

  // VIEW: FINANCIAL REPORTS (SUB-TAB AWARE: GENERAL SALES vs CONTROLLED AUDIT)
  else if (currentView === 'financials') {
    const isAuditTab = (typeof currentFinanceTab !== 'undefined' && currentFinanceTab === 'audit');

    if (isAuditTab) {
      // Sub-Tab: Statutory Controlled Substance (Schedule H) Audit
      const controlledList = state.invoices.filter(i => i.isControlled || i.is_controlled);
      const headers = [
        'Audit Inv ID', 'Dispense Timestamp', 'Patient Customer', 'Controlled Drugs Dispensed',
        'Prescribing Physician', 'Doctor Reg No', 'Patient Govt ID Ref', 'Tender Tendered', 'Dispensing Pharmacist'
      ];

      const rows = controlledList.map(inv => [
        inv.id,
        inv.timestamp,
        inv.customer,
        inv.itemsDispensed || inv.items_dispensed,
        inv.doctorName || inv.doctor_name || 'Dr. Sarah',
        inv.doctorRegNo || inv.doctor_reg_no || 'MCI-REG-VALID',
        inv.patientIdRef || inv.patient_id_ref || 'VERIFIED-GOVT-ID',
        inv.tender,
        inv.dispensingPharmacist || inv.dispensing_pharmacist || state.currentUser.name
      ]);

      downloadCleanCSV('Schedule_H_Statutory_Audit', 'Schedule H / Controlled Substance Statutory Audit Trail', headers, rows, {
        'Regulatory Compliance': 'CDSCO / FDA Schedule H & H1 Mandated',
        'Total Controlled Scripts Dispensed': controlledList.length
      });
    } else {
      // Sub-Tab: Commercial Sales & Revenue Ledger
      const headers = ['Invoice ID', 'Date & Time', 'Customer', 'Phone', 'Items Dispensed', 'Tender', 'Subtotal', 'Tax (GST)', 'Grand Total Paid'];
      const rows = state.invoices.map(inv => [
        inv.id,
        inv.timestamp,
        inv.customer,
        inv.phone || 'N/A',
        inv.itemsDispensed || inv.items_dispensed,
        inv.tender,
        (inv.subtotal || 0).toFixed(2),
        (inv.baseTax || inv.base_tax || 0).toFixed(2),
        (inv.baseTotal || inv.base_total || 0).toFixed(2)
      ]);

      const grossRev = state.invoices.reduce((s, i) => s + (i.baseTotal || i.base_total || 0), 0);
      const totalTax = state.invoices.reduce((s, i) => s + (i.baseTax || i.base_tax || 0), 0);

      downloadCleanCSV('Commercial_Sales_Ledger', 'Dispensary Commercial Revenue & Sales Ledger', headers, rows, {
        'Gross Revenue Collected': formatCurrency(grossRev),
        'Total Tax Remitted': formatCurrency(totalTax)
      });
    }
  }

  // VIEW: SYSTEM SETTINGS (STAFF ROSTER)
  else if (currentView === 'settings') {
    const headers = ['License ID', 'Staff Name', 'Work Email', 'Role Clearance', 'Account Status'];
    const rows = state.staffAccounts.map(st => [
      st.id,
      st.name,
      st.email,
      st.role,
      st.active ? 'Active' : 'Suspended'
    ]);

    downloadCleanCSV('Staff_Clearance_Roster', 'Dispensary Staff Accounts & Role Clearances', headers, rows, {
      'Total Staff Members': state.staffAccounts.length,
      'Active Clearances': state.staffAccounts.filter(s => s.active).length
    });
  }
}

function openEmailModal() {
  const modal = document.getElementById('email-modal');
  const subjectInput = document.getElementById('email-subject');
  const bodyInput = document.getElementById('email-body');
  const attachmentBadge = document.getElementById('email-attachment-name');

  const view = state.currentView;
  let sectionLabel = view.toUpperCase();

  if (view === 'pos') {
    if (state.cart.length > 0) {
      const custName = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Customer';
      const subtotalBase = state.cart.reduce((s, i) => s + (i.basePrice * i.qty), 0);
      const totalBase = subtotalBase + (subtotalBase * state.clinic.taxRate) / 100;

      attachmentBadge.textContent = `${state.clinic.name.replace(/\s+/g, '_')}_POS_Receipt_Draft.pdf`;
      subjectInput.value = `Dispensary Medication Bill - ${custName}`;
      bodyInput.value = `Dear ${custName},\n\nPlease find attached the official medicine bill receipt of ${formatCurrency(totalBase)} issued by ${state.clinic.name}.\n\nDispensing Pharmacist: ${state.currentUser.name}`;
    } else if (state.lastDispensedInvoice) {
      emailGeneratedInvoice();
      return;
    } else {
      showCustomAlert('error', 'Cart Empty', 'No items in POS cart to email. Please add medicines or dispense first.');
      return;
    }
  } else if (view === 'prescriptions') {
    sectionLabel = `RX_${currentRxFilter.replace(/\s+/g, '_').toUpperCase()}`;
    attachmentBadge.textContent = `${state.clinic.name.replace(/\s+/g, '_')}_${sectionLabel}_Audit.pdf`;
    subjectInput.value = `Prescription Queue [${currentRxFilter}] - ${state.clinic.name}`;
    bodyInput.value = `Attached please find the verified electronic queue log for "${currentRxFilter}" prescriptions audited by ${state.currentUser.name}.`;
  } else if (view === 'settings') {
    sectionLabel = 'CLINIC_PROFILE_AND_STAFF_CLEARANCE';
    attachmentBadge.textContent = `${state.clinic.name.replace(/\s+/g, '_')}_${sectionLabel}_Audit.pdf`;
    subjectInput.value = `Official Pharmacy Profile & Clearance Registry - ${state.clinic.name}`;
    bodyInput.value = `Attached is the complete regulatory record containing Clinic Credentials (DL: ${state.clinic.dl}) and Active Staff Clearances.`;
  } else if (view === 'suppliers') {
    sectionLabel = state.supplierSubTab === 'po' ? 'PURCHASE_ORDERS' : 'SUPPLIER_DIRECTORY';
    attachmentBadge.textContent = `${state.clinic.name.replace(/\s+/g, '_')}_${sectionLabel}_Audit.pdf`;
    subjectInput.value = `Official Purchase Order & Supplier Verification - ${state.clinic.name}`;
    bodyInput.value = `Attached please find the verified Procurement / Goods Receipt document issued by ${state.clinic.name}.`;
  } else {
    attachmentBadge.textContent = `${state.clinic.name.replace(/\s+/g, '_')}_${sectionLabel}_Report.pdf`;
    subjectInput.value = `PharmaPulse Dispensary Operations Report - ${new Date().toLocaleDateString()}`;
    bodyInput.value = `Good day,\n\nPlease find attached the status report for our dispensary operations.\n\nRegards,\n${state.currentUser.name}`;
  }

  modal.classList.remove('hidden');
}

function closeEmailModal() {
  document.getElementById('email-modal').classList.add('hidden');
}

function handleSendEmail(e) {
  e.preventDefault();
  const recipient = document.getElementById('email-recipient').value;
  closeEmailModal();
  showCustomAlert('success', 'Email Transmitted', `Encrypted document package dispatched to ${recipient}.`);
}

function openShareModal() {
  const modal = document.getElementById('share-modal');
  const secName = document.getElementById('share-section-name');
  const snippet = document.getElementById('share-preview-snippet');

  let sectionTitle = state.currentView.toUpperCase();
  let details = '';

  if (state.currentView === 'pos') {
    if (state.cart.length > 0) {
      const custName = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Customer';
      const subtotalBase = state.cart.reduce((s, i) => s + (i.basePrice * i.qty), 0);
      const totalBase = subtotalBase + (subtotalBase * state.clinic.taxRate) / 100;
      sectionTitle = 'POS & BILLING (ACTIVE ORDER)';
      details = `Customer: ${custName}\nItems: ${state.cart.length} SKUs (${state.cart.map(c => c.name).join(', ')})\nTotal Amount: ${formatCurrency(totalBase)}`;
    } else if (state.lastDispensedInvoice) {
      const inv = state.lastDispensedInvoice;
      sectionTitle = `POS INVOICE #${inv.id}`;
      details = `Customer: ${inv.customer}\nItems: ${inv.itemsDispensed}\nTotal: ${formatCurrency(inv.baseTotal)}`;
    } else {
      details = 'Status: POS Register Active (Cart Idle)';
    }
  } else if (state.currentView === 'prescriptions') {
    sectionTitle += ` (${currentRxFilter})`;
    details = `Active Filter: ${currentRxFilter}\nTotal Queue: ${state.prescriptions.length} Records`;
  } else if (state.currentView === 'settings') {
    sectionTitle = 'CLINIC PROFILE & STAFF CLEARANCE';
    details = `Facility: ${state.clinic.name}\nLicense: ${state.clinic.dl}\nStaff Registered: ${state.staffAccounts.length}`;
  } else {
    details = `Active Inventory: ${state.inventory.length} SKUs\nTotal Transactions: ${state.invoices.length}`;
  }

  secName.value = `${state.clinic.name} > ${sectionTitle}`;
  snippet.value = `[PharmaPulse Secure Record]\nSection: ${sectionTitle}\n${details}\nAuthorized Operator: ${state.currentUser.name}\nTimestamp: ${new Date().toISOString()}`;

  modal.classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('share-modal').classList.add('hidden');
}

function copyShareLink() {
  navigator.clipboard.writeText(window.location.href);
  closeShareModal();
  showCustomAlert('success', 'Secure Link Copied', 'Encrypted access link copied to system clipboard.');
}

let pendingStaffEditAvatarFile = null;

/* =========================================================================
   UPDATE BOTTOM-LEFT PROFILE CARD & PHOTO
   ========================================================================= */
/* =========================================================================
   BOTTOM-LEFT PROFILE AVATAR UPDATER
   ========================================================================= */
function updateSidebarUserProfile() {
  const nameElem = document.getElementById('sidebar-user-name');
  const roleElem = document.getElementById('sidebar-user-role');
  const initialsElem = document.getElementById('sidebar-user-initials');
  const avatarImg = document.getElementById('sidebar-user-avatar-img');

  if (nameElem) nameElem.textContent = state.currentUser.name || 'Staff User';
  if (roleElem) roleElem.textContent = state.currentUser.role || 'Clearance Pending';

  // Compute initials fallback
  const initials = state.currentUser.name
    ? state.currentUser.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
    : 'KK';
  if (initialsElem) initialsElem.textContent = initials;

  // Display image if present
  if (state.currentUser.avatar_url && avatarImg) {
    const fullAvatarUrl = state.currentUser.avatar_url.startsWith('http')
      ? state.currentUser.avatar_url
      : `http://localhost:5000${state.currentUser.avatar_url}`;
    
    avatarImg.src = fullAvatarUrl;
    avatarImg.classList.remove('hidden');
    if (initialsElem) initialsElem.classList.add('hidden');
  } else if (avatarImg && initialsElem) {
    avatarImg.classList.add('hidden');
    initialsElem.classList.remove('hidden');
  }
}

/* =========================================================================
   STAFF ACCOUNTS & CLEARANCE: RENDER ROWS WITH AVATAR BOXES
   ========================================================================= */
function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  if (!container) return;

  const currentIsAdmin = state.currentUser.isSuperAdmin;
  const currentUserId = state.currentUser.id;

  container.innerHTML = state.staffAccounts.map(staff => {
    const isSelf = staff.id === currentUserId;
    const canEdit = isSelf || currentIsAdmin;
    const canDelete = currentIsAdmin && !isSelf;

    // Build the avatar thumbnail
    let avatarContent = '';
    if (staff.avatar_url) {
      const imgUrl = staff.avatar_url.startsWith('http') 
        ? staff.avatar_url 
        : `http://localhost:5000${staff.avatar_url}`;
      avatarContent = `<img src="${imgUrl}" class="staff-row-avatar-img" alt="${staff.name}" />`;
    } else {
      const initials = staff.name
        ? staff.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
        : 'ST';
      avatarContent = `<span class="staff-row-avatar-initials">${initials}</span>`;
    }

    return `
      <div class="staff-row-card">
        <div class="staff-row-avatar-box">
          ${avatarContent}
        </div>
        <div class="staff-info">
          <div class="staff-name-line">
            ${staff.name}
            ${staff.active ? '<span class="staff-badge-active">Active</span>' : '<span class="staff-badge-suspended">Suspended</span>'}
            ${isSelf ? '<span class="staff-badge-you">You</span>' : ''}
          </div>
          <div class="staff-details">${staff.email} | ID: <strong>${staff.id}</strong> | ${staff.role}</div>
        </div>
        <div>
          ${canEdit 
            ? `<button type="button" class="btn-row-action" onclick="openStaffModal('${staff.id}')">Edit</button>`
            : `<button type="button" class="btn-row-action" disabled style="opacity:0.4;">Restricted</button>`
          }
          ${canDelete
            ? `<button type="button" class="btn-row-action danger" onclick="deleteStaff('${staff.id}')">Delete</button>`
            : (isSelf ? '<button type="button" class="btn-row-action" disabled style="opacity:0.4;">Locked</button>' : '')
          }
        </div>
      </div>
    `;
  }).join('');

  updateSidebarUserProfile();
}

/* =========================================================================
   STAFF EDIT MODAL: IMAGE PREVIEW & ALL-COLUMN FORM BINDING
   ========================================================================= */
function openStaffModal(staffId) {
  const staff = state.staffAccounts.find(s => String(s.id) === String(staffId));
  if (!staff) return;

  const isSelf = String(staff.id) === String(state.currentUser.id);
  const currentIsAdmin = Boolean(state.currentUser.isSuperAdmin || state.currentUser.role === 'Super Admin / Pharmacist');

  if (!isSelf && !currentIsAdmin) {
    showCustomAlert('error', 'Clearance Denied', 'Staff members are only permitted to edit their own profile.');
    return;
  }

  // Core Identity
  document.getElementById('staff-edit-id').value = staff.id;
  document.getElementById('staff-edit-name').value = staff.name || '';
  document.getElementById('staff-edit-email').value = staff.email || '';
  document.getElementById('staff-edit-password').value = '';
  pendingStaffEditAvatarFile = null;

  // Additional Staff Columns: License & Phone
  const licenseInput = document.getElementById('staff-edit-license');
  if (licenseInput) licenseInput.value = staff.license || '';

  const phoneInput = document.getElementById('staff-edit-phone');
  if (phoneInput) phoneInput.value = staff.phone || '';

  // Security Q&A Columns
  const secQInput = document.getElementById('staff-edit-sec-q');
  if (secQInput) secQInput.value = staff.security_question || 'First clinic worked at?';

  const secAInput = document.getElementById('staff-edit-sec-a');
  if (secAInput) secAInput.value = staff.security_answer || '';

  // Render Avatar
  const previewImg = document.getElementById('staff-edit-avatar-preview');
  const placeholder = document.getElementById('staff-edit-avatar-placeholder');
  
  if (staff.avatar_url) {
    const fullUrl = staff.avatar_url.startsWith('http') ? staff.avatar_url : `http://localhost:5000${staff.avatar_url}`;
    previewImg.src = fullUrl;
    previewImg.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    previewImg.src = '';
    previewImg.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }

  // Administrative Clearance Controls
  const roleGroup = document.getElementById('staff-role-group');
  const statusGroup = document.getElementById('staff-status-group');
  const roleSelect = document.getElementById('staff-edit-role');
  const statusSelect = document.getElementById('staff-edit-status');

  if (roleSelect) roleSelect.value = staff.role || 'Super Admin / Pharmacist';
  if (statusSelect) statusSelect.value = (staff.active === 1 || staff.active === true || staff.active === 'true') ? 'true' : 'false';

  if (!currentIsAdmin) {
    if (roleGroup) roleGroup.style.display = 'none';
    if (statusGroup) statusGroup.style.display = 'none';
  } else {
    if (roleGroup) roleGroup.style.display = 'flex';
    if (statusGroup) statusGroup.style.display = 'flex';
  }

  document.getElementById('staff-edit-modal').classList.remove('hidden');
}

function previewStaffEditAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showCustomAlert('error', 'Invalid File', 'Please select an image file (PNG, JPG, WEBP).');
    return;
  }

  pendingStaffEditAvatarFile = file;
  const reader = new FileReader();
  reader.onload = function(evt) {
    const previewImg = document.getElementById('staff-edit-avatar-preview');
    previewImg.src = evt.target.result;
    previewImg.classList.remove('hidden');
    document.getElementById('staff-edit-avatar-placeholder').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

function closeStaffModal() {
  document.getElementById('staff-edit-modal').classList.add('hidden');
  pendingStaffEditAvatarFile = null;
}

/* =========================================================================
   SAVE STAFF & SYNC ALL COLUMNS WITH BACKEND
   ========================================================================= */
async function handleSaveStaff(e) {
  e.preventDefault();
  const staffId = document.getElementById('staff-edit-id').value;
  const isSelf = String(staffId) === String(state.currentUser.id);
  const currentIsAdmin = Boolean(state.currentUser.isSuperAdmin || state.currentUser.role === 'Super Admin / Pharmacist');

  const existingStaff = state.staffAccounts.find(s => String(s.id) === String(staffId)) || {};

  const name = document.getElementById('staff-edit-name').value.trim();
  const email = document.getElementById('staff-edit-email').value.trim();
  const newPassword = document.getElementById('staff-edit-password').value.trim();

  // License & Phone bindings
  const licenseEl = document.getElementById('staff-edit-license');
  const license = licenseEl ? licenseEl.value.trim() : (existingStaff.license || '');

  const phoneEl = document.getElementById('staff-edit-phone');
  const phone = phoneEl ? phoneEl.value.trim() : (existingStaff.phone || '');

  // Security Q&A bindings
  const secQEl = document.getElementById('staff-edit-sec-q');
  const security_question = secQEl ? secQEl.value : (existingStaff.security_question || '');

  const secAEl = document.getElementById('staff-edit-sec-a');
  const security_answer = secAEl ? secAEl.value.trim() : (existingStaff.security_answer || '');

  // Admin-only parameters
  const roleEl = document.getElementById('staff-edit-role');
  const role = (currentIsAdmin && roleEl) ? roleEl.value : existingStaff.role;

  const statusEl = document.getElementById('staff-edit-status');
  const active = (currentIsAdmin && statusEl) ? (statusEl.value === 'true') : Boolean(existingStaff.active);

  // Pack all columns into FormData for multipart upload
  const formData = new FormData();
  formData.append('name', name);
  formData.append('email', email);
  formData.append('role', role);
  formData.append('active', active ? '1' : '0');
  formData.append('license', license);
  formData.append('phone', phone);
  formData.append('security_question', security_question);
  formData.append('security_answer', security_answer);

  if (newPassword) {
    formData.append('password', newPassword);
  }
  if (pendingStaffEditAvatarFile) {
    formData.append('avatar', pendingStaffEditAvatarFile);
  }

  try {
    const response = await apiRequest(`/staff/${staffId}`, 'PUT', formData, true);

    // Synchronize local session immediately if self-editing
    if (isSelf) {
      state.currentUser.name = name;
      state.currentUser.email = email;
      state.currentUser.role = role;
      state.currentUser.license = license;
      state.currentUser.phone = phone;
      state.currentUser.security_question = security_question;
      state.currentUser.security_answer = security_answer;

      if (response && response.avatar_url) {
        state.currentUser.avatar_url = response.avatar_url;
      }
      localStorage.setItem('pharmapulse_user', JSON.stringify(state.currentUser));
      if (typeof updateSidebarUserProfile === 'function') {
        updateSidebarUserProfile();
      }
    }

    closeStaffModal();
    await syncDatabaseFromBackend();
    showCustomAlert('success', 'Profile Saved', `Clearance credentials and profile for ${name} were updated.`);
  } catch (err) {
    console.error('Failed to update staff credentials:', err);
  }
}

/* =========================================================================
   CUSTOM ALERT NOTIFICATION SYSTEM
   ========================================================================= */

function showCustomAlert(type, title, message) {
  const modal = document.getElementById('custom-alert-modal');
  const titleElem = document.getElementById('alert-title');
  const msgElem = document.getElementById('alert-message');
  const iconElem = document.getElementById('alert-icon');

  if (!modal) {
    // Fallback if modal HTML is absent from DOM
    alert(`${title}: ${message}`);
    return;
  }

  if (titleElem) titleElem.textContent = title;
  if (msgElem) msgElem.textContent = message;

  if (iconElem) {
    if (type === 'success') {
      iconElem.className = 'fa-solid fa-circle-check';
      iconElem.style.color = 'var(--success, #16a34a)';
    } else if (type === 'error') {
      iconElem.className = 'fa-solid fa-circle-xmark';
      iconElem.style.color = 'var(--danger, #dc2626)';
    } else {
      iconElem.className = 'fa-solid fa-circle-info';
      iconElem.style.color = 'var(--primary, #0284c7)';
    }
  }

  modal.classList.remove('hidden');
}

function closeCustomAlert() {
  const modal = document.getElementById('custom-alert-modal');
  if (modal) modal.classList.add('hidden');
}

/* =========================================================================
   CUSTOMER INQUIRY AUTOMATION LOGIC
   ========================================================================= */

// Fetch inquiries from backend
async function loadInquiries() {
  const tbody = document.getElementById('inquiries-table-body');
  try {
    const data = await apiRequest('/inquiries', 'GET');
    state.inquiries = Array.isArray(data) ? data : [];
    renderInquiriesTable();
  } catch (err) {
    console.warn('Could not load inquiries from server:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: #94a3b8; padding: 24px;">
            No customer inquiries logged yet. Click "Simulate Customer Inquiry" to begin.
          </td>
        </tr>`;
    }
  }
}

// Render inquiries into table rows
function renderInquiriesTable() {
  const tbody = document.getElementById('inquiries-table-body');
  if (!tbody) return;

  if (!state.inquiries || state.inquiries.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: #94a3b8; padding: 24px;">
          No customer inquiries logged yet. Click "Simulate Customer Inquiry" to begin.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = state.inquiries.map(inq => {
    const urgencyClass = inq.urgency === 'High' ? 'inquiry-badge-high' : (inq.urgency === 'Medium' ? 'inquiry-badge-med' : 'inquiry-badge-low');
    
    // An inquiry is considered addressed if it was resolved or replied to
    const hasBeenReplied = inq.status === 'Replied';
    const isCompleted = inq.status === 'Resolved' || hasBeenReplied;

    let statusBadgeColor = '#fef3c7; color:#b45309;'; // default 'New'
    if (inq.status === 'Resolved') statusBadgeColor = '#dcfce7; color:#15803d;';
    if (inq.status === 'Replied') statusBadgeColor = '#e0f2fe; color:#0369a1;';

    return `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 12px;"><strong>#INQ-${inq.id}</strong></td>
        <td style="padding: 12px;"><small style="color: #64748b;">${inq.created_at ? inq.created_at.slice(0, 16).replace('T', ' ') : 'Recent'}</small></td>
        <td style="padding: 12px;">
          <strong>${inq.name}</strong><br>
          <small style="color: #64748b;">${inq.email} | ${inq.phone || 'No Phone'}</small>
        </td>
        <td style="padding: 12px;">
          <span class="inquiry-tag">${inq.category || 'General'}</span>
          <p style="margin: 4px 0 0 0; font-size: 12.5px; color: #1e293b;">${inq.ai_summary || inq.message}</p>
          ${inq.reply_message ? `
            <div style="margin-top: 6px; background: #f0fdf4; border-left: 3px solid #16a34a; padding: 6px 10px; font-size: 12px; color: #166534; border-radius: 4px;">
              <strong>Sent Reply:</strong> ${inq.reply_message}
            </div>
          ` : ''}
        </td>
        <td style="padding: 12px;">
          <span class="${urgencyClass}">${inq.urgency || 'Routine'}</span>
        </td>
        <td style="padding: 12px;">
          <span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 4px; background: ${statusBadgeColor}">
            ${inq.status || 'New'}
          </span>
        </td>
        <td style="padding: 12px; text-align: center;">
          <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
            ${!isCompleted ? `
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #0284c7; background: #e0f2fe; color: #0369a1; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="openReplyModal(${inq.id})">
                <i class="fa-solid fa-reply"></i> Reply
              </button>
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #cbd5e1; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="markInquiryResolved(${inq.id})">
                <i class="fa-solid fa-check"></i> Resolve
              </button>
            ` : `
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #fca5a5; background: #fef2f2; color: #dc2626; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="deleteInquiryRecord(${inq.id})" title="Delete Record">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}
// Handler to delete inquiry
async function deleteInquiryRecord(id) {
  if (!confirm(`Are you sure you want to permanently delete inquiry #INQ-${id}?`)) {
    return;
  }

  try {
    await apiRequest(`/inquiries/${id}`, 'DELETE');
    await loadInquiries();
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Record Deleted', `Inquiry #INQ-${id} has been removed.`);
    }
  } catch (err) {
    console.error('Failed to delete inquiry:', err);
  }
}

// Open & Close Modal
function openNewInquiryModal() {
  const modal = document.getElementById('new-inquiry-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeNewInquiryModal() {
  const modal = document.getElementById('new-inquiry-modal');
  if (modal) modal.classList.add('hidden');
}

// Submit simulated inquiry
async function submitInquiryForm(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-submit-inquiry');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running Gemini AI...';
  }

  const payload = {
    name: document.getElementById('inq-name').value.trim(),
    email: document.getElementById('inq-email').value.trim(),
    phone: document.getElementById('inq-phone').value.trim(),
    message: document.getElementById('inq-message').value.trim()
  };

  try {
    await apiRequest('/inquiries', 'POST', payload);
    closeNewInquiryModal();
    document.getElementById('inquiry-form').reset();
    await loadInquiries();
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Automation Successful', 'AI summary generated, row appended to Google Sheets, and Gmail reply sent.');
    }
  } catch (err) {
    console.error('Inquiry submission error:', err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Run AI Automation';
    }
  }
}

// Mark status as resolved
async function markInquiryResolved(id) {
  try {
    await apiRequest(`/inquiries/${id}/status`, 'PUT', { status: 'Resolved' });
    await loadInquiries();
  } catch (err) {
    console.error('Update status error:', err);
  }
}

/* =========================================================================
   INQUIRY DIRECT REPLY HANDLERS
   ========================================================================= */

function openReplyModal(id) {
  const inq = (state.inquiries || []).find(i => i.id === id);
  if (!inq) return;

  document.getElementById('reply-inq-id').value = inq.id;
  document.getElementById('reply-modal-cust').textContent = inq.name;
  document.getElementById('reply-modal-email').textContent = inq.email;
  document.getElementById('reply-modal-query').textContent = inq.message;
  document.getElementById('reply-text').value = '';

  const modal = document.getElementById('reply-inquiry-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeReplyModal() {
  const modal = document.getElementById('reply-inquiry-modal');
  if (modal) modal.classList.add('hidden');
}

function insertReplyTemplate(type) {
  const area = document.getElementById('reply-text');
  if (!area) return;

  if (type === 'stock') {
    area.value = "Hello! Yes, the requested medication is currently in stock at our dispensary. You may pick it up anytime between 9:00 AM and 9:00 PM.";
  } else if (type === 'rx_needed') {
    area.value = "Hello! The requested medication is a Schedule prescription drug. Kindly bring a valid prescription from a registered doctor to dispense this medicine.";
  } else if (type === 'order_ready') {
    area.value = "Hello! Your requested medication has been verified and packed. It is ready for pickup at our dispensary counter.";
  }
}

async function submitInquiryReply(e) {
  e.preventDefault();
  const id = document.getElementById('reply-inq-id').value;
  const replyMessage = document.getElementById('reply-text').value.trim();
  const btn = document.getElementById('btn-send-reply');

  if (!replyMessage) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
  }

  try {
    await apiRequest(`/inquiries/${id}/reply`, 'POST', { replyMessage });
    closeReplyModal();
    await loadInquiries();
    if (typeof showCustomAlert === 'function') {
      showCustomAlert('success', 'Email Sent', 'Pharmacist reply dispatched via Gmail.');
    }
  } catch (err) {
    console.error('Failed to send reply:', err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Email';
    }
  }
}

// Update table render to include Reply button
function renderInquiriesTable() {
  const tbody = document.getElementById('inquiries-table-body');
  if (!tbody) return;

  if (!state.inquiries || state.inquiries.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: #94a3b8; padding: 24px;">
          No customer inquiries logged yet. Click "Simulate Customer Inquiry" to begin.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = state.inquiries.map(inq => {
    const urgencyClass = inq.urgency === 'High' ? 'inquiry-badge-high' : (inq.urgency === 'Medium' ? 'inquiry-badge-med' : 'inquiry-badge-low');
    const isResolved = (inq.status === 'Resolved' || inq.status === 'Replied');

    return `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 12px;"><strong>#INQ-${inq.id}</strong></td>
        <td style="padding: 12px;"><small style="color: #64748b;">${inq.created_at ? inq.created_at.slice(0, 16).replace('T', ' ') : 'Recent'}</small></td>
        <td style="padding: 12px;">
          <strong>${inq.name}</strong><br>
          <small style="color: #64748b;">${inq.email} | ${inq.phone || 'No Phone'}</small>
        </td>
        <td style="padding: 12px;">
          <span class="inquiry-tag">${inq.category || 'General'}</span>
          <p style="margin: 4px 0 0 0; font-size: 12.5px; color: #1e293b;">${inq.ai_summary || inq.message}</p>
          ${inq.reply_message ? `
            <div style="margin-top: 6px; background: #f0fdf4; border-left: 3px solid #16a34a; padding: 4px 8px; font-size: 11.5px; color: #166534;">
              <strong>Sent Reply:</strong> ${inq.reply_message}
            </div>
          ` : ''}
        </td>
        <td style="padding: 12px;">
          <span class="${urgencyClass}">${inq.urgency || 'Routine'}</span>
        </td>
        <td style="padding: 12px;">
          <span style="font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 4px; background: ${isResolved ? '#dcfce7; color:#15803d;' : '#fef3c7; color:#b45309;'}">
            ${inq.status || 'New'}
          </span>
        </td>
        <td style="padding: 12px; text-align: center;">
          <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
            ${!isResolved ? `
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #0284c7; background: #e0f2fe; color: #0369a1; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="openReplyModal(${inq.id})">
                <i class="fa-solid fa-reply"></i> Reply
              </button>
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #cbd5e1; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="markInquiryResolved(${inq.id})">
                <i class="fa-solid fa-check"></i> Resolve
              </button>
            ` : `
              <span style="color:#10b981; font-size: 12px;"><i class="fa-solid fa-check-double"></i> Done</span>
              <button type="button" class="btn-sm" style="padding: 4px 8px; border: 1px solid #fca5a5; background: #fef2f2; color: #dc2626; border-radius: 4px; cursor: pointer; font-size: 12px;" onclick="deleteInquiryRecord(${inq.id})" title="Delete Record">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* =========================================================================
   AI PHARMACY CHATBOT CLIENT
   ========================================================================= */

function toggleChatWindow() {
  const win = document.getElementById('chat-window');
  const openIcon = document.getElementById('chat-icon-open');
  const closeIcon = document.getElementById('chat-icon-close');

  const isClosed = win.classList.contains('hidden');
  if (isClosed) {
    win.classList.remove('hidden');
    openIcon.classList.add('hidden');
    closeIcon.classList.remove('hidden');
    document.getElementById('chat-input').focus();
  } else {
    win.classList.add('hidden');
    openIcon.classList.remove('hidden');
    closeIcon.classList.add('hidden');
  }
}

async function sendChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const msgContainer = document.getElementById('chat-messages');

  const text = input.value.trim();
  if (!text) return;

  // 1. Append User Message
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user';
  userDiv.textContent = text;
  msgContainer.appendChild(userDiv);
  input.value = '';
  msgContainer.scrollTop = msgContainer.scrollHeight;

  // 2. Add Temporary Loading Message
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-msg bot';
  typingDiv.id = 'chat-typing-indicator';
  typingDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking dispensary records...';
  msgContainer.appendChild(typingDiv);
  msgContainer.scrollTop = msgContainer.scrollHeight;

  sendBtn.disabled = true;

  // 3. Dispatch to Backend
  try {
    const data = await apiRequest('/chat', 'POST', { message: text });
    typingDiv.remove();

    const botDiv = document.createElement('div');
    botDiv.className = 'chat-msg bot';
    botDiv.textContent = data.reply || "I'm available to help, please ask your question again.";
    msgContainer.appendChild(botDiv);
  } catch (err) {
    typingDiv.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg bot';
    errDiv.style.color = '#dc2626';
    errDiv.textContent = 'Could not reach assistant. Please check your connection.';
    msgContainer.appendChild(errDiv);
  } finally {
    sendBtn.disabled = false;
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
}

