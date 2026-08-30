// Supporto configurazione centralizzata via CloudFront / ALB o fallback locale
const isCloudFront = window.location.hostname.includes('cloudfront.net');
const hasCustomUrl = typeof window.GLAMDROP_API_URL === 'string' && window.GLAMDROP_API_URL.trim().length > 0;
const albBaseUrl = hasCustomUrl ? window.GLAMDROP_API_URL.replace(/\/$/, '') : (isCloudFront ? '' : null);
const currentHost = window.location.hostname;
const currentPort = window.location.port;

let defaultAuthUrl = albBaseUrl !== null ? albBaseUrl : `http://${currentHost}:3001`;
let defaultBookingUrl = albBaseUrl !== null ? albBaseUrl : `http://${currentHost}:3002`;
let defaultDropUrl = albBaseUrl !== null ? albBaseUrl : `http://${currentHost}:3003`;
let defaultNotifUrl = albBaseUrl !== null ? albBaseUrl : `http://${currentHost}:3004`;

// In ambiente Kubernetes su IP nodo o remoto senza ALB
if (albBaseUrl === null && (currentHost !== 'localhost' && currentHost !== '127.0.0.1')) {
  defaultAuthUrl = `http://${currentHost}:30001`;
  defaultBookingUrl = `http://${currentHost}:30002`;
  defaultDropUrl = `http://${currentHost}:30003`;
  defaultNotifUrl = `http://${currentHost}:30004`;
}

// Reset localStorage config if hostname or port has changed to avoid using stale cached API paths
const cachedAuth = localStorage.getItem('cfg_auth_url');
if (cachedAuth) {
  try {
    const originBase = window.location.origin || `${window.location.protocol}//${window.location.host}`;
    const cachedUrl = new URL(cachedAuth, originBase);
    const defaultUrl = new URL(defaultAuthUrl || '/', originBase);
    if (cachedUrl.hostname !== defaultUrl.hostname || cachedUrl.port !== defaultUrl.port) {
      localStorage.removeItem('cfg_auth_url');
      localStorage.removeItem('cfg_booking_url');
      localStorage.removeItem('cfg_drop_url');
      localStorage.removeItem('cfg_notif_url');
    }
  } catch (e) {
    localStorage.removeItem('cfg_auth_url');
    localStorage.removeItem('cfg_booking_url');
    localStorage.removeItem('cfg_drop_url');
    localStorage.removeItem('cfg_notif_url');
  }
}

let AUTH_API = localStorage.getItem('cfg_auth_url') || defaultAuthUrl;
let BOOKING_API = localStorage.getItem('cfg_booking_url') || defaultBookingUrl;
let DROP_API = localStorage.getItem('cfg_drop_url') || defaultDropUrl;
let NOTIF_API = localStorage.getItem('cfg_notif_url') || defaultNotifUrl;

// Identificazione del portale attivo (Client vs Partner B2B)
const isPartnerPage = typeof document !== 'undefined' && (
  (document.body && document.body.classList.contains('partner-portal')) ||
  window.location.pathname.includes('partner.html')
);

const SESSION_KEY = isPartnerPage ? 'currentUser_partner' : 'currentUser_client';

function getStoredUser() {
  try {
    const specific = localStorage.getItem(SESSION_KEY);
    if (specific) return JSON.parse(specific);
    
    // Fallback retrocompatibile con la vecchia chiave unica
    const legacy = localStorage.getItem('currentUser');
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (isPartnerPage && (parsed.role === 'salon_manager' || parsed.role === 'employee')) {
        return parsed;
      }
      if (!isPartnerPage && parsed.role === 'client') {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

// Global State
let currentUser = getStoredUser();

// Intercettore globale Fetch per gestire le scadenze dei token di autenticazione (401/403)
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  let [resource, config] = args;
  
  if (currentUser && currentUser.token) {
    if (!config) config = {};
    if (!config.headers) config.headers = {};
    
    if (config.headers instanceof Headers) {
      if (!config.headers.has('Authorization')) {
        config.headers.set('Authorization', `Bearer ${currentUser.token}`);
      }
    } else {
      if (!config.headers['Authorization'] && !config.headers['authorization']) {
        config.headers['Authorization'] = `Bearer ${currentUser.token}`;
      }
    }
  }

  try {
    const response = await originalFetch(resource, config);
    if (response.status === 401 || response.status === 403) {
      const urlStr = String(resource);
      if (!urlStr.includes('/api/auth/verify') && !urlStr.includes('/api/auth/client/login') && !urlStr.includes('/api/auth/salon/login') && !urlStr.includes('/api/auth/employee/login')) {
        console.warn('Session expired or unauthorized (401/403):', urlStr);
        alert('La tua sessione è scaduta. Effettua nuovamente l\'accesso per continuare.');
        performLogout();
        if (window.location.pathname.includes('partner.html')) {
          window.location.reload();
        } else {
          openLogin('client');
        }
      }
    }
    return response;
  } catch (error) {
    throw error;
  }
};

let currentSalonId = null; // for currently browsing client
let currentActiveDrops = [];
let simTokens = []; // collected tokens for concurrency test
let simDropId = null;

// DOM Elements (Shared)
const navButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsForm = document.getElementById('settings-form');
const loginModal = document.getElementById('login-modal');
const registerModal = document.getElementById('register-modal');
const bookingModal = document.getElementById('booking-modal');
const userDisplay = document.getElementById('user-display');
const userNameSpan = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout-btn');

// Console Log Helper
const consoleLogs = document.getElementById('console-logs');
const toggleConsoleBtn = document.getElementById('toggle-console-btn');
const footerConsole = document.querySelector('.footer-log-console');
const consoleChevron = document.getElementById('console-chevron');

// Helper to safely add event listeners to elements that may or may not exist on the page
function addSafeListener(id, event, callback) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, callback);
  }
}

function logConsole(message, type = 'system') {
  if (!consoleLogs) return;
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  line.innerHTML = `[${timestamp}] ${message}`;
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Toggle bottom console panel
if (toggleConsoleBtn) {
  toggleConsoleBtn.addEventListener('click', () => {
    footerConsole.classList.toggle('open');
    const isOpen = footerConsole.classList.contains('open');
    consoleChevron.innerHTML = isOpen ? '<i class="fa-solid fa-chevron-down"></i>' : '<i class="fa-solid fa-chevron-up"></i>';
  });
}

// Configure API modal
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    document.getElementById('cfg-auth-url').value = AUTH_API;
    document.getElementById('cfg-booking-url').value = BOOKING_API;
    document.getElementById('cfg-drop-url').value = DROP_API;
    settingsModal.showModal();
  });
}

if (settingsForm) {
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    AUTH_API = document.getElementById('cfg-auth-url').value.replace(/\/$/, "");
    BOOKING_API = document.getElementById('cfg-booking-url').value.replace(/\/$/, "");
    DROP_API = document.getElementById('cfg-drop-url').value.replace(/\/$/, "");
    
    localStorage.setItem('cfg_auth_url', AUTH_API);
    localStorage.setItem('cfg_booking_url', BOOKING_API);
    localStorage.setItem('cfg_drop_url', DROP_API);
    
    // Re-detect or save notifications URL matching the host or ALB
    try {
      if (AUTH_API.includes(':30001') || AUTH_API.includes(':3001')) {
        const authHost = new URL(AUTH_API).hostname;
        NOTIF_API = AUTH_API.includes('30001') ? `http://${authHost}:30004` : `http://${authHost}:3004`;
      } else {
        NOTIF_API = AUTH_API;
      }
    } catch (e) {
      NOTIF_API = AUTH_API;
    }
    localStorage.setItem('cfg_notif_url', NOTIF_API);

    logConsole(`Endpoint API salvati: Auth=${AUTH_API}, Booking=${BOOKING_API}, Drop=${DROP_API}, Notif=${NOTIF_API}`, 'system');
    settingsModal.close();
    initApp();
  });
}

// Tab Switching
navButtons.forEach(button => {
  button.addEventListener('click', () => {
    const targetTab = button.getAttribute('data-tab');
    navButtons.forEach(btn => btn.classList.remove('active'));
    tabContents.forEach(content => content.classList.remove('active'));
    
    button.classList.add('active');
    const tabEl = document.getElementById(targetTab);
    if (tabEl) {
      tabEl.classList.add('active');
    }
    
    if (targetTab === 'simulator-tab') {
      loadSimDrops();
    }
  });
});

// Initialize App
function initApp() {
  if (typeof initPhotoUploaders === 'function') initPhotoUploaders();
  // Set up dynamic portal link redirections based on host and port
  const partnerLink = document.getElementById('partner-portal-link');
  const footerPartnerLink = document.getElementById('footer-partner-portal-link');
  const clientLink = document.getElementById('client-portal-link');
  
  const setPartnerHref = (el) => {
    if (!el) return;
    if (currentHost === 'glamdrop.local') {
      el.href = 'http://partner.glamdrop.local';
    } else if (currentPort === '30080') {
      el.href = `http://${currentHost}:30081`;
    } else if (currentPort === '8080') {
      el.href = `http://${currentHost}:8081`;
    } else {
      el.href = 'partner.html';
    }
  };
  setPartnerHref(partnerLink);
  setPartnerHref(footerPartnerLink);
  
  const footerClientLink = document.getElementById('footer-client-portal-link');
  const footerSimLink = document.getElementById('footer-sim-link');

  const setClientHref = (el) => {
    if (!el) return;
    if (currentHost === 'partner.glamdrop.local') {
      el.href = 'http://glamdrop.local';
    } else if (currentPort === '30081') {
      el.href = `http://${currentHost}:30080`;
    } else if (currentPort === '8081') {
      el.href = `http://${currentHost}:8080`;
    } else {
      el.href = 'index.html';
    }
  };
  setClientHref(clientLink);
  setClientHref(footerClientLink);

  if (footerSimLink) {
    let clientBaseUrl = 'index.html';
    if (currentHost === 'partner.glamdrop.local') {
      clientBaseUrl = 'http://glamdrop.local';
    } else if (currentPort === '30081') {
      clientBaseUrl = `http://${currentHost}:30080`;
    } else if (currentPort === '8081') {
      clientBaseUrl = `http://${currentHost}:8080`;
    }
    footerSimLink.href = `${clientBaseUrl}?tab=simulator`;
  }

  // Handle tab routing from URL query params
  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam === 'simulator') {
    switchToSimulatorTab();
  }

  const cityInput = document.getElementById('search-salon-location');
  const cityPanel = document.getElementById('city-dropdown-panel');
  
  if (cityInput && cityPanel) {
    const renderSuggestions = async (query) => {
      if (query.length < 2) {
        cityPanel.innerHTML = '';
        cityPanel.style.display = 'none';
        return;
      }
      try {
        const res = await fetch(`${AUTH_API}/api/auth/cities?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('API error');
        const cities = await res.json();
        
        cityPanel.innerHTML = '';
        if (cities.length === 0) {
          cityPanel.style.display = 'none';
          return;
        }
        
        cities.forEach(city => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          item.innerHTML = `
            <div class="autocomplete-icon-wrapper">
              <i class="fa-solid fa-location-dot"></i>
            </div>
            <div class="autocomplete-info">
              <span class="autocomplete-city-name">${city.name}</span>
              <span class="autocomplete-province-country">${city.province}, ${city.region}</span>
            </div>
          `;
          item.addEventListener('mousedown', (e) => {
            cityInput.value = city.name;
            cityPanel.style.display = 'none';
            filterSalonsAndServices();
          });
          cityPanel.appendChild(item);
        });
        cityPanel.style.display = 'block';
      } catch (err) {
        console.error('Errore durante la ricerca delle città:', err);
      }
    };
    
    cityInput.addEventListener('input', (e) => {
      renderSuggestions(e.target.value.trim());
    });
    
    cityInput.addEventListener('focus', () => {
      renderSuggestions(cityInput.value.trim());
    });
    
    cityInput.addEventListener('blur', () => {
      setTimeout(() => {
        cityPanel.style.display = 'none';
      }, 200);
    });
  }

  // Add Preferred City Autocomplete
  const addPrefCityInput = document.getElementById('add-pref-city');
  const addPrefCityPanel = document.getElementById('add-pref-city-panel');
  
  if (addPrefCityInput && addPrefCityPanel) {
    const renderAddSuggestions = async (query) => {
      if (query.length < 2) {
        addPrefCityPanel.innerHTML = '';
        addPrefCityPanel.style.display = 'none';
        return;
      }
      try {
        const res = await fetch(`${AUTH_API}/api/auth/cities?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('API error');
        const cities = await res.json();
        
        addPrefCityPanel.innerHTML = '';
        if (cities.length === 0) {
          addPrefCityPanel.style.display = 'none';
          return;
        }
        
        cities.forEach(city => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          item.innerHTML = `
            <div class="autocomplete-icon-wrapper">
              <i class="fa-solid fa-location-dot"></i>
            </div>
            <div class="autocomplete-info">
              <span class="autocomplete-city-name">${city.name}</span>
              <span class="autocomplete-province-country">${city.province}, ${city.region}</span>
            </div>
          `;
          item.addEventListener('mousedown', (e) => {
            addCityTag(city.name);
            addPrefCityInput.value = '';
            addPrefCityPanel.style.display = 'none';
          });
          addPrefCityPanel.appendChild(item);
        });
        addPrefCityPanel.style.display = 'block';
      } catch (err) {
        console.error('Errore durante la ricerca città preferite:', err);
      }
    };
    
    addPrefCityInput.addEventListener('input', (e) => {
      renderAddSuggestions(e.target.value.trim());
    });
    addPrefCityInput.addEventListener('focus', () => {
      renderAddSuggestions(addPrefCityInput.value.trim());
    });
    addPrefCityInput.addEventListener('blur', () => {
      setTimeout(() => {
        addPrefCityPanel.style.display = 'none';
      }, 200);
    });
  }

  // Custom Category Picker
  const catInput = document.getElementById('search-salon-category-input');
  const catPanel = document.getElementById('category-dropdown-panel');
  const catHidden = document.getElementById('search-salon-category');
  
  if (catInput && catPanel) {
    catInput.addEventListener('focus', () => {
      catPanel.style.display = 'block';
    });
    catInput.addEventListener('blur', () => {
      setTimeout(() => {
        catPanel.style.display = 'none';
      }, 200);
    });
    
    catPanel.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('mousedown', () => {
        const val = item.getAttribute('data-val');
        const name = item.querySelector('.autocomplete-city-name').textContent;
        catInput.value = name;
        catHidden.value = val;
        catPanel.style.display = 'none';
        filterSalonsAndServices();
      });
    });
  }

  // Custom Datetime Picker
  const dtInput = document.getElementById('search-salon-datetime');
  const dtPanel = document.getElementById('datetime-dropdown-panel');
  const confirmDtBtn = document.getElementById('confirm-datetime-btn');
  const dateHidden = document.getElementById('search-salon-date');
  const timeHidden = document.getElementById('search-salon-time');
  
  const dateVal = document.getElementById('picker-date-val');
  const timeVal = document.getElementById('picker-time-val');
  
  if (dtInput && dtPanel) {
    dtInput.addEventListener('focus', () => {
      dtPanel.style.display = 'block';
    });
    
    document.addEventListener('mousedown', (e) => {
      const wrapper = document.getElementById('datetime-picker-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        dtPanel.style.display = 'none';
      }
    });
    
    if (confirmDtBtn) {
      confirmDtBtn.addEventListener('click', () => {
        const d = dateVal.value;
        const t = timeVal.value;
        
        dateHidden.value = d;
        timeHidden.value = t;
        
        if (d && t) {
          const formattedDate = new Date(d).toLocaleDateString('it-IT');
          dtInput.value = `${formattedDate} alle ${t}`;
        } else if (d) {
          const formattedDate = new Date(d).toLocaleDateString('it-IT');
          dtInput.value = `${formattedDate}`;
        } else if (t) {
          dtInput.value = `Ogni giorno alle ${t}`;
        } else {
          dtInput.value = '';
        }
        
        dtPanel.style.display = 'none';
        filterSalonsAndServices();
      });
    }
  }

  // Reset Filters Button
  const resetFiltersBtn = document.getElementById('reset-search-filters');
  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener('click', () => {
      document.getElementById('search-salon-name').value = '';
      document.getElementById('search-salon-location').value = '';
      
      const catInput = document.getElementById('search-salon-category-input');
      const catHidden = document.getElementById('search-salon-category');
      if (catInput) catInput.value = '';
      if (catHidden) catHidden.value = 'all';
      
      const dtInput = document.getElementById('search-salon-datetime');
      const dateHidden = document.getElementById('search-salon-date');
      const timeHidden = document.getElementById('search-salon-time');
      const dateVal = document.getElementById('picker-date-val');
      const timeVal = document.getElementById('picker-time-val');
      
      if (dtInput) dtInput.value = '';
      if (dateHidden) dateHidden.value = '';
      if (timeHidden) timeHidden.value = '';
      if (dateVal) dateVal.value = '';
      if (timeVal) timeVal.value = '';
      
      filterSalonsAndServices();
    });
  }

  updateUserUI();
  loadSalonsForClient();
  loadActiveDrops();
  
  const statusFilter = document.getElementById('filter-booking-status');
  const sortSelect = document.getElementById('sort-booking-by');
  if (statusFilter) {
    statusFilter.addEventListener('change', renderFilteredClientBookings);
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', renderFilteredClientBookings);
  }
  
  // Start polling drops and notification logs every 1 second for instant refresh
  setInterval(loadActiveDrops, 1000);
  setInterval(pollNotificationLogs, 1000);

  // Poll B2B bookings for real-time dashboard updates instantly (every 1 second)
  setInterval(() => {
    if (currentUser) {
      if (currentUser.role === 'salon_manager') {
        loadSalonBookings();
      } else if (currentUser.role === 'employee') {
        loadEmployeeBookings();
      }
    }
  }, 1000);
}

// Poll logs from Python service (if available)
let lastLoggedNotifId = -1;
async function pollNotificationLogs() {
  try {
    const res = await fetch(`${NOTIF_API}/api/notifications`);
    if (res.ok) {
      const logs = await res.json();
      // Only display new notifications
      logs.forEach(log => {
        if (log.id > lastLoggedNotifId) {
          lastLoggedNotifId = log.id;
          const type = log.type.includes('DROP') ? 'drop' : 'booking';
          logConsole(log.message, type);
        }
      });
    }
  } catch (err) {
    // Silently ignore if notif-service is offline
  }
}

// Update User Login/Logout UI
function updateUserUI() {
  const authNavButtons = document.getElementById('auth-nav-buttons');
  const clBookingsNavBtn = document.getElementById('client-bookings-nav-btn');
  const partnerTabs = document.querySelector('.partner-tabs-container');
  const profileMenuContainer = document.getElementById('profile-menu-container');
  const mailboxBtn = document.getElementById('mailbox-btn');
  const profileDropdownName = document.getElementById('profile-dropdown-name');

  if (currentUser) {
    if (userNameSpan) {
      userNameSpan.textContent = `${currentUser.first_name} (${currentUser.role.toUpperCase()})`;
    }
    if (userDisplay) {
      userDisplay.style.display = 'flex';
    }
    if (profileMenuContainer) {
      profileMenuContainer.style.display = 'block';
    }
    if (profileDropdownName) {
      profileDropdownName.textContent = currentUser.first_name;
    }
    if (authNavButtons) {
      authNavButtons.style.display = 'none';
    }
    
    const isPartnerPage = document.body.classList.contains('partner-portal') || window.location.pathname.includes('partner.html');

    // Enable/Disable sections based on role
    if (currentUser.role === 'client') {
      if (clBookingsNavBtn) clBookingsNavBtn.style.display = 'inline-flex';
      if (mailboxBtn) mailboxBtn.style.display = 'inline-flex';
      loadClientBookings();
      if (partnerTabs) partnerTabs.style.display = 'flex';
      initMailboxPolling();
    } else {
      if (clBookingsNavBtn) clBookingsNavBtn.style.display = 'none';
      if (mailboxBtn) mailboxBtn.style.display = 'inline-flex';
      if (profileMenuContainer) profileMenuContainer.style.display = 'block';
      if (partnerTabs) partnerTabs.style.display = 'none'; // Hide role switching once logged in as a partner
      
      initMailboxPolling();

      if (isPartnerPage) {
        const guestLanding = document.getElementById('partner-guest-landing-view');
        if (guestLanding) {
          guestLanding.style.display = 'none';
          guestLanding.classList.add('hidden');
        }

        if (currentUser.role === 'salon_manager') {
          const view = document.getElementById('manager-dashboard-view');
          if (view) view.style.display = 'grid';
          loadSalonDetails();
          loadSalonBookings();

          // Automatically activate manager tab
          document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
          const managerContent = document.getElementById('manager-tab');
          if (managerContent) {
            managerContent.style.display = 'block';
            managerContent.classList.add('active');
          }
          const empTab = document.getElementById('employee-tab');
          if (empTab) empTab.style.display = 'none';

        } else if (currentUser.role === 'employee') {
          const view = document.getElementById('employee-dashboard-view');
          if (view) view.style.display = 'grid';
          loadEmployeeSchedules();
          loadEmployeeBookings();
          loadEmployeeUnavailabilities();

          // Automatically activate employee tab
          document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
          const employeeContent = document.getElementById('employee-tab');
          if (employeeContent) {
            employeeContent.style.display = 'block';
            employeeContent.classList.add('active');
          }
          const mgrTab = document.getElementById('manager-tab');
          if (mgrTab) mgrTab.style.display = 'none';
        }
      } else {
        // We are on index.html (client page)
        const clientTab = document.getElementById('client-tab');
        if (clientTab) {
          clientTab.style.display = 'block';
          clientTab.classList.add('active');
        }
        const salonsListView = document.getElementById('salons-list-view');
        if (salonsListView) {
          salonsListView.style.display = 'block';
        }
      }
    }
  } else {
    if (userDisplay) {
      userDisplay.style.display = 'none';
    }
    if (profileMenuContainer) {
      profileMenuContainer.style.display = 'none';
    }
    if (mailboxBtn) {
      mailboxBtn.style.display = 'none';
    }
    if (authNavButtons) {
      authNavButtons.style.display = 'flex';
    }
    if (clBookingsNavBtn) {
      clBookingsNavBtn.style.display = 'none';
    }
    if (partnerTabs) {
      partnerTabs.style.display = 'none';
    }
    
    // Clear own city filter on logout
    const cityInput = document.getElementById('search-salon-location');
    if (cityInput) {
      cityInput.value = '';
      filterSalonsAndServices();
    }
    
    stopMailboxPolling();
    const guestLanding = document.getElementById('partner-guest-landing-view');
    if (guestLanding) {
      guestLanding.style.display = 'flex';
      guestLanding.classList.remove('hidden');
    }

    const mgrTab = document.getElementById('manager-tab');
    if (mgrTab) mgrTab.style.display = 'none';
    const mgrView = document.getElementById('manager-dashboard-view');
    if (mgrView) mgrView.style.display = 'none';

    const empTab = document.getElementById('employee-tab');
    if (empTab) empTab.style.display = 'none';
    const empView = document.getElementById('employee-dashboard-view');
    if (empView) empView.style.display = 'none';
     
    const clBookingsList = document.getElementById('dedicated-bookings-list');
    if (clBookingsList) {
      clBookingsList.innerHTML = '<p class="placeholder-text">Accedi come Cliente per vedere le tue prenotazioni.</p>';
    }
    const saBookingsList = document.getElementById('salon-bookings-list');
    if (saBookingsList) {
      saBookingsList.innerHTML = '<p class="placeholder-text">Accedi come Gestore per visualizzare l\'agenda del salone.</p>';
    }
    const emBookingsList = document.getElementById('employee-bookings-list');
    if (emBookingsList) {
      emBookingsList.innerHTML = '<p class="placeholder-text">Accedi come Dipendente per visualizzare il tuo calendario appuntamenti.</p>';
    }
  }
}

