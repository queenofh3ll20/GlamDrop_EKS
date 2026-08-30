process.env.TZ = 'Europe/Rome';
const express = require('express');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const { createClient } = require('redis');
const axios = require('axios');
const db = require('./db');

const app = express();
app.use(express.json());

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
const PORT = process.env.PORT || 3003;
const REDIS_URL = db.requireEnv('REDIS_URL');
const RABBITMQ_URL = db.requireEnv('RABBITMQ_URL');
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:3002';

// Health check endpoints per ALB e smoke test
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'drop-service', timestamp: new Date().toISOString() });
});

app.get('/api/drops/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'drop-service', timestamp: new Date().toISOString() });
});

let redisClient = null;
let mqChannel = null;
let isMqConnecting = false;

// Connect to Redis (con supporto TLS per ElastiCache rediss://)
async function initRedis() {
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        tls: REDIS_URL.startsWith('rediss://'),
        rejectUnauthorized: false
      }
    });
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await redisClient.connect();
    console.log('Connected to Redis in Drop Service');
  } catch (err) {
    console.error('Failed to connect to Redis, retrying in 5 seconds...', err);
    setTimeout(initRedis, 5000);
  }
}

// Connect to RabbitMQ & Start Consumers (con riconnessione a runtime)
async function initRabbitMQ() {
  if (isMqConnecting) return;
  isMqConnecting = true;
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    conn.on('error', (err) => {
      console.error('RabbitMQ connection error (drop-service):', err.message);
    });
    conn.on('close', () => {
      console.warn('RabbitMQ connection closed. Reconnecting in 5 seconds...');
      mqChannel = null;
      isMqConnecting = false;
      setTimeout(initRabbitMQ, 5000);
    });

    mqChannel = await conn.createChannel();
    mqChannel.on('error', (err) => {
      console.error('RabbitMQ channel error (drop-service):', err.message);
    });
    mqChannel.on('close', () => {
      console.warn('RabbitMQ channel closed (drop-service).');
      mqChannel = null;
    });
    
    await mqChannel.assertQueue('drop.booking.events', { durable: true });
    await mqChannel.assertQueue('drop.events', { durable: true });
    await mqChannel.assertQueue('drop.claims.processing', { durable: true });

    console.log('Connected to RabbitMQ in Drop Service');
    isMqConnecting = false;

    // Start consuming Late Cancellations from Booking Service
    mqChannel.consume('drop.booking.events', async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString());
        if (content.type === 'BOOKING_CANCELLED_LATE') {
          console.log('Received late cancellation event. Auto-creating a Drop...');
          const { original_booking_id, salon_id, service_id, employee_id, booking_time, drop_price } = content.data;
          
          await createDropInternal({
            salon_id,
            service_id,
            employee_id,
            original_booking_id,
            booking_time,
            discounted_price: drop_price
          });
        }
        mqChannel.ack(msg);
      } catch (err) {
        console.error('Error handling booking event:', err);
        // Nack with requeue=false to avoid infinite loop
        mqChannel.nack(msg, false, false);
      }
    });

    // Start consuming Claim requests in background (Worker)
    mqChannel.consume('drop.claims.processing', async (msg) => {
      if (!msg) return;
      try {
        const { drop_id, client_id } = JSON.parse(msg.content.toString());
        console.log(`Worker processing claim for Drop: ${drop_id} by Client: ${client_id}`);

        // 1. Fetch Drop Details from PG
        const dropRes = await db.query('SELECT * FROM drops WHERE id = $1', [drop_id]);
        if (dropRes.rows.length === 0) {
          console.error(`Drop ${drop_id} not found in DB`);
          mqChannel.ack(msg);
          return;
        }

        const drop = dropRes.rows[0];
        if (drop.status === 'claimed') {
          console.log(`Drop ${drop_id} already marked as claimed in DB`);
          mqChannel.ack(msg);
          return;
        }

        // 2. Call Booking Service to write Booking & Process Mock Payment
        try {
          const bookingTimeStr = new Date(drop.booking_time).toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
          const confirmRes = await axios.post(`${BOOKING_SERVICE_URL}/api/bookings/confirm-drop`, {
            client_id,
            salon_id: drop.salon_id,
            service_id: drop.service_id,
            employee_id: drop.employee_id,
            booking_time: bookingTimeStr,
            price: drop.discounted_price,
            drop_id: drop.id
          });

          const booking = confirmRes.data;

          // 3. Update Drop Status in PostgreSQL
          await db.query(
            `UPDATE drops 
             SET status = 'claimed', claimed_by = $1, claimed_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [client_id, drop_id]
          );

          console.log(`Successfully wrote Booking: ${booking.id} and updated Drop: ${drop_id}`);

          // 4. Publish Drop Claim Confirmed event for notifications
          publishEvent('drop.events', 'DROP_CLAIMED_CONFIRMED', {
            drop_id,
            client_id,
            booking_id: booking.id,
            salon_id: drop.salon_id,
            price: drop.discounted_price
          });

        } catch (apiErr) {
          console.error(`Booking Service call failed for Drop claim:`, apiErr.message);
          
          const isConflict = apiErr.response && apiErr.response.status === 400;
          if (isConflict) {
            // Drop slot is already occupied, mark drop as expired
            await redisClient.hSet(`drop:${drop_id}`, 'status', 'expired');
            await db.query(`UPDATE drops SET status = 'expired' WHERE id = $1`, [drop_id]);
            console.log(`Drop ${drop_id} marked as expired due to booking conflict.`);
          } else {
            // Revert Redis status back to available if general DB sync failed (so someone else can try)
            await redisClient.hSet(`drop:${drop_id}`, 'status', 'available');
            await redisClient.hDel(`drop:${drop_id}`, 'claimed_by');
            await db.query(`UPDATE drops SET status = 'available' WHERE id = $1`, [drop_id]);
          }
        }

        mqChannel.ack(msg);
      } catch (err) {
        console.error('Error in claim processing worker:', err);
        mqChannel.nack(msg, false, true); // requeue to retry
      }
    });

  } catch (err) {
    console.error('RabbitMQ Connection failed in Drop Service, retrying in 5 seconds...', err.message);
    isMqConnecting = false;
    setTimeout(initRabbitMQ, 5000);
  }
}

// Helper to publish events
function publishEvent(queue, eventType, data) {
  if (!mqChannel) return;
  const payload = JSON.stringify({ type: eventType, data });
  mqChannel.sendToQueue(queue, Buffer.from(payload), { persistent: true });
}

// Init Database with retry loop
async function initDb(maxRetries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[INIT-DB] Inizializzazione database Drop Service (tentativo ${attempt}/${maxRetries})...`);
      await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(err => {
        console.warn('[INIT-DB] Estensione uuid-ossp opzionale saltata:', err.message);
      });

      await db.query(`
        CREATE TABLE IF NOT EXISTS drops (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          salon_id UUID NOT NULL,
          service_id UUID NOT NULL,
          employee_id UUID NOT NULL,
          original_booking_id UUID,
          booking_time TIMESTAMP NOT NULL,
          discounted_price DECIMAL(10,2) NOT NULL,
          status VARCHAR(50) NOT NULL CHECK (status IN ('available', 'claimed', 'expired')),
          claimed_by UUID,
          claimed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      console.log('Database tables initialized successfully in Drop Service.');
      return;
    } catch (err) {
      console.error(`[INIT-DB ERROR] Tentativo ${attempt}/${maxRetries} fallito:`, err.message);
      if (attempt === maxRetries) {
        console.error('Failed to initialize database tables in Drop Service after maximum retries:', err);
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
    return res.status(403).json({ error: 'Token non valido' });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Operazione non autorizzata per questo ruolo' });
    }
    next();
  };
}

// Core function to create a drop in PG and cache in Redis
async function createDropInternal({ salon_id, service_id, employee_id, original_booking_id, booking_time, discounted_price }) {
  // Format booking_time cleanly for JS Date parsing (replace space with T)
  const cleanTimeStr = String(booking_time).trim().replace(' ', 'T');
  const targetTime = new Date(cleanTimeStr).getTime();
  const expireSeconds = Math.floor((targetTime - Date.now()) / 1000);
  
  if (isNaN(targetTime) || expireSeconds <= 0) {
    // 1. Write to PostgreSQL as expired
    const result = await db.query(
      `INSERT INTO drops (salon_id, service_id, employee_id, original_booking_id, booking_time, discounted_price, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'expired') RETURNING *`,
      [salon_id, service_id, employee_id, original_booking_id, booking_time, discounted_price]
    );
    const drop = result.rows[0];
    console.log(`Drop created as already expired. ID: ${drop.id}`);
    publishEvent('drop.events', 'DROP_CREATED', drop);
    return drop;
  }

  // 1. Write to PostgreSQL
  const result = await db.query(
    `INSERT INTO drops (salon_id, service_id, employee_id, original_booking_id, booking_time, discounted_price, status) 
     VALUES ($1, $2, $3, $4, $5, $6, 'available') RETURNING *`,
    [salon_id, service_id, employee_id, original_booking_id, booking_time, discounted_price]
  );
  
  const drop = result.rows[0];

  // 2. Cache in Redis
  try {
    await redisClient.hSet(`drop:${drop.id}`, {
      status: 'available',
      discounted_price: String(discounted_price),
      salon_id: String(salon_id),
      service_id: String(service_id),
      employee_id: String(employee_id),
      booking_time: String(booking_time),
    });
    await redisClient.expire(`drop:${drop.id}`, expireSeconds);
  } catch (rErr) {
    console.error('Redis caching error for drop:', rErr);
  }

  console.log(`Drop created and cached. ID: ${drop.id}, Expires in: ${expireSeconds}s`);

  // 4. Publish Event to trigger notification
  publishEvent('drop.events', 'DROP_CREATED', drop);

  return drop;
}

// --- API DROPS ---

// List Active Drops
app.get('/api/drops', async (req, res) => {
  try {
    await db.query("UPDATE drops SET status = 'expired' WHERE status = 'available' AND booking_time <= NOW()");

    const result = await db.query("SELECT * FROM drops WHERE status = 'available' ORDER BY booking_time ASC");
    return res.json(result.rows);
  } catch (err) {
    console.error('Error in GET /api/drops:', err);
    return res.status(500).json({ error: 'Errore nel recupero dei drop' });
  }
});

// Create Drop Manually (Manager)
app.post('/api/drops', authenticateToken, requireRole(['salon_manager']), async (req, res) => {
  const { service_id, employee_id, booking_time, discounted_price } = req.body;
  const salon_id = req.user.salonId;

  if (!service_id || !employee_id || !booking_time || !discounted_price) {
    return res.status(400).json({ error: 'Tutti i campi sono obbligatori' });
  }

  try {
    const drop = await createDropInternal({
      salon_id,
      service_id,
      employee_id,
      original_booking_id: null,
      booking_time,
      discounted_price
    });
    return res.status(201).json(drop);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante la creazione del drop' });
  }
});

// CLAIM DROP - Thundering Herd Solver (Lua Script in Redis)
app.post('/api/drops/:id/claim', authenticateToken, requireRole(['client']), async (req, res) => {
  const dropId = req.params.id;
  const clientId = req.user.userId;

  try {
    const redisKey = `drop:${dropId}`;

    // Lua script to atomically reserve the drop
    const luaScript = `
      local status = redis.call('hget', KEYS[1], 'status')
      if status == 'available' then
        redis.call('hset', KEYS[1], 'status', 'claimed')
        redis.call('hset', KEYS[1], 'claimed_by', ARGV[1])
        return 1
      else
        return 0
      end
    `;

    // Execute atomic claim in Redis
    const result = await redisClient.eval(luaScript, {
      keys: [redisKey],
      arguments: [clientId],
    });

    if (result === 1) {
      console.log(`Redis claim SUCCESS for Drop: ${dropId} by Client: ${clientId}`);

      // Push to RabbitMQ to write to SQL asynchronously
      mqChannel.sendToQueue(
        'drop.claims.processing',
        Buffer.from(JSON.stringify({ drop_id: dropId, client_id: clientId })),
        { persistent: true }
      );

      // Return immediate success to client (Thundering Herd solved!)
      return res.status(202).json({
        message: 'Richiesta di prenotazione presa in carico con successo. Riceverai una notifica di conferma a breve.',
        drop_id: dropId,
        status: 'pending_confirmation'
      });
    } else {
      console.log(`Redis claim FAILED (Taken/Expired) for Drop: ${dropId} by Client: ${clientId}`);
      
      const dropRes = await db.query('SELECT * FROM drops WHERE id = $1', [dropId]);
      if (dropRes.rows.length === 0) {
        return res.status(404).json({ error: 'Drop non trovato' });
      }

      const drop = dropRes.rows[0];
      const bookingTimeStr = new Date(drop.booking_time).toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
      const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });

      if (drop.status === 'claimed') {
        return res.status(409).json({ error: 'Questo slot scontato (Drop) è già stato acquistato da un altro utente' });
      } else if (drop.status === 'expired' || bookingTimeStr <= nowStr) {
        if (drop.status !== 'expired') {
          await db.query("UPDATE drops SET status = 'expired' WHERE id = $1", [dropId]);
        }
        return res.status(410).json({ error: 'Questo slot scontato (Drop) è scaduto' });
      } else {
        return res.status(409).json({ error: 'Questo slot scontato (Drop) non è più disponibile' });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Errore durante l\'acquisto del drop' });
  }
});

// Start service
initDb().then(() => {
  initRedis();
  initRabbitMQ();
  app.listen(PORT, () => {
    console.log(`Drop Service running on port ${PORT}`);
  });
});
