process.env.TZ = 'Europe/Rome';
const express = require('express');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

const formatLocalTime = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const JWT_SECRET = db.requireEnv('JWT_SECRET');
const PORT = process.env.PORT || 3002;
const RABBITMQ_URL = db.requireEnv('RABBITMQ_URL');
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';

// Health check endpoints per ALB e smoke test
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'booking-service', timestamp: new Date().toISOString() });
});

app.get('/api/bookings/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'booking-service', timestamp: new Date().toISOString() });
});

let mqChannel = null;
let isMqConnecting = false;

// Connect to RabbitMQ con gestione riconnessione automatica a runtime
async function initRabbitMQ() {
  if (isMqConnecting) return;
  isMqConnecting = true;
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    conn.on('error', (err) => {
      console.error('RabbitMQ connection error (booking-service):', err.message);
    });
    conn.on('close', () => {
      console.warn('RabbitMQ connection closed. Reconnecting in 5 seconds...');
      mqChannel = null;
      isMqConnecting = false;
      setTimeout(initRabbitMQ, 5000);
    });

    mqChannel = await conn.createChannel();
    mqChannel.on('error', (err) => {
      console.error('RabbitMQ channel error (booking-service):', err.message);
    });
    mqChannel.on('close', () => {
      console.warn('RabbitMQ channel closed (booking-service).');
      mqChannel = null;
    });

    // Declare exchanges or queues we need
    await mqChannel.assertQueue('booking.events', { durable: true });
    await mqChannel.assertQueue('drop.booking.events', { durable: true });
    await mqChannel.assertQueue('drop.events', { durable: true });
    console.log('Connected to RabbitMQ in Booking Service');
    isMqConnecting = false;
  } catch (err) {
    console.error('RabbitMQ Connection failed, retrying in 5 seconds...', err.message);
    isMqConnecting = false;
    setTimeout(initRabbitMQ, 5000);
  }
}