// Log out user
function performLogout() {
  if (currentUser) {
    logConsole(`Logout effettuato per ${currentUser.email}`, 'system');
  }
  currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('currentUser');
  updateUserUI();
  if (!isPartnerPage) {
    showSalonsList();
  }
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    performLogout();
  });
}
addSafeListener('logout-dropdown-btn', 'click', () => {
  performLogout();
});

// Authentication Modal Openers with Event Delegation
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.open-login-btn') : null;
  if (btn) {
    const role = btn.getAttribute('data-role');
    openLogin(role);
  }
});

let currentAuthRole = (typeof window !== 'undefined' && (window.location.hostname.includes('partner') || (document.body && document.body.classList.contains('partner-portal')))) ? 'salon_manager' : 'client';
function openLogin(role) {
  if (role) {
    currentAuthRole = role;
  } else if (typeof window !== 'undefined' && (window.location.hostname.includes('partner') || (document.body && document.body.classList.contains('partner-portal')))) {
    currentAuthRole = 'salon_manager';
  } else {
    currentAuthRole = 'client';
  }
  
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  if (emailInput) emailInput.value = '';
  if (passwordInput) passwordInput.value = '';

  const badge = document.getElementById('modal-role-badge');
  const title = document.getElementById('login-modal-title');
  const regBox = document.getElementById('register-toggle-box');

  if (badge) {
    if (currentAuthRole === 'client') {
      badge.textContent = 'Cliente';
      badge.className = 'role-badge';
    } else if (currentAuthRole === 'salon_manager') {
      badge.textContent = 'Salone (Manager)';
      badge.className = 'role-badge status-confirmed';
    } else if (currentAuthRole === 'employee') {
      badge.textContent = 'Dipendente / Estetista';
      badge.className = 'role-badge info-badge';
    } else {
      badge.textContent = currentAuthRole.replace('_', ' ');
      badge.className = 'role-badge info-badge';
    }
  }

  if (title) {
    if (currentAuthRole === 'employee') {
      title.textContent = 'Accedi Dipendente';
    } else if (currentAuthRole === 'salon_manager') {
      title.textContent = 'Accedi Partner Salone';
    } else {
      title.textContent = 'Accedi';
    }
  }

  if (regBox) {
    if (currentAuthRole === 'employee') {
      // Nella sezione dipendente deve esserci solo possibilità di login (estetista registrata dal manager)
      regBox.style.display = 'none';
    } else {
      regBox.style.display = 'block';
      if (currentAuthRole === 'salon_manager') {
        regBox.innerHTML = 'Non hai registrato il salone? <a href="#" id="toggle-register-btn">Registralo ora</a>';
      } else {
        regBox.innerHTML = 'Non hai un account? <a href="#" id="toggle-register-btn">Registrati ora</a>';
      }
    }
  }
  
  if (loginModal) loginModal.showModal();
}

// Toggle register dialog (Event delegation for dynamic elements)
document.addEventListener('click', (e) => {
  if (e.target && (e.target.id === 'toggle-register-btn' || e.target.closest('#toggle-register-btn'))) {
    e.preventDefault();
    if (loginModal) loginModal.close();
    
    const isPartner = typeof window !== 'undefined' && (window.location.hostname.includes('partner') || (document.body && document.body.classList.contains('partner-portal')));
    if (isPartner && currentAuthRole !== 'employee') currentAuthRole = 'salon_manager';

    // Configure register form for manager details if role is manager
    const managerFields = document.getElementById('manager-reg-fields');
    if (managerFields) {
      if (currentAuthRole === 'salon_manager') {
        managerFields.style.display = 'block';
      } else {
        managerFields.style.display = 'none';
      }
    }
    
    if (registerModal) registerModal.showModal();
  }
});

// Submit Login
addSafeListener('login-form', 'submit', async (e) => {
  e.preventDefault();
  const emailEl = document.getElementById('login-email');
  const passwordEl = document.getElementById('login-password');
  const email = emailEl ? emailEl.value.trim() : '';
  const password = passwordEl ? passwordEl.value : '';

  const submitBtn = e.target.querySelector('[type="submit"]');
  const originalBtnContent = submitBtn ? submitBtn.innerHTML : 'Accedi';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Accesso in corso...';
  }
  
  let endpoint = `${AUTH_API}/api/auth/client/login`;
  if (currentAuthRole === 'salon_manager') endpoint = `${AUTH_API}/api/auth/salon/login`;
  if (currentAuthRole === 'employee') endpoint = `${AUTH_API}/api/auth/employee/login`;
  
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Credenziali non valide');
      return;
    }
    
    currentUser = data.user;
    currentUser.token = data.token;
    const targetSessionKey = (currentUser.role === 'salon_manager' || currentUser.role === 'employee') 
      ? 'currentUser_partner' 
      : 'currentUser_client';
    localStorage.setItem(targetSessionKey, JSON.stringify(currentUser));
    localStorage.removeItem('currentUser');
    
    logConsole(`Login avvenuto con successo: ${currentUser.email}`, 'system');
    if (loginModal) loginModal.close();
    updateUserUI();
    
  } catch (err) {
    alert('Errore di connessione con il servizio Auth. Verifica che il servizio sia attivo e le impostazioni siano corrette.');
    console.error(err);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnContent;
    }
  }
});

// Submit Registration
addSafeListener('register-form', 'submit', async (e) => {
  e.preventDefault();

  const isPartner = typeof window !== 'undefined' && (window.location.hostname.includes('partner') || (document.body && document.body.classList.contains('partner-portal')));
  if (isPartner) currentAuthRole = 'salon_manager';

  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const first_name = document.getElementById('reg-firstname').value.trim();
  const last_name = document.getElementById('reg-lastname').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();

  let payload = { email, password, first_name, last_name, phone };
  let endpoint = `${AUTH_API}/api/auth/client/register`;

  if (currentAuthRole === 'salon_manager') {
    endpoint = `${AUTH_API}/api/auth/salon/register`;
    const nameEl = document.getElementById('reg-salonname');
    const streetEl = document.getElementById('reg-salonstreet');
    const cityEl = document.getElementById('reg-saloncity');
    const descEl = document.getElementById('reg-salondescription');
    payload.name = nameEl ? nameEl.value.trim() : '';
    payload.street = streetEl ? streetEl.value.trim() : '';
    payload.city = cityEl ? cityEl.value.trim() : '';
    payload.description = descEl ? descEl.value.trim() : '';

    if (!payload.name || !payload.street || !payload.city) {
      alert('Compila tutti i campi obbligatori del salone: Nome, Via e Città.');
      return;
    }
  }

  console.log(`[REGISTER] Endpoint: ${endpoint}`);
  console.log(`[REGISTER] Payload:`, { ...payload, password: '***' });

  const submitBtn = e.target.querySelector('[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Registrazione in corso...'; }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = {};
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error('[REGISTER] Risposta non JSON:', parseErr);
    }

      console.log('[REGISTER] Risposta [', res.status, ']:', data);

    if (!res.ok) {
      const errMsg = data.error || data.message || `Errore HTTP ${res.status}`;
      const detailMsg = data.details ? `\n\nDettagli: ${data.details}` : '';
      alert(`Errore registrazione:\n${errMsg}${detailMsg}\n\n(auth-service: ${AUTH_API})`);
      return;
    }

    alert('Registrazione completata con successo! Ora puoi accedere.');
    if (registerModal) registerModal.close();
    loadSalonsForClient();
    openLogin(currentAuthRole);

  } catch (err) {
    console.error('[REGISTER] Errore di rete:', err);
    alert(`Impossibile contattare il server di autenticazione.\n\nURL tentato: ${endpoint}\nErrore: ${err.message}\n\nAssicurati che il servizio auth sia avviato.`);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Registrati'; }
  }
});

// --- CLIENT APIS ---

// Load list of Salons and construct Client view
let currentSalonsList = [];
let currentSalonServices = [];
let salonServicesMap = {};

async function loadSalonsForClient() {
  const grid = document.getElementById('salons-grid');
  if (!grid) return; // Not on the client index page
  
  const salonSelect = document.getElementById('salon-select');
  
  try {
    const res = await fetch(`${AUTH_API}/api/auth/salons`);
    if (!res.ok) {
      grid.innerHTML = '<p class="placeholder-text text-danger">Servizio catalogo non raggiungibile (CORS o Connessione fallita).</p>';
      return;
    }
    currentSalonsList = await res.json();
    
    if (currentSalonsList.length === 0) {
      grid.innerHTML = '<p class="placeholder-text">Nessun salone disponibile nel database.</p>';
      if (salonSelect) {
        salonSelect.innerHTML = '<option value="">Nessun salone disponibile</option>';
      }
      return;
    }
    
    // 1. Populate hidden salon select for backward compatibility
    if (salonSelect) {
      salonSelect.innerHTML = currentSalonsList.map(s => `<option value="${s.id}">${s.name} (${s.street}, ${s.city})</option>`).join('');
    }
    
    // 2. Render cards grid first
    await renderSalonsGrid();

    // 3. Fetch and cache services for treatment search
    await Promise.all(currentSalonsList.map(async (salon) => {
      try {
        const sRes = await fetch(`${BOOKING_API}/api/catalog/salons/${salon.id}/services`);
        if (sRes.ok) {
          salonServicesMap[salon.id] = await sRes.json();
        }
      } catch (e) {
        salonServicesMap[salon.id] = [];
      }
    }));

    // 4. Bind explicit input listener on search-salon-name
    const nameSearchInput = document.getElementById('search-salon-name');
    if (nameSearchInput) {
      nameSearchInput.addEventListener('input', filterSalonsAndServices);
      nameSearchInput.addEventListener('keyup', filterSalonsAndServices);
    }

    // 5. Trigger initial filter pass with populated services
    filterSalonsAndServices();
  } catch (err) {
    grid.innerHTML = '<p class="placeholder-text text-danger">Servizio catalogo non raggiungibile. Verifica gli endpoint.</p>';
  }
}

function getSalonFallbackImage(salon) {
  const salonImages = [
    'hero-beauty.jpg',
    'body_massage.jpg',
    'face_treatment.jpg',
    'hair_styling.jpg',
    'nails_treatment.jpg',
    'default_beauty.jpg',
    'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=800&q=80'
  ];
  if (!salon) return salonImages[0];
  let idNum = 0;
  if (typeof salon.id === 'number') {
    idNum = salon.id;
  } else if (typeof salon.id === 'string' && !isNaN(parseInt(salon.id))) {
    idNum = parseInt(salon.id);
  } else {
    const str = String(salon.id || salon.name || 'salon');
    for (let i = 0; i < str.length; i++) {
      idNum += str.charCodeAt(i);
    }
  }
  return salonImages[Math.abs(idNum) % salonImages.length];
}

async function renderSalonsGrid() {
  const grid = document.getElementById('salons-grid');
  if (!grid) return;

  // Set of salon IDs that have active drops currently in the system
  const activeDropSalonIds = new Set(
    currentActiveDrops
      .filter(drop => drop.status === 'available')
      .map(drop => drop.salon_id)
  );

  // Fetch reviews in parallel
  const reviewsData = {};
  await Promise.all(
    currentSalonsList.map(async salon => {
      try {
        const res = await fetch(`${BOOKING_API}/api/reviews/salon/${salon.id}`);
        if (res.ok) {
          const revs = await res.json();
          const count = revs.length;
          const avg = count > 0 ? (revs.reduce((sum, r) => sum + r.rating, 0) / count).toFixed(1) : null;
          reviewsData[salon.id] = { count, avg };
        }
      } catch (err) {
        console.error('Error fetching reviews for', salon.name, err);
      }
      if (!reviewsData[salon.id]) {
        reviewsData[salon.id] = { count: 0, avg: null };
      }
    })
  );

  // Deduplicate currentSalonsList strictly in frontend by normalized name, street and city
  const seenSalons = new Set();
  const uniqueSalonsList = [];
  currentSalonsList.forEach(s => {
    const normName = (s.name || '').toLowerCase().trim();
    const normStreet = (s.street || '').toLowerCase().trim();
    const normCity = (s.city || '').toLowerCase().trim();
    const key = `${normName}__${normStreet}__${normCity}`;
    if (!seenSalons.has(key)) {
      seenSalons.add(key);
      uniqueSalonsList.push(s);
    }
  });

  // Sort salons: salons with active drops first, then alphabetical
  const sortedSalons = [...uniqueSalonsList].sort((a, b) => {
    const hasDropA = activeDropSalonIds.has(a.id) ? 1 : 0;
    const hasDropB = activeDropSalonIds.has(b.id) ? 1 : 0;
    if (hasDropA !== hasDropB) {
      return hasDropB - hasDropA; // active drops first
    }
    return a.name.localeCompare(b.name);
  });

  // Fetch real rankings from backend
  let top3BookingsIds = [];
  let top5RatingIds = [];
  try {
    const rankRes = await fetch(`${BOOKING_API}/api/catalog/salons/rankings?t=${Date.now()}`);
    if (rankRes.ok) {
      const rankData = await rankRes.json();
      top3BookingsIds = rankData.top3Booked || [];
      top5RatingIds = rankData.top5Rated || [];
    }
  } catch (err) {
    console.error('Error fetching rankings from backend:', err);
  }

  // 2. Render Cards Grid
  grid.innerHTML = '';
  sortedSalons.forEach((salon, idx) => {
    const fallbackImg = getSalonFallbackImage(salon);
    const imageSrc = (salon.image_url && salon.image_url.trim().length > 0) ? salon.image_url.trim() : fallbackImg;
    
    const count = reviewsData[salon.id] ? reviewsData[salon.id].count : 0;
    const avg = reviewsData[salon.id] ? reviewsData[salon.id].avg : null;
    
    const ratingHTML = avg 
      ? `<span class="salon-card-rating"><i class="fa-solid fa-star"></i> ${avg}</span>` 
      : `<span class="salon-card-rating" style="color: var(--text-muted); font-size: 11px;"><i class="fa-regular fa-star"></i> N/D</span>`;
      
    const reviewsHTML = count > 0 
      ? `${count} ${count === 1 ? 'recensione' : 'recensioni'}` 
      : 'Nessuna recensione';

    let idNum = Math.abs(typeof salon.id === 'number' ? salon.id : String(salon.id || '').length);
    const categoryTags = ['Corpo', 'Viso', 'Capelli', 'Unghie'][idNum % 4] + ', Estetica';
    
    // Determine badges dynamically based on rankings and active drops
    let badgeHTML = '';
    if (activeDropSalonIds.has(salon.id)) {
      badgeHTML += '<span class="salon-badge-active-drop"><i class="fa-solid fa-bolt animate-pulse"></i> Drop Attivo -50%</span>';
    }
    if (top3BookingsIds.includes(salon.id)) {
      badgeHTML += '<span class="salon-badge-top-bookings"><i class="fa-solid fa-fire"></i> Top 3 Prenotati</span>';
    }
    if (top5RatingIds.includes(salon.id)) {
      badgeHTML += '<span class="salon-badge-top-reviews"><i class="fa-solid fa-trophy"></i> Top 5 Recensioni</span>';
    }

    const card = document.createElement('div');
    card.className = 'salon-card';
    card.setAttribute('data-id', salon.id);
    card.setAttribute('data-categories', categoryTags);
    card.onclick = () => selectSalon(salon.id);
    
    card.innerHTML = `
      <div class="salon-card-image-wrapper">
        <img src="${imageSrc}" alt="${salon.name}" class="salon-card-image" onerror="this.onerror=null; this.src='${fallbackImg}';">
        <div class="salon-badges-container">
          ${badgeHTML}
        </div>
      </div>
      <div class="salon-card-content">
        <div class="salon-card-header-row">
          <h3 class="salon-card-title">${salon.name}</h3>
          ${ratingHTML}
        </div>
        <div class="salon-card-address">
          <i class="fa-solid fa-location-dot"></i> ${salon.street}, ${salon.city}
        </div>
        <p class="salon-card-desc">${salon.description || 'Salone di bellezza partner GlamDrop. Trattamenti professionali e promozioni esclusive.'}</p>
        <div class="salon-card-reviews">
          ${reviewsHTML}
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  initLiveCounter();
}

// Load services of a salon
async function loadSalonCatalog(salonId) {
  const catalogList = document.getElementById('catalog-list');
  if (!catalogList) return;

  catalogList.innerHTML = '<p class="placeholder-text"><i class="fa-solid fa-spinner fa-spin"></i> Caricamento servizi in corso...</p>';

  document.querySelectorAll('.cat-filter-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-category') === 'all');
  });

  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/salons/${salonId}/services`);

    if (!res.ok) {
      const errText = await res.text();
      console.error('Errore API catalogo, stato:', res.status, errText);
      catalogList.innerHTML = `<p class="placeholder-text text-danger"><i class="fa-solid fa-circle-exclamation"></i> Impossibile caricare i servizi (errore ${res.status}).<br><small>Assicurati che il booking-service sia avviato e raggiungibile su ${BOOKING_API}</small></p>`;
      return;
    }

    const services = await res.json();
    currentSalonServices = services;

    if (!Array.isArray(services) || services.length === 0) {
      catalogList.innerHTML = '<p class="placeholder-text">Il salone non ha ancora inserito servizi nel catalogo.</p>';
      return;
    }

    renderCatalogList(services);
  } catch (err) {
    console.error('Errore fetch catalogo:', err);
    catalogList.innerHTML = `<p class="placeholder-text text-danger"><i class="fa-solid fa-circle-exclamation"></i> Errore di connessione al booking-service.<br><small>${err.message}</small></p>`;
  }
}

const categoryImages = {
  'Viso': 'face_treatment.jpg',
  'Corpo': 'body_massage.jpg',
  'Capelli': 'hair_styling.jpg',
  'Unghie': 'nails_treatment.jpg',
  'default': 'default_beauty.jpg'
};

const defaultDescriptions = {
  'Viso': 'Pulizia profonda, idratazione e trattamenti rigeneranti per la pelle del viso.',
  'Corpo': 'Massaggi rilassanti, trattamenti drenanti e tonificanti per il benessere del corpo.',
  'Capelli': 'Tagli di tendenza, piega professionale e trattamenti nutrienti per capelli sani.',
  'Unghie': 'Manicure, pedicure, applicazione smalto semipermanente e ricostruzione gel.',
  'default': 'Trattamento professionale personalizzato eseguito dai nostri esperti.'
};

function getTreatmentImage(srv, idx) {
  const name = (srv.name || '').toLowerCase();
  let src = (srv.image_url && srv.image_url.trim().length > 0) ? srv.image_url.trim() : null;
  let fallback = 'default_beauty.jpg';

  if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image'))) {
    return { src, fallback: 'default_beauty.jpg' };
  }

  if (name.includes('ricostruzione') || name.includes('gel')) {
    fallback = 'default_beauty.jpg';
    if (!src || src.includes('nails_treatment')) src = fallback;
  } else if (name.includes('smalto') || name.includes('semipermanente')) {
    fallback = 'nails_treatment.jpg';
    if (!src) src = fallback;
  } else if (name.includes('nail art') || name.includes('decoraz')) {
    fallback = 'hero-beauty.jpg';
    if (!src) src = fallback;
  } else if (name.includes('pedicure')) {
    fallback = 'body_massage.jpg';
    if (!src) src = fallback;
  } else if (name.includes('manicure rapida')) {
    fallback = 'face_treatment.jpg';
    if (!src || src.includes('nails_treatment')) src = fallback;
  } else if (name.includes('manicure')) {
    fallback = 'nails_treatment.jpg';
    if (!src) src = fallback;
  } else if (name.includes('laminaz') || name.includes('ciglia')) {
    fallback = 'hair_styling.jpg';
    if (!src) src = fallback;
  } else if (name.includes('anti-age') || name.includes('antiage') || name.includes('collagene') || name.includes('viso') || name.includes('pulizia')) {
    fallback = 'face_treatment.jpg';
    if (!src) src = fallback;
  } else if (name.includes('massaggio') || name.includes('drenante') || name.includes('corpo') || name.includes('cellulite')) {
    fallback = 'body_massage.jpg';
    if (!src) src = fallback;
  } else if (name.includes('taglio') || name.includes('piega') || name.includes('capell') || name.includes('balayage')) {
    fallback = 'hair_styling.jpg';
    if (!src) src = fallback;
  } else {
    const list = ['nails_treatment.jpg', 'face_treatment.jpg', 'body_massage.jpg', 'hair_styling.jpg', 'default_beauty.jpg', 'hero-beauty.jpg'];
    fallback = list[idx % list.length];
    if (!src) src = fallback;
  }

  return { src, fallback };
}

