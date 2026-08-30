process.env.TZ = 'Europe/Rome';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

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
const PORT = process.env.PORT || 3001;

// Health check endpoints per ALB e smoke test
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service', timestamp: new Date().toISOString() });
});

app.get('/api/auth/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service', timestamp: new Date().toISOString() });
});

// Auth middlewares
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token non fornito' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
};

const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accesso negato. Ruolo non autorizzato' });
    }
    next();
  };
};

// Init DB tables with retry loop
async function initDb(maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[INIT-DB] Inizializzazione database (tentativo ${attempt}/${maxRetries})...`);
      await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(err => {
        console.warn('[INIT-DB] Estensione uuid-ossp opzionale saltata (utilizza gen_random_uuid nativo):', err.message);
      });

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('client', 'salon_manager', 'employee')),
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        phone VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    
    await db.query(`
      CREATE TABLE IF NOT EXISTS salons (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        street VARCHAR(255) NOT NULL,
        city VARCHAR(255) NOT NULL,
        latitude FLOAT DEFAULT 45.4642,
        longitude FLOAT DEFAULT 9.1900,
        description TEXT,
        image_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS street VARCHAR(255);`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS city VARCHAR(255);`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS latitude FLOAT DEFAULT 45.4642;`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS longitude FLOAT DEFAULT 9.1900;`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS description TEXT;`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS image_url TEXT;`);
    await db.query(`ALTER TABLE salons ALTER COLUMN image_url TYPE TEXT;`);
    await db.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);


    // Remove exact duplicate salons (same name and street) keeping the one with manager_id if present, else earliest
    await db.query(`
      DELETE FROM salons WHERE id NOT IN (
        SELECT DISTINCT ON (COALESCE(LOWER(TRIM(name)), ''), COALESCE(LOWER(TRIM(street)), '')) id 
        FROM salons 
        ORDER BY COALESCE(LOWER(TRIM(name)), ''), COALESCE(LOWER(TRIM(street)), ''), (manager_id IS NOT NULL) DESC, created_at ASC
      );
    `).catch(err => console.warn('Non critical: duplicate cleanup skipped:', err.message));

    // Ensure initial default seed salons exist if the database has zero or few salons
    const uniqueSalonsData = [
      {
        name: 'Glamour Salone Boutique',
        street: 'Via Torino 12',
        city: 'Milano',
        latitude: 45.4642,
        longitude: 9.1900,
        description: 'Salone boutique raffinato nel cuore di Milano specializzato in hairstyle e trattamenti beauty di lusso.',
        image_url: 'hero-beauty.jpg'
      },
      {
        name: 'Oasis Beauty Room 913',
        street: 'Corso Buenos Aires 12',
        city: 'Milano',
        latitude: 45.4782,
        longitude: 9.2110,
        description: 'Oasi di benessere ed estetica avanzata per trattamenti viso e corpo ad alta tecnologia.',
        image_url: 'body_massage.jpg'
      },
      {
        name: 'Aura Spa & Wellness',
        street: 'Via Roma 45',
        city: 'Torino',
        latitude: 45.0683,
        longitude: 7.6831,
        description: 'Centro benessere zen dedicato a massaggi rigeneranti e rituali spa rilassanti.',
        image_url: 'face_treatment.jpg'
      },
      {
        name: "L'Atelier del Capello",
        street: 'Via dei Condotti 88',
        city: 'Roma',
        latitude: 41.9056,
        longitude: 12.4823,
        description: 'Atelier sartoriale del capello, balayage artistico e pieghe glamour personalizzate.',
        image_url: 'hair_styling.jpg'
      },
      {
        name: 'Velvet Touch Beauty Studio',
        street: "Via de' Calzaiuoli 15",
        city: 'Firenze',
        latitude: 43.7711,
        longitude: 11.2558,
        description: 'Studio estetico elegante per manicure di precisione, lash lifting e cura del viso.',
        image_url: 'nails_treatment.jpg'
      },
      {
        name: 'Lumina Skin & Nail Care',
        street: 'Via Rizzoli 7',
        city: 'Bologna',
        latitude: 44.4942,
        longitude: 11.3465,
        description: 'Nail bar e centro estetico specializzato in ricostruzione gel, nail art e cura della pelle.',
        image_url: 'default_beauty.jpg'
      },
      {
        name: 'Elegance Hairstyle & Spa',
        street: 'Via Toledo 120',
        city: 'Napoli',
        latitude: 40.8423,
        longitude: 14.2489,
        description: 'Salone di acconciature ed estetica con trattamenti ristrutturanti e cosmetica organica.',
        image_url: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80'
      },
      {
        name: 'Nirvana Body & Mind Spa',
        street: 'Calle Larga San Marco 45',
        city: 'Venezia',
        latitude: 45.4343,
        longitude: 12.3388,
        description: 'Luxury spa nel cuore di Venezia per massaggi di coppia, percorsi benessere e idromassaggio.',
        image_url: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=800&q=80'
      }
    ];

    for (const preset of uniqueSalonsData) {
      const exists = await db.query(
        'SELECT id FROM salons WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND LOWER(TRIM(street)) = LOWER(TRIM($2))',
        [preset.name, preset.street]
      );
      if (exists.rows.length === 0) {
        await db.query(
          `INSERT INTO salons (name, street, city, latitude, longitude, description, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [preset.name, preset.street, preset.city, preset.latitude, preset.longitude, preset.description, preset.image_url]
        );
      }
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        salon_id UUID REFERENCES salons(id) ON DELETE CASCADE,
        specialization VARCHAR(255),
        photo_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url TEXT;`);

    // Create and seed italian_cities table
    await db.query(`
      CREATE TABLE IF NOT EXISTS italian_cities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        province VARCHAR(10) NOT NULL,
        region VARCHAR(255) NOT NULL
      );
    `);

    const citiesCount = await db.query('SELECT COUNT(*) FROM italian_cities');
    if (parseInt(citiesCount.rows[0].count) === 0) {
      console.log('Seeding Italian cities into database...');
      const filePath = path.join(__dirname, 'comuni.json');
      if (fs.existsSync(filePath)) {
        const citiesData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const batchSize = 500;
        for (let i = 0; i < citiesData.length; i += batchSize) {
          const batch = citiesData.slice(i, i + batchSize);
          const values = [];
          const placeholders = [];
          batch.forEach((city, index) => {
            const offset = index * 3;
            placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
            values.push(city.nome, city.sigla, city.regione.nome);
          });
          const query = `
            INSERT INTO italian_cities (name, province, region) 
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (name) DO NOTHING;
          `;
          await db.query(query, values);
        }
        console.log(`Successfully seeded ${citiesData.length} Italian cities.`);
      } else {
        console.warn(`comuni.json not found at ${filePath}. Skipping cities seeding.`);
      }
    }

      console.log('Database tables initialized successfully in Auth Service.');
      return;
    } catch (err) {
      console.error(`[INIT-DB ERROR] Tentativo ${attempt}/${maxRetries} fallito:`, err.message);
      if (attempt === maxRetries) {
        console.error('Failed to initialize database tables after maximum retries:', err);
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

// Verification endpoint for other microservices
app.post('/api/auth/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token non fornito' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({ valid: true, user: decoded });
  } catch (err) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
});

// Helper login handler
async function handleLogin(req, res, role) {
  let { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password richieste' });
  }
  email = String(email).trim().toLowerCase();

  try {
    // Get user and role-specific details if applicable
    let queryText = 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)';
    const userRes = await db.query(queryText, [email]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const user = userRes.rows[0];
    if (user.role !== role) {
      return res.status(403).json({ error: `Accesso negato. Ruolo richiesto: ${role}` });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Context details
    let salonId = null;
    let employeeId = null;

    if (role === 'salon_manager') {
      const salonRes = await db.query('SELECT id FROM salons WHERE manager_id = $1', [user.id]);
      if (salonRes.rows.length > 0) {
        salonId = salonRes.rows[0].id;
      }
    } else if (role === 'employee') {
      const empRes = await db.query('SELECT id, salon_id FROM employees WHERE user_id = $1', [user.id]);
      if (empRes.rows.length > 0) {
        employeeId = empRes.rows[0].id;
        salonId = empRes.rows[0].salon_id;
      }
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        salonId,
        employeeId,
        first_name: user.first_name,
        last_name: user.last_name,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        salonId,
        employeeId,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
}

const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '6');

// Client Register & Login
app.post('/api/auth/client/register', async (req, res) => {
  let { email, password, first_name, last_name, phone } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password richieste' });
  }
  email = String(email).trim().toLowerCase();

  try {
    const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone) 
       VALUES ($1, $2, 'client', $3, $4, $5) RETURNING id, email, role, first_name, last_name`,
      [email, hash, first_name || null, last_name || null, phone || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email già registrata' });
    }
    console.error('[AUTH REGISTER CLIENT ERROR]:', err);
    return res.status(500).json({ error: 'Errore durante la registrazione', details: err.message });
  }
});

app.post('/api/auth/client/login', (req, res) => handleLogin(req, res, 'client'));

// Salon Register & Login
app.post('/api/auth/salon/register', async (req, res) => {
  let { email, password, first_name, last_name, phone, name, street, city, latitude, longitude, description, image_url } = req.body;
  if (!email || !password || !name || !street || !city) {
    return res.status(400).json({ error: 'I campi email, password, nome salone, via e città sono obbligatori' });
  }
  email = String(email).trim().toLowerCase();

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    
    // Create Manager User
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone) 
       VALUES ($1, $2, 'salon_manager', $3, $4, $5) RETURNING id`,
      [email, hash, first_name || null, last_name || null, phone || null]
    );
    const managerId = userRes.rows[0].id;

    // Create Salon
    const lat = parseFloat(latitude) || 45.4642;
    const lng = parseFloat(longitude) || 9.1900;
    const salonRes = await client.query(
      `INSERT INTO salons (manager_id, name, street, city, latitude, longitude, description, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, street, city, image_url`,
      [managerId, name, street, city, lat, lng, description || null, image_url || null]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      manager_id: managerId,
      salon: salonRes.rows[0],
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('Rollback failed:', rbErr); }
    }
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email già registrata nel sistema' });
    }
    console.error('Errore durante la registrazione del salone:', err);
    return res.status(500).json({ error: 'Errore durante la registrazione del salone', details: err.message });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/auth/salon/login', (req, res) => handleLogin(req, res, 'salon_manager'));

// Employee Register & Login
app.post('/api/auth/employee/register', async (req, res) => {
  let { email, password, first_name, last_name, phone, salon_id, specialization, photo_url } = req.body;
  if (!email || !password || !salon_id) {
    return res.status(400).json({ error: 'I campi email, password e salon_id sono obbligatori' });
  }
  email = String(email).trim().toLowerCase();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if salon exists
    const salonCheck = await client.query('SELECT id FROM salons WHERE id = $1', [salon_id]);
    if (salonCheck.rows.length === 0) {
      client.release();
      return res.status(400).json({ error: 'Salone specificato non trovato' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    
    // Create Employee User
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone) 
       VALUES ($1, $2, 'employee', $3, $4, $5) RETURNING id`,
      [email, hash, first_name || null, last_name || null, phone || null]
    );
    const employeeUserId = userRes.rows[0].id;

    // Create Employee Profile
    const empRes = await client.query(
      `INSERT INTO employees (user_id, salon_id, specialization, photo_url) 
       VALUES ($1, $2, $3, $4) RETURNING id, salon_id, specialization, photo_url`,
      [employeeUserId, salon_id, specialization || null, photo_url || null]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      employee_id: empRes.rows[0].id,
      user_id: employeeUserId,
      salon_id: empRes.rows[0].salon_id,
      specialization: empRes.rows[0].specialization,
      photo_url: empRes.rows[0].photo_url,
      first_name: first_name || null,
      last_name: last_name || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email già registrata' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la registrazione del dipendente' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/employee/login', (req, res) => handleLogin(req, res, 'employee'));

app.get('/api/auth/salons', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, street, city, latitude, longitude, description, image_url FROM salons');
    return res.json(result.rows);
  } catch (err) {
    console.error('[AUTH GET SALONS ERROR]:', err);
    return res.status(500).json({ error: 'Errore interno del server', details: err.message });
  }
});

// Autocomplete search for Italian cities
app.get('/api/auth/cities', async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) {
    return res.json([]);
  }
  try {
    const result = await db.query(
      'SELECT name, province, region FROM italian_cities WHERE name ILIKE $1 ORDER BY name ASC LIMIT 10',
      [`%${q}%`]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la ricerca delle città' });
  }
});

app.get('/api/auth/salons/:id/employees', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.specialization, e.photo_url, u.first_name, u.last_name, u.email 
       FROM employees e 
       JOIN users u ON e.user_id = u.id 
       WHERE e.salon_id = $1`,
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.get('/api/auth/employees/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.salon_id, e.specialization, e.photo_url, u.first_name, u.last_name, u.email 
       FROM employees e 
       JOIN users u ON e.user_id = u.id 
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dipendente non trovato' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.get('/api/auth/users/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, role FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.put('/api/auth/salons/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const { name, street, city, description, image_url } = req.body;
  const salonId = req.params.id;
  
  try {
    const checkSalon = await db.query('SELECT * FROM salons WHERE id = $1 AND manager_id = $2', [salonId, req.user.userId]);
    if (checkSalon.rows.length === 0) {
      return res.status(403).json({ error: 'Non sei autorizzato a modificare questo salone' });
    }

    const current = checkSalon.rows[0];
    const newName = name !== undefined ? name : current.name;
    const newStreet = street !== undefined ? street : current.street;
    const newCity = city !== undefined ? city : current.city;
    const newDesc = description !== undefined ? description : current.description;
    const newImg = (image_url === '' || image_url === null) ? null : (image_url !== undefined ? image_url : current.image_url);

    await db.query(
      'UPDATE salons SET name = $1, street = $2, city = $3, description = $4, image_url = $5 WHERE id = $6',
      [newName, newStreet, newCity, newDesc, newImg, salonId]
    );
    return res.json({ message: 'Informazioni salone aggiornate con successo', image_url: newImg });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la modifica del salone' });
  }
});

app.put('/api/auth/employees/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const empId = req.params.id;
  const { specialization, photo_url, first_name, last_name } = req.body;
  
  try {
    const check = await db.query(
      `SELECT e.id, e.user_id, e.specialization, e.photo_url FROM employees e 
       JOIN salons s ON e.salon_id = s.id 
       WHERE e.id = $1 AND s.manager_id = $2`,
      [empId, req.user.userId]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Non autorizzato a modificare questo dipendente' });
    }

    const current = check.rows[0];
    const newSpec = (specialization !== undefined) ? specialization : current.specialization;
    const newPhoto = (photo_url === '' || photo_url === null) ? null : (photo_url !== undefined ? photo_url : current.photo_url);

    await db.query(
      'UPDATE employees SET specialization = $1, photo_url = $2 WHERE id = $3',
      [newSpec, newPhoto, empId]
    );

    if (first_name || last_name) {
      await db.query(
        'UPDATE users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name) WHERE id = $3',
        [first_name || null, last_name || null, current.user_id]
      );
    }

    return res.json({ message: 'Dipendente aggiornato con successo', photo_url: newPhoto, specialization: newSpec });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la modifica del dipendente' });
  }
});

app.delete('/api/auth/employees/:id', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const empId = req.params.id;
  
  try {
    const check = await db.query(
      `SELECT e.id, e.user_id FROM employees e 
       JOIN salons s ON e.salon_id = s.id 
       WHERE e.id = $1 AND s.manager_id = $2`,
      [empId, req.user.userId]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Non autorizzato a eliminare questo dipendente' });
    }
    
    const userId = check.rows[0].user_id;
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    return res.json({ message: 'Dipendente eliminato con successo' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante l\'eliminazione del dipendente' });
  }
});

// Start service
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Auth Service running on port ${PORT}`);
  });
});