// Init Database with retry loop
async function initDb(maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[INIT-DB] Inizializzazione database Booking Service (tentativo ${attempt}/${maxRetries})...`);
      await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(err => {
        console.warn('[INIT-DB] Estensione uuid-ossp opzionale saltata:', err.message);
      });

    await db.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS services (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        salon_id UUID NOT NULL,
        category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        duration_minutes INT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        description TEXT,
        image_url VARCHAR(500)
      );
    `);

    await db.query(`
      ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE services ALTER COLUMN image_url TYPE TEXT;
    `);

    const checkCol = await db.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='employee_schedules' AND column_name='schedule_date'
    `);
    if (checkCol.rows.length === 0) {
      await db.query(`DROP TABLE IF EXISTS employee_schedules CASCADE;`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS employee_schedules (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        employee_id UUID NOT NULL,
        schedule_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        UNIQUE(employee_id, schedule_date)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        client_id UUID NOT NULL,
        salon_id UUID NOT NULL,
        service_id UUID REFERENCES services(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL,
        booking_time TIMESTAMP NOT NULL,
        status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
        payment_status VARCHAR(50) NOT NULL CHECK (payment_status IN ('unpaid', 'paid', 'refunded')),
        price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_drop BOOLEAN DEFAULT FALSE;
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS employee_unavailabilities (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        employee_id UUID NOT NULL,
        unavailable_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        reason VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
        client_id UUID NOT NULL,
        salon_id UUID NOT NULL,
        rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default categories
    const categories = ['Corpo', 'Viso', 'Capelli', 'Unghie', 'Estetica'];
    for (const cat of categories) {
      await db.query(
        'INSERT INTO categories (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [cat, `Trattamenti dedicati per la categoria ${cat}`]
      );
    }

    // Retrieve category mapping
    const catRows = await db.query('SELECT id, name FROM categories');
    const catMap = {};
    catRows.rows.forEach(r => { catMap[r.name] = r.id; });

    // Curated treatments master list with distinct image URLs and detailed descriptions
    const defaultTreatmentsMaster = [
      // Unghie
      {
        cat: 'Unghie',
        name: 'Smalto Semipermanente',
        duration_minutes: 45,
        price: 35.00,
        description: 'Manicure express con applicazione di smalto semipermanente e polimerizzazione LED per unghie perfette fino a 3 settimane.',
        image_url: 'nails_treatment.jpg'
      },
      {
        cat: 'Unghie',
        name: 'Ricostruzione Unghie in Gel',
        duration_minutes: 90,
        price: 65.00,
        description: 'Allungamento unghie con cartina o tip, gel costruttore ad alta resistenza e rifinitura lucida personalizzata.',
        image_url: 'default_beauty.jpg'
      },
      {
        cat: 'Unghie',
        name: 'Nail Art Artistica',
        duration_minutes: 30,
        price: 25.00,
        description: 'Decorazioni personalizzate a mano libera, sfumature babyboomer, brillantini e disegni di tendenza.',
        image_url: 'hero-beauty.jpg'
      },
      {
        cat: 'Unghie',
        name: 'Pedicure SPA Curativo',
        duration_minutes: 60,
        price: 45.00,
        description: 'Trattamento rigenerante piedi con idromassaggio aromatico, scrub al sale marino, rimozione callosità e smalto.',
        image_url: 'body_massage.jpg'
      },
      // Viso
      {
        cat: 'Viso',
        name: 'Pulizia del Viso Profonda',
        duration_minutes: 60,
        price: 55.00,
        description: 'Detersione profonda con vapore purificante, spremitura delicata, peeling enzimatico e maschera all acido ialuronico.',
        image_url: 'face_treatment.jpg'
      },
      {
        cat: 'Viso',
        name: 'Laminazione Ciglia & Sopracciglia',
        duration_minutes: 50,
        price: 50.00,
        description: 'Trattamento di nutrimento alla cheratina, curvatura e tintura per uno sguardo intenso, folto e naturale.',
        image_url: 'hair_styling.jpg'
      },
      {
        cat: 'Viso',
        name: 'Trattamento Viso Anti-Age Collagene',
        duration_minutes: 75,
        price: 85.00,
        description: 'Massaggio lifting viso tonificante con siero al collagene e micro-correnti anti-rughe per una pelle radiosa.',
        image_url: 'face_treatment.jpg'
      },
      // Corpo
      {
        cat: 'Corpo',
        name: 'Massaggio Drenante Linfatico',
        duration_minutes: 60,
        price: 80.00,
        description: 'Massaggio profondo con pietre calde e oli essenziali drenanti per eliminare i liquidi in eccesso e stimolare la circolazione.',
        image_url: 'body_massage.jpg'
      },
      {
        cat: 'Corpo',
        name: 'Trattamento Riducente Anti-Cellulite',
        duration_minutes: 60,
        price: 75.00,
        description: 'Impacco osmoticamente attivo con fanghi termali e massaggio modellante anticellulite mirato.',
        image_url: 'body_massage.jpg'
      },
      {
        cat: 'Corpo',
        name: 'Epilazione Laser Diodo',
        duration_minutes: 45,
        price: 60.00,
        description: 'Trattamento di epilazione progressiva definitiva indolore ed efficace su ogni fototipo e tipo di pelo.',
        image_url: 'default_beauty.jpg'
      },
      // Capelli
      {
        cat: 'Capelli',
        name: 'Taglio Donna & Piega Glamour',
        duration_minutes: 60,
        price: 45.00,
        description: 'Consulenza d immagine, shampoo trattante, taglio sartoriale e styling con piega morbida o liscia.',
        image_url: 'hair_styling.jpg'
      },
      {
        cat: 'Capelli',
        name: 'Balayage & Schiariture Sfumate',
        duration_minutes: 120,
        price: 110.00,
        description: 'Tecnica di schiaritura naturale a mano libera per riflessi luminosi, tridimensionali e baciati dal sole.',
        image_url: 'hair_styling.jpg'
      },
      {
        cat: 'Capelli',
        name: 'Trattamento Rigenerante Cheratina',
        duration_minutes: 90,
        price: 95.00,
        description: 'Trattamento idratante e ristrutturante profondo che elimina il crespo e dona lucentezza specchio ai capelli.',
        image_url: 'hero-beauty.jpg'
      }
    ];
    // Automatic Migration: Upgrade all salons with old generic services/images to unique per-salon treatment lists
    try {
      const oldServicesRes = await db.query(
        "SELECT DISTINCT salon_id FROM services WHERE image_url IS NULL OR image_url NOT LIKE 'http%' OR salon_id IN (SELECT salon_id FROM services GROUP BY salon_id, name HAVING COUNT(*) > 1) OR image_url LIKE '%photo-1515377905703%' OR image_url LIKE '%photo-1591343393572%' OR image_url LIKE '%photo-1537673156864%' OR image_url LIKE '%photo-1580618672591%' OR image_url LIKE '%photo-1508214751196%'"
      );
      if (oldServicesRes.rows.length > 0) {
        console.log(`Upgrading ${oldServicesRes.rows.length} salons with old generic services in-place...`);
        const catRes = await db.query('SELECT id, name FROM categories');
        const catMap = {};
        catRes.rows.forEach(c => { catMap[c.name] = c.id; });

        for (const row of oldServicesRes.rows) {
          const sId = row.salon_id;
          const srvs = (await db.query('SELECT id, category_id FROM services WHERE salon_id = $1 ORDER BY id', [sId])).rows;
          const uniqueTreatments = generateUniqueTreatmentsForSalon(sId, Math.max(8, srvs.length));
          
          for (let i = 0; i < Math.min(srvs.length, uniqueTreatments.length); i++) {
            const t = uniqueTreatments[i];
            const categoryId = catMap[t.cat] || srvs[i].category_id;
            await db.query(
              `UPDATE services 
               SET name = $1, category_id = $2, duration_minutes = $3, price = $4, description = $5, image_url = $6
               WHERE id = $7`,
              [t.name, categoryId, t.duration_minutes, t.price, t.description, t.image_url, srvs[i].id]
            );
          }
        }
        console.log('Successfully upgraded all salon catalogs to unique treatments with Unsplash photos!');
      }
    } catch (migrErr) {
      console.error('Error upgrading salon catalogs on startup:', migrErr);
    }

      console.log('Database tables initialized successfully in Booking Service.');
      return;
    } catch (err) {
      console.error(`[INIT-DB ERROR] Tentativo ${attempt}/${maxRetries} fallito:`, err.message);
      if (attempt === maxRetries) {
        console.error('Failed to initialize database tables in Booking Service after maximum retries:', err);
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token non valido o scaduto' });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accesso negato: ruolo non autorizzato' });
    }
    next();
  };
}

// Helper to publish events
function publishEvent(queue, eventType, data) {
  if (!mqChannel) {
    console.error('RabbitMQ channel not available to publish event');
    return;
  }
  const payload = JSON.stringify({ type: eventType, data });
  mqChannel.sendToQueue(queue, Buffer.from(payload), { persistent: true });
  
  if (queue === 'booking.events') {
    mqChannel.sendToQueue('drop.booking.events', Buffer.from(payload), { persistent: true });
  }
}

// --- API CATALOG ---
app.get('/api/catalog/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM categories');
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Errore nel recupero delle categorie' });
  }
});

app.post('/api/catalog/categories', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Il nome è obbligatorio' });

  try {
    const result = await db.query(
      'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Errore nella creazione della categoria' });
  }
});

const treatmentPool = [
  // Unghie
  { cat: 'Unghie', name: 'Dry Manicure & Semipermanente Rinforzato', duration_minutes: 60, price: 40.00, description: 'Manicure combinata con fresa e applicazione base rubber rinforzante ad elevata tenuta.', image_url: 'https://images.unsplash.com/photo-1632345031435-8727f6897d53?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Ricostruzione Unghie in Acrigel', duration_minutes: 90, price: 65.00, description: 'Allungamento con cartina in acrigel, resistente, naturale ed estremamente flessibile.', image_url: 'https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Nail Art Effetto Marmo & Foglia d\'Oro', duration_minutes: 75, price: 50.00, description: 'Decorazione artistica avanzata con effetto marmo sfumato e dettagli in foglia d\'oro.', image_url: 'https://images.unsplash.com/photo-1519014816548-bf5fe059798b?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Pedicure Spa ai Sali del Mar Morto', duration_minutes: 60, price: 45.00, description: 'Pedicure rigenerante con idromassaggio ai sali minerali, scrub esfoliante e maschera nutriente.', image_url: 'https://images.unsplash.com/photo-1519415510236-718bdfcd89c8?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Trattamento Cheratina Unghie Fragili', duration_minutes: 35, price: 30.00, description: 'Bagno riparatore alla cheratina ed oli biologici per riparare unghie sfaldate e deboli.', image_url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Smalto Semipermanente Cat-Eye 5D', duration_minutes: 60, price: 45.00, description: 'Effetto magnetico riflettente 5D con riflessi cangianti e finitura ultra-brillante.', image_url: 'https://images.unsplash.com/photo-1599940824399-b87987ceb72a?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Refill Gel & Cambiocolore Express', duration_minutes: 60, price: 42.00, description: 'Ritocco ricrescita gel con limatura strutturale e nuovo colore a scelta.', image_url: 'https://images.unsplash.com/photo-1610992015732-2449b76344bc?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Unghie', name: 'Pedicure Curativo Callosità & Smalto', duration_minutes: 70, price: 52.00, description: 'Trattamento podologico estetico per levigazione talloni e benessere del piede.', image_url: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=600&q=80' },

  // Viso
  { cat: 'Viso', name: 'Pulizia Viso ad Ultrasuoni & Vapore', duration_minutes: 60, price: 60.00, description: 'Pulizia profonda non invasiva con spatola ad ultrasuoni, vapore ozonizzato e maschera idratante.', image_url: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Trattamento Anti-Age Acido Ialuronico & Collagene', duration_minutes: 75, price: 85.00, description: 'Rituale rimpolpante a tecnologia dermo-infusione per attenuare le rughe ed illuminare la pelle.', image_url: 'https://images.unsplash.com/photo-1512290900673-7002ee842932?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Massaggio Facciale Kobido Giapponese', duration_minutes: 50, price: 70.00, description: 'Antico massaggio di sollevamento naturale che stimola la produzione di elastina e tonifica i muscoli facciali.', image_url: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Laminazione Ciglia & Sopracciglia con Nutriente', duration_minutes: 60, price: 55.00, description: 'Trattamento curvante e rinforzante al complesso cheratinico con tintura nera o castana inclusa.', image_url: 'https://images.unsplash.com/photo-1583001809863-22bd19967675?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Peeling Illuminante Vitamina C & AHA', duration_minutes: 45, price: 65.00, description: 'Esfoliazione delicata agli alfa-idrossiacidi per schiarire le macchie e donare immediata radiosità.', image_url: 'https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Rituale Detox Carbone Attivo & Argilla Nera', duration_minutes: 55, price: 58.00, description: 'Maschera purificante al carbone vegetale bio per pelli miste e pori ostruiti.', image_url: 'https://images.unsplash.com/photo-1560750588-73207b1ef5b8?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Trattamento Bio-Lifting al Peptide di Vipera', duration_minutes: 70, price: 90.00, description: 'Effetto siero tensore immediato per mimetizzare le rughe d espressione di fronte e contorno labbra.', image_url: 'https://images.unsplash.com/photo-1516975080664-ed2fc6a32937?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Viso', name: 'Lift-Up Occhi Decongestionante alla Caffeina', duration_minutes: 40, price: 48.00, description: 'Massaggio sgonfiante con rulli di quarzo rosa e maschera hydrogel idratante antietà.', image_url: 'https://images.unsplash.com/photo-1522337660859-02fbefca4702?auto=format&fit=crop&w=600&q=80' },

  // Corpo
  { cat: 'Corpo', name: 'Massaggio Linfodrenante Metodo Vodder', duration_minutes: 60, price: 70.00, description: 'Tecnica manuale specifica per riattivare la circolazione linfatica e ridurre il gonfiore alle gambe.', image_url: 'https://images.unsplash.com/photo-1519823551278-64ac92734fb1?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Rituale Scrub ai Cristalli di Sale & Miele', duration_minutes: 50, price: 55.00, description: 'Gommage sensoriale vellutante con sali rosa dell\'Himalaya e miele biologico nutriente.', image_url: 'https://images.unsplash.com/photo-1507652313519-d4e9174996dd?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Massaggio Decontratturante Pietre Calde', duration_minutes: 60, price: 75.00, description: 'Massaggio profondo con pietre vulcaniche calde per sciogliere le contratture della schiena.', image_url: 'https://images.unsplash.com/photo-1600334089648-b0d9d3028eb2?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Trattamento Drenante Bendaggio Crio-Attivo', duration_minutes: 60, price: 65.00, description: 'Bende imbevute di principi attivi rinfrescanti ad azione urto contro ritenzione idrica e cellulite.', image_url: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Pressoterapia Drenante Gambe Leggere', duration_minutes: 45, price: 40.00, description: 'Trattamento meccanico a compressione sequenziale per favorire il ritorno venoso e la leggerezza.', image_url: 'https://images.unsplash.com/photo-1519823551278-64ac92734fb1?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Massaggio Svedese Rilassante con Olio di Argan', duration_minutes: 60, price: 68.00, description: 'Manovre avvolgenti e distensive con olio caldo di argan puro estratto a freddo.', image_url: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Fango Riducente Alghe di Bretagna', duration_minutes: 65, price: 72.00, description: 'Impacco di fanghi marini snellenti per rimodellare fianchi, cosce e addome.', image_url: 'https://images.unsplash.com/photo-1489659639091-8b687bc4386e?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Corpo', name: 'Massaggio Candela Aromatica alle Spezie', duration_minutes: 50, price: 62.00, description: 'Rituale caldo con burro di karitè fuso per una pelle straordinariamente setosa e profumata.', image_url: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=600&q=80' },

  // Capelli
  { cat: 'Capelli', name: 'Taglio Sartoriale & Piega Glossy Glamour', duration_minutes: 60, price: 48.00, description: 'Analisi della forma del viso, taglio personalizzato, trattamento lucidante e piega professionale.', image_url: 'https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Balayage Sfumato Seta & Tonalizzante', duration_minutes: 120, price: 120.00, description: 'Schiaritura a mano libera a basso impatto con tonalizzante rigenerante al velo di seta.', image_url: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Ricostruzione Molecolare Botox Capelli', duration_minutes: 75, price: 75.00, description: 'Trattamento intensivo a base di acido ialuronico e cheratina per chiudere le squame e rimpolpare la fibra.', image_url: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Rituale Cute Detox all\'Argilla e Oli Essenziali', duration_minutes: 45, price: 45.00, description: 'Scrub cuoio capelluto riequilibrante anti-sebo con lavaggio aromaterapico rilassante.', image_url: 'https://images.unsplash.com/photo-1527799820374-dcf8d9d4a388?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Colorazione Biologica Ristrutturante Olio di Jojoba', duration_minutes: 90, price: 65.00, description: 'Tinta 100% senza ammoniaca con alta copertura dei capelli bianchi e lucentezza naturale.', image_url: 'https://images.unsplash.com/photo-1519699047748-de8e457a634e?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Piega Onde Hollywoodiane & Trattamento Glow', duration_minutes: 45, price: 38.00, description: 'Styling a caldo con ferro conico per onde morbide, durature ed estremamente lucide.', image_url: 'https://images.unsplash.com/photo-1492106087820-71f1a00d2b11?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Extension Cheratina 100% Capelli Naturali (Ciocca)', duration_minutes: 120, price: 150.00, description: 'Applicazione invisibile a freddo per infoltimento ed allungamento chioma.', image_url: 'https://images.unsplash.com/photo-1582039983478-f7b538741364?auto=format&fit=crop&w=600&q=80' },
  { cat: 'Capelli', name: 'Trattamento Anti-Crespo alla Seta Vegana', duration_minutes: 80, price: 85.00, description: 'Lisciante disciplinante senza formaldeide per capelli morbidi, pettinabili e resistenti all umidità.', image_url: 'https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=600&q=80' }
];

function generateUniqueTreatmentsForSalon(salonId, count = 10) {
  const str = String(salonId);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 1000007;
  }

  const poolCopy = [...treatmentPool];
  const selected = [];
  let currentHash = hash;

  while (selected.length < count && poolCopy.length > 0) {
    const idx = currentHash % poolCopy.length;
    selected.push(poolCopy[idx]);
    poolCopy.splice(idx, 1); // Remove picked item so NO DUPLICATES EVER!
    currentHash = (currentHash * 17 + 13) % 1000007;
  }

  return selected;
}

app.get('/api/catalog/salons/:salon_id/services', async (req, res) => {
  try {
    const salonId = req.params.salon_id;

    let result = await db.query(
      `SELECT s.*, COALESCE(c.name, 'Estetica & Beauty') as category_name
       FROM services s
       LEFT JOIN categories c ON s.category_id = c.id
       WHERE s.salon_id = $1
       ORDER BY COALESCE(c.name, ''), s.name`,
      [salonId]
    );

    const needsUniqueUpgrade = result.rows.length === 0;

    if (needsUniqueUpgrade) {
      console.log(`Auto-seeding unique catalog for salon ID ${salonId}...`);
      try {
        const catRes = await db.query('SELECT id, name FROM categories');
        const catMap = {};
        catRes.rows.forEach(c => { catMap[c.name] = c.id; });

        const targetCount = 10;
        const salonTreatments = generateUniqueTreatmentsForSalon(salonId, targetCount);

        for (const t of salonTreatments) {
          const categoryId = catMap[t.cat];
          if (!categoryId) continue;
          await db.query(
            `INSERT INTO services (salon_id, category_id, name, duration_minutes, price, description, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [salonId, categoryId, t.name, t.duration_minutes, t.price, t.description, t.image_url]
          );
        }

        result = await db.query(
          `SELECT s.*, c.name as category_name
           FROM services s
           JOIN categories c ON s.category_id = c.id
           WHERE s.salon_id = $1
           ORDER BY c.name, s.name`,
          [salonId]
        );
        console.log(`Auto-seeded ${result.rows.length} unique services for salon ID ${salonId}`);
      } catch (seedErr) {
        console.error('Auto-seed failed:', seedErr);
      }
    }

    return res.json(result.rows);
  } catch (err) {
    console.error('Error fetching salon services:', err);
    return res.status(500).json({ error: 'Errore nel recupero dei servizi' });
  }
});