function renderCatalogList(services) {
  const catalogList = document.getElementById('catalog-list');
  if (!catalogList) return;
  catalogList.innerHTML = '';
  
  services.forEach((srv, idx) => {
    const card = document.createElement('div');
    card.className = 'service-item-card';
    card.setAttribute('data-cat-name', srv.category_name);
    
    // Choose image and description
    const imgData = getTreatmentImage(srv, idx);
    const desc = srv.description || defaultDescriptions[srv.category_name] || defaultDescriptions['default'];
    
    card.innerHTML = `
      <img src="${imgData.src}" alt="${srv.name}" class="service-card-img" onerror="this.onerror=null; this.src='${imgData.fallback}';" style="width: 100%; height: 160px; object-fit: cover; border-radius: 12px; margin-bottom: 12px;">
      <div class="service-info" style="display: flex; flex-direction: column; gap: 6px; flex: 1;">
        <h4 style="margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--text-main);">${srv.name}</h4>
        <p class="service-description" style="margin: 4px 0 8px 0; font-size: 0.85rem; color: var(--text-muted); line-height: 1.4;">${desc}</p>
        <div class="service-meta" style="margin-top: auto; display: flex; gap: 10px; font-size: 0.8rem; color: var(--text-muted);">
          <span><i class="fa-solid fa-clock"></i> ${srv.duration_minutes} min</span> • 
          <span><i class="fa-solid fa-tag"></i> ${srv.category_name}</span>
        </div>
        <div class="service-price" style="font-size: 1.3rem; font-weight: 800; color: var(--gold); margin: 6px 0;">${srv.price}€</div>
      </div>
      <button class="btn btn-gold btn-sm select-service-btn" 
              data-id="${srv.id}" 
              data-name="${srv.name}" 
              data-price="${srv.price}"
              data-duration="${srv.duration_minutes}"
              data-category="${srv.category_name}"
              style="width: 100%;">
        Prenota
      </button>
    `;
    catalogList.appendChild(card);
  });

  // Attach booking handler
  document.querySelectorAll('.select-service-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentUser || currentUser.role !== 'client') {
        alert('Devi effettuare l\'accesso come Cliente per effettuare prenotazioni.');
        openLogin('client');
        return;
      }
      
      const srvId = btn.getAttribute('data-id');
      const srvName = btn.getAttribute('data-name');
      const srvPrice = btn.getAttribute('data-price');
      const srvDuration = btn.getAttribute('data-duration');
      const srvCategory = btn.getAttribute('data-category');
      
      openBookingModal(srvId, srvName, srvPrice, srvDuration, srvCategory);
    });
  });
}

// Category filter
document.querySelectorAll('.cat-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const cat = btn.getAttribute('data-category');
    const cards = document.querySelectorAll('.service-item-card');
    
    cards.forEach(card => {
      const cardCat = card.getAttribute('data-cat-name');
      if (cat === 'all' || cardCat === cat) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  });
});

// Open standard booking modal
async function openBookingModal(srvId, name, price, duration, category) {
  const select = document.getElementById('bk-employee-select');
  const cardsContainer = document.getElementById('bk-employee-cards-container');
  if (!select || !bookingModal) return;
  
  document.getElementById('bk-service-id').value = srvId;
  document.getElementById('bk-service-duration').value = duration || '60';
  document.getElementById('bk-service-name').textContent = name;
  document.getElementById('bk-service-price').textContent = `Prezzo: ${price}€ (Durata: ${duration} min)`;
  
  // Reset date and slots
  document.getElementById('bk-date').value = '';
  document.getElementById('bk-selected-time').value = '';
  const container = document.getElementById('bk-slots-container');
  if (container) {
    container.innerHTML = '<p class="placeholder-text" style="font-size: 0.85rem; padding: 10px 0;">Seleziona dipendente e data per caricare gli slot.</p>';
  }
  
  select.innerHTML = '<option value="">Caricamento estetiste...</option>';
  if (cardsContainer) {
    cardsContainer.innerHTML = '<p class="placeholder-text" style="text-align: center; padding: 10px 0; font-size: 0.85rem;">Caricamento estetiste qualificate...</p>';
  }
  
  try {
    const res = await fetch(`${AUTH_API}/api/auth/salons/${currentSalonId}/employees`);
    if (!res.ok) return;
    const employees = await res.json();
    
    select.innerHTML = '<option value="">Seleziona un\'estetista...</option>';
    if (cardsContainer) cardsContainer.innerHTML = '';
    
    // Filter employees by specialization matching the service category
    const catLower = category.toLowerCase();
    const filtered = employees.filter(emp => {
      const spec = emp.specialization.toLowerCase();
      let matches = spec.includes(catLower);
      if (!matches) {
        if (catLower === 'unghie' && (spec.includes('mani') || spec.includes('unghie') || spec.includes('nails'))) matches = true;
        if (catLower === 'viso' && (spec.includes('viso') || spec.includes('face'))) matches = true;
        if (catLower === 'corpo' && (spec.includes('corpo') || spec.includes('body'))) matches = true;
      }
      return matches;
    });

    if (filtered.length === 0) {
      select.innerHTML = '<option value="">Nessun dipendente specializzato disponibile</option>';
      if (cardsContainer) {
        cardsContainer.innerHTML = '<p class="placeholder-text text-danger" style="text-align: center; padding: 10px 0; font-size: 0.85rem;">Nessun dipendente specializzato disponibile per questo trattamento.</p>';
      }
      bookingModal.showModal();
      return;
    }
    
    const beauticianAvatars = [
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=150&q=80',
      'https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&w=150&q=80',
      'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=150&q=80',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80',
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=150&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&q=80'
    ];

    filtered.forEach((emp, index) => {
      // 1. Dropdown fallback population
      const opt = document.createElement('option');
      opt.value = emp.id;
      opt.textContent = `${emp.first_name} ${emp.last_name} (${emp.specialization})`;
      select.appendChild(opt);

      // 2. Beautiful cards rendering
      if (cardsContainer) {
        const empPhoto = (emp.photo_url && emp.photo_url.trim().length > 0)
          ? emp.photo_url.trim()
          : (emp.image_url && emp.image_url.trim().length > 0)
            ? emp.image_url.trim()
            : beauticianAvatars[index % beauticianAvatars.length];
        const card = document.createElement('div');
        card.className = 'employee-card-select';
        card.setAttribute('data-id', emp.id);
        card.innerHTML = `
          <img src="${empPhoto}" class="employee-card-avatar" alt="${emp.first_name}" onerror="this.src='${beauticianAvatars[index % beauticianAvatars.length]}'">
          <div class="employee-card-name">${emp.first_name}</div>
          <div class="employee-card-spec">${emp.specialization}</div>
        `;
        
        card.addEventListener('click', () => {
          document.querySelectorAll('.employee-card-select').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          select.value = emp.id;
          updateBookingAvailability();
        });
        
        cardsContainer.appendChild(card);
      }
    });
    
    bookingModal.showModal();
  } catch (err) {
    alert('Errore nel caricare lo staff del salone');
  }
}

// Update Booking slots availability list
async function updateBookingAvailability() {
  const empId = document.getElementById('bk-employee-select').value;
  const dateVal = document.getElementById('bk-date').value;
  const duration = document.getElementById('bk-service-duration').value || '60';
  const container = document.getElementById('bk-slots-container');
  const selectedTimeInput = document.getElementById('bk-selected-time');
  
  if (!container) return;
  selectedTimeInput.value = ''; // reset selection
  
  if (!empId || !dateVal) {
    container.innerHTML = '<p class="placeholder-text" style="font-size: 0.85rem; padding: 10px 0;">Seleziona dipendente e data per caricare gli slot.</p>';
    return;
  }
  
  container.innerHTML = '<p class="placeholder-text" style="font-size: 0.85rem; padding: 10px 0;">Verifica disponibilità in corso...</p>';
  
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings/availability?employee_id=${empId}&date=${dateVal}&duration_minutes=${duration}`);
    if (!res.ok) {
      container.innerHTML = '<p class="placeholder-text text-danger" style="font-size: 0.85rem; padding: 10px 0;">Errore nel recupero della disponibilità.</p>';
      return;
    }
    const data = await res.json();
    
    container.innerHTML = '';
    const now = new Date();
    let activeSlotsCount = 0;

    const slotsToRender = data.allSlots && data.allSlots.length > 0
      ? data.allSlots
      : data.slots.map(s => ({ time: s, status: 'available' }));

    slotsToRender.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      
      const slotDate = new Date(`${dateVal}T${item.time}:00`);
      const isPast = slotDate < now;
      const isBooked = item.status === 'booked';
      const isUnavailable = item.status === 'unavailable';
      const isDisabled = isPast || isBooked || isUnavailable;

      if (isDisabled) {
        btn.className = 'slot-btn disabled';
        btn.disabled = true;
        btn.style.textDecoration = 'line-through';
        btn.style.opacity = isPast ? '0.4' : '0.5';
        if (isBooked) btn.title = 'Già prenotato';
        else if (isUnavailable) btn.title = 'Non disponibile';
        else if (isPast) btn.title = 'Orario passato';
      } else {
        btn.className = 'slot-btn';
        activeSlotsCount++;
      }

      btn.textContent = item.time;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (isDisabled) return;
        document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedTimeInput.value = item.time;
      });
      container.appendChild(btn);
    });

    if (data.available === false) {
      container.innerHTML = `<p class="placeholder-text text-danger" style="font-size: 0.85rem; padding: 10px 0; text-align: center; width: 100%;">${data.reason || 'Nessuna disponibilità per questa data.'}</p>`;
      return;
    }

    if (activeSlotsCount === 0) {
      const allPast = slotsToRender.length > 0 && slotsToRender.every(item => new Date(`${dateVal}T${item.time}:00`) < now);
      if (allPast) {
        container.innerHTML = '<p class="placeholder-text text-warning" style="font-size: 0.9rem; font-weight: 700; padding: 10px 0; text-align: center; width: 100%;">Orario lavorativo per questa data già trascorso.</p>';
      } else {
        container.innerHTML = '<p class="placeholder-text text-danger" style="font-size: 0.9rem; font-weight: 700; padding: 10px 0; text-align: center; width: 100%;">Nessuno slot disponibile per questa data.</p>';
      }
    }
  } catch (err) {
    container.innerHTML = '<p class="placeholder-text text-danger" style="font-size: 0.85rem; padding: 10px 0;">Connessione fallita.</p>';
  }
}

// Attach change event listeners to slots checker inputs
addSafeListener('bk-employee-select', 'change', updateBookingAvailability);
addSafeListener('bk-date', 'change', updateBookingAvailability);

// Submit Booking form
addSafeListener('booking-form', 'submit', async (e) => {
  e.preventDefault();
  const service_id = document.getElementById('bk-service-id').value;
  const employee_id = document.getElementById('bk-employee-select').value;
  const dateVal = document.getElementById('bk-date').value;
  const timeVal = document.getElementById('bk-selected-time').value;
  
  if (!timeVal) {
    alert('Seleziona un orario disponibile prima di confermare.');
    return;
  }
  
  const booking_time = `${dateVal}T${timeVal}:00`;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ service_id, employee_id, booking_time })
    });
    
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Errore nella prenotazione');
      return;
    }
    
    logConsole(`Nuova prenotazione standard registrata con successo! ID: ${data.id}`, 'booking');
    if (bookingModal) bookingModal.close();
    loadClientBookings();
    
  } catch (err) {
    alert('Errore di connessione con il servizio Prenotazioni.');
  }
});

// Load Client bookings
let currentClientBookings = [];

async function loadClientBookings() {
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    currentClientBookings = await res.json();
    
    renderFilteredClientBookings();
  } catch (err) {
    const list = document.getElementById('dedicated-bookings-list');
    if (list) {
      list.innerHTML = '<p class="placeholder-text text-danger">Errore nel caricare le prenotazioni.</p>';
    }
  }
}

function renderFilteredClientBookings() {
  const list = document.getElementById('dedicated-bookings-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  const statusFilter = document.getElementById('filter-booking-status') ? document.getElementById('filter-booking-status').value : 'all';
  const sortBy = document.getElementById('sort-booking-by') ? document.getElementById('sort-booking-by').value : 'date-desc';
  
  let filtered = [...currentClientBookings];
  
  // 1. Status Filter
  if (statusFilter === 'active') {
    filtered = filtered.filter(bk => bk.status === 'confirmed' || bk.status === 'pending');
  } else if (statusFilter === 'past') {
    filtered = filtered.filter(bk => {
      const isPastTime = (new Date(bk.booking_time).getTime() + (30 * 60 * 1000)) < Date.now();
      return (isPastTime || bk.status === 'completed') && bk.status !== 'cancelled';
    });
  } else if (statusFilter === 'cancelled') {
    filtered = filtered.filter(bk => bk.status === 'cancelled');
  }
  
  // 2. Sort Logic
  filtered.sort((a, b) => {
    if (sortBy === 'date-desc') {
      return new Date(b.booking_time) - new Date(a.booking_time);
    } else if (sortBy === 'date-asc') {
      return new Date(a.booking_time) - new Date(b.booking_time);
    } else if (sortBy === 'salon') {
      const salonA = (currentSalonsList.find(s => String(s.id) === String(a.salon_id))?.name || '').toLowerCase();
      const salonB = (currentSalonsList.find(s => String(s.id) === String(b.salon_id))?.name || '').toLowerCase();
      return salonA.localeCompare(salonB);
    } else if (sortBy === 'category') {
      const catA = (a.category_name || '').toLowerCase();
      const catB = (b.category_name || '').toLowerCase();
      return catA.localeCompare(catB);
    }
    return 0;
  });
  
  if (filtered.length === 0) {
    list.innerHTML = '<p class="placeholder-text" style="padding: 20px 0;">Nessuna prenotazione trovata con i filtri selezionati.</p>';
    return;
  }
  
  filtered.forEach(bk => {
    const card = document.createElement('div');
    card.className = 'booking-item-card';
    const formattedTime = new Date(bk.booking_time).toLocaleString('it-IT');
    
    // Look up salon details
    const salon = currentSalonsList.find(s => String(s.id) === String(bk.salon_id));
    const salonName = salon ? salon.name : 'Salone Beauty';
    const salonAddress = salon ? `${salon.street}, ${salon.city}` : '';
    
    const serviceName = bk.service_name || 'Trattamento Beauty';
    const categoryName = bk.category_name || 'Estetica';
    
    const isConfirmed = bk.status === 'confirmed';
    const isPending = bk.status === 'pending';
    const statusClass = isConfirmed ? 'status-confirmed' : (isPending ? 'status-pending' : 'status-cancelled');
    const statusBadge = `<span class="booking-status-tag ${statusClass}">${bk.status}</span>`;
    
    const bookingTime = new Date(bk.booking_time).getTime();
    const isPastForCancel = bookingTime < Date.now();
    const isPastForReview = (bookingTime <= Date.now() || bk.status === 'completed') && bk.status !== 'cancelled';

    const isDropBooking = bk.is_drop === true;
    const cancelBtn = ((isConfirmed || isPending) && !isPastForCancel && !isDropBooking) ? `<button class="btn btn-cancel btn-sm cancel-bk-btn" data-id="${bk.id}">Annulla</button>` : '';
    const reviewBtn = (isPastForReview && bk.status !== 'cancelled') ? `<button class="btn btn-gold btn-sm review-bk-btn" data-id="${bk.id}" data-salon-id="${bk.salon_id}"><i class="fa-solid fa-star"></i> Recensisci</button>` : '';
    
    card.innerHTML = `
      <div class="booking-main-info" style="text-align: left;">
        <h4 style="margin: 0 0 5px 0; font-size: 1.1rem; font-weight: 800; color: var(--text-main);">${serviceName}</h4>
        <div style="font-size: 13px; font-weight: 700; color: var(--gold); margin-bottom: 5px;"><i class="fa-solid fa-store"></i> ${salonName} <span style="font-weight:normal; color: var(--text-muted);">(${salonAddress})</span></div>
        <div class="service-meta" style="font-size: 12px; color: var(--text-muted);">
          <span><i class="fa-solid fa-clock"></i> ${formattedTime}</span> • 
          <span>Categoria: <strong>${categoryName}</strong></span> • 
          <span>Prezzo: <strong>${bk.price}€</strong></span> • 
          <span>Pagamento: <i>${bk.payment_status}</i></span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        ${statusBadge}
        ${cancelBtn}
        ${reviewBtn}
      </div>
    `;
    list.appendChild(card);
  });
  
  // Attach cancellation handler
  list.querySelectorAll('.cancel-bk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      cancelBooking(id);
    });
  });

  // Attach review modal handler
  list.querySelectorAll('.review-bk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bookingId = btn.getAttribute('data-id');
      const salonId = btn.getAttribute('data-salon-id');
      
      document.getElementById('rev-booking-id').value = bookingId;
      document.getElementById('rev-salon-id').value = salonId;
      document.getElementById('rev-comment').value = '';
      
      setReviewStarsSelection(5);
      
      const revModal = document.getElementById('review-modal');
      if (revModal) revModal.showModal();
    });
  });
}

// Cancel Booking (24h Policy check)
async function cancelBooking(bookingId) {
  if (!confirm("Sei sicuro di voler annullare la prenotazione? Se mancano meno di 24 ore riceverai solo il 50% di rimborso.")) {
    return;
  }
  
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Errore durante la cancellazione');
      return;
    }
    
    alert(`${data.message}. Rimborsati: ${data.refunded_amount}€.`);
    logConsole(`Prenotazione ${bookingId} cancellata. Rimborso: ${data.refunded_amount}€`, 'booking');
    
    if (data.late_cancellation) {
      logConsole(`Cancellazione TARDIVA! Un drop al 50% dello slot è stato innescato!`, 'drop');
      loadActiveDrops();
    }
    
    loadClientBookings();
    loadSalonBookings(); // updates manager view if open
  } catch (err) {
    alert('Errore nella cancellazione');
  }
}

// --- ACTIVE GLAMDROPS POLLING ---
// --- ACTIVE GLAMDROPS POLLING & CAROUSEL ---
let currentDropIndex = 0;

async function loadActiveDrops() {
  const list = document.getElementById('drops-list');
  if (!list) return;
  
  try {
    const res = await fetch(`${DROP_API}/api/drops?t=${Date.now()}`);
    if (!res.ok) return;
    const newDrops = await res.json();
    
    const changed = JSON.stringify(newDrops) !== JSON.stringify(currentActiveDrops);
    currentActiveDrops = newDrops;
    
    // Update selector for Simulator
    updateSimSelector();
    
    // Re-render B2C homepage if drops list changed and home view is visible
    const salonsView = document.getElementById('salons-list-view');
    if (changed && salonsView && salonsView.style.display !== 'none') {
      renderSalonsGrid();
    }
    
    renderActiveDropsGrid();
  } catch (err) {
    list.innerHTML = '<p class="placeholder-text text-danger">Servizio Drop non raggiungibile.</p>';
  }
}

function renderActiveDropsGrid() {
  const list = document.getElementById('drops-list');
  if (!list) return;

  // Filter drops by selected salon
  const detailView = document.getElementById('salon-detail-view');
  let displayedDrops = currentActiveDrops;
  if (detailView && detailView.style.display !== 'none' && currentSalonId) {
    displayedDrops = currentActiveDrops.filter(drop => 
      currentSalonServices.some(srv => srv.id === drop.service_id)
    );
  }

  if (displayedDrops.length === 0) {
    list.innerHTML = '<p class="placeholder-text">Nessun drop attivo al momento. Fai una cancellazione tardiva (&lt;24h) per vederlo comparire!</p>';
    return;
  }

  if (currentDropIndex >= displayedDrops.length) {
    currentDropIndex = 0;
  }

  list.innerHTML = '';

  if (displayedDrops.length > 1) {
    const carouselContainer = document.createElement('div');
    carouselContainer.className = 'drops-carousel';
    carouselContainer.style.position = 'relative';
    carouselContainer.style.display = 'flex';
    carouselContainer.style.alignItems = 'center';
    carouselContainer.style.width = '100%';

    // Left Arrow
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'carousel-arrow prev-arrow';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.style.cssText = `
      position: absolute;
      left: -15px;
      z-index: 10;
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid var(--border-color);
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      color: var(--gold);
      transition: var(--transition);
    `;
    prevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      currentDropIndex = (currentDropIndex - 1 + displayedDrops.length) % displayedDrops.length;
      renderActiveDropsGrid();
    });
    
    prevBtn.addEventListener('mouseenter', () => {
      prevBtn.style.background = 'var(--gold-light)';
    });
    prevBtn.addEventListener('mouseleave', () => {
      prevBtn.style.background = 'rgba(255, 255, 255, 0.95)';
    });

    // Right Arrow
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'carousel-arrow next-arrow';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.style.cssText = `
      position: absolute;
      right: -15px;
      z-index: 10;
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid var(--border-color);
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      color: var(--gold);
      transition: var(--transition);
    `;
    nextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      currentDropIndex = (currentDropIndex + 1) % displayedDrops.length;
      renderActiveDropsGrid();
    });
    
    nextBtn.addEventListener('mouseenter', () => {
      nextBtn.style.background = 'var(--gold-light)';
    });
    nextBtn.addEventListener('mouseleave', () => {
      nextBtn.style.background = 'rgba(255, 255, 255, 0.95)';
    });

    // Inner card container
    const cardWrapper = document.createElement('div');
    cardWrapper.style.width = '100%';
    cardWrapper.style.padding = '0 20px';
    
    const drop = displayedDrops[currentDropIndex];
    const card = createDropCardElement(drop, displayedDrops.length);
    cardWrapper.appendChild(card);

    carouselContainer.appendChild(prevBtn);
    carouselContainer.appendChild(cardWrapper);
    carouselContainer.appendChild(nextBtn);
    list.appendChild(carouselContainer);
  } else {
    const drop = displayedDrops[0];
    const card = createDropCardElement(drop, 1);
    list.appendChild(card);
  }
}

function createDropCardElement(drop, totalCount) {
  const card = document.createElement('div');
  card.className = 'drop-card';
  card.style.width = '100%';
  const formattedTime = new Date(drop.booking_time).toLocaleString('it-IT');
  const originalPrice = (parseFloat(drop.discounted_price) * 2).toFixed(2);
  
  const service = currentSalonServices.find(srv => srv.id === drop.service_id);
  const serviceName = service ? service.name : 'Drop Last-Minute';
  
  const indicator = totalCount > 1 ? `<div class="drop-carousel-indicator" style="text-align: center; font-size: 11px; color: var(--text-muted); margin-top: 8px;">Slot ${currentDropIndex + 1} di ${totalCount}</div>` : '';

  card.innerHTML = `
    <div class="drop-header">
      <div>
        <h4 style="font-weight: 700;">${serviceName}</h4>
        <div class="drop-time-badge"><i class="fa-solid fa-clock"></i> ${formattedTime}</div>
      </div>
      <span class="drop-discount-tag">-50% OFF</span>
    </div>
    <div class="drop-prices">
      <span class="drop-old-price">${originalPrice}€</span>
      <span class="drop-new-price">${drop.discounted_price}€</span>
    </div>
    <button class="btn btn-pink claim-drop-btn mt-2" data-id="${drop.id}" style="width: 100%;">
      <i class="fa-solid fa-bolt"></i> ACQUISTA ORA!
    </button>
    ${indicator}
  `;

  const claimBtn = card.querySelector('.claim-drop-btn');
  if (claimBtn) {
    claimBtn.addEventListener('click', () => {
      if (!currentUser || currentUser.role !== 'client') {
        alert('Devi accedere come Cliente per acquistare i Drop.');
        openLogin('client');
        return;
      }
      claimDrop(drop.id);
    });
  }

  return card;
}

// Claim drop (with thundering herd Redis response)
async function claimDrop(dropId) {
  logConsole(`Invio richiesta di Claim per il Drop ${dropId} a Redis...`, 'drop');
  try {
    const res = await fetch(`${DROP_API}/api/drops/${dropId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      }
    });
    
    if (res.status === 401 || res.status === 403) {
      alert('La tua sessione è scaduta o non è valida. Effettua nuovamente l\'accesso.');
      performLogout();
      openLogin('client');
      return;
    }
    
    const data = await res.json();
    if (res.status === 202) {
      logConsole(`[Redis SUCCESS] ${data.message}`, 'success');
      alert('Acquisto avvenuto con successo! Troverai la prenotazione nella tua area.');
      
      // Instant optimistic UI update
      currentActiveDrops = currentActiveDrops.filter(d => String(d.id) !== String(dropId));
      renderActiveDropsGrid();
      renderSalonsGrid();

      loadActiveDrops();
      loadClientBookings();
    } else if (res.status === 409) {
      logConsole(`[Redis CONFLICT] ${data.error}`, 'error');
      alert('Spiacenti! Un altro utente ha acquistato questo slot un millisecondo prima di te.');
    } else {
      alert(data.error || 'Errore');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
}

// --- SALON MANAGER APIS ---

// Helper to populate specialization checkboxes dynamically
function populateSpecializationCheckboxes(categories) {
  const empContainer = document.getElementById('emp-spec-checkboxes');
  const mgrContainer = document.getElementById('mgr-spec-checkboxes');
  
  if (empContainer) {
    empContainer.innerHTML = categories.map(cat => `
      <label style="display:flex; align-items:center; gap:5px; font-weight:normal; margin-bottom:0; cursor:pointer; color:var(--text-main);">
        <input type="checkbox" name="emp-specialization-check" value="${cat.name}">
        ${cat.name}
      </label>
    `).join('');
  }
  
  if (mgrContainer) {
    mgrContainer.innerHTML = categories.map(cat => `
      <label style="display:flex; align-items:center; gap:5px; font-weight:normal; margin-bottom:0; cursor:pointer; color:var(--text-main);">
        <input type="checkbox" name="mgr-specialization-check" value="${cat.name}">
        ${cat.name}
      </label>
    `).join('');
  }

  const mgrContainerOnly = document.getElementById('mgr-spec-checkboxes-only');
  if (mgrContainerOnly) {
    mgrContainerOnly.innerHTML = categories.map(cat => `
      <label style="display:flex; align-items:center; gap:5px; font-weight:normal; margin-bottom:0; cursor:pointer; color:var(--text-main);">
        <input type="checkbox" name="mgr-specialization-check" value="${cat.name}">
        ${cat.name}
      </label>
    `).join('');
  }
}

// Load Salon details, services, employees, and categories
async function loadSalonDetails() {
  const select = document.getElementById('srv-category');
  if (!select) return;
  
  // 1. Fetch categories
  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/categories`);
    if (res.ok) {
      const categories = await res.json();
      select.innerHTML = '';
      categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.name;
        select.appendChild(opt);
      });
      // Populate checkboxes dynamically
      populateSpecializationCheckboxes(categories);
    }
  } catch (err) {
    console.error('Errore caricamento categorie:', err);
  }

  // 2. Fetch current Salon Info
  if (currentUser && currentUser.salonId) {
    try {
      const salonsRes = await fetch(`${AUTH_API}/api/auth/salons`);
      if (salonsRes.ok) {
        const salons = await salonsRes.json();
        const currentSalon = salons.find(s => String(s.id) === String(currentUser.salonId));
        if (currentSalon) {
          const nameEl = document.getElementById('sal-info-name');
          const streetEl = document.getElementById('sal-info-street');
          const cityEl = document.getElementById('sal-info-city');
          const descEl = document.getElementById('sal-info-desc');
          const imgEl = document.getElementById('sal-info-image');
          if (nameEl) nameEl.value = currentSalon.name || '';
          if (streetEl) streetEl.value = currentSalon.street || '';
          if (cityEl) cityEl.value = currentSalon.city || '';
          if (descEl) descEl.value = currentSalon.description || '';
          if (imgEl) {
            imgEl.value = currentSalon.image_url || '';
            if (salInfoUploader) salInfoUploader.updatePreview(currentSalon.image_url || '');
          }
        }
      }
    } catch (err) {
      console.error('Errore caricamento info salone:', err);
    }
    
    // Load lists
    loadManagerEmployees();
    loadManagerServices();
    loadSalonBookings();
  }
}

// Update Salon Info
addSafeListener('update-salon-form', 'submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('sal-info-name').value;
  const street = document.getElementById('sal-info-street').value;
  const city = document.getElementById('sal-info-city').value;
  const description = document.getElementById('sal-info-desc').value;
  const image_url = document.getElementById('sal-info-image') ? document.getElementById('sal-info-image').value.trim() : '';

  try {
    const res = await fetch(`${AUTH_API}/api/auth/salons/${currentUser.salonId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ name, street, city, description, image_url })
    });

    if (res.ok) {
      alert('Informazioni e foto salone aggiornate con successo!');
      loadSalonDetails();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante l\'aggiornamento');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Register Employee
addSafeListener('register-employee-form', 'submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('emp-email').value;
  const password = document.getElementById('emp-password').value;
  const first_name = document.getElementById('emp-firstname').value;
  const last_name = document.getElementById('emp-lastname').value;
  const photo_url = document.getElementById('emp-photo') ? document.getElementById('emp-photo').value.trim() : '';
  
  // Read checked checkboxes
  const selectedSpecs = Array.from(document.querySelectorAll('input[name="emp-specialization-check"]:checked')).map(cb => cb.value);
  if (selectedSpecs.length === 0) {
    alert('Seleziona almeno una specializzazione (trattamento abilitato) per la dipendente');
    return;
  }
  const specialization = selectedSpecs.join(', ');
  const salon_id = currentUser.salonId;

  try {
    const res = await fetch(`${AUTH_API}/api/auth/employee/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, first_name, last_name, salon_id, specialization, photo_url })
    });

    if (res.ok) {
      alert('Estetista aggiunta con successo!');
      document.getElementById('emp-email').value = '';
      document.getElementById('emp-password').value = 'Password123!';
      document.getElementById('emp-firstname').value = '';
      document.getElementById('emp-lastname').value = '';
      if (document.getElementById('emp-photo')) document.getElementById('emp-photo').value = '';
      if (empRegUploader) empRegUploader.updatePreview('');
      // Reset checkboxes
      document.querySelectorAll('input[name="emp-specialization-check"]').forEach(cb => cb.checked = false);
      loadManagerEmployees();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Load manager employees list
// Load manager employees list
async function loadManagerEmployees() {
  const container = document.getElementById('manager-employees-list');
  const selectEmp = document.getElementById('drop-employee-select');
  if (!container) return;

  try {
    const res = await fetch(`${AUTH_API}/api/auth/salons/${currentUser.salonId}/employees`);
    if (!res.ok) return;
    const employees = await res.json();

    container.innerHTML = '';
    if (selectEmp) selectEmp.innerHTML = '';

    if (employees.length === 0) {
      container.innerHTML = '<p class="placeholder-text" style="padding: 10px 0;">Nessun dipendente registrato.</p>';
      if (selectEmp) selectEmp.innerHTML = '<option value="">Nessun dipendente...</option>';
      return;
    }

    // Current Week Bounds (Mon-Sun)
    const now = new Date();
    const currentDay = now.getDay();
    const diff = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
    sunday.setHours(23, 59, 59, 999);

    for (const emp of employees) {
      const card = document.createElement('div');
      card.className = 'service-item-card';
      card.style.padding = '15px';
      card.style.marginBottom = '12px';

      // Fetch employee schedules to show inline (filtered to current week)
      let schedulesHtml = '<span style="color: var(--text-muted); font-size: 11px;">Nessun turno assegnato per questa settimana</span>';
      try {
        const sRes = await fetch(`${BOOKING_API}/api/schedules/employees/${emp.id}`);
        let unavailabilities = [];
        try {
          const unRes = await fetch(`${BOOKING_API}/api/schedules/unavailability?employee_id=${emp.id}`);
          if (unRes.ok) {
            unavailabilities = await unRes.json();
          }
        } catch (unErr) {
          console.error('Errore nel recupero indisponibilità:', unErr);
        }

        if (sRes.ok) {
          const schedules = await sRes.json();
          // Filter to upcoming schedules (today onwards)
          const todayMidnight = new Date();
          todayMidnight.setHours(0, 0, 0, 0);

          const upcomingSchedules = schedules.filter(s => {
            const date = new Date(s.schedule_date);
            return date >= todayMidnight;
          }).sort((a, b) => new Date(a.schedule_date) - new Date(b.schedule_date));

          if (upcomingSchedules.length > 0) {
            schedulesHtml = upcomingSchedules.map(s => {
              const formattedDate = new Date(s.schedule_date).toLocaleDateString('it-IT');
              const sDateStr = new Date(s.schedule_date).toISOString().split('T')[0];
              const isUnavailable = unavailabilities.some(un => {
                const unDateStr = new Date(un.unavailable_date).toISOString().split('T')[0];
                return sDateStr === unDateStr;
              });
              const labelSuffix = isUnavailable ? ' <strong style="color: var(--danger); font-size: 10px;">(Indisponibile)</strong>' : '';

              return `
                <div style="font-size: 11px; margin-top: 4px; color: var(--gold); display: flex; align-items: center; justify-content: space-between;">
                  <span><i class="fa-solid fa-calendar-day"></i> ${formattedDate}: ${s.start_time.substring(0,5)} - ${s.end_time.substring(0,5)}${labelSuffix}</span>
                  <button class="btn btn-cancel btn-xs delete-sched-btn" style="padding: 2px 6px; font-size: 9px; line-height: 1;" data-id="${s.id}" title="Rimuovi Turno"><i class="fa-solid fa-trash-can"></i> Rimuovi</button>
                </div>`;
            }).join('');
          }
        }
      } catch (err) {
        console.error('Errore nel recupero turni dipendente:', err);
      }

      const empPhoto = emp.photo_url || emp.image_url;
      const avatarHtml = empPhoto
        ? `<img src="${empPhoto}" alt="${emp.first_name}" style="width: 46px; height: 46px; border-radius: 50%; object-fit: cover; border: 2px solid var(--gold); flex-shrink: 0;" onerror="this.style.display='none'">`
        : `<div style="width: 46px; height: 46px; border-radius: 50%; background: rgba(212, 175, 55, 0.15); display: flex; align-items: center; justify-content: center; color: var(--gold); font-size: 20px; flex-shrink: 0;"><i class="fa-solid fa-user-nurse"></i></div>`;

      card.innerHTML = `
        <div style="display: flex; align-items: start; gap: 12px; flex: 1;">
          ${avatarHtml}
          <div style="flex: 1;">
            <a href="#" class="emp-history-link" style="color: var(--text-main); font-weight: 800; font-size: 1.1rem; text-decoration: underline;" data-id="${emp.id}" data-name="${emp.first_name} ${emp.last_name || ''}">${emp.first_name} ${emp.last_name || ''}</a>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px; margin-top: 2px;">Spec: <strong>${emp.specialization}</strong></div>
            <div style="border-top: 1px solid var(--border-color); padding-top: 6px; margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">
              ${schedulesHtml}
            </div>
          </div>
        </div>
        <div style="display:flex; gap: 6px; align-items: start; margin-left: 15px; flex-wrap: wrap; justify-content: flex-end;">
          <button class="btn btn-gold-outline btn-xs edit-emp-modal-btn" data-id="${emp.id}" data-firstname="${emp.first_name}" data-lastname="${emp.last_name || ''}" data-photo="${emp.photo_url || ''}" title="Modifica Staff & Foto"><i class="fa-solid fa-camera"></i> Foto / Staff</button>
          <button class="btn btn-gold btn-xs set-sched-btn" data-id="${emp.id}" data-name="${emp.first_name}">Turni</button>
          <button class="btn btn-gold btn-xs set-spec-btn" data-id="${emp.id}" data-name="${emp.first_name}" data-spec="${emp.specialization}">Spec</button>
          <button class="btn btn-cancel btn-xs delete-emp-btn" data-id="${emp.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
      container.appendChild(card);

      if (selectEmp) {
        const opt = document.createElement('option');
        opt.value = emp.id;
        opt.textContent = `${emp.first_name} ${emp.last_name || ''} (${emp.specialization})`;
        selectEmp.appendChild(opt);
      }
    }

    // Attach listeners: click on employee name link
    document.querySelectorAll('.emp-history-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.getAttribute('data-id');
        const name = link.getAttribute('data-name');
        openEmployeeHistoryModal(id, name);
      });
    });

    // Attach listeners: edit employee modal button
    document.querySelectorAll('.edit-emp-modal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const firstname = btn.getAttribute('data-firstname');
        const lastname = btn.getAttribute('data-lastname');
        const photo = btn.getAttribute('data-photo');
        openEditEmployeeModal(id, firstname, lastname, photo);
      });
    });

    // Attach listeners: delete schedule shift button
    document.querySelectorAll('.delete-sched-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        deleteEmployeeSchedule(id);
      });
    });

    // Attach listeners: manage schedule button
    document.querySelectorAll('.set-sched-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        document.getElementById('sched-emp-id').value = id;
        document.getElementById('sched-emp-name').textContent = name;
        
        const todayStr = new Date().toLocaleDateString('en-CA');
        const schedDateInput = document.getElementById('mgr-sched-date');
        if (schedDateInput) {
          schedDateInput.min = todayStr;
          if (!schedDateInput.value || schedDateInput.value < todayStr) {
            schedDateInput.value = todayStr;
          }
        }

        document.getElementById('manager-schedule-form').style.display = 'block';
        document.getElementById('manager-specialization-form').style.display = 'none';
      });
    });

    // Attach listeners: change specialization button
    document.querySelectorAll('.set-spec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const spec = btn.getAttribute('data-spec');
        document.getElementById('spec-emp-id').value = id;
        document.getElementById('spec-emp-name').textContent = name;
        
        // Check matched specialization checkboxes
        const currentSpecs = spec.split(',').map(s => s.trim().toLowerCase());
        document.querySelectorAll('#mgr-spec-checkboxes-only input[name="mgr-specialization-check"]').forEach(cb => {
          cb.checked = currentSpecs.includes(cb.value.toLowerCase());
        });
        
        document.getElementById('manager-specialization-form').style.display = 'block';
        document.getElementById('manager-schedule-form').style.display = 'none';
      });
    });

    document.querySelectorAll('.delete-emp-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Sei sicuro di voler rimuovere questa dipendente?')) return;
        const id = btn.getAttribute('data-id');
        try {
          const dRes = await fetch(`${AUTH_API}/api/auth/employees/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentUser.token}` }
          });
          if (dRes.ok) {
            alert('Dipendente rimossa con successo');
            loadManagerEmployees();
          } else {
            alert('Errore nella rimozione');
          }
        } catch (e) {
          alert('Errore di connessione');
        }
      });
    });

  } catch (e) {
    container.innerHTML = '<p class="placeholder-text text-danger">Errore caricamento staff.</p>';
  }
}

// Helper for fallback images
function getCategoryFallbackImage(categoryName) {
  const cat = (categoryName || '').toLowerCase();
  if (cat.includes('capelli') || cat.includes('hair')) return 'https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=600&q=80';
  if (cat.includes('viso') || cat.includes('face')) return 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=600&q=80';
  if (cat.includes('corpo') || cat.includes('body') || cat.includes('massagg')) return 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=600&q=80';
  if (cat.includes('unghie') || cat.includes('nail')) return 'https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=600&q=80';
  return 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=600&q=80';
}

// Load manager services catalog
async function loadManagerServices() {
  const container = document.getElementById('manager-services-list');
  const selectDropSrv = document.getElementById('drop-service-select');
  if (!container) return;

  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/salons/${currentUser.salonId}/services`);
    if (!res.ok) {
      container.innerHTML = '<p class="placeholder-text text-danger" style="padding: 10px 0;">Impossibile recuperare il listino dal server.</p>';
      return;
    }
    const services = await res.json();

    container.innerHTML = '';
    if (selectDropSrv) selectDropSrv.innerHTML = '';

    if (!Array.isArray(services) || services.length === 0) {
      container.innerHTML = '<p class="placeholder-text" style="padding: 10px 0;">Nessun servizio a listino.</p>';
      if (selectDropSrv) selectDropSrv.innerHTML = '<option value="">Nessun servizio...</option>';
      updateDiscountedDropPrice();
      return;
    }

    services.forEach(s => {
      const card = document.createElement('div');
      card.className = 'service-item-card';
      card.style.padding = '10px 15px';
      card.style.marginBottom = '8px';
      card.style.display = 'flex';
      card.style.alignItems = 'center';
      card.style.justifyContent = 'space-between';

      const srvImg = (s.image_url && s.image_url.trim()) ? s.image_url.trim() : getCategoryFallbackImage(s.category_name);
      const thumbnailHtml = `<img src="${srvImg}" alt="${s.name}" style="width: 55px; height: 42px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border-color); flex-shrink: 0;" onerror="this.src='default_beauty.jpg'">`;

      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
          ${thumbnailHtml}
          <div>
            <strong style="font-size: 1rem;">${s.name}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${s.duration_minutes} min • <span style="color: var(--gold); font-weight: 700;">${s.price}€</span></div>
            ${s.description ? `<div style="font-size: 10px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 250px;">${s.description}</div>` : ''}
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; justify-content: flex-end;">
          <button class="btn btn-gold-outline btn-xs edit-srv-modal-btn" data-id="${s.id}" data-name="${s.name}" data-price="${s.price}" data-duration="${s.duration_minutes}" data-desc="${s.description || ''}" data-photo="${s.image_url || ''}" title="Modifica Servizio & Foto"><i class="fa-solid fa-pen-to-square"></i> Modifica</button>
          <button class="btn btn-cancel btn-xs delete-srv-btn" data-id="${s.id}" title="Elimina Servizio"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;
      container.appendChild(card);

      if (selectDropSrv) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.price}€)`;
        opt.dataset.price = s.price;
        selectDropSrv.appendChild(opt);
      }
    });

    // Automatically calculate and display initial discounted price
    updateDiscountedDropPrice();

    // Attach listeners: edit service modal button
    document.querySelectorAll('.edit-srv-modal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const price = btn.getAttribute('data-price');
        const duration = btn.getAttribute('data-duration');
        const desc = btn.getAttribute('data-desc');
        const photo = btn.getAttribute('data-photo');
        openEditServiceModal(id, name, price, duration, desc, photo);
      });
    });

    // Attach listeners: delete service photo button
    document.querySelectorAll('.del-srv-photo-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        deleteServicePhoto(id);
      });
    });

    // Attach listeners: delete service button
    document.querySelectorAll('.delete-srv-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eliminare questo servizio dal catalogo?')) return;
        const id = btn.getAttribute('data-id');
        try {
          const dRes = await fetch(`${BOOKING_API}/api/catalog/services/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentUser.token}` }
          });
          if (dRes.ok) {
            alert('Servizio eliminato.');
            loadManagerServices();
          } else {
            const errData = await dRes.json().catch(() => ({}));
            alert(errData.error || 'Errore durante l\'eliminazione del servizio');
          }
        } catch (e) {
          alert('Errore di connessione');
        }
      });
    });

    // Update discounted price in form
    updateDiscountedDropPrice();

  } catch (e) {
    container.innerHTML = '<p class="placeholder-text text-danger">Errore caricamento servizi.</p>';
  }
}