app.get('/api/catalog/salons/rankings', async (req, res) => {
  try {
    // 1. Get review count and average rating per salon
    const reviewsRes = await db.query(
      `SELECT salon_id, COUNT(*) as count, AVG(rating) as avg 
       FROM reviews 
       GROUP BY salon_id`
    );

    // 2. Get bookings count per salon
    const bookingsRes = await db.query(
      `SELECT salon_id, COUNT(*) as count 
       FROM bookings 
       GROUP BY salon_id`
    );

    // Build ratings map
    const ratingsMap = {};
    reviewsRes.rows.forEach(row => {
      ratingsMap[row.salon_id] = {
        count: parseInt(row.count),
        avg: parseFloat(row.avg)
      };
    });

    // Build bookings map
    const bookingsMap = {};
    bookingsRes.rows.forEach(row => {
      bookingsMap[row.salon_id] = parseInt(row.count);
    });

    // Get all salon IDs from both bookings and reviews to list them
    const salonIds = [...new Set([...reviewsRes.rows.map(r => r.salon_id), ...bookingsRes.rows.map(b => b.salon_id)])];

    const salonsMetrics = salonIds.map(salonId => {
      const rating = ratingsMap[salonId] ? ratingsMap[salonId].avg : 0;
      const reviewsCount = ratingsMap[salonId] ? ratingsMap[salonId].count : 0;
      const bookingsCount = bookingsMap[salonId] || 0;
      return { salonId, rating, reviewsCount, bookingsCount };
    });

    // Sort by rating (descending) to find top 5 rated
    const top5Rated = [...salonsMetrics]
      .filter(s => s.rating > 0)
      .sort((a, b) => b.rating - a.rating || b.reviewsCount - a.reviewsCount)
      .slice(0, 5)
      .map(s => s.salonId);

    // Sort by bookings (descending) to find top 3 booked
    const top3Booked = [...salonsMetrics]
      .filter(s => s.bookingsCount > 0)
      .sort((a, b) => b.bookingsCount - a.bookingsCount)
      .slice(0, 3)
      .map(s => s.salonId);

    return res.json({ top3Booked, top5Rated });
  } catch (err) {
    console.error('Error fetching salon rankings:', err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/api/catalog/services', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const { category_id, name, duration_minutes, price, description, image_url } = req.body;
  const salon_id = req.user.salonId; // obtained from JWT for manager

  if (!category_id || !name || !duration_minutes || !price || !salon_id) {
    return res.status(400).json({ error: 'Tutti i campi sono obbligatori' });
  }

  try {
    const result = await db.query(
      `INSERT INTO services (salon_id, category_id, name, duration_minutes, price, description, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [salon_id, category_id, name, duration_minutes, price, description || '', image_url || '']
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nella creazione del servizio' });
  }
});

// --- API SCHEDULES ---
app.get('/api/schedules/employees/:employee_id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM employee_schedules WHERE employee_id = $1 ORDER BY schedule_date ASC',
      [req.params.employee_id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Errore nel recupero degli orari' });
  }
});

app.post('/api/schedules', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const { employee_id, schedule_date, start_time, end_time } = req.body;

  if (!employee_id || !schedule_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Tutti i campi (employee_id, schedule_date, start_time, end_time) sono obbligatori' });
  }

  const todayStr = new Date().toLocaleDateString('en-CA');
  if (schedule_date < todayStr) {
    return res.status(400).json({ error: 'Non è possibile assegnare turni lavorativi nel passato' });
  }

  try {
    const result = await db.query(
      `INSERT INTO employee_schedules (employee_id, schedule_date, start_time, end_time) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (employee_id, schedule_date) 
       DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time 
       RETURNING *`,
      [employee_id, schedule_date, start_time, end_time]
    );
    const schedule = result.rows[0];

    // Publish event for employee shift notifications
    try {
      const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/employees/${employee_id}`);
      if (empRes.ok) {
        const employee = await empRes.json();
        publishEvent('booking.events', 'EMPLOYEE_SCHEDULE_ASSIGNED', {
          employee_id,
          user_id: employee.user_id,
          salon_id: employee.salon_id,
          schedule_date,
          start_time,
          end_time
        });
      }
    } catch (err) {
      console.error('Error publishing schedule assigned event:', err);
    }

    return res.json(schedule);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel salvataggio degli orari' });
  }
});

app.delete('/api/schedules/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const scheduleId = req.params.id;
  try {
    const result = await db.query('DELETE FROM employee_schedules WHERE id = $1 RETURNING *', [scheduleId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Turno non trovato' });
    }
    return res.json({ message: 'Turno rimosso con successo', schedule: result.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la rimozione del turno' });
  }
});

// GET /api/bookings/count/today
app.get('/api/bookings/count/today', async (req, res) => {
  try {
    const result = await db.query("SELECT COUNT(*) FROM bookings WHERE created_at >= CURRENT_DATE");
    const count = parseInt(result.rows[0].count, 10);
    return res.json({ count });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel recupero del contatore appuntamenti' });
  }
});

// GET /api/bookings/availability?employee_id=...&date=...&duration_minutes=...
app.get('/api/bookings/availability', async (req, res) => {
  const { employee_id, date, duration_minutes } = req.query;

  if (!employee_id || !date || !duration_minutes) {
    return res.status(400).json({ error: 'Parametri employee_id, date e duration_minutes richiesti' });
  }

  const duration = parseInt(duration_minutes);
  const bookingDate = new Date(date);
  if (isNaN(bookingDate.getTime())) {
    return res.status(400).json({ error: 'Formato data non valido' });
  }

  try {
    const schedRes = await db.query(
      'SELECT start_time, end_time FROM employee_schedules WHERE employee_id = $1 AND schedule_date = $2::date',
      [employee_id, date]
    );

    if (schedRes.rows.length === 0) {
      return res.json({ 
        date, 
        available: false, 
        reason: 'Il dipendente non ha un turno di lavoro assegnato per questa data', 
        slots: [],
        allSlots: []
      });
    }

    const start_time = schedRes.rows[0].start_time;
    const end_time = schedRes.rows[0].end_time;

    const parseTime = (tStr) => {
      const [h, m] = tStr.split(':').map(Number);
      return h * 60 + m;
    };
    
    const formatTime = (totalMin) => {
      const h = Math.floor(totalMin / 60).toString().padStart(2, '0');
      const m = (totalMin % 60).toString().padStart(2, '0');
      return `${h}:${m}`;
    };

    const startMin = parseTime(start_time);
    const endMin = parseTime(end_time);

    const bookingsRes = await db.query(
      `SELECT b.booking_time::time as start_time, s.duration_minutes 
       FROM bookings b 
       JOIN services s ON b.service_id = s.id 
       WHERE b.employee_id = $1 AND b.booking_time::date = $2::date AND b.status = 'confirmed'`,
      [employee_id, date]
    );

    const bookedRanges = bookingsRes.rows.map(row => {
      const start = parseTime(row.start_time);
      return {
        start,
        end: start + row.duration_minutes
      };
    });

    const unavailRes = await db.query(
      `SELECT start_time, end_time FROM employee_unavailabilities 
       WHERE employee_id = $1 AND unavailable_date = $2::date`,
      [employee_id, date]
    );

    const unavailRanges = unavailRes.rows.map(row => {
      return {
        start: parseTime(row.start_time),
        end: parseTime(row.end_time)
      };
    });

    const slots = [];
    const allSlots = [];
    const step = 15;

    for (let t = startMin; t <= endMin - duration; t += step) {
      const slotStart = t;
      const slotEnd = t + duration;

      let hasBookingOverlap = false;
      for (const range of bookedRanges) {
        if (slotStart < range.end && slotEnd > range.start) {
          hasBookingOverlap = true;
          break;
        }
      }

      let hasUnavailOverlap = false;
      for (const range of unavailRanges) {
        if (slotStart < range.end && slotEnd > range.start) {
          hasUnavailOverlap = true;
          break;
        }
      }

      let status = 'available';
      if (hasBookingOverlap) {
        status = 'booked';
      } else if (hasUnavailOverlap) {
        status = 'unavailable';
      }

      const formattedSlot = formatTime(slotStart);
      if (status === 'available') {
        slots.push(formattedSlot);
      }
      allSlots.push({ time: formattedSlot, status });
    }

    return res.json({
      date,
      available: slots.length > 0,
      slots,
      allSlots
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante il calcolo della disponibilità' });
  }
});

// POST /api/schedules/unavailability
app.post('/api/schedules/unavailability', authenticateToken, requireRole(['employee', 'salon_manager']), async (req, res) => {
  const { employee_id, unavailable_date, start_time, end_time, reason } = req.body;

  if (!employee_id || !unavailable_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'I campi employee_id, unavailable_date, start_time e end_time sono obbligatori' });
  }

  if (req.user.role === 'employee' && req.user.employeeId !== employee_id) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }

  try {
    await db.query(
      `INSERT INTO employee_unavailabilities (employee_id, unavailable_date, start_time, end_time, reason) 
       VALUES ($1, $2, $3, $4, $5)`,
      [employee_id, unavailable_date, start_time, end_time, reason || 'Indisponibilità temporanea']
    );

    const conflictBookings = await db.query(
      `SELECT b.*, s.name as service_name, s.duration_minutes 
       FROM bookings b 
       JOIN services s ON b.service_id = s.id 
       WHERE b.employee_id = $1 
         AND b.status = 'confirmed' 
         AND b.booking_time::date = $2::date
         AND (b.booking_time::time < $4::time AND b.booking_time::time + interval '1 minute' * s.duration_minutes > $3::time)`,
      [employee_id, unavailable_date, start_time, end_time]
    );

    for (const b of conflictBookings.rows) {
      // 1. Fetch Service and Category details
      const serviceRes = await db.query(
        `SELECT s.*, c.name as category_name 
         FROM services s 
         JOIN categories c ON s.category_id = c.id 
         WHERE s.id = $1`,
        [b.service_id]
      );
      const service = serviceRes.rows[0];

      // 2. Fetch all salon employees
      let hasAvailableReplacement = false;
      try {
        const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/salons/${b.salon_id}/employees`);
        if (empRes.ok) {
          const employees = await empRes.json();
          const bookingDate = new Date(b.booking_time);
          const bookingTimeStr = bookingDate.toTimeString().split(' ')[0]; // HH:MM:SS
          const bookingDateStr = bookingDate.toISOString().split('T')[0];

          for (const e of employees) {
            // Must not be the currently unavailable employee
            if (String(e.id) === String(employee_id)) continue;

            // Check specialization compatibility
            const spec = e.specialization.toLowerCase();
            const cat = service.category_name.toLowerCase();
            let isSpecialized = spec.includes(cat);
            if (!isSpecialized) {
              if (cat === 'unghie' && (spec.includes('mani') || spec.includes('unghie') || spec.includes('nails'))) isSpecialized = true;
              if (cat === 'viso' && (spec.includes('viso') || spec.includes('face'))) isSpecialized = true;
              if (cat === 'corpo' && (spec.includes('corpo') || spec.includes('body'))) isSpecialized = true;
            }
            if (!isSpecialized) continue;

            // Check schedule (must be working at that day/time)
            const schedRes = await db.query(
              'SELECT start_time, end_time FROM employee_schedules WHERE employee_id = $1 AND schedule_date = $2::date',
              [e.id, b.booking_time]
            );
            if (schedRes.rows.length === 0) continue;
            const schedule = schedRes.rows[0];
            if (bookingTimeStr < schedule.start_time || bookingTimeStr > schedule.end_time) continue;

            // Check unavailabilities
            const unavailCheck = await db.query(
              `SELECT id FROM employee_unavailabilities 
               WHERE employee_id = $1 
                 AND unavailable_date = $2::date
                 AND (start_time < ($3::time + interval '1 minute' * $4) AND end_time > $3::time)`,
              [e.id, bookingDateStr, bookingTimeStr, service.duration_minutes]
            );
            if (unavailCheck.rows.length > 0) continue;

            // Check double bookings
            const conflictCheck = await db.query(
              `SELECT b.id FROM bookings b
               JOIN services s ON b.service_id = s.id
               WHERE b.employee_id = $1 
                 AND b.status = 'confirmed' 
                 AND tsrange(b.booking_time, b.booking_time + interval '1 minute' * s.duration_minutes) && 
                     tsrange($2::timestamp, $2::timestamp + interval '1 minute' * $3)`,
              [e.id, b.booking_time, service.duration_minutes]
            );
            if (conflictCheck.rows.length > 0) continue;

            // If we get here, this employee is qualified and available!
            hasAvailableReplacement = true;
            break;
          }
        }
      } catch (err) {
        console.error('Error checking replacement availability:', err);
      }

      if (hasAvailableReplacement) {
        // Safe to mark as pending for manual reassignment
        await db.query(
          `UPDATE bookings SET status = 'pending' WHERE id = $1`,
          [b.id]
        );
        
        publishEvent('booking.events', 'BOOKING_PENDING_REASSIGNMENT', {
          booking_id: b.id,
          salon_id: b.salon_id,
          employee_id: b.employee_id,
          booking_time: b.booking_time,
          service_name: b.service_name
        });
      } else {
        // No backup staff available: cancel and refund 100%
        await db.query(
          `UPDATE bookings SET status = 'cancelled', payment_status = 'refunded' WHERE id = $1`,
          [b.id]
        );
        await db.query(
          `INSERT INTO refunds (booking_id, amount) VALUES ($1, $2)`,
          [b.id, b.price]
        );

        publishEvent('booking.events', 'BOOKING_CANCELLED_REGULAR', {
          id: b.id,
          client_id: b.client_id,
          salon_id: b.salon_id,
          service_id: b.service_id,
          employee_id: b.employee_id,
          booking_time: b.booking_time,
          status: 'cancelled',
          payment_status: 'refunded',
          price: b.price,
          refundAmount: b.price
        });
      }
    }

    // Publish unavailability event for Salon notifications
    try {
      const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/employees/${employee_id}`);
      if (empRes.ok) {
        const employee = await empRes.json();
        publishEvent('booking.events', 'EMPLOYEE_UNAVAILABILITY_REGISTERED', {
          employee_id,
          employee_name: `${employee.first_name} ${employee.last_name}`,
          salon_id: employee.salon_id,
          unavailable_date,
          start_time,
          end_time,
          reason: reason || 'Indisponibilità temporanea'
        });
      }
    } catch (err) {
      console.error('Error publishing unavailability event:', err);
    }

    return res.status(201).json({
      message: 'Indisponibilità salvata con successo',
      affected_bookings_count: conflictBookings.rows.length,
      affected_bookings: conflictBookings.rows
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante il salvataggio dell\'indisponibilità' });
  }
});

// GET /api/schedules/unavailability
app.get('/api/schedules/unavailability', authenticateToken, requireRole(['employee', 'salon_manager']), async (req, res) => {
  let employeeId = req.query.employee_id;

  if (req.user.role === 'employee') {
    employeeId = req.user.employeeId;
  }

  if (!employeeId) {
    return res.status(400).json({ error: 'Parametro employee_id richiesto' });
  }

  try {
    const result = await db.query(
      `SELECT * FROM employee_unavailabilities 
       WHERE employee_id = $1 
       ORDER BY unavailable_date DESC, start_time ASC`,
      [employeeId]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Errore nel recupero delle indisponibilità' });
  }
});

// DELETE /api/schedules/unavailability/:id
app.delete('/api/schedules/unavailability/:id', authenticateToken, requireRole(['employee', 'salon_manager']), async (req, res) => {
  try {
    if (req.user.role === 'employee') {
      const check = await db.query(
        'SELECT employee_id FROM employee_unavailabilities WHERE id = $1',
        [req.params.id]
      );
      if (check.rows.length > 0 && check.rows[0].employee_id !== req.user.employeeId) {
        return res.status(403).json({ error: 'Non autorizzato' });
      }
    }

    await db.query('DELETE FROM employee_unavailabilities WHERE id = $1', [req.params.id]);
    return res.json({ message: 'Indisponibilità eliminata con successo' });
  } catch (err) {
    return res.status(500).json({ error: 'Errore durante l\'eliminazione' });
  }
});

// PUT /api/bookings/:id/reassign
app.put('/api/bookings/:id/reassign', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const bookingId = req.params.id;
  const { employee_id } = req.body;

  if (!employee_id) {
    return res.status(400).json({ error: 'Parametro employee_id richiesto' });
  }

  try {
    const bookingRes = await db.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    const booking = bookingRes.rows[0];

    if (booking.salon_id !== req.user.salonId) {
      return res.status(403).json({ error: 'Non sei autorizzato' });
    }

    const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/employees/${employee_id}`);
    if (!empRes.ok) {
      return res.status(400).json({ error: 'Dipendente non trovato o non valido' });
    }
    const employee = await empRes.json();

    if (employee.salon_id !== booking.salon_id) {
      return res.status(400).json({ error: 'Il dipendente non appartiene a questo salone' });
    }

    const serviceRes = await db.query(
      `SELECT s.*, c.name as category_name 
       FROM services s 
       JOIN categories c ON s.category_id = c.id 
       WHERE s.id = $1`,
      [booking.service_id]
    );
    const service = serviceRes.rows[0];
    
    const spec = employee.specialization.toLowerCase();
    const cat = service.category_name.toLowerCase();
    let isSpecialized = spec.includes(cat);
    if (!isSpecialized) {
      if (cat === 'unghie' && (spec.includes('mani') || spec.includes('unghie') || spec.includes('nails'))) isSpecialized = true;
      if (cat === 'viso' && (spec.includes('viso') || spec.includes('face'))) isSpecialized = true;
      if (cat === 'corpo' && (spec.includes('corpo') || spec.includes('body'))) isSpecialized = true;
    }

    if (!isSpecialized) {
      return res.status(400).json({ error: `Il dipendente ha specializzazione '${employee.specialization}' e non può svolgere trattamenti di categoria '${service.category_name}'` });
    }

     const bookingDate = new Date(booking.booking_time);
     const timeStr = bookingDate.toTimeString().split(' ')[0];
 
     const schedRes = await db.query(
       'SELECT start_time, end_time FROM employee_schedules WHERE employee_id = $1 AND schedule_date = $2::date',
       [employee_id, booking.booking_time]
     );
    if (schedRes.rows.length === 0) {
      return res.status(400).json({ error: 'Il dipendente non lavora in questo giorno' });
    }
    const { start_time, end_time } = schedRes.rows[0];
    if (timeStr < start_time || timeStr > end_time) {
      return res.status(400).json({ error: 'Orario dell\'appuntamento fuori dal turno del dipendente' });
    }

    const conflictCheck = await db.query(
      `SELECT b.id FROM bookings b
       JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = $1 
         AND b.status = 'confirmed' 
         AND tsrange(b.booking_time, b.booking_time + interval '1 minute' * s.duration_minutes) && 
             tsrange($2::timestamp, $2::timestamp + interval '1 minute' * $3)`,
      [employee_id, booking.booking_time, service.duration_minutes]
    );

    if (conflictCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Il dipendente è già prenotato in questa fascia oraria' });
    }

    const unavailCheck = await db.query(
      `SELECT id FROM employee_unavailabilities 
       WHERE employee_id = $1 
         AND unavailable_date = $2::timestamp::date
         AND (start_time < ($2::timestamp::time + interval '1 minute' * $3) AND end_time > $2::timestamp::time)`,
      [employee_id, booking.booking_time, service.duration_minutes]
    );
    if (unavailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Il dipendente non è disponibile in questo orario' });
    }

    await db.query(
      `UPDATE bookings SET employee_id = $1, status = 'confirmed' WHERE id = $2`,
      [employee_id, bookingId]
    );

    publishEvent('booking.events', 'BOOKING_REASSIGNED', {
      booking_id: bookingId,
      employee_id,
      booking_time: booking.booking_time
    });

    return res.json({ message: 'Prenotazione riassegnata con successo' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore interno durante la riassegnazione' });
  }
});

// PUT /api/catalog/services/:id
app.put('/api/catalog/services/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const serviceId = req.params.id;
  const { name, duration_minutes, price, description, image_url, category_id } = req.body;
  
  try {
    const check = await db.query(
      `SELECT s.id FROM services s 
       JOIN salons sl ON s.salon_id = sl.id 
       WHERE s.id = $1 AND sl.manager_id = $2`,
      [serviceId, req.user.userId]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Non autorizzato' });
    }

    const currentRes = await db.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Servizio non trovato' });
    }
    const current = currentRes.rows[0];

    const updatedName = name !== undefined ? name : current.name;
    const updatedDuration = duration_minutes !== undefined ? duration_minutes : current.duration_minutes;
    const updatedPrice = price !== undefined ? price : current.price;
    const updatedDesc = description !== undefined ? description : current.description;
    const updatedImg = (image_url === '' || image_url === null) ? null : (image_url !== undefined ? image_url : current.image_url);
    const updatedCat = category_id !== undefined ? category_id : current.category_id;

    const result = await db.query(
      `UPDATE services 
       SET name = $1, duration_minutes = $2, price = $3, description = $4, image_url = $5, category_id = $6
       WHERE id = $7 RETURNING *`,
      [updatedName, updatedDuration, updatedPrice, updatedDesc, updatedImg, updatedCat, serviceId]
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la modifica del servizio' });
  }
});

// DELETE /api/catalog/services/:id
app.delete('/api/catalog/services/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const serviceId = req.params.id;
  try {
    const srvCheck = await db.query('SELECT salon_id FROM services WHERE id = $1', [serviceId]);
    if (srvCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Servizio non trovato' });
    }

    const serviceSalonId = srvCheck.rows[0].salon_id;
    let authorized = false;

    if (req.user.salonId && String(req.user.salonId) === String(serviceSalonId)) {
      authorized = true;
    } else {
      const salonCheck = await db.query('SELECT id FROM salons WHERE id = $1 AND manager_id = $2', [serviceSalonId, req.user.userId]);
      if (salonCheck.rows.length > 0) {
        authorized = true;
      } else {
        const anySalon = await db.query('SELECT id FROM salons WHERE manager_id = $1', [req.user.userId]);
        if (anySalon.rows.length > 0) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Non autorizzato a eliminare questo servizio' });
    }

    // Safely disassociate foreign key references before deleting service
    await db.query('DELETE FROM drops WHERE service_id = $1', [serviceId]).catch(e => console.warn('Non-critical drop cleanup:', e.message));
    await db.query('UPDATE bookings SET service_id = NULL WHERE service_id = $1', [serviceId]).catch(e => console.warn('Non-critical booking nullification:', e.message));
    await db.query('DELETE FROM services WHERE id = $1', [serviceId]);

    return res.json({ message: 'Servizio rimosso dal catalogo con successo' });
  } catch (err) {
    console.error('Errore durante la rimozione del servizio:', err);
    return res.status(500).json({ error: 'Errore durante la rimozione del servizio: ' + (err.message || '') });
  }
});

// --- API BOOKINGS ---
app.get('/api/bookings', authenticateToken, async (req, res) => {
  try {
    let queryText = `
      SELECT 
        b.id, b.client_id, b.salon_id, b.service_id, b.employee_id, b.status, b.payment_status, b.price, b.created_at, b.is_drop,
        TO_CHAR(b.booking_time, 'YYYY-MM-DD"T"HH24:MI:SS') as booking_time,
        s.name as service_name,
        c.name as category_name
      FROM bookings b
      LEFT JOIN services s ON b.service_id = s.id
      LEFT JOIN categories c ON s.category_id = c.id
    `;
    let params = [];

    if (req.user.role === 'client') {
      queryText += ' WHERE b.client_id = $1 ORDER BY b.booking_time DESC';
      params.push(req.user.userId);
    } else if (req.user.role === 'employee') {
      queryText += ' WHERE b.employee_id = $1 ORDER BY b.booking_time DESC';
      params.push(req.user.employeeId);
    } else if (req.user.role === 'salon_manager') {
      queryText += ' WHERE b.salon_id = $1 ORDER BY b.booking_time DESC';
      params.push(req.user.salonId);
    }

    const result = await db.query(queryText, params);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Errore nel recupero delle prenotazioni' });
  }
});

// Create Standard Booking
// Create Standard Booking
app.post('/api/bookings', authenticateToken, requireRole(['client']), async (req, res) => {
  const { service_id, employee_id, booking_time } = req.body;
  const client_id = req.user.userId;

  if (!service_id || !employee_id || !booking_time) {
    return res.status(400).json({ error: 'Tutti i campi sono obbligatori' });
  }

  const bookingDate = new Date(booking_time);
  if (bookingDate <= new Date()) {
    return res.status(400).json({ error: 'La data di prenotazione deve essere nel futuro' });
  }

  try {
    await db.query('BEGIN');

    // 1. Fetch Service Info
    const serviceRes = await db.query('SELECT * FROM services WHERE id = $1', [service_id]);
    if (serviceRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Servizio non trovato' });
    }
    const service = serviceRes.rows[0];

    // 1b. Fetch Employee Specialization from auth-service and validate it
    const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/employees/${employee_id}`);
    if (!empRes.ok) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Dipendente non trovato o non valido' });
    }
    const employee = await empRes.json();
    if (employee.salon_id !== service.salon_id) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Il dipendente specificato non appartiene a questo salone' });
    }

    // Get service category name
    const catRes = await db.query('SELECT name FROM categories WHERE id = $1', [service.category_id]);
    const serviceCategory = catRes.rows[0].name;

    const spec = employee.specialization.toLowerCase();
    const cat = serviceCategory.toLowerCase();
    let isSpecialized = spec.includes(cat);
    if (!isSpecialized) {
      if (cat === 'unghie' && (spec.includes('mani') || spec.includes('unghie') || spec.includes('nails'))) isSpecialized = true;
      if (cat === 'viso' && (spec.includes('viso') || spec.includes('face'))) isSpecialized = true;
      if (cat === 'corpo' && (spec.includes('corpo') || spec.includes('body'))) isSpecialized = true;
    }

    if (!isSpecialized) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: `Il dipendente ha specializzazione '${employee.specialization}' e non può erogare servizi di categoria '${serviceCategory}'` });
    }

    // 2. Validate Employee Schedule for that day (Lock the row to prevent race conditions)
    const schedRes = await db.query(
      'SELECT * FROM employee_schedules WHERE employee_id = $1 AND schedule_date = $2::date FOR UPDATE',
      [employee_id, booking_time]
    );
    if (schedRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Il dipendente non ha turni lavorativi assegnati per questo giorno' });
    }
    
    // Check if time is within schedule
    const schedule = schedRes.rows[0];
    const bookingTimeStr = bookingDate.toTimeString().split(' ')[0]; // HH:MM:SS
    if (bookingTimeStr < schedule.start_time || bookingTimeStr > schedule.end_time) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Orario al di fuori del turno lavorativo del dipendente' });
    }

    // Check unavailability conflict
    const unavailCheck = await db.query(
      `SELECT id FROM employee_unavailabilities 
       WHERE employee_id = $1 
         AND unavailable_date = $2::date
         AND (start_time < ($3::time + interval '1 minute' * $4) AND end_time > $3::time)`,
      [employee_id, bookingDate.toISOString().split('T')[0], bookingTimeStr, service.duration_minutes]
    );
    if (unavailCheck.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Il dipendente non è disponibile in questa fascia oraria (indisponibilità registrata)' });
    }

    // 3. Double booking check
    const conflictCheck = await db.query(
      `SELECT b.id FROM bookings b
       JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = $1 
         AND b.status = 'confirmed' 
         AND tsrange(b.booking_time, b.booking_time + interval '1 minute' * s.duration_minutes) && 
             tsrange($2::timestamp, $2::timestamp + interval '1 minute' * $3)`,
      [employee_id, booking_time, service.duration_minutes]
    );

    if (conflictCheck.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Il dipendente è già prenotato in questa fascia oraria' });
    }

    // 4. Mock Payment Integration
    // Assume payment is successful immediately.
    
    // 5. Create Booking
    const newBookingRes = await db.query(
      `INSERT INTO bookings (client_id, salon_id, service_id, employee_id, booking_time, status, payment_status, price) 
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'paid', $6) RETURNING *`,
      [client_id, service.salon_id, service_id, employee_id, booking_time, service.price]
    );
    
    const newBooking = newBookingRes.rows[0];

    await db.query('COMMIT');

    // 6. Publish Event
    publishEvent('booking.events', 'BOOKING_CONFIRMED', newBooking);

    return res.status(201).json(newBooking);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la creazione della prenotazione' });
  }
});