// Manager schedule submit handler
addSafeListener('manager-schedule-form', 'submit', async (e) => {
  e.preventDefault();
  const employee_id = document.getElementById('sched-emp-id').value;
  const schedule_date = document.getElementById('mgr-sched-date').value;
  const start_time = document.getElementById('mgr-sched-start').value + ':00';
  const end_time = document.getElementById('mgr-sched-end').value + ':00';

  try {
    const res = await fetch(`${BOOKING_API}/api/schedules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ employee_id, schedule_date, start_time, end_time })
    });

    if (res.ok) {
      alert('Turno lavorativo salvato con successo!');
      document.getElementById('manager-schedule-form').style.display = 'none';
      loadManagerEmployees();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore nel salvataggio del turno');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Manager specialization update submit handler
addSafeListener('manager-specialization-form', 'submit', async (e) => {
  e.preventDefault();
  const employee_id = document.getElementById('spec-emp-id').value;
  const selectedSpecs = Array.from(document.querySelectorAll('#mgr-spec-checkboxes-only input[name="mgr-specialization-check"]:checked')).map(cb => cb.value);
  if (selectedSpecs.length === 0) {
    alert('Seleziona almeno una specializzazione per la dipendente');
    return;
  }
  const specialization = selectedSpecs.join(', ');

  try {
    const res = await fetch(`${AUTH_API}/api/auth/employees/${employee_id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ specialization })
    });

    if (res.ok) {
      // Post notification for employee specialization change
      try {
        await fetch(`${NOTIF_API}/api/notifications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'EMPLOYEE_SPECIALIZATION_UPDATED',
            message: `Notifica dipendente: Aggiornata la tua specializzazione a "${specialization}".`,
            data: {
              employee_id: employee_id,
              specialization: specialization
            }
          })
        });
      } catch (err) {
        console.error('Error logging specialization update notification:', err);
      }

      alert('Specializzazione aggiornata con successo!');
      document.getElementById('manager-specialization-form').style.display = 'none';
      loadManagerEmployees();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante l\'aggiornamento');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Delete schedule shift
async function deleteEmployeeSchedule(scheduleId) {
  if (!confirm('Sei sicuro di voler rimuovere questo turno?')) return;
  try {
    const res = await fetch(`${BOOKING_API}/api/schedules/${scheduleId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (res.ok) {
      loadManagerEmployees();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore nella cancellazione del turno');
    }
  } catch (e) {
    console.error(e);
    alert('Errore di connessione');
  }
}

// Open read-only employee shift history pop-up grouped by week range
async function openEmployeeHistoryModal(employeeId, employeeName) {
  const modal = document.getElementById('modal-employee-history');
  const body = document.getElementById('history-modal-body');
  const title = document.getElementById('history-modal-title');
  if (!modal || !body) return;

  title.textContent = `Storico Turni: ${employeeName}`;
  body.innerHTML = '<p class="placeholder-text">Caricamento turni...</p>';
  modal.showModal();

  try {
    const sRes = await fetch(`${BOOKING_API}/api/schedules/employees/${employeeId}`);
    let unavailabilities = [];
    try {
      const unRes = await fetch(`${BOOKING_API}/api/schedules/unavailability?employee_id=${employeeId}`);
      if (unRes.ok) {
        unavailabilities = await unRes.json();
      }
    } catch (unErr) {
      console.error('Errore nel recupero indisponibilità per lo storico:', unErr);
    }

    if (sRes.ok) {
      const schedules = await sRes.json();
      if (schedules.length === 0) {
        body.innerHTML = '<p class="placeholder-text">Nessun turno registrato nello storico.</p>';
        return;
      }

      // Group schedules by calendar week (Monday of that week)
      const weeks = {};
      schedules.forEach(s => {
        const sDate = new Date(s.schedule_date);
        const day = sDate.getDay();
        const diff = sDate.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(sDate.setDate(diff));
        mon.setHours(0,0,0,0);
        
        const weekKey = mon.toLocaleDateString('it-IT');
        if (!weeks[weekKey]) {
          weeks[weekKey] = [];
        }
        weeks[weekKey].push(s);
      });

      body.innerHTML = '';
      // Render weeks
      Object.entries(weeks).sort((a,b) => {
        const dateA = new Date(a[0].split('/').reverse().join('-'));
        const dateB = new Date(b[0].split('/').reverse().join('-'));
        return dateA - dateB;
      }).forEach(([weekLabel, weekSchedules]) => {
        const weekCard = document.createElement('div');
        weekCard.style.background = 'rgba(255,255,255,0.02)';
        weekCard.style.border = '1px solid var(--border-color)';
        weekCard.style.borderRadius = '12px';
        weekCard.style.padding = '12px';
        weekCard.style.marginBottom = '12px';

        const monday = new Date(weekLabel.split('/').reverse().join('-'));
        const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
        const rangeStr = `Settimana del ${weekLabel} al ${sunday.toLocaleDateString('it-IT')}`;

        // Sort week schedules by date
        weekSchedules.sort((a, b) => new Date(a.schedule_date) - new Date(b.schedule_date));

        let listHtml = weekSchedules.map(s => {
          const dateStr = new Date(s.schedule_date).toLocaleDateString('it-IT');
          const sDateStr = new Date(s.schedule_date).toISOString().split('T')[0];
          const isUnavailable = unavailabilities.some(un => {
            const unDateStr = new Date(un.unavailable_date).toISOString().split('T')[0];
            return sDateStr === unDateStr;
          });
          const labelSuffix = isUnavailable ? ' <strong style="color: var(--danger); font-size: 10px;">(Indisponibile)</strong>' : '';

          return `<div style="font-size: 11px; margin-top: 4px; color: var(--text-main);"><i class="fa-solid fa-clock"></i> ${dateStr}: ${s.start_time.substring(0,5)} - ${s.end_time.substring(0,5)}${labelSuffix}</div>`;
        }).join('');

        weekCard.innerHTML = `
          <h5 style="color: var(--gold); font-size: 12px; margin: 0 0 8px 0; font-weight:700;">${rangeStr}</h5>
          <div style="display:flex; flex-direction:column; gap:4px;">
            ${listHtml}
          </div>
        `;
        body.appendChild(weekCard);
      });

    } else {
      body.innerHTML = '<p class="placeholder-text text-danger">Errore nel caricamento dello storico.</p>';
    }
  } catch (err) {
    console.error('Error fetching shift history:', err);
    body.innerHTML = '<p class="placeholder-text text-danger">Errore di connessione.</p>';
  }
}



// Load bookings of the salon (General Agenda & Pending)
async function loadSalonBookings() {
  const list = document.getElementById('salon-bookings-list');
  const pendingList = document.getElementById('pending-bookings-list');
  const pendingCard = document.getElementById('pending-reassignments-card');
  if (!list) return;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const bookings = await res.json();

    // Dynamically calculate and update stats based on selected period
    renderB2BStats();
    
    // Fetch employees for this salon to map names
    let employeesList = [];
    try {
      const empRes = await fetch(`${AUTH_API}/api/auth/salons/${currentUser.salonId}/employees`);
      if (empRes.ok) {
        employeesList = await empRes.json();
      }
    } catch (e) {
      console.error('Error fetching employees mapping:', e);
    }

    // Resolve client names in parallel using getClientNameCached
    await Promise.all(
      bookings.map(async bk => {
        bk.resolvedClientName = await getClientNameCached(bk.client_id);
        const emp = employeesList.find(e => String(e.id) === String(bk.employee_id));
        bk.resolvedEmployeeName = emp ? `${emp.first_name} ${emp.last_name}` : (bk.employee_id ? `Estetista ID ${String(bk.employee_id).substring(0,8)}...` : 'Non assegnata');
      })
    );

    // Sort bookings: pending vs confirmed/cancelled
    const pendings = bookings.filter(b => b.status === 'pending');
    const others = bookings.filter(b => b.status !== 'pending');

    // 1. Render Pending Bookings (if any)
    if (pendingList) {
      pendingList.innerHTML = '';
      if (pendings.length > 0) {
        if (pendingCard) pendingCard.style.display = 'block';
        pendings.forEach(bk => {
          const card = document.createElement('div');
          card.className = 'booking-item-card';
          card.style.borderLeft = '3px solid #ff9f43';
          card.style.marginBottom = '10px';
          const formattedTime = new Date(bk.booking_time).toLocaleString('it-IT');
          
          const bookingTime = new Date(bk.booking_time).getTime();
          const isPast = bookingTime < Date.now();

          const actionButtons = isPast ? '' : `
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-gold btn-sm reassign-bk-btn" data-id="${bk.id}" data-service-id="${bk.service_id}">Riassegna</button>
              <button class="btn btn-cancel btn-sm cancel-bk-btn" data-id="${bk.id}">Annulla (Rimborsa 100% Clienti)</button>
            </div>
          `;

          card.innerHTML = `
            <div class="booking-main-info">
              <h4 style="color: #ff9f43;"><i class="fa-solid fa-triangle-exclamation"></i> Appuntamento Pendente: ${bk.resolvedClientName}</h4>
              <div class="service-meta">
                <span><i class="fa-solid fa-clock"></i> ${formattedTime}</span> • 
                <span>Trattamento: <strong>${bk.service_name || 'Beauty'}</strong></span> • 
                <span>Estetista prec: ${bk.resolvedEmployeeName}</span> • 
                <span>Prezzo: ${bk.price}€</span>
              </div>
            </div>
            ${actionButtons}
          `;
          pendingList.appendChild(card);
        });
      } else {
        if (pendingCard) pendingCard.style.display = 'none';
      }
    }

    // 2. Render General Agenda
    list.innerHTML = '';
    if (others.length === 0) {
      list.innerHTML = '<p class="placeholder-text">Nessuna prenotazione attiva in agenda.</p>';
      return;
    }
    
    others.forEach(bk => {
      const card = document.createElement('div');
      card.className = 'booking-item-card';
      card.style.marginBottom = '10px';
      const formattedTime = new Date(bk.booking_time).toLocaleString('it-IT');
      const statusClass = bk.status === 'confirmed' ? 'status-confirmed' : (bk.status === 'cancelled' ? 'status-cancelled' : 'status-pending');
      const statusLabel = bk.is_drop ? `${bk.status} (via Drop)` : bk.status;
      const statusBadge = `<span class="booking-status-tag ${statusClass}">${statusLabel}</span>`;

      card.innerHTML = `
        <div class="booking-main-info">
          <h4>Cliente: <strong>${bk.resolvedClientName}</strong></h4>
          <div class="service-meta">
            <span><i class="fa-solid fa-clock"></i> ${formattedTime}</span> • 
            <span>Trattamento: <strong>${bk.service_name || 'Beauty'}</strong></span> • 
            <span>Prezzo: <strong>${bk.price}€</strong></span> • 
            <span>Estetista: <strong>${bk.resolvedEmployeeName}</strong></span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 15px;">
          ${statusBadge}
        </div>
      `;
      list.appendChild(card);
    });

    // Attach listeners
    document.querySelectorAll('.cancel-bk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        cancelBooking(id);
      });
    });

    document.querySelectorAll('.reassign-bk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const srvId = btn.getAttribute('data-service-id');
        openReassignModal(id, srvId);
      });
    });

  } catch (err) {
    list.innerHTML = '<p class="placeholder-text text-danger">Errore di connessione</p>';
  }
}

// Open Reassign Staff Modal
async function openReassignModal(bookingId, serviceId) {
  const select = document.getElementById('reassign-employee-select');
  const modal = document.getElementById('reassign-modal');
  if (!select || !modal) return;

  document.getElementById('reassign-booking-id').value = bookingId;
  select.innerHTML = '<option value="">Caricamento estetiste...</option>';

  try {
    // 1. Fetch employees
    const empRes = await fetch(`${AUTH_API}/api/auth/salons/${currentUser.salonId}/employees`);
    if (!empRes.ok) return;
    const employees = await empRes.json();

    // 2. Fetch service catalog to know category
    const srvRes = await fetch(`${BOOKING_API}/api/catalog/salons/${currentUser.salonId}/services`);
    if (!srvRes.ok) return;
    const services = await srvRes.json();
    const service = services.find(s => s.id === serviceId);
    if (!service) return;

    select.innerHTML = '<option value="">Seleziona estetista di sostituzione...</option>';

    // Filter employees with correct specialization
    const catLower = service.category_name.toLowerCase();
    const filtered = employees.filter(emp => {
      const spec = emp.specialization.toLowerCase();
      let matches = spec.includes(catLower);
      if (!matches) {
        if (catLower === 'unghie' && (spec.includes('mani') || spec.includes('unghie') || spec.includes('nails'))) matches = true;
        if (catLower === 'viso' && (spec.includes('viso') || spec.includes('face'))) matches = true;
        if (catLower === 'corpo' && (spec.includes('corpo') || spec.includes('body'))) matches = true;
      }
      return matches;
    });

    if (filtered.length === 0) {
      select.innerHTML = '<option value="">Nessun sostituto specializzato disponibile</option>';
      modal.showModal();
      return;
    }

    filtered.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.id;
      opt.textContent = `${emp.first_name} ${emp.last_name} (${emp.specialization})`;
      select.appendChild(opt);
    });

    modal.showModal();
  } catch (err) {
    alert('Errore nel caricamento dei dipendenti qualificati.');
  }
}

// Submit Reassign employee form
addSafeListener('reassign-form', 'submit', async (e) => {
  e.preventDefault();
  const bookingId = document.getElementById('reassign-booking-id').value;
  const employee_id = document.getElementById('reassign-employee-select').value;
  const modal = document.getElementById('reassign-modal');

  try {
    const res = await fetch(`${BOOKING_API}/api/bookings/${bookingId}/reassign`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ employee_id })
    });

    if (res.ok) {
      alert('Sostituto assegnato correttamente!');
      if (modal) modal.close();
      loadSalonBookings();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore nella riassegnazione.');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});


// --- EMPLOYEE APIS ---

// Add Working Schedule
addSafeListener('schedule-form', 'submit', async (e) => {
  e.preventDefault();
  const schedule_date = document.getElementById('sched-date').value;
  const start_time = document.getElementById('sched-start').value + ':00';
  const end_time = document.getElementById('sched-end').value + ':00';
  const employee_id = currentUser.employeeId;

  try {
    const res = await fetch(`${BOOKING_API}/api/schedules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ employee_id, schedule_date, start_time, end_time })
    });

    if (res.ok) {
      alert('Orario lavorativo impostato con successo!');
      loadEmployeeSchedules();
    } else {
      const err = await res.json();
      alert(err.error);
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Load working hours list
// Load working hours list
async function loadEmployeeSchedules() {
  const list = document.getElementById('employee-schedules-list');
  const kpiShift = document.getElementById('emp-kpi-next-shift');
  if (!list) return;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/schedules/employees/${currentUser.employeeId}`);
    if (!res.ok) return;
    const schedules = await res.json();

    // Current Week Bounds (Mon-Sun)
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const upcomingSchedules = schedules.filter(s => {
      const date = new Date(s.schedule_date);
      return date >= todayMidnight;
    }).sort((a, b) => new Date(a.schedule_date) - new Date(b.schedule_date));

    list.innerHTML = '';
    if (upcomingSchedules.length === 0) {
      list.innerHTML = '<p class="placeholder-text">Nessun turno assegnato per i prossimi giorni.</p>';
      if (kpiShift) kpiShift.textContent = 'Nessuno';
      return;
    }

    if (kpiShift && upcomingSchedules.length > 0) {
      const first = upcomingSchedules[0];
      const dStr = new Date(first.schedule_date).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      kpiShift.textContent = `${dStr} (${first.start_time.substring(0,5)} - ${first.end_time.substring(0,5)})`;
    }

    upcomingSchedules.forEach(s => {
      const row = document.createElement('div');
      row.className = 'schedule-day-row';
      const formattedDate = new Date(s.schedule_date).toLocaleDateString('it-IT');
      row.innerHTML = `
        <strong>${formattedDate}</strong>
        <span>${s.start_time.substring(0,5)} - ${s.end_time.substring(0,5)}</span>
      `;
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '<p class="placeholder-text text-danger">Errore di connessione</p>';
  }
}

// Block Unavailability submit
addSafeListener('unavailability-form', 'submit', async (e) => {
  e.preventDefault();
  const employee_id = currentUser.employeeId;
  const unavailable_date = document.getElementById('unavail-date').value;
  const start_time = document.getElementById('unavail-start').value + ':00';
  const end_time = document.getElementById('unavail-end').value + ':00';
  const reason = document.getElementById('unavail-reason').value;

  try {
    const res = await fetch(`${BOOKING_API}/api/schedules/unavailability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ employee_id, unavailable_date, start_time, end_time, reason })
    });

    if (res.ok) {
      const data = await res.json();
      alert(`Indisponibilità salvata correttamente! Prenotazioni impattate: ${data.affected_bookings_count}`);
      document.getElementById('unavail-date').value = '';
      document.getElementById('unavail-reason').value = '';
      loadEmployeeUnavailabilities();
      loadEmployeeBookings();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Load employee unavailabilities list
async function loadEmployeeUnavailabilities() {
  const container = document.getElementById('employee-unavailabilities-list');
  const kpiAbs = document.getElementById('emp-kpi-absences');
  if (!container) return;

  try {
    const res = await fetch(`${BOOKING_API}/api/schedules/unavailability`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const list = await res.json();

    if (kpiAbs) {
      kpiAbs.textContent = `${list.length} ${list.length === 1 ? 'Giorno' : 'Giorni'}`;
    }

    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p class="placeholder-text" style="padding: 10px 0;">Nessun periodo di assenza inserito.</p>';
      return;
    }

    list.forEach(un => {
      const card = document.createElement('div');
      card.className = 'schedule-day-row';
      card.style.borderLeft = '3px solid var(--danger)';
      card.style.marginBottom = '6px';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      
      const formattedDate = new Date(un.unavailable_date).toLocaleDateString('it-IT');
      card.innerHTML = `
        <div>
          <strong>${formattedDate}</strong> (${un.start_time.substring(0,5)} - ${un.end_time.substring(0,5)})
          <div style="font-size: 11px; color: var(--text-muted);">${un.reason}</div>
        </div>
        <button class="delete-unavail-btn" data-id="${un.id}" style="background: none; border: none; color: var(--danger); cursor: pointer; padding: 5px; font-size: 14px;" title="Elimina indisponibilità">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      `;

      const deleteBtn = card.querySelector('.delete-unavail-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          if (confirm('Sei sicuro di voler rimuovere questa indisponibilità?')) {
            try {
              const dRes = await fetch(`${BOOKING_API}/api/schedules/unavailability/${un.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${currentUser.token}` }
              });
              if (dRes.ok) {
                alert('Indisponibilità rimossa con successo!');
                loadEmployeeUnavailabilities();
                loadEmployeeBookings();
              } else {
                const errData = await dRes.json();
                alert(errData.error || 'Errore durante la rimozione');
              }
            } catch (err) {
              alert('Errore di connessione.');
            }
          }
        });
      }

      container.appendChild(card);
    });
  } catch (e) {
    container.innerHTML = '<p class="placeholder-text text-danger">Errore caricamento assenze.</p>';
  }
}

// Load personal employee bookings
async function loadEmployeeBookings() {
  const list = document.getElementById('employee-bookings-list');
  const kpiBk = document.getElementById('emp-kpi-bookings');
  if (!list) return;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!res.ok) return;
    const bookings = await res.json();

    if (kpiBk) {
      const activeCount = bookings.filter(b => b.status !== 'cancelled').length;
      kpiBk.textContent = activeCount;
    }

    // Resolve client names in parallel
    await Promise.all(
      bookings.map(async bk => {
        bk.resolvedClientName = await getClientNameCached(bk.client_id);
      })
    );

    list.innerHTML = '';
    if (bookings.length === 0) {
      list.innerHTML = '<p class="placeholder-text">Nessun appuntamento prenotato con te.</p>';
      return;
    }

    bookings.forEach(bk => {
      const card = document.createElement('div');
      card.className = 'booking-item-card';
      card.style.marginBottom = '10px';
      const formattedTime = new Date(bk.booking_time).toLocaleString('it-IT');
      const statusClass = bk.status === 'confirmed' ? 'status-confirmed' : (bk.status === 'cancelled' ? 'status-cancelled' : 'status-pending');
      const statusLabel = bk.is_drop ? `${bk.status} (via Drop)` : bk.status;
      const statusBadge = `<span class="booking-status-tag ${statusClass}">${statusLabel}</span>`;

      card.innerHTML = `
        <div class="booking-main-info">
          <h4>Cliente: <strong>${bk.resolvedClientName}</strong></h4>
          <div class="service-meta">
            <span><i class="fa-solid fa-clock"></i> ${formattedTime}</span> • 
            <span>Trattamento: <strong>${bk.service_name || 'Beauty'}</strong></span> • 
            <span>Prezzo: <strong>${bk.price}€</strong></span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 15px;">
          ${statusBadge}
        </div>
      `;
      list.appendChild(card);
    });
  } catch (err) {
    list.innerHTML = '<p class="placeholder-text text-danger">Errore di connessione</p>';
  }
}


// ================= CONCURRENCY SIMULATOR =================

// Populate drops select in Simulator tab
function updateSimSelector() {
  const select = document.getElementById('sim-drop-select');
  const runBtn = document.getElementById('run-sim-btn');
  if (!select) return;
  
  select.innerHTML = '';
  if (currentActiveDrops.length === 0) {
    select.innerHTML = '<option value="">Nessun Drop attivo nel sistema...</option>';
    if (runBtn) runBtn.disabled = true;
    return;
  }
  
  currentActiveDrops.forEach(drop => {
    const opt = document.createElement('option');
    opt.value = drop.id;
    const date = new Date(drop.booking_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    opt.textContent = `Drop ID: ${drop.id.substring(0,8)}... (${drop.discounted_price}€ alle ${date})`;
    select.appendChild(opt);
  });
  
  if (runBtn) runBtn.disabled = false;
}

// Retrieve simulator active drops
async function loadSimDrops() {
  await loadActiveDrops();
}

// Auto setup scenario: runs registrations, schedules, bookings, cancellation and yields a drop + 50 clients
addSafeListener('auto-setup-sim-btn', 'click', async () => {
  const setupBtn = document.getElementById('auto-setup-sim-btn');
  setupBtn.disabled = true;
  setupBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Configurazione scenario...';
  
  const consoleLine = logConsole("Inizio Auto-Setup Scenario...", 'system');
  
  try {
    const idSuffix = Math.floor(Math.random() * 100000);
    
    // 1. Register Manager & Salon
    logConsole("1. Registrazione Manager Salone...", 'system');
    const mgrEmail = `sim_mgr_${idSuffix}@glam.com`;
    const salonName = `Simulated Glam ${idSuffix}`;
    const regRes = await fetch(`${AUTH_API}/api/auth/salon/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: mgrEmail,
        password: 'Password123!',
        first_name: 'SimMax',
        last_name: 'Rossi',
        phone: '12345',
        name: salonName,
        street: 'Piazza Duomo 12',
        city: 'Milano'
      })
    });
    const salonData = await regRes.json();
    const salonId = salonData.salon.id;

    // Login Manager to get token
    const mgrLoginRes = await fetch(`${AUTH_API}/api/auth/salon/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mgrEmail, password: 'Password123!' })
    });
    const mgrToken = (await mgrLoginRes.json()).token;

    // 2. Register Employee
    logConsole("2. Registrazione Estetista...", 'system');
    const empEmail = `sim_emp_${idSuffix}@glam.com`;
    const empRegRes = await fetch(`${AUTH_API}/api/auth/employee/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: empEmail,
        password: 'Password123!',
        first_name: 'SimStaff',
        last_name: 'Verdi',
        salon_id: salonId,
        specialization: 'Corpo'
      })
    });
    const empData = await empRegRes.json();
    const employeeId = empData.employee_id;

    // 3. Set Working schedule
    logConsole("3. Configurazione orari dipendente...", 'system');
    const today = new Date().getDay();
    await fetch(`${BOOKING_API}/api/schedules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mgrToken}`
      },
      body: JSON.stringify({ employee_id: employeeId, day_of_week: today, start_time: '00:00:00', end_time: '23:59:59' })
    });

    // 4. Create Category & Service
    logConsole("4. Creazione Servizio Corpo da 80€...", 'system');
    const catRes = await fetch(`${BOOKING_API}/api/catalog/categories`);
    const categories = await catRes.json();
    const catId = categories[0].id; // uses Corpo or Unghie

    const srvRes = await fetch(`${BOOKING_API}/api/catalog/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mgrToken}`
      },
      body: JSON.stringify({ category_id: catId, name: 'Trattamento Simula', duration_minutes: 60, price: 80 })
    });
    const serviceId = (await srvRes.json()).id;

    // 5. Create Client
    logConsole("5. Registrazione cliente per prenotazione...", 'system');
    const clientEmail = `sim_cli_${idSuffix}@glam.com`;
    await fetch(`${AUTH_API}/api/auth/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, password: 'Password123!', first_name: 'SimClient', last_name: 'Bianchi' })
    });

    // Client Login
    const cliLoginRes = await fetch(`${AUTH_API}/api/auth/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, password: 'Password123!' })
    });
    const clientToken = (await cliLoginRes.json()).token;

    // 6. Make standard booking for today + 4 hours (which is < 24h away)
    logConsole("6. Effettuazione prenotazione standard...", 'system');
    const bookingTime = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const bookingRes = await fetch(`${BOOKING_API}/api/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ service_id: serviceId, employee_id: employeeId, booking_time: bookingTime })
    });
    const bookingId = (await bookingRes.json()).id;

    // 7. Cancel standard booking (triggers Late Cancellation Event -> Drop generated at 50% discount = 40€)
    logConsole("7. Cancellazione tardiva (<24h)...", 'system');
    await fetch(`${BOOKING_API}/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${clientToken}` }
    });

    logConsole("8. Generazione Drop in corso (RabbitMQ consuma l'evento)...", 'system');
    // Wait for async consumer
    await new Promise(r => setTimeout(r, 2000));
    
    // Refresh drops
    await loadActiveDrops();
    
    // 8. Register 50 clients to obtain JWT tokens for concurrency test
    logConsole("9. Registrazione di 50 Clienti Concorrenti nel database in parallelo...", 'system');
    simTokens = [];
    const registerPromises = [];
    
    for (let i = 0; i < 50; i++) {
      const email = `herd_${idSuffix}_${i}@test.com`;
      const pass = 'Password123!';
      const regPromise = async () => {
        // Register
        await fetch(`${AUTH_API}/api/auth/client/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pass, first_name: `User${i}`, last_name: 'Herd' })
        });
        // Login
        const lRes = await fetch(`${AUTH_API}/api/auth/client/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pass })
        });
        const lData = await lRes.json();
        return lData.token;
      };
      registerPromises.push(regPromise());
    }
    
    simTokens = await Promise.all(registerPromises);
    
    logConsole(`Scenario configurato con successo! Generati 50 utenti virtuali.`, 'system');
    alert('Scenario configurato con successo! È stato generato un drop e creati 50 utenti concorrenti. Ora premi "Esegui Assalto Simultaneo".');

  } catch (err) {
    console.error(err);
    alert('Errore durante la configurazione automatica dello scenario. Controlla che le API siano avviate.');
  } finally {
    setupBtn.disabled = false;
    setupBtn.innerHTML = '<i class="fa-solid fa-magic"></i> Auto-Setup Scenario';
  }
});

// Run concurrency test (Assalto simultaneo)
addSafeListener('run-sim-btn', 'click', async () => {
  const dropId = document.getElementById('sim-drop-select').value;
  const runBtn = document.getElementById('run-sim-btn');
  const simLogs = document.getElementById('sim-logs');
  
  if (!dropId) {
    alert('Nessun drop selezionato.');
    return;
  }
  
  if (simTokens.length === 0) {
    alert('Esegui prima la configurazione automatica (Auto-Setup Scenario) per registrare i 50 client concorrenti.');
    return;
  }

  runBtn.disabled = true;
  simLogs.innerHTML = '';
  logConsole(`Lancio dell'assalto concorrente di 50 utenti sul Drop: ${dropId}...`, 'system');
  
  let successCount = 0;
  let conflictCount = 0;
  let responseTimes = [];
  
  // Single concurrent claim function
  const runClaim = async (token, idx) => {
    const startTime = performance.now();
    try {
      const res = await fetch(`${DROP_API}/api/drops/${dropId}/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      const endTime = performance.now();
      const elapsed = Math.round(endTime - startTime);
      responseTimes.push(elapsed);
      
      const data = await res.json();
      
      const line = document.createElement('div');
      line.className = 'log-line';
      
      if (res.status === 202) {
        successCount++;
        line.innerHTML = `<span class="log-success">[202 Accepted]</span> Utente_${idx} si è aggiudicato il drop in ${elapsed}ms! (Salvataggio asincrono)`;
      } else if (res.status === 409) {
        conflictCount++;
        line.innerHTML = `<span class="log-conflict">[409 Conflict]</span> Utente_${idx} rifiutato all'istante da Redis in ${elapsed}ms: slot occupato.`;
      } else {
        line.innerHTML = `<span>[${res.status}]</span> Utente_${idx} errore in ${elapsed}ms: ${data.error}`;
      }
      simLogs.appendChild(line);
      
    } catch (err) {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.innerHTML = `<span class="log-conflict">[FAIL]</span> Connessione fallita per Utente_${idx}.`;
      simLogs.appendChild(line);
    }
  };

  // Launch 50 requests in parallel!
  const promises = simTokens.map((token, idx) => runClaim(token, idx));
  await Promise.all(promises);

  // Print results
  document.getElementById('sim-stat-total').textContent = simTokens.length;
  document.getElementById('sim-stat-success').textContent = successCount;
  document.getElementById('sim-stat-conflict').textContent = conflictCount;
  
  const avgTime = Math.round(responseTimes.reduce((a,b) => a+b, 0) / responseTimes.length);
  document.getElementById('sim-stat-time').textContent = `${avgTime} ms`;
  
  // Fill progress bar (usually 1 success out of 50 = 2% or show conflict ratio)
  document.getElementById('sim-progress-bar').style.width = '100%';
  
  logConsole(`=== FINE SIMULAZIONE ===`, 'system');
  logConsole(`Successi: ${successCount} (Dovrebbe essere esattamente 1)`, successCount === 1 ? 'system' : 'error');
  logConsole(`Conflitti: ${conflictCount} (Rifiutati instantaneamente da Redis)`, 'system');
  
  loadActiveDrops(); // reload lists
  runBtn.disabled = false;
});

// Manual refresh removed (polling handles it auto)

// Submit Add Service Form
addSafeListener('add-service-form', 'submit', async (e) => {
  e.preventDefault();
  if (!currentUser || currentUser.role !== 'salon_manager') return;

  const categoryId = document.getElementById('srv-category').value;
  const name = document.getElementById('srv-name').value;
  const duration = parseInt(document.getElementById('srv-duration').value);
  const price = parseFloat(document.getElementById('srv-price').value);
  const description = document.getElementById('srv-description').value || '';
  const image_url = document.getElementById('srv-image') ? document.getElementById('srv-image').value.trim() : '';

  if (!categoryId || !name || !duration || !price) {
    alert('Tutti i campi sono obbligatori');
    return;
  }

  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ category_id: categoryId, name, duration_minutes: duration, price, description, image_url })
    });

    if (res.ok) {
      alert('Trattamento aggiunto con successo al catalogo!');
      document.getElementById('srv-name').value = '';
      document.getElementById('srv-price').value = '';
      document.getElementById('srv-description').value = '';
      if (document.getElementById('srv-image')) document.getElementById('srv-image').value = '';
      if (srvRegUploader) srvRegUploader.updatePreview('');
      loadManagerServices();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante la creazione del servizio');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Automatically update discounted price (50% of the service price)
function updateDiscountedDropPrice() {
  const selectDropSrv = document.getElementById('drop-service-select');
  const dropPriceInput = document.getElementById('drop-price');
  if (!selectDropSrv || !dropPriceInput) return;
  const selectedOpt = selectDropSrv.options[selectDropSrv.selectedIndex];
  if (selectedOpt && selectedOpt.dataset.price) {
    const originalPrice = parseFloat(selectedOpt.dataset.price);
    const discounted = (originalPrice * 0.5).toFixed(2);
    dropPriceInput.value = discounted;
  } else {
    dropPriceInput.value = '';
  }
}
addSafeListener('drop-service-select', 'change', updateDiscountedDropPrice);

// Submit Add Drop Form
addSafeListener('add-drop-form', 'submit', async (e) => {
  e.preventDefault();
  if (!currentUser || currentUser.role !== 'salon_manager') return;

  const serviceSelect = document.getElementById('drop-service-select');
  const employeeSelect = document.getElementById('drop-employee-select');
  const serviceId = serviceSelect ? serviceSelect.value : '';
  const employeeId = employeeSelect ? employeeSelect.value : '';
  const timeInput = document.getElementById('drop-time').value; // 'YYYY-MM-DDTHH:MM'
  let discountedPrice = parseFloat(document.getElementById('drop-price').value);

  if (!serviceId) {
    alert('Seleziona un trattamento dal listino per pubblicare il Drop. Se non hai ancora inserito trattamenti, aggiungine uno nella sezione "Catalogo Servizi".');
    return;
  }

  if (!employeeId) {
    alert('Nessun dipendente selezionato. Devi prima registrare almeno un\'estetista / dipendente nella sezione "Gestione Staff" per poter assegnare e pubblicare un Drop.');
    return;
  }

  if (!timeInput) {
    alert('Seleziona data e ora per lo slot promozionale.');
    return;
  }

  // Auto-calculate 50% if drop-price field was not computed yet
  if (isNaN(discountedPrice) || discountedPrice <= 0) {
    const selectedOpt = serviceSelect.options[serviceSelect.selectedIndex];
    if (selectedOpt && selectedOpt.dataset.price) {
      discountedPrice = parseFloat((parseFloat(selectedOpt.dataset.price) * 0.5).toFixed(2));
      document.getElementById('drop-price').value = discountedPrice;
    }
  }

  if (isNaN(discountedPrice) || discountedPrice <= 0) {
    alert('Impossibile calcolare il prezzo scontato del trattamento selezionato.');
    return;
  }

  // Ensure bookingTime is strictly in the future
  const chosenDate = new Date(timeInput);
  if (chosenDate.getTime() <= Date.now()) {
    alert('La data e ora dell\'appuntamento devono essere nel futuro per pubblicare un Drop attivo.');
    return;
  }

  // Format date time: YYYY-MM-DD HH:MM:00
  const bookingTime = timeInput.replace('T', ' ') + ':00';

  const submitBtn = e.target.querySelector('[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Pubblicazione in corso...'; }

  try {
    const res = await fetch(`${DROP_API}/api/drops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({
        service_id: serviceId,
        employee_id: employeeId,
        booking_time: bookingTime,
        discounted_price: discountedPrice
      })
    });

    if (res.ok) {
      alert('Drop Last-Minute al 50% pubblicato con successo! È ora visibile sulla homepage e acquistabile dagli utenti.');
      document.getElementById('drop-time').value = '';
      updateDiscountedDropPrice();
      loadActiveDrops();
      loadSalonBookings();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante la pubblicazione del drop');
    }
  } catch (err) {
    alert('Errore di connessione con il servizio Drop');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Pubblica Slot Scontato'; }
  }
});



// Auth Helper: Programmatically trigger Registration modal
function setRegisterRole(role) {
  currentAuthRole = role;
  const managerFields = document.getElementById('manager-reg-fields');
  const clientBtn = document.getElementById('reg-role-client-btn');
  const managerBtn = document.getElementById('reg-role-manager-btn');
  const modalTitle = document.getElementById('register-modal-title');
  const submitBtn = document.getElementById('reg-submit-btn');

  if (managerFields) {
    managerFields.style.display = (role === 'salon_manager') ? 'block' : 'none';
  }
  if (clientBtn && managerBtn) {
    if (role === 'salon_manager') {
      managerBtn.className = 'btn btn-sm btn-gold active';
      clientBtn.className = 'btn btn-sm btn-gold-outline';
      if (modalTitle) modalTitle.textContent = 'Registrazione Salone (Partner Manager)';
      if (submitBtn) submitBtn.textContent = 'Registra Salone & Account';
    } else {
      clientBtn.className = 'btn btn-sm btn-gold active';
      managerBtn.className = 'btn btn-sm btn-gold-outline';
      if (modalTitle) modalTitle.textContent = 'Registrazione Cliente';
      if (submitBtn) submitBtn.textContent = 'Registrati come Cliente';
    }
  }
}
window.setRegisterRole = setRegisterRole;

function openRegister(role) {
  if (loginModal) loginModal.close();
  setRegisterRole(role || 'client');
  if (registerModal) registerModal.showModal();
}
window.openRegister = openRegister;

// B2C Dynamic Filtering for Search bar inputs
async function filterSalonsAndServices() {
  const query = document.getElementById('search-salon-name').value.toLowerCase().trim();
  const cityQuery = document.getElementById('search-salon-location').value.toLowerCase().trim();
  const category = document.getElementById('search-salon-category').value;
  
  const dateFilter = document.getElementById('search-salon-date').value;
  const timeFilter = document.getElementById('search-salon-time').value;
  
  const salonsView = document.getElementById('salons-list-view');
  if (salonsView && salonsView.style.display !== 'none') {
    // We are on homepage list: filter salon cards
    const cards = document.querySelectorAll('#salons-grid .salon-card');
    
    // Check real-time availability from API if date and time are both selected
    let availableSalonIds = null;
    if (dateFilter && timeFilter) {
      availableSalonIds = new Set();
      await Promise.all(currentSalonsList.map(async (salon) => {
        try {
          // 1. Fetch employees of this salon
          const empRes = await fetch(`${AUTH_API}/api/auth/salons/${salon.id}/employees`);
          if (!empRes.ok) return;
          const employees = await empRes.json();
          
          // 2. Check each employee's availability
          let isSalonAvailable = false;
          await Promise.all(employees.map(async (emp) => {
            try {
              const availRes = await fetch(`${BOOKING_API}/api/bookings/availability?employee_id=${emp.id}&date=${dateFilter}&duration_minutes=30`);
              if (!availRes.ok) return;
              const availData = await availRes.json();
              
              if (availData.available && availData.slots.includes(timeFilter)) {
                isSalonAvailable = true;
              }
            } catch (e) {}
          }));
          
          if (isSalonAvailable) {
            availableSalonIds.add(salon.id);
          }
        } catch (e) {}
      }));
    }
    
    let visibleCardsCount = 0;
    cards.forEach(card => {
      const salonId = card.getAttribute('data-id');
      const name = card.querySelector('.salon-card-title').textContent.toLowerCase();
      const desc = card.querySelector('.salon-card-desc').textContent.toLowerCase();
      
      const salonObj = currentSalonsList.find(s => String(s.id) === String(salonId));
      const street = salonObj ? (salonObj.street || '').toLowerCase() : '';
      const city = salonObj ? (salonObj.city || '').toLowerCase() : '';
      const categoryAttr = card.getAttribute('data-categories') || '';
      
      const salonServices = salonServicesMap[salonId] || [];
      const matchesService = salonServices.some(srv => {
        const srvName = (srv.name || '').toLowerCase();
        const srvDesc = (srv.description || '').toLowerCase();
        const srvCat = (srv.category_name || '').toLowerCase();
        return srvName.includes(query) || srvDesc.includes(query) || srvCat.includes(query);
      });

      const matchesQuery = !query || name.includes(query) || desc.includes(query) || street.includes(query) || city.includes(query) || matchesService;
      const matchesCity = !cityQuery || city.includes(cityQuery);
      const matchesCategory = (category === 'all') || 
        categoryAttr.toLowerCase().includes(category.toLowerCase()) || 
        salonServices.some(srv => (srv.category_name || '').toLowerCase().includes(category.toLowerCase()));
      
      // Real-time availability match
      let matchesAvailability = true;
      if (availableSalonIds !== null) {
        matchesAvailability = availableSalonIds.has(salonId);
      }
      
      // Fallback: If date is selected but no time is selected, we can filter out Sundays
      let matchesDate = true;
      if (dateFilter && !timeFilter) {
        const dayOfWeek = new Date(dateFilter).getDay();
        if (dayOfWeek === 0) { // Sunday
          matchesDate = false;
        }
      }
      
      if (matchesQuery && matchesCity && matchesCategory && matchesAvailability && matchesDate) {
        card.style.display = 'flex';
        visibleCardsCount++;
      } else {
        card.style.display = 'none';
      }
    });

    let noResultsMsg = document.getElementById('no-salons-search-msg');
    if (visibleCardsCount === 0) {
      if (!noResultsMsg) {
        noResultsMsg = document.createElement('div');
        noResultsMsg.id = 'no-salons-search-msg';
        noResultsMsg.className = 'placeholder-text';
        noResultsMsg.style.gridColumn = '1 / -1';
        noResultsMsg.style.textAlign = 'center';
        noResultsMsg.style.padding = '40px 20px';
        noResultsMsg.style.fontSize = '1rem';
        noResultsMsg.innerHTML = '<i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; color: var(--gold); margin-bottom: 12px; display: block;"></i>Nessun salone o trattamento trovato con i filtri selezionati.';
        const grid = document.getElementById('salons-grid');
        if (grid) grid.appendChild(noResultsMsg);
      } else {
        noResultsMsg.style.display = 'block';
      }
    } else if (noResultsMsg) {
      noResultsMsg.style.display = 'none';
    }
  } else {
    // We are on detail page: filter treatment items in the list
    const srvCards = document.querySelectorAll('#catalog-list .service-item-card');
    srvCards.forEach(card => {
      const name = card.querySelector('h4').textContent.toLowerCase();
      const cat = card.getAttribute('data-cat-name') || '';
      
      const matchesQuery = name.includes(query);
      const matchesCategory = (category === 'all') || cat.toLowerCase() === category.toLowerCase();
      
      if (matchesQuery && matchesCategory) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  }
}
window.filterSalonsAndServices = filterSalonsAndServices;

// Fetch and load today's real bookings count
async function loadTodayBookingsCount() {
  const counterEl = document.getElementById('stats-prenotati-oggi');
  if (!counterEl) return;
  try {
    const res = await fetch(`${BOOKING_API}/api/bookings/count/today`);
    if (res.ok) {
      const data = await res.json();
      counterEl.textContent = data.count.toLocaleString('it-IT');
    }
  } catch (err) {
    console.error('Errore caricamento contatore reale:', err);
  }
}

// Social proof counter increments - ONLY real DB count periodically
async function initLiveCounter() {
  await loadTodayBookingsCount();
  
  if (window.liveCounterInterval) clearInterval(window.liveCounterInterval);
  window.liveCounterInterval = setInterval(loadTodayBookingsCount, 10000);
}

// Load reviews for selected salon
async function loadSalonReviews(salonId) {
  const reviewsList = document.getElementById('salon-reviews-list');
  if (!reviewsList) return;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/reviews/salon/${salonId}`);
    let dbReviews = [];
    if (res.ok) {
      dbReviews = await res.json();
    }
    
    let totalRating = 0;
    let reviewItemsHTML = '';
    
    // Render real reviews from DB
    dbReviews.forEach(rev => {
      const stars = '<i class="fa-solid fa-star"></i>'.repeat(rev.rating) + '<i class="fa-regular fa-star"></i>'.repeat(5 - rev.rating);
      const author = 'Cliente GlamDrop #' + rev.client_id.slice(0, 4).toUpperCase();
      const dateStr = new Date(rev.created_at).toLocaleDateString('it-IT');
      totalRating += rev.rating;

      let treatmentMeta = '';
      if (rev.service_name && rev.booking_time) {
        const bkTime = new Date(rev.booking_time).toLocaleString('it-IT', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        treatmentMeta = `<div style="font-size: 11px; font-weight: 700; color: var(--gold); margin-bottom: 3px;">
          <i class="fa-solid fa-circle-check"></i> ${rev.service_name} • Eseguito da: ${rev.employee_name || 'Dipendente'} il ${bkTime}
        </div>`;
      }
      
      reviewItemsHTML += `
        <div class="review-item" style="padding: 15px; border-bottom: 1px solid var(--border-color);">
          <div class="review-header" style="display: flex; justify-content: space-between; margin-bottom: 5px;">
            <span class="review-author" style="font-weight: 700;">${author}</span>
            <span class="review-stars" style="color: #FFB020;">${stars}</span>
          </div>
          ${treatmentMeta}
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">Recensito il ${dateStr}</div>
          <p class="review-comment" style="font-style: italic; color: var(--text-main);">"${rev.comment || 'Nessun commento scritto.'}"</p>
        </div>
      `;
    });
    
    const totalCount = dbReviews.length;
    const avgRating = totalCount > 0 ? (totalRating / totalCount).toFixed(1) : '0.0';
    
    if (totalCount === 0) {
      reviewsList.innerHTML = '<p class="placeholder-text" style="text-align: center; padding: 20px 0; color: var(--text-muted); font-size: 13px;">Nessuna recensione disponibile per questo salone. Sii il primo a prenotare e lasciare una valutazione!</p>';
    } else {
      reviewsList.innerHTML = reviewItemsHTML;
    }
    
    // Dynamically update the header badge rating
    const detailRatingBadge = document.querySelector('.detail-salon-address');
    if (detailRatingBadge) {
      let starBadge = document.getElementById('detail-salon-rating-badge');
      if (!starBadge) {
        starBadge = document.createElement('span');
        starBadge.id = 'detail-salon-rating-badge';
        starBadge.style.marginLeft = '15px';
        starBadge.style.fontWeight = '700';
        starBadge.style.color = '#FFB020';
        detailRatingBadge.appendChild(starBadge);
      }
      if (totalCount > 0) {
        starBadge.innerHTML = `<i class="fa-solid fa-star"></i> ${avgRating} (${totalCount} ${totalCount === 1 ? 'recensione' : 'recensioni'})`;
        starBadge.style.display = 'inline-block';
      } else {
        starBadge.innerHTML = `<i class="fa-regular fa-star"></i> Nessuna recensione`;
        starBadge.style.display = 'inline-block';
      }
    }
  } catch (err) {
    console.error('Errore caricamento recensioni:', err);
    reviewsList.innerHTML = '<p class="placeholder-text">Errore nel caricamento delle recensioni.</p>';
  }
}

// Stars selector toggler inside modal
function setReviewStarsSelection(rating) {
  document.getElementById('rev-rating-value').value = rating;
  const stars = document.querySelectorAll('#star-rating-selector i');
  stars.forEach(star => {
    const starRating = parseInt(star.getAttribute('data-rating'));
    if (starRating <= rating) {
      star.classList.add('selected');
      star.classList.remove('fa-regular');
      star.classList.add('fa-solid');
    } else {
      star.classList.remove('selected');
      star.classList.remove('fa-solid');
      star.classList.add('fa-regular');
    }
  });
}
window.setReviewStarsSelection = setReviewStarsSelection;

// Footer Simulator view trigger
function switchToSimulatorTab() {
  const simTabBtn = document.getElementById('sim-nav-btn');
  if (simTabBtn) {
    simTabBtn.click();
  } else {
    // Simulator tab manual display
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const clientTab = document.getElementById('client-tab');
    const simTab = document.getElementById('simulator-tab');
    if (clientTab) clientTab.classList.remove('active');
    if (simTab) simTab.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
window.switchToSimulatorTab = switchToSimulatorTab;

// Bind star rating selectors on document ready with hover effects!
const starRatingSelector = document.getElementById('star-rating-selector');
if (starRatingSelector) {
  const stars = starRatingSelector.querySelectorAll('i');
  
  stars.forEach(star => {
    star.addEventListener('click', () => {
      const rating = parseInt(star.getAttribute('data-rating'));
      setReviewStarsSelection(rating);
    });
    
    // Hover effect
    star.addEventListener('mouseenter', () => {
      const rating = parseInt(star.getAttribute('data-rating'));
      stars.forEach(s => {
        const starRating = parseInt(s.getAttribute('data-rating'));
        if (starRating <= rating) {
          s.classList.add('selected');
          s.classList.remove('fa-regular');
          s.classList.add('fa-solid');
        } else {
          s.classList.remove('selected');
          s.classList.remove('fa-solid');
          s.classList.add('fa-regular');
        }
      });
    });
  });
  
  // Restore selected rating when mouse leaves the container
  starRatingSelector.addEventListener('mouseleave', () => {
    const selectedRating = parseInt(document.getElementById('rev-rating-value').value || '5');
    setReviewStarsSelection(selectedRating);
  });
}

// Bind review form submit handler
addSafeListener('review-form', 'submit', async (e) => {
  e.preventDefault();
  const booking_id = document.getElementById('rev-booking-id').value;
  const rating = document.getElementById('rev-rating-value').value;
  const comment = document.getElementById('rev-comment').value;
  const salonId = document.getElementById('rev-salon-id').value;
  
  try {
    const res = await fetch(`${BOOKING_API}/api/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ booking_id, rating, comment })
    });
    
    if (res.ok) {
      alert('Recensione pubblicata con successo!');
      document.getElementById('review-modal').close();
      loadClientBookings();
      if (salonId) loadSalonReviews(salonId);
    } else {
      const err = await res.json();
      alert(err.error || 'Errore nella pubblicazione della recensione');
    }
  } catch (err) {
    alert('Errore di connessione.');
  }
});

// SPA Navigation: Select Salon Detail View
async function selectSalon(salonId) {
  currentDropIndex = 0;

  // FIX: aggiorna sempre currentSalonId e lancia il catalogo,
  // indipendentemente dall'esistenza di salon-select (che e' nascosto)
  currentSalonId = salonId;

  const select = document.getElementById('salon-select');
  if (select) select.value = salonId;

  // Carica immediatamente i servizi del salone selezionato
  loadSalonCatalog(salonId);

  const salon = currentSalonsList.find(s => s.id === salonId);
  if (salon) {
    const detailName = document.getElementById('detail-salon-name');
    const detailAddr = document.getElementById('detail-salon-address');
    const detailDesc = document.getElementById('detail-salon-desc');
    if (detailName) detailName.textContent = salon.name;
    if (detailAddr) detailAddr.textContent = `${salon.street}, ${salon.city}`;
    if (detailDesc) detailDesc.textContent = salon.description || 'Salone di bellezza partner GlamDrop. Trattamenti professionali e promozioni esclusive.';
  }

  const salonsView = document.getElementById('salons-list-view');
  const detailView = document.getElementById('salon-detail-view');
  if (salonsView) salonsView.style.display = 'none';
  if (detailView) detailView.style.display = 'block';

  loadSalonReviews(salonId);

  if (currentUser && currentUser.role === 'client') {
    loadClientBookings();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.selectSalon = selectSalon;

// SPA Navigation: Back to Salons Homepage List
function showSalonsList() {
  const salonsView = document.getElementById('salons-list-view');
  const detailView = document.getElementById('salon-detail-view');
  const bookingsView = document.getElementById('client-bookings-view');
  const settingsView = document.getElementById('client-settings-view');
  
  if (salonsView) salonsView.style.display = 'block';
  if (detailView) detailView.style.display = 'none';
  if (bookingsView) bookingsView.style.display = 'none';
  if (settingsView) settingsView.style.display = 'none';
  
  const clientTab = document.getElementById('client-tab');
  const simTab = document.getElementById('simulator-tab');
  if (simTab) simTab.classList.remove('active');
  if (clientTab) clientTab.classList.add('active');
}
window.showSalonsList = showSalonsList;

// SPA Navigation: Show Dedicated Client Bookings View
function showClientBookingsView() {
  const salonsView = document.getElementById('salons-list-view');
  const detailView = document.getElementById('salon-detail-view');
  const bookingsView = document.getElementById('client-bookings-view');
  const settingsView = document.getElementById('client-settings-view');
  
  if (salonsView) salonsView.style.display = 'none';
  if (detailView) detailView.style.display = 'none';
  if (bookingsView) bookingsView.style.display = 'block';
  if (settingsView) settingsView.style.display = 'none';
  
  loadClientBookings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.showClientBookingsView = showClientBookingsView;

// SPA Navigation: Show User Settings View
function showClientSettingsView() {
  const salonsView = document.getElementById('salons-list-view');
  const detailView = document.getElementById('salon-detail-view');
  const bookingsView = document.getElementById('client-bookings-view');
  const settingsView = document.getElementById('client-settings-view');
  
  if (salonsView) salonsView.style.display = 'none';
  if (detailView) detailView.style.display = 'none';
  if (bookingsView) bookingsView.style.display = 'none';
  if (settingsView) settingsView.style.display = 'block';
  
  // Close profile dropdown
  const profileDropdown = document.getElementById('profile-dropdown');
  if (profileDropdown) profileDropdown.style.display = 'none';
  
  loadClientSettings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.showClientSettingsView = showClientSettingsView;

// --- MAILBOX ALERTS & PREFERENCES MANAGEMENT ---
let mailboxPollingInterval = null;
let servicesCache = {};


function initMailboxPolling() {
  if (mailboxPollingInterval) clearInterval(mailboxPollingInterval);
  loadMailboxNotifications();
  mailboxPollingInterval = setInterval(loadMailboxNotifications, 1000);
}

function stopMailboxPolling() {
  if (mailboxPollingInterval) {
    clearInterval(mailboxPollingInterval);
    mailboxPollingInterval = null;
  }
}

async function fetchSalonServicesCached(salonId) {
  if (servicesCache[salonId]) return servicesCache[salonId];
  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/salons/${salonId}/services`);
    if (res.ok) {
      const services = await res.json();
      servicesCache[salonId] = services;
      return services;
    }
  } catch (err) {
    console.error('Error fetching salon services for cache:', err);
  }
  return [];
}

function formatNotifMessage(notif, serviceName = 'trattamento', salonName = '') {
  let text = notif.message;
  
  // Format the booking/drop time if present
  let timeText = '';
  if (notif.data && notif.data.booking_time) {
    try {
      const date = new Date(notif.data.booking_time);
      const formattedTime = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      const formattedDate = date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const isToday = date.toDateString() === new Date().toDateString();
      timeText = isToday ? `oggi alle ${formattedTime}` : `il ${formattedDate} alle ${formattedTime}`;
    } catch (e) {
      timeText = notif.data.booking_time;
    }
  }

  const salonText = salonName ? ` presso <strong>${salonName}</strong>` : '';

  if (notif.type === 'DROP_CREATED') {
    const priceText = notif.data.discounted_price ? `${parseFloat(notif.data.discounted_price).toFixed(2)}€` : 'prezzo scontato';
    return `<strong>Flash Sale 50%!</strong> Prenota al volo <strong>${serviceName}</strong>${salonText} per <strong>${timeText}</strong> a soli <strong>${priceText}</strong>!`;
  }
  if (notif.type === 'DROP_CLAIMED_CONFIRMED') {
    const priceText = notif.data.price ? `${parseFloat(notif.data.price).toFixed(2)}€` : 'prezzo scontato';
    return `<strong>Drop Assegnato!</strong> Ti sei aggiudicato <strong>${serviceName}</strong>${salonText} per <strong>${timeText}</strong> a <strong>${priceText}</strong>. Controlla le tue prenotazioni!`;
  }
  if (notif.type === 'BOOKING_CONFIRMED') {
    const priceText = notif.data.price ? `${parseFloat(notif.data.price).toFixed(2)}€` : '';
    const priceTextFormatted = priceText ? ` (pagato: <strong>${priceText}</strong>)` : '';
    return `<strong>Prenotazione Confermata!</strong> Il tuo appuntamento per <strong>${serviceName}</strong>${salonText} per <strong>${timeText}</strong> è confermato${priceTextFormatted}.`;
  }
  if (notif.type === 'BOOKING_CANCELLED_REGULAR') {
    const refundText = notif.data.refundAmount ? ` con rimborso del 100% (<strong>${parseFloat(notif.data.refundAmount).toFixed(2)}€</strong>)` : '';
    return `<strong>Prenotazione Annullata.</strong> Il tuo appuntamento per <strong>${serviceName}</strong>${salonText} per <strong>${timeText}</strong> è stato annullato${refundText}.`;
  }
  if (notif.type === 'BOOKING_CANCELLED_LATE') {
    const refundText = notif.data.refundAmount ? ` con rimborso del 50% (<strong>${parseFloat(notif.data.refundAmount).toFixed(2)}€</strong>)` : '';
    return `<strong>Cancellazione Tardiva.</strong> Il tuo appuntamento per <strong>${serviceName}</strong>${salonText} per <strong>${timeText}</strong> è stato annullato a meno di 24 ore${refundText}.`;
  }
  return text;
}

let lastLoadedNotifIds = [];

async function loadMailboxNotifications() {
  if (!currentUser) return;

  const listContainer = document.getElementById('mailbox-notifications-list');
  const badge = document.getElementById('mailbox-unread-count');
  if (!listContainer) return;

  try {
    const prefKey = `prefs_${currentUser.id}`;
    const savedPrefs = JSON.parse(localStorage.getItem(prefKey)) || {};
    const prefs = {
      notifEnabled: true,
      cities: [],
      salons: [],
      categories: [],
      ...savedPrefs
    };

    const res = await fetch(`${NOTIF_API}/api/notifications`);
    if (!res.ok) {
      console.warn('[DEBUG Mailbox] Fetch notifications failed with status:', res.status);
      return;
    }
    const allNotifs = await res.json();

    const readKey = `read_notifications_${currentUser.id}`;
    let readNotifications = JSON.parse(localStorage.getItem(readKey)) || [];

    // Check if the server notifications list restarted (e.g. container restart)
    const clearedKey = `cleared_${currentUser.id}`;
    let clearedNotifs = JSON.parse(localStorage.getItem(clearedKey)) || [];

    if (allNotifs.length > 0) {
      const maxServerId = Math.max(...allNotifs.map(n => Number(n.id)));
      const maxReadId = readNotifications.length > 0 ? Math.max(...readNotifications.map(Number)) : 0;
      const maxClearedId = clearedNotifs.length > 0 ? Math.max(...clearedNotifs.map(Number).filter(n => !isNaN(n))) : 0;
      
      if (maxServerId < maxReadId || maxServerId < maxClearedId) {
        console.log('[DEBUG Mailbox] Server IDs reset detected. Clearing readNotifications and clearedNotifs.');
        readNotifications = [];
        localStorage.setItem(readKey, JSON.stringify([]));
        clearedNotifs = [];
        localStorage.setItem(clearedKey, JSON.stringify([]));
      }
    }

    const filteredNotifs = [];

    if (currentUser.role === 'client') {
      if (!prefs.notifEnabled) {
        listContainer.innerHTML = '<p class="placeholder-text" style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 15px 0;">Le notifiche push sono disattivate nelle tue Impostazioni.</p>';
        if (badge) {
          badge.style.display = 'none';
          badge.textContent = '0';
        }
        return;
      }

      for (const notif of allNotifs) {
        if (clearedNotifs.includes(notif.id)) continue;
        if (!notif.data) continue;

        const msg = notif.message || '';
        if (msg.includes('Notifica dipendente') || msg.includes('Notifica salone') || msg.includes('Riassegnazione pendente')) {
          continue;
        }

        const isDropCreated = notif.type === 'DROP_CREATED';
        const isForCurrentUser = notif.data.client_id === currentUser.id;

        if (isDropCreated) {
          const salonId = notif.data.salon_id;
          const serviceId = notif.data.service_id;

          const salon = currentSalonsList.find(s => String(s.id) === String(salonId));
          if (!salon) continue;

          if (prefs.cities && prefs.cities.length > 0) {
            const salonCityLower = salon.city ? salon.city.toLowerCase() : '';
            const preferredCitiesLower = prefs.cities.map(c => c.toLowerCase());
            if (!preferredCitiesLower.includes(salonCityLower)) {
              continue;
            }
          }

          if (prefs.salons && prefs.salons.length > 0 && !prefs.salons.includes(salonId)) {
            continue;
          }

          if (prefs.categories && prefs.categories.length > 0 && serviceId) {
            const services = await fetchSalonServicesCached(salonId);
            const service = services.find(s => String(s.id) === String(serviceId));
            if (service && !prefs.categories.includes(service.category_name)) {
              continue;
            }
          }
        } else if (!isForCurrentUser) {
          continue;
        }

        filteredNotifs.push(notif);
      }
    } else if (currentUser.role === 'salon_manager') {
      for (const notif of allNotifs) {
        if (clearedNotifs.includes(notif.id)) continue;
        if (!notif.data) continue;

        const msg = notif.message || '';
        const hasSalonTarget = msg.includes('Notifica salone') || msg.includes('Riassegnazione pendente') || msg.includes('Cancellazione tardiva') || msg.includes('Cancellazione regolare');
        
        const notifSalonId = notif.data.salon_id || notif.data.salonId;
        const isForMySalon = notifSalonId && String(notifSalonId) === String(currentUser.salonId);

        if (hasSalonTarget && isForMySalon) {
          filteredNotifs.push(notif);
        }
      }
    } else if (currentUser.role === 'employee') {
      for (const notif of allNotifs) {
        if (clearedNotifs.includes(notif.id)) continue;
        if (!notif.data) continue;

        const msg = notif.message || '';
        const hasEmployeeTarget = msg.includes('Notifica dipendente') || msg.includes('Nuovo appuntamento in agenda');
        
        const isForMe = (notif.data.employee_id && String(notif.data.employee_id) === String(currentUser.employeeId)) || 
                        (notif.data.user_id && String(notif.data.user_id) === String(currentUser.id)) ||
                        (notif.data.client_id && String(notif.data.client_id) === String(currentUser.id));

        if (hasEmployeeTarget && isForMe) {
          filteredNotifs.push(notif);
        }
      }
    }

    // Detect changes in filtered notifications to trigger auto-refreshes of data lists
    const newNotifIds = filteredNotifs.map(n => n.id);
    const isDifferent = lastLoadedNotifIds.length > 0 && JSON.stringify(newNotifIds) !== JSON.stringify(lastLoadedNotifIds);
    
    // Save for click-to-clear reference
    lastLoadedNotifIds = newNotifIds;
    
    if (isDifferent) {
      console.log('[DEBUG Mailbox] Notifications changed! Triggering automatic UI refresh.');
      if (currentUser.role === 'client') {
        loadActiveDrops();
        loadSalons();
      } else if (currentUser.role === 'salon_manager') {
        loadSalonBookings();
      } else if (currentUser.role === 'employee') {
        loadEmployeeBookings();
      }
    }

    // Calculate unread count (type-safe mapping to String to prevent mismatches)
    const unreadCount = filteredNotifs.filter(n => !readNotifications.map(String).includes(String(n.id))).length;

    console.log('[DEBUG Mailbox]', {
      totalFetched: allNotifs.length,
      filteredCount: filteredNotifs.length,
      unreadCount: unreadCount,
      readNotifications: readNotifications,
      lastLoadedNotifIds: lastLoadedNotifIds,
      badgeFound: !!badge,
      badgeStyleDisplay: badge ? badge.style.display : 'n/a',
      prefs: prefs
    });
    console.log('[DEBUG Mailbox] Raw notifications from server:', allNotifs);
    console.log('[DEBUG Mailbox] Logged-in User details:', currentUser);

    if (badge) {
      if (unreadCount > 0) {
        badge.style.display = 'inline-flex';
        badge.style.zIndex = '10'; // Ensure it renders on top of the envelope icon
        badge.textContent = unreadCount;
      } else {
        badge.style.display = 'none';
        badge.textContent = '0';
      }
    }

    if (filteredNotifs.length === 0) {
      listContainer.innerHTML = '<p class="placeholder-text" style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 15px 0;">Nessuna notifica al momento.</p>';
      return;
    }

    // Render list
    listContainer.innerHTML = '';
    for (const notif of filteredNotifs) {
      const item = document.createElement('div');
      const isUnread = !readNotifications.map(String).includes(String(notif.id));
      item.className = `mailbox-notification-item ${isUnread ? 'unread' : ''}`;
      
      let serviceName = 'trattamento';
      let salonName = '';
      if (notif.data && notif.data.salon_id) {
        const salon = currentSalonsList.find(s => String(s.id) === String(notif.data.salon_id));
        if (salon) salonName = salon.name;
        
        if (notif.data.service_id) {
          const services = await fetchSalonServicesCached(notif.data.salon_id);
          const service = services.find(s => String(s.id) === String(notif.data.service_id));
          if (service) serviceName = service.name;
        }
      }

      const formattedMsg = formatNotifMessage(notif, serviceName, salonName);
      const timeStr = new Date(notif.timestamp * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

      item.innerHTML = `
        <div>${formattedMsg}</div>
        <div class="mailbox-notification-time"><i class="fa-regular fa-clock"></i> ${timeStr}</div>
      `;
      listContainer.appendChild(item);
    }

  } catch (err) {
    console.error('Error loading mailbox notifications:', err);
  }
}

// Clear notifications handler
addSafeListener('clear-notif-btn', 'click', () => {
  if (!currentUser) return;
  const clearedKey = `cleared_${currentUser.id}`;
  const cleared = JSON.parse(localStorage.getItem(clearedKey)) || [];
  const newCleared = [...new Set([...cleared, ...lastLoadedNotifIds])];
  localStorage.setItem(clearedKey, JSON.stringify(newCleared));
  loadMailboxNotifications();
});

// Dropdowns and Profile click handlers
addSafeListener('profile-avatar-btn', 'click', (e) => {
  e.stopPropagation();
  const profileDropdown = document.getElementById('profile-dropdown');
  const mailboxDropdown = document.getElementById('mailbox-dropdown');
  if (mailboxDropdown) mailboxDropdown.style.display = 'none';
  
  if (profileDropdown) {
    const isVisible = profileDropdown.style.display === 'block';
    profileDropdown.style.display = isVisible ? 'none' : 'block';
  }
});

addSafeListener('mailbox-btn', 'click', (e) => {
  e.stopPropagation();
  const profileDropdown = document.getElementById('profile-dropdown');
  const mailboxDropdown = document.getElementById('mailbox-dropdown');
  if (profileDropdown) profileDropdown.style.display = 'none';

  if (mailboxDropdown) {
    const isVisible = mailboxDropdown.style.display === 'block';
    if (isVisible) {
      mailboxDropdown.style.display = 'none';
    } else {
      mailboxDropdown.style.display = 'block';
      // Mark all currently displayed as read (type-safe mapping to String using user-scoped key)
      if (currentUser) {
        const readKey = `read_notifications_${currentUser.id}`;
        let readNotifications = JSON.parse(localStorage.getItem(readKey)) || [];
        readNotifications = [...new Set([...readNotifications.map(String), ...lastLoadedNotifIds.map(String)])];
        localStorage.setItem(readKey, JSON.stringify(readNotifications));
      }
      // Update badge immediately
      const badge = document.getElementById('mailbox-unread-count');
      if (badge) {
        badge.style.display = 'none';
        badge.textContent = '0';
      }
      // Re-render to clear highlighting
      loadMailboxNotifications();
    }
  }
});

// Close dropdowns clicking outside
document.addEventListener('click', (e) => {
  const profileDropdown = document.getElementById('profile-dropdown');
  if (profileDropdown && !e.target.closest('#profile-menu-container')) {
    profileDropdown.style.display = 'none';
  }

  const mailboxDropdown = document.getElementById('mailbox-dropdown');
  if (mailboxDropdown && !e.target.closest('#mailbox-dropdown') && !e.target.closest('#mailbox-btn')) {
    mailboxDropdown.style.display = 'none';
  }
});

// --- Cities Tags & Salons Filtering Helpers ---
function getSelectedCitiesTags() {
  const tags = [];
  document.querySelectorAll('#pref-cities-tags-container .city-tag').forEach(tag => {
    tags.push(tag.dataset.city);
  });
  return tags;
}

function saveClientPreferences() {
  if (!currentUser) return;

  const prefKey = `prefs_${currentUser.id}`;
  const notifEnabled = document.getElementById('pref-notif-enabled').checked;
  const cities = getSelectedCitiesTags();

  const salons = [];
  document.querySelectorAll('input[name="pref-salon"]:checked').forEach(cb => {
    salons.push(cb.value);
  });

  const categories = [];
  document.querySelectorAll('input[name="pref-category"]:checked').forEach(cb => {
    categories.push(cb.value);
  });

  const prefs = { cities, notifEnabled, salons, categories };
  localStorage.setItem(prefKey, JSON.stringify(prefs));

  logConsole('Preferenze di notifica salvate con successo (autosave).', 'success');
  loadMailboxNotifications();
}

function addCityTag(cityName, triggerSave = true) {
  const container = document.getElementById('pref-cities-tags-container');
  const input = document.getElementById('add-pref-city');
  if (!container || !input) return;

  // Check if tag already exists
  const existingTags = getSelectedCitiesTags();
  if (existingTags.map(c => c.toLowerCase()).includes(cityName.toLowerCase())) {
    return;
  }

  // Create tag element
  const tag = document.createElement('span');
  tag.className = 'city-tag';
  tag.dataset.city = cityName;
  tag.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(206, 157, 79, 0.15);
    color: var(--gold);
    border: 1px solid var(--gold);
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 700;
  `;
  tag.innerHTML = `
    ${cityName}
    <button type="button" class="remove-tag-btn" style="border: none; background: transparent; color: var(--gold); font-size: 14px; cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center; line-height: 1;">&times;</button>
  `;

  // Add remove event
  tag.querySelector('.remove-tag-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    tag.remove();
    renderPreferredSalonsList();
    saveClientPreferences();
  });

  // Insert tag before the input field
  container.insertBefore(tag, input);

  // Update salons list
  renderPreferredSalonsList();

  if (triggerSave) {
    saveClientPreferences();
  }
}

function renderPreferredSalonsList() {
  const salonsContainer = document.getElementById('pref-salons-container');
  if (!salonsContainer) return;

  // Get currently selected cities from tags
  const selectedCities = getSelectedCitiesTags();

  // Get currently checked salons in the DOM to preserve checks during dynamic updates
  const checkedSalons = new Set();
  document.querySelectorAll('input[name="pref-salon"]:checked').forEach(cb => {
    checkedSalons.add(cb.value);
  });

  // Also check saved prefs if any
  if (currentUser) {
    const prefKey = `prefs_${currentUser.id}`;
    const prefs = JSON.parse(localStorage.getItem(prefKey)) || {};
    if (prefs.salons) {
      prefs.salons.forEach(id => checkedSalons.add(String(id)));
    }
  }

  // Filter salons
  const filteredSalons = currentSalonsList.filter(s => {
    if (selectedCities.length === 0) return true;
    return selectedCities.map(c => c.toLowerCase()).includes((s.city || '').toLowerCase());
  });

  salonsContainer.innerHTML = '';
  if (filteredSalons.length === 0) {
    salonsContainer.innerHTML = '<p class="placeholder-text" style="font-size: 12px; color: var(--text-muted); margin: 0;">Nessun salone disponibile per le città selezionate.</p>';
  } else {
    filteredSalons.forEach(s => {
      const isChecked = checkedSalons.has(String(s.id)) ? 'checked' : '';
      const label = document.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: normal; margin-bottom: 0;';
      label.innerHTML = `<input type="checkbox" name="pref-salon" value="${s.id}" ${isChecked} style="accent-color: var(--gold); width: 16px; height: 16px;"> ${s.name} <span style="color: var(--text-muted); font-size: 11px;">(${s.city})</span>`;
      salonsContainer.appendChild(label);
    });
  }
}

// Client preferences settings form
function loadClientSettings() {
  if (!currentUser) return;
  
  const prefKey = `prefs_${currentUser.id}`;
  const savedPrefs = JSON.parse(localStorage.getItem(prefKey)) || {};
  const prefs = {
    notifEnabled: true,
    cities: [],
    salons: [],
    categories: [],
    ...savedPrefs
  };

  // ownCity input removed

  const enabledInput = document.getElementById('pref-notif-enabled');
  if (enabledInput) {
    enabledInput.checked = prefs.notifEnabled;
    togglePrefDetailsSection(prefs.notifEnabled);
  }

  // Populate preferred cities tags
  const tagsContainer = document.getElementById('pref-cities-tags-container');
  const addCityInput = document.getElementById('add-pref-city');
  if (tagsContainer && addCityInput) {
    // Clear existing tags
    tagsContainer.querySelectorAll('.city-tag').forEach(tag => tag.remove());
    
    // Check if user has saved before
    const hasSavedBefore = localStorage.getItem(prefKey) !== null;
    
    if (hasSavedBefore) {
      const savedCities = prefs.cities || [];
      savedCities.forEach(city => {
        addCityTag(city, false); // Don't trigger save during load
      });
    } else {
      // First-time user: default to active salons' cities
      const activeSalonsCities = [...new Set(currentSalonsList.map(s => s.city).filter(Boolean))];
      activeSalonsCities.forEach(city => {
        addCityTag(city, false); // Don't trigger save during load
      });
    }
  }

  // Populates the filtered preferred salons list
  renderPreferredSalonsList();

  document.querySelectorAll('input[name="pref-category"]').forEach(cb => {
    cb.checked = (prefs.categories || []).includes(cb.value);
  });
}

function togglePrefDetailsSection(enabled) {
  const section = document.getElementById('preferences-details-section');
  if (section) {
    section.style.display = enabled ? 'block' : 'none';
  }
}

addSafeListener('pref-notif-enabled', 'change', (e) => {
  togglePrefDetailsSection(e.target.checked);
  saveClientPreferences();
});

// Click container to focus input
addSafeListener('pref-cities-tags-container', 'click', (e) => {
  const input = document.getElementById('add-pref-city');
  if (input && (e.target.id === 'pref-cities-tags-container' || e.target.classList.contains('tags-input-container'))) {
    input.focus();
  }
});

// Event delegation for checkbox changes to trigger autosave instantly
addSafeListener('preferences-details-section', 'change', (e) => {
  if (e.target.name === 'pref-salon' || e.target.name === 'pref-category') {
    saveClientPreferences();
  }
});

addSafeListener('user-preferences-form', 'submit', (e) => {
  e.preventDefault();
  saveClientPreferences();
  showSalonsList(); // Return to homepage immediately!
});

// Cache for resolving and displaying real client names in B2B agenda
let clientNamesCache = {};
async function getClientNameCached(clientId) {
  if (!clientId) return 'Cliente Sconosciuto';
  if (clientNamesCache[clientId]) return clientNamesCache[clientId];
  try {
    const res = await fetch(`${AUTH_API}/api/auth/users/${clientId}`);
    if (res.ok) {
      const user = await res.json();
      const name = `${user.first_name} ${user.last_name}`;
      clientNamesCache[clientId] = name;
      return name;
    }
  } catch (err) {
    console.error('Error fetching client name:', err);
  }
  return 'Cliente #' + clientId.substring(0, 4).toUpperCase();
}

// B2B Stats Management
let currentStatsPeriod = 'day';
async function changeStatsPeriod(period, btn) {
  currentStatsPeriod = period;
  
  // Update button active styling
  document.querySelectorAll('.period-selectors button').forEach(b => {
    b.classList.remove('btn-gold');
    b.classList.add('btn-gold-outline');
    b.classList.remove('active');
  });
  if (btn) {
    btn.classList.add('btn-gold');
    btn.classList.remove('btn-gold-outline');
    btn.classList.add('active');
  }
  
  await renderB2BStats();
}

async function renderB2BStats() {
  if (!currentUser || currentUser.role !== 'salon_manager') return;

  const revenueEl = document.getElementById('stats-revenue');
  const bookingsEl = document.getElementById('stats-bookings');
  const dropsEl = document.getElementById('stats-drops');
  const chartContainer = document.getElementById('stats-chart-container');
  const chartLabels = document.getElementById('stats-chart-labels');
  const treatmentsList = document.getElementById('stats-treatments-list');

  if (!revenueEl) return;

  try {
    // 1. Fetch bookings
    const bookingsRes = await fetch(`${BOOKING_API}/api/bookings`, {
      headers: { 'Authorization': `Bearer ${currentUser.token}` }
    });
    if (!bookingsRes.ok) return;
    const allBookings = await bookingsRes.json();

    // 2. Fetch drops
    let allDrops = [];
    try {
      const dropRes = await fetch(`${DROP_API}/api/drops`);
      if (dropRes.ok) {
        allDrops = await dropRes.json();
      }
    } catch (e) {
      console.error('Error fetching drops for stats:', e);
    }
    const salonDrops = allDrops.filter(d => String(d.salon_id) === String(currentUser.salonId));

    // 3. Define period boundaries
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    let filteredBookings = [];
    let filteredDrops = [];
    let intervalValues = [];
    let intervalLabels = [];

    if (currentStatsPeriod === 'day') {
      // Filter today
      filteredBookings = allBookings.filter(b => {
        const d = new Date(b.booking_time);
        return d >= todayStart;
      });
      filteredDrops = salonDrops.filter(d => {
        const date = new Date(d.created_at || d.booking_time);
        return date >= todayStart;
      });

      // 4 time blocks: 08:00-11:00, 11:00-14:00, 14:00-17:00, 17:00-20:00
      intervalLabels = ['08-11', '11-14', '14-17', '17-20'];
      intervalValues = [0, 0, 0, 0];
      filteredBookings.forEach(b => {
        if (b.status === 'cancelled') return;
        const hr = new Date(b.booking_time).getHours();
        const p = parseFloat(b.price) || 0;
        if (hr >= 8 && hr < 11) intervalValues[0] += p;
        else if (hr >= 11 && hr < 14) intervalValues[1] += p;
        else if (hr >= 14 && hr < 17) intervalValues[2] += p;
        else if (hr >= 17 && hr < 20) intervalValues[3] += p;
      });

    } else if (currentStatsPeriod === 'week') {
      // Last 7 days
      const oneWeekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      filteredBookings = allBookings.filter(b => {
        const d = new Date(b.booking_time);
        return d >= oneWeekAgo;
      });
      filteredDrops = salonDrops.filter(d => {
        const date = new Date(d.created_at || d.booking_time);
        return date >= oneWeekAgo;
      });

      // Days of the week (last 7 days)
      const dayNames = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
        intervalLabels.push(dayNames[d.getDay()]);
        intervalValues.push(0);
      }
      filteredBookings.forEach(b => {
        if (b.status === 'cancelled') return;
        const bDate = new Date(b.booking_time);
        const diffDays = Math.floor((todayStart.getTime() - bDate.getTime()) / (24 * 60 * 60 * 1000));
        if (diffDays >= 0 && diffDays < 7) {
          const index = 6 - diffDays;
          intervalValues[index] += parseFloat(b.price) || 0;
        }
      });

    } else if (currentStatsPeriod === 'month') {
      // Current Month
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      filteredBookings = allBookings.filter(b => {
        const d = new Date(b.booking_time);
        return d >= monthStart;
      });
      filteredDrops = salonDrops.filter(d => {
        const date = new Date(d.created_at || d.booking_time);
        return date >= monthStart;
      });

      // 4 Weeks
      intervalLabels = ['Sett 1', 'Sett 2', 'Sett 3', 'Sett 4+'];
      intervalValues = [0, 0, 0, 0];
      filteredBookings.forEach(b => {
        if (b.status === 'cancelled') return;
        const dayOfMonth = new Date(b.booking_time).getDate();
        const p = parseFloat(b.price) || 0;
        if (dayOfMonth <= 7) intervalValues[0] += p;
        else if (dayOfMonth <= 14) intervalValues[1] += p;
        else if (dayOfMonth <= 21) intervalValues[2] += p;
        else intervalValues[3] += p;
      });

    } else if (currentStatsPeriod === 'year') {
      // Current Year
      const yearStart = new Date(now.getFullYear(), 0, 1);
      filteredBookings = allBookings.filter(b => {
        const d = new Date(b.booking_time);
        return d >= yearStart;
      });
      filteredDrops = salonDrops.filter(d => {
        const date = new Date(d.created_at || d.booking_time);
        return date >= yearStart;
      });

      // 12 Months
      intervalLabels = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
      intervalValues = Array(12).fill(0);
      filteredBookings.forEach(b => {
        if (b.status === 'cancelled') return;
        const month = new Date(b.booking_time).getMonth();
        intervalValues[month] += parseFloat(b.price) || 0;
      });
    }

    // 4. Compute Summary cards
    const revenue = filteredBookings
      .filter(b => b.status === 'confirmed' || b.status === 'completed')
      .reduce((sum, b) => sum + (parseFloat(b.price) || 0), 0);
    const totalBookings = filteredBookings.filter(b => b.status !== 'cancelled').length;
    const totalDrops = filteredDrops.length;

    revenueEl.textContent = `€${revenue.toFixed(2)}`;
    bookingsEl.textContent = totalBookings;
    dropsEl.textContent = totalDrops;

    // 5. Render CSS Bar Chart
    chartContainer.innerHTML = '';
    chartLabels.innerHTML = '';
    const maxVal = Math.max(...intervalValues, 10); // default scaling base

    intervalLabels.forEach((lbl, idx) => {
      const val = intervalValues[idx];
      const percent = ((val / maxVal) * 100).toFixed(0);
      
      const barWrapper = document.createElement('div');
      barWrapper.style.display = 'flex';
      barWrapper.style.flexDirection = 'column';
      barWrapper.style.alignItems = 'center';
      barWrapper.style.width = '100%';
      barWrapper.style.height = '100%';
      barWrapper.style.justifyContent = 'flex-end';

      const bar = document.createElement('div');
      bar.className = 'stats-chart-bar';
      bar.style.height = `${percent}%`;
      bar.style.width = '30px';
      bar.style.background = val > 0 ? 'linear-gradient(to top, var(--gold), #ffdf7a)' : 'rgba(255,255,255,0.05)';
      bar.style.borderRadius = '6px 6px 0 0';
      bar.style.transition = 'height 0.4s ease-out';
      bar.style.position = 'relative';
      bar.style.cursor = 'pointer';

      // Tooltip displaying value
      bar.setAttribute('title', `Incasso: €${val.toFixed(2)}`);
      
      barWrapper.appendChild(bar);
      chartContainer.appendChild(barWrapper);

      const label = document.createElement('div');
      label.style.width = '100%';
      label.style.textAlign = 'center';
      label.style.fontSize = '10px';
      label.style.color = 'var(--text-muted)';
      label.textContent = lbl;
      chartLabels.appendChild(label);
    });

    // 6. Compute and Render Treatment list breakdown
    treatmentsList.innerHTML = '';
    const treatmentCounts = {};
    filteredBookings.forEach(b => {
      if (b.status === 'cancelled') return;
      const sName = b.service_name || 'Servizio Generico';
      const price = parseFloat(b.price) || 0;
      if (!treatmentCounts[sName]) {
        treatmentCounts[sName] = { count: 0, revenue: 0 };
      }
      treatmentCounts[sName].count++;
      treatmentCounts[sName].revenue += price;
    });

    const sortedTreatments = Object.entries(treatmentCounts).sort((a, b) => b[1].count - a[1].count);

    if (sortedTreatments.length === 0) {
      treatmentsList.innerHTML = '<p class="placeholder-text" style="text-align: center; padding: 15px 0;">Nessun trattamento in questo periodo.</p>';
    } else {
      sortedTreatments.forEach(([name, data]) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.background = 'rgba(255,255,255,0.01)';
        item.style.border = '1px solid var(--border-color)';
        item.style.borderRadius = '8px';
        item.style.fontSize = '12px';

        item.innerHTML = `
          <div style="font-weight: 700; color: var(--text-main);">${name}</div>
          <div style="color: var(--gold); font-weight: 800;">${data.count}x (${data.revenue.toFixed(2)}€)</div>
        `;
        treatmentsList.appendChild(item);
      });
    }

  } catch (err) {
    console.error('Error rendering statistics:', err);
  }
}

// --- PHOTO UPLOADER HELPER & MODAL HANDLERS ---
function bindPhotoUploader(inputId, fileInputId, previewImgId, previewIconId, deleteBtnId) {
  const urlInput = document.getElementById(inputId);
  const fileInput = document.getElementById(fileInputId);
  const imgEl = document.getElementById(previewImgId);
  const iconEl = document.getElementById(previewIconId);
  const deleteBtn = document.getElementById(deleteBtnId);

  function updatePreview(val) {
    if (val && String(val).trim().length > 0) {
      if (imgEl) {
        imgEl.src = String(val).trim();
        imgEl.style.display = 'block';
      }
      if (iconEl) iconEl.style.display = 'none';
    } else {
      if (imgEl) {
        imgEl.src = '';
        imgEl.style.display = 'none';
      }
      if (iconEl) iconEl.style.display = 'block';
    }
  }

  if (urlInput) {
    urlInput.addEventListener('input', () => updatePreview(urlInput.value));
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          const rawDataUrl = evt.target.result;
          // Downscale and compress image using canvas (max 800px, 0.75 quality)
          const img = new Image();
          img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            const maxDim = 800;
            if (width > maxDim || height > maxDim) {
              if (width > height) {
                height = Math.round((height * maxDim) / width);
                width = maxDim;
              } else {
                width = Math.round((width * maxDim) / height);
                height = maxDim;
              }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
            if (urlInput) urlInput.value = compressedDataUrl;
            updatePreview(compressedDataUrl);
          };
          img.onerror = function() {
            if (urlInput) urlInput.value = rawDataUrl;
            updatePreview(rawDataUrl);
          };
          img.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (urlInput) urlInput.value = '';
      if (fileInput) fileInput.value = '';
      updatePreview('');
    });
  }

  return { updatePreview };
}

let salInfoUploader, empRegUploader, srvRegUploader, editEmpUploader, editSrvUploader;

function initPhotoUploaders() {
  salInfoUploader = bindPhotoUploader('sal-info-image', 'sal-info-photo-file', 'sal-info-photo-preview', 'sal-info-photo-icon', 'sal-info-delete-photo-btn');
  empRegUploader = bindPhotoUploader('emp-photo', 'emp-reg-photo-file', 'emp-reg-photo-preview', 'emp-reg-photo-icon', 'emp-reg-delete-photo-btn');
  srvRegUploader = bindPhotoUploader('srv-image', 'srv-reg-photo-file', 'srv-reg-photo-preview', 'srv-reg-photo-icon', 'srv-reg-delete-photo-btn');
  editEmpUploader = bindPhotoUploader('edit-emp-photo-url', 'edit-emp-photo-file', 'edit-emp-photo-preview', 'edit-emp-photo-icon', 'edit-emp-delete-photo-btn');
  editSrvUploader = bindPhotoUploader('edit-srv-photo-url', 'edit-srv-photo-file', 'edit-srv-photo-preview', 'edit-srv-photo-icon', 'edit-srv-delete-photo-btn');

  // Bind partner area city autocompletes
  bindCityAutocomplete('sal-info-city', 'sal-info-city-panel');
  bindCityAutocomplete('reg-saloncity', 'reg-saloncity-panel');

  // Populate time dropdowns for shifts and unavailabilities
  populateTimeDropdowns();
}

function populateTimeDropdowns() {
  const timeSelects = [
    { id: 'mgr-sched-start', defaultVal: '09:00' },
    { id: 'mgr-sched-end', defaultVal: '18:00' },
    { id: 'unavail-start', defaultVal: '09:00' },
    { id: 'unavail-end', defaultVal: '18:00' }
  ];

  const options = [];
  for (let hour = 7; hour <= 22; hour++) {
    for (let min = 0; min < 60; min += 30) {
      if (hour === 22 && min > 0) break;
      const hStr = hour.toString().padStart(2, '0');
      const mStr = min.toString().padStart(2, '0');
      options.push(`${hStr}:${mStr}`);
    }
  }

  timeSelects.forEach(({ id, defaultVal }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    options.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (t === defaultVal) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

function bindCityAutocomplete(inputId, panelId) {
  const input = document.getElementById(inputId);
  const panel = document.getElementById(panelId);
  if (!input || !panel) return;

  const renderSuggestions = async (query) => {
    if (!query || query.length < 2) {
      panel.innerHTML = '';
      panel.style.display = 'none';
      return;
    }
    try {
      const res = await fetch(`${AUTH_API}/api/auth/cities?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const cities = await res.json();
      
      panel.innerHTML = '';
      if (cities.length === 0) {
        panel.style.display = 'none';
        return;
      }

      cities.forEach(city => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `
          <div class="autocomplete-icon-wrapper">
            <i class="fa-solid fa-location-dot"></i>
          </div>
          <div class="autocomplete-info">
            <span class="autocomplete-city-name" style="font-weight: 700;">${city.name}</span>
            <span class="autocomplete-province-country" style="font-size: 11px; color: var(--text-muted);">${city.province}, ${city.region}</span>
          </div>
        `;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = city.name;
          panel.style.display = 'none';
        });
        panel.appendChild(item);
      });
      panel.style.display = 'block';
    } catch (err) {
      console.error('Errore ricerca città:', err);
    }
  };

  input.addEventListener('input', (e) => {
    renderSuggestions(e.target.value.trim());
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) {
      renderSuggestions(input.value.trim());
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      panel.style.display = 'none';
    }, 200);
  });
}