// Endpoint dedicated to confirming drops (called by drop-service worker or asynchronously via queue)
// We expose it as an internal API or handle it via consumer. Let's support both.
app.post('/api/bookings/confirm-drop', async (req, res) => {
  // Simple internal auth validation (in production, use API keys or network isolation)
  const { client_id, salon_id, service_id, employee_id, booking_time, price, drop_id } = req.body;
  
  if (!client_id || !salon_id || !service_id || !employee_id || !booking_time || !price) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }

  try {
    await db.query('BEGIN');

    // 1. Fetch Service Info
    const serviceRes = await db.query('SELECT * FROM services WHERE id = $1', [service_id]);
    if (serviceRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Servizio non trovato' });
    }
    const service = serviceRes.rows[0];

    // 2. Lock the row to prevent race conditions
    await db.query(
      'SELECT * FROM employee_schedules WHERE employee_id = $1 AND schedule_date = $2::date FOR UPDATE',
      [employee_id, booking_time]
    );

    // 3. Double booking check
    const conflictCheck = await db.query(
      `SELECT b.id FROM bookings b
       JOIN services s ON b.service_id = s.id
       WHERE b.employee_id = $1 
         AND b.status = 'confirmed' 
         AND tsrange(b.booking_time, b.booking_time + interval '1 minute' * s.duration_minutes) && 
             tsrange($2::timestamp, $2::timestamp + interval '1 minute' * $3)`,
      [employee_id, booking_time, service.duration_minutes]
    );

    if (conflictCheck.rows.length > 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Il dipendente è già prenotato in questa fascia oraria' });
    }

    const result = await db.query(
      `INSERT INTO bookings (client_id, salon_id, service_id, employee_id, booking_time, status, payment_status, price, is_drop) 
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'paid', $6, TRUE) RETURNING *`,
      [client_id, salon_id, service_id, employee_id, booking_time, price]
    );

    const booking = result.rows[0];
    await db.query('COMMIT');
    publishEvent('booking.events', 'DROP_CLAIM_CONFIRMED', { booking, drop_id });
    return res.status(201).json(booking);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Errore interno nel confermare il drop booking' });
  }
});

// Cancel Booking with 24 Hours Refund Policy
app.post('/api/bookings/:id/cancel', authenticateToken, async (req, res) => {
  const bookingId = req.params.id;
  const user = req.user;

  try {
    // Fetch Booking
    const bookingRes = await db.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }

    const booking = bookingRes.rows[0];

    // Auth validation: only client who booked or manager can cancel
    if (user.role === 'client' && booking.client_id !== user.userId) {
      return res.status(403).json({ error: 'Non autorizzato a cancellare questa prenotazione' });
    }
    if (user.role === 'salon_manager' && booking.salon_id !== user.salonId) {
      return res.status(403).json({ error: 'Non autorizzato' });
    }

    if (booking.is_drop) {
      return res.status(400).json({ error: 'Le prenotazioni effettuate tramite Flash Drop non sono annullabili' });
    }

    if (booking.status !== 'confirmed' && booking.status !== 'pending') {
      return res.status(400).json({ error: 'La prenotazione non è attiva o è già stata modificata' });
    }

    let refundAmount = 0;
    let isLateCancellation = false;

    if (booking.status === 'pending') {
      // Cancellazione forzata da parte del salone o per indisponibilità: sempre 100% di rimborso!
      refundAmount = booking.price;
    } else {
      const now = new Date();
      const bookingTime = new Date(booking.booking_time);
      const diffHours = (bookingTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (diffHours > 24) {
        // 100% Refund
        refundAmount = booking.price;
      } else if (diffHours > 0) {
        // Late Cancellation: 50% Refund to Client, and trigger 50% Discounted Drop
        refundAmount = (booking.price * 0.5).toFixed(2);
        isLateCancellation = true;
      } else {
        return res.status(400).json({ error: 'Non puoi cancellare un appuntamento già passato o in corso' });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update booking status
      await client.query(
        `UPDATE bookings SET status = 'cancelled', payment_status = 'refunded' WHERE id = $1`,
        [bookingId]
      );

      // Create refund record
      await client.query(
        `INSERT INTO refunds (booking_id, amount) VALUES ($1, $2)`,
        [bookingId, refundAmount]
      );

      await client.query('COMMIT');
      
      const cancelledBooking = {
        ...booking,
        status: 'cancelled',
        payment_status: 'refunded',
        refundAmount
      };

      if (isLateCancellation) {
        // Publish to rabbitmq so Drop Service can automatically generate a Drop!
        publishEvent('booking.events', 'BOOKING_CANCELLED_LATE', {
          booking: cancelledBooking,
          original_booking_id: booking.id,
          salon_id: booking.salon_id,
          service_id: booking.service_id,
          employee_id: booking.employee_id,
          booking_time: formatLocalTime(booking.booking_time),
          original_price: booking.price,
          drop_price: (booking.price * 0.5).toFixed(2)
        });
      } else {
        publishEvent('booking.events', 'BOOKING_CANCELLED_REGULAR', cancelledBooking);
      }

      return res.json({
        message: 'Cancellazione completata con successo',
        refunded_amount: refundAmount,
        late_cancellation: isLateCancellation
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la cancellazione della prenotazione' });
  }
});

// POST /api/reviews
app.post('/api/reviews', authenticateToken, requireRole(['client']), async (req, res) => {
  const { booking_id, rating, comment } = req.body;
  const client_id = req.user.userId;

  if (!booking_id || !rating) {
    return res.status(400).json({ error: 'booking_id e rating sono richiesti' });
  }

  const ratingVal = parseInt(rating);
  if (isNaN(ratingVal) || ratingVal < 1 || ratingVal > 5) {
    return res.status(400).json({ error: 'Il rating deve essere compreso tra 1 e 5' });
  }

  try {
    // Validate booking ownership and completion time
    const bookingRes = await db.query(
      `SELECT b.*, s.duration_minutes 
       FROM bookings b 
       JOIN services s ON b.service_id = s.id 
       WHERE b.id = $1 AND b.client_id = $2`,
      [booking_id, client_id]
    );

    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata o non autorizzata' });
    }

    const booking = bookingRes.rows[0];
    
    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Non puoi recensire una prenotazione annullata' });
    }

    let bookingTime = new Date(booking.booking_time).getTime();
    if (isNaN(bookingTime)) {
      bookingTime = new Date(String(booking.booking_time).replace(' ', 'T')).getTime();
    }

    const isCompleted = booking.status === 'completed';
    const isPastBooking = !isNaN(bookingTime) && (bookingTime <= Date.now() || (bookingTime - 2 * 3600 * 1000) <= Date.now());

    if (!isCompleted && !isPastBooking) {
      return res.status(400).json({ error: 'Non puoi recensire un trattamento non ancora terminato' });
    }

    // Insert review
    const insertRes = await db.query(
      `INSERT INTO reviews (booking_id, client_id, salon_id, rating, comment) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (booking_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment 
       RETURNING *`,
      [booking_id, client_id, booking.salon_id, ratingVal, comment || '']
    );

    const review = insertRes.rows[0];

    // Publish event for salon review notifications
    publishEvent('booking.events', 'CLIENT_REVIEW_CREATED', {
      review_id: review.id,
      booking_id: booking_id,
      client_id: client_id,
      salon_id: booking.salon_id,
      rating: ratingVal,
      comment: comment || ''
    });

    return res.json(review);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel salvataggio della recensione' });
  }
});

// GET /api/reviews/salon/:salon_id
app.get('/api/reviews/salon/:salon_id', async (req, res) => {
  const { salon_id } = req.params;
  try {
    // 1. Fetch employees of this salon from auth-service to map their names
    let employees = [];
    try {
      const empRes = await fetch(`${AUTH_SERVICE_URL}/api/auth/salons/${salon_id}/employees`);
      if (empRes.ok) {
        employees = await empRes.json();
      }
    } catch (err) {
      console.error('Error fetching employees from auth-service:', err.message);
    }

    const empMap = {};
    employees.forEach(emp => {
      empMap[emp.id] = `${emp.first_name} ${emp.last_name}`;
    });

    // 2. Query reviews with joined booking/service details
    const reviewsRes = await db.query(
      `SELECT r.id, r.booking_id, r.client_id, r.salon_id, r.rating, r.comment, r.created_at,
              b.booking_time,
              s.name as service_name,
              b.employee_id
       FROM reviews r
       LEFT JOIN bookings b ON r.booking_id = b.id
       LEFT JOIN services s ON b.service_id = s.id
       WHERE r.salon_id = $1 
       ORDER BY r.created_at DESC`,
      [salon_id]
    );

    // 3. Map employee name to each review
    const result = reviewsRes.rows.map(row => {
      const empName = empMap[row.employee_id] || 'Dipendente';
      return {
        id: row.id,
        booking_id: row.booking_id,
        client_id: row.client_id,
        salon_id: row.salon_id,
        rating: row.rating,
        comment: row.comment,
        created_at: row.created_at,
        booking_time: row.booking_time,
        service_name: row.service_name,
        employee_name: empName
      };
    });

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore nel recupero delle recensioni' });
  }
});

// Start service
initDb().then(() => {
  initRabbitMQ();
  app.listen(PORT, () => {
    console.log(`Booking & Catalog Service running on port ${PORT}`);
  });
});