// Open Edit Employee & Photo Modal
function openEditEmployeeModal(empId, firstname, lastname, photoUrl) {
  const modal = document.getElementById('modal-edit-employee');
  if (!modal) return;

  document.getElementById('edit-emp-id').value = empId;
  document.getElementById('edit-emp-firstname').value = firstname || '';
  document.getElementById('edit-emp-lastname').value = lastname || '';
  
  const photoInput = document.getElementById('edit-emp-photo-url');
  if (photoInput) {
    photoInput.value = photoUrl || '';
    if (editEmpUploader) editEmpUploader.updatePreview(photoUrl || '');
  }

  modal.showModal();
}

// Submit Edit Employee Form
addSafeListener('edit-employee-form', 'submit', async (e) => {
  e.preventDefault();
  const empId = document.getElementById('edit-emp-id').value;
  const first_name = document.getElementById('edit-emp-firstname').value;
  const last_name = document.getElementById('edit-emp-lastname').value;
  const photo_url = document.getElementById('edit-emp-photo-url') ? document.getElementById('edit-emp-photo-url').value.trim() : '';

  try {
    const res = await fetch(`${AUTH_API}/api/auth/employees/${empId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ first_name, last_name, photo_url })
    });

    if (res.ok) {
      alert('Informazioni dipendente e foto aggiornate!');
      const modal = document.getElementById('modal-edit-employee');
      if (modal) modal.close();
      loadManagerEmployees();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante l\'aggiornamento');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Delete Employee Photo
async function deleteEmployeePhoto(empId) {
  if (!confirm('Eliminare la foto di questa dipendente?')) return;
  try {
    const res = await fetch(`${AUTH_API}/api/auth/employees/${empId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ photo_url: '' })
    });

    if (res.ok) {
      alert('Foto dipendente rimossa con successo.');
      loadManagerEmployees();
    } else {
      alert('Errore durante la rimozione della foto');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
}

// Open Edit Service & Photo Modal
function openEditServiceModal(srvId, name, price, duration, desc, photoUrl) {
  const modal = document.getElementById('modal-edit-service');
  if (!modal) return;

  document.getElementById('edit-srv-id').value = srvId;
  document.getElementById('edit-srv-name').value = name || '';
  document.getElementById('edit-srv-price').value = price || '';
  document.getElementById('edit-srv-duration').value = duration || '';
  document.getElementById('edit-srv-desc').value = desc || '';

  const photoInput = document.getElementById('edit-srv-photo-url');
  if (photoInput) {
    photoInput.value = photoUrl || '';
    if (editSrvUploader) editSrvUploader.updatePreview(photoUrl || '');
  }

  modal.showModal();
}

// Submit Edit Service Form
addSafeListener('edit-service-form', 'submit', async (e) => {
  e.preventDefault();
  const srvId = document.getElementById('edit-srv-id').value;
  const name = document.getElementById('edit-srv-name').value;
  const price = parseFloat(document.getElementById('edit-srv-price').value);
  const duration_minutes = parseInt(document.getElementById('edit-srv-duration').value);
  const description = document.getElementById('edit-srv-desc').value;
  const image_url = document.getElementById('edit-srv-photo-url') ? document.getElementById('edit-srv-photo-url').value.trim() : '';

  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/services/${srvId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ name, price, duration_minutes, description, image_url })
    });

    if (res.ok) {
      alert('Trattamento e foto aggiornati con successo!');
      const modal = document.getElementById('modal-edit-service');
      if (modal) modal.close();
      loadManagerServices();
    } else {
      const err = await res.json();
      alert(err.error || 'Errore durante la modifica del trattamento');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
});

// Delete Service Photo
async function deleteServicePhoto(srvId) {
  if (!confirm('Eliminare la foto di questo trattamento?')) return;
  try {
    const res = await fetch(`${BOOKING_API}/api/catalog/services/${srvId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentUser.token}`
      },
      body: JSON.stringify({ image_url: '' })
    });

    if (res.ok) {
      alert('Foto trattamento rimossa con successo.');
      loadManagerServices();
    } else {
      alert('Errore durante la rimozione della foto');
    }
  } catch (err) {
    alert('Errore di connessione');
  }
}

window.renderB2BStats = renderB2BStats;
window.changeStatsPeriod = changeStatsPeriod;

// Launch app init
initApp();
